package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// FileData 前后端之间传递的文件内容
type FileData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SaveImageResult 图片落盘结果
type SaveImageResult struct {
	Path string `json:"path"` // 落盘绝对路径
	Src  string `json:"src"`  // markdown 中的引用路径（正斜杠；相对模式下是相对当前文件的路径）
}

// App 应用主体，负责文件对话框与读写
type App struct {
	ctx         context.Context
	curPath     string // 当前打开/已保存的文件路径，空表示未命名
	startupPath string // 命令行带入的要打开的文件路径
	ln          net.Listener
	settings    Settings // 应用设置
	resetOnShow bool     // 关闭到后台后，下次显示窗口时回到启动页
}

func NewApp() *App {
	return &App{settings: loadSettings()}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if a.ln != nil {
		go a.serveSingleInstance()
	}
	go runTray(ctx, a)
}

// beforeClose 拦截窗口关闭：先交给前端处理未保存内容，再决定退出 / 留在后台
func (a *App) beforeClose(ctx context.Context) bool {
	if forceQuit {
		return false
	}
	runtime.EventsEmit(ctx, "close-requested", a.ln != nil)
	return true
}

// ConfirmClose 前端关闭询问的结果
func (a *App) ConfirmClose(action string, remember bool) {
	if remember && (action == "exit" || action == "background") {
		a.settings.CloseAction = action
		_ = saveSettingsToDisk(a.settings)
	}
	// 附属窗口实例（无托盘）只能退出，不能藏起来
	if action == "exit" || a.ln == nil {
		forceQuit = true
		runtime.Quit(a.ctx)
		return
	}
	a.resetOnShow = true
	runtime.WindowHide(a.ctx)
}

// showMainWindow 显示主窗口；若是“关闭到后台”后重开，则让前端回到启动页
func (a *App) showMainWindow() {
	reset := a.resetOnShow
	a.resetOnShow = false
	runtime.EventsEmit(a.ctx, "window-shown", reset)
	runtime.WindowShow(a.ctx)
}

// serveSingleInstance 单实例服务：接收第二实例的打开文件/唤出窗口请求
func (a *App) serveSingleInstance() {
	mux := http.NewServeMux()
	mux.HandleFunc("/show", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Typora-Lite", "pong")
		a.showMainWindow()
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/open", func(w http.ResponseWriter, r *http.Request) {
		p, err := url.QueryUnescape(r.URL.Query().Get("path"))
		if err != nil || p == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := a.openFileInternal(p); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Typora-Lite", "pong")
		runtime.WindowShow(a.ctx)
		w.WriteHeader(http.StatusOK)
	})
	_ = http.Serve(a.ln, mux)
}

// openFileInternal 读取文件并通知前端加载（单实例远程打开）
func (a *App) openFileInternal(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	a.curPath = path
	a.resetOnShow = false // 重新打开文件后不再回到启动页
	addRecentFile(path)
	runtime.EventsEmit(a.ctx, "open-file", FileData{Path: path, Content: string(data)})
	return nil
}

// GetStartupFile 领取待打开的文件（命令行参数或单实例转发），取后清空
func (a *App) GetStartupFile() *FileData {
	if a.startupPath == "" {
		return nil
	}
	p := a.startupPath
	a.startupPath = ""
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	a.curPath = p
	addRecentFile(p)
	return &FileData{Path: p, Content: string(data)}
}

// PickMarkdownPath 只弹出选择对话框返回路径（不读取内容），供"在新窗口打开"使用
func (a *App) PickMarkdownPath() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

// OpenInNewWindow 在新窗口打开指定 .md 文件（绕过单实例询问）
func (a *App) OpenInNewWindow(path string) error {
	if path == "" {
		return nil // 用户取消选择
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return exec.Command(exe, "--new-window", path).Start()
}

// OpenPath 直接按路径打开 .md 文件（拖拽打开）
func (a *App) OpenPath(path string) (*FileData, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".md" && ext != ".markdown" {
		return nil, fmt.Errorf("仅支持打开 .md 文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	a.curPath = path
	addRecentFile(path)
	return &FileData{Path: path, Content: string(data)}, nil
}

// ImportImage 把磁盘上的图片文件导入资源目录（拖拽图片进编辑器）
func (a *App) ImportImage(path string) (*SaveImageResult, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			ext = ".jpg"
		}
	default:
		return nil, fmt.Errorf("不支持的图片格式: %s", ext)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return a.saveToAssets(data, ext)
}

// RegisterMdAssociation 把 Typora Lite 加入 .md 文件的“打开方式”列表。
// 全部写 HKCU（免管理员），注册后通知资源管理器刷新关联缓存。
func (a *App) RegisterMdAssociation() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe = filepath.Clean(exe)

	const progID = "TyporaLite.md"
	cmd := fmt.Sprintf(`"%s" "%%1"`, exe)

	// 1) ProgID：打开命令 + 图标 + 友好名称
	steps := []struct {
		path  string
		name  string
		value string
	}{
		{`Software\Classes\` + progID, "", "Typora Lite Markdown"},
		{`Software\Classes\` + progID, "FriendlyTypeName", "Typora Lite Markdown"},
		{`Software\Classes\` + progID + `\DefaultIcon`, "", fmt.Sprintf(`"%s",0`, exe)},
		{`Software\Classes\` + progID + `\shell\open\command`, "", cmd},
		// 2) 应用注册：让“打开方式 / 选择其他应用”列表能稳定展示
		{`Software\Classes\Applications\TyporaLite.exe`, "FriendlyAppName", "Typora Lite"},
		{`Software\Classes\Applications\TyporaLite.exe\DefaultIcon`, "", fmt.Sprintf(`"%s",0`, exe)},
		{`Software\Classes\Applications\TyporaLite.exe\shell\open\command`, "", cmd},
		{`Software\Classes\Applications\TyporaLite.exe\SupportedTypes`, ".md", ""},
		{`Software\Classes\Applications\TyporaLite.exe\SupportedTypes`, ".markdown", ""},
	}
	for _, s := range steps {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, s.path, registry.SET_VALUE)
		if err != nil {
			return "", fmt.Errorf("写入注册表失败(%s): %w", s.path, err)
		}
		err = k.SetStringValue(s.name, s.value)
		k.Close()
		if err != nil {
			return "", fmt.Errorf("写入注册表值失败(%s / %s): %w", s.path, s.name, err)
		}
	}

	// 3) .md\OpenWithProgids 必须是【子键】，子键下以 ProgID 命名的空值
	for _, ext := range []string{".md", ".markdown"} {
		kow, _, err := registry.CreateKey(
			registry.CURRENT_USER,
			`Software\Classes\`+ext+`\OpenWithProgids`,
			registry.SET_VALUE,
		)
		if err != nil {
			return "", fmt.Errorf("写入 OpenWithProgids 失败(%s): %w", ext, err)
		}
		err = kow.SetStringValue(progID, "")
		kow.Close()
		if err != nil {
			return "", fmt.Errorf("写入 OpenWithProgids 值失败(%s): %w", ext, err)
		}
	}

	// 清理旧版本误写在 .md 键下的同名多字符串值（错误结构，会导致识别异常）
	for _, ext := range []string{".md", ".markdown"} {
		kmd, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+ext, registry.SET_VALUE)
		if err != nil {
			continue
		}
		_ = kmd.DeleteValue("OpenWithProgids")
		kmd.Close()
	}

	// 4) 通知资源管理器立即刷新文件关联（否则要重启 explorer 才生效）
	notifyAssocChanged()

	return "已注册成功。请右键 .md 文件 → 打开方式 → 选择其他应用，即可看到 Typora Lite。\n\n" +
		"注意：若以后移动了本程序位置，需要重新点此注册。", nil
}

// SHChangeNotify：让资源管理器立即感知关联变化
func notifyAssocChanged() {
	const (
		shcneAssocChanged = 0x08000000
		shcnfIDList       = 0x0000
	)
	shell32 := windows.NewLazySystemDLL("shell32.dll")
	proc := shell32.NewProc("SHChangeNotify")
	if proc.Find() == nil {
		_, _, _ = proc.Call(shcneAssocChanged, shcnfIDList, 0, 0)
	}
}

// RenameFile 重命名当前打开的文件（只改主名，自动保留原扩展名），返回新路径
func (a *App) RenameFile(newBaseName string) (string, error) {
	if a.curPath == "" {
		return "", fmt.Errorf("当前文档尚未保存，请先保存后再重命名")
	}
	base := strings.TrimSpace(newBaseName)
	if base == "" {
		return "", fmt.Errorf("文件名不能为空")
	}
	if strings.ContainsAny(base, `\/:*?"<>|`) {
		return "", fmt.Errorf("文件名不能包含 \\ / : * ? \" < > | 等字符")
	}

	ext := filepath.Ext(a.curPath)
	// 用户可能自己带上了扩展名，统一剥掉后再拼接
	if ext != "" && strings.EqualFold(base[len(base)-len(ext):], ext) && len(base) > len(ext) {
		base = base[:len(base)-len(ext)]
	}
	newPath := filepath.Join(filepath.Dir(a.curPath), base+ext)
	if newPath == a.curPath {
		return a.curPath, nil
	}
	if _, err := os.Stat(newPath); err == nil {
		return "", fmt.Errorf("同名文件已存在: %s", base+ext)
	}
	if err := os.Rename(a.curPath, newPath); err != nil {
		return "", err
	}
	a.curPath = newPath
	addRecentFile(newPath)
	return newPath, nil
}

// ---------- 设置 ----------

// GetSettings 读取设置
func (a *App) GetSettings() Settings {
	return a.settings
}

// SaveSettings 保存设置并持久化
func (a *App) SaveSettings(s Settings) (Settings, error) {
	if s.AssetsFolder == "" {
		s.AssetsFolder = "assets"
	}
	if s.AssetMode != "custom" && s.AssetMode != "relative" {
		s.AssetMode = "relative"
	}
	if s.CloseAction == "" {
		// 前端保存其他设置时未带此字段 → 保留原有选择
		s.CloseAction = a.settings.CloseAction
	}
	if s.CloseAction != "exit" && s.CloseAction != "background" {
		s.CloseAction = "ask"
	}
	if s.OpenAction != "current" && s.OpenAction != "new" {
		s.OpenAction = "ask"
	}
	if s.Theme != "light" {
		s.Theme = "dark"
	}
	a.settings = s
	if err := saveSettingsToDisk(s); err != nil {
		return s, err
	}
	// 主题变化时同步原生窗口边框（顶部标题栏/最小化按钮那排）
	if a.ctx != nil {
		if s.Theme == "light" {
			runtime.WindowSetLightTheme(a.ctx)
		} else {
			runtime.WindowSetDarkTheme(a.ctx)
		}
	}
	return s, nil
}

// ChooseDirectory 弹出选择目录对话框
func (a *App) ChooseDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择图片资源存储目录",
	})
}

// ---------- 图片存储 ----------

// resolveAssetsDir 按设置决定图片落盘目录
func (a *App) resolveAssetsDir() string {
	s := a.settings
	if s.AssetMode == "custom" && s.CustomDir != "" {
		return s.CustomDir
	}
	if a.curPath != "" {
		return filepath.Join(filepath.Dir(a.curPath), s.AssetsFolder)
	}
	// relative 模式但当前文件未保存 → 软件默认资源目录
	return DefaultAssetsDir()
}

// timeImageName 统一按时间命名：20261104-153045.png，同秒冲突时追加序号
func timeImageName(dir, ext string) string {
	base := time.Now().Format("20060102-150405")
	for i := 0; ; i++ {
		name := base + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		if _, err := os.Stat(filepath.Join(dir, name)); os.IsNotExist(err) {
			return name
		}
	}
}

// saveToAssets 落盘公共逻辑：写入资源目录并生成 markdown 引用
func (a *App) saveToAssets(data []byte, ext string) (*SaveImageResult, error) {
	dir := a.resolveAssetsDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	name := timeImageName(dir, ext)
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, data, 0644); err != nil {
		return nil, err
	}

	// markdown 引用：relative 模式且当前文件已保存 → 相对路径；否则绝对路径
	var src string
	if a.settings.AssetMode == "relative" && a.curPath != "" {
		src = pathSlash(a.settings.AssetsFolder) + "/" + name
	} else {
		src = pathSlash(abs)
	}
	return &SaveImageResult{Path: abs, Src: src}, nil
}

// extFromContentType 由响应 Content-Type 推断扩展名
func extFromContentType(ct string) string {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if i := strings.Index(ct, ";"); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	switch ct {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/bmp":
		return ".bmp"
	case "image/avif":
		return ".avif"
	}
	return ""
}

// extFromURL 由 URL 路径推断扩展名（白名单校验）
func extFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	ext := strings.ToLower(filepath.Ext(u.Path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			return ".jpg"
		}
		return ext
	}
	return ""
}

// SaveImage 把前端传来的图片（base64）写入本地并返回 markdown 引用路径
func (a *App) SaveImage(fileName string, base64Data string) (*SaveImageResult, error) {
	// 兼容 dataURL 前缀
	if i := strings.Index(base64Data, ","); i >= 0 && strings.HasPrefix(base64Data, "data:") {
		base64Data = base64Data[i+1:]
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return nil, fmt.Errorf("解码图片失败: %w", err)
	}

	ext := strings.ToLower(filepath.Ext(fileName))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif":
		if ext == ".jpeg" {
			ext = ".jpg"
		}
	default:
		ext = ".png"
	}
	return a.saveToAssets(data, ext)
}

// DownloadImage 下载网络图片到本地资源目录并返回 markdown 引用路径
func (a *App) DownloadImage(rawURL string) (*SaveImageResult, error) {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return nil, fmt.Errorf("仅支持 http(s) 图片地址")
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return nil, fmt.Errorf("下载图片失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载图片失败: HTTP %d", resp.StatusCode)
	}
	const maxImageSize = 50 << 20 // 50MB
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageSize))
	if err != nil {
		return nil, fmt.Errorf("读取图片失败: %w", err)
	}

	ext := extFromContentType(resp.Header.Get("Content-Type"))
	if ext == "" {
		ext = extFromURL(rawURL)
	}
	if ext == "" {
		ext = ".png"
	}
	return a.saveToAssets(data, ext)
}

// pathSlash 统一成正斜杠，方便 markdown 引用与 URL 传输
func pathSlash(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// ---------- 图片查看 ----------

// ViewImage 打开独立图片查看窗口（新起一个查看器进程）
func (a *App) ViewImage(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("图片不存在: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return exec.Command(exe, "--image-viewer", abs).Start()
}

// RevealInExplorer 在资源管理器中定位图片文件
func (a *App) RevealInExplorer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("图片不存在: %w", err)
	}
	return exec.Command("explorer", "/select,"+abs).Start()
}

// ---------- 文件操作 ----------

// OpenMarkdown 弹出系统对话框选择 .md 文件并读取
func (a *App) OpenMarkdown() (*FileData, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, nil // 用户取消
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	a.curPath = path
	addRecentFile(path)
	return &FileData{Path: path, Content: string(data)}, nil
}

// SaveMarkdown 保存到当前路径；无路径时自动转另存为
func (a *App) SaveMarkdown(content string) (string, error) {
	if a.curPath == "" {
		return a.SaveMarkdownAs(content)
	}
	if err := os.WriteFile(a.curPath, []byte(content), 0644); err != nil {
		return "", err
	}
	return a.curPath, nil
}

// SaveMarkdownAs 弹出另存为对话框
func (a *App) SaveMarkdownAs(content string) (string, error) {
	name := "未命名.md"
	if a.curPath != "" {
		name = filepath.Base(a.curPath)
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存 Markdown 文件",
		DefaultFilename: name,
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown (*.md)", Pattern: "*.md"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // 用户取消
	}
	if !strings.HasSuffix(strings.ToLower(path), ".md") {
		path += ".md"
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", err
	}
	a.curPath = path
	addRecentFile(path)
	return path, nil
}

// ClosePath 关闭文件时清空当前路径
func (a *App) ClosePath() {
	a.curPath = ""
}
