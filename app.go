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
	windowMode  string   // 当前窗口模式："welcome" | "editor"
}

func NewApp() *App {
	return &App{settings: loadSettings()}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 单实例端口只用于「无文件参数双击 exe 时唤出已有窗口」；不再有托盘常驻。
	if a.ln != nil {
		go a.serveSingleInstance()
	}
}

// beforeClose 拦截窗口关闭：先交给前端处理未保存内容，确认后整个进程退出
func (a *App) beforeClose(ctx context.Context) bool {
	if forceQuit {
		return false
	}
	runtime.EventsEmit(ctx, "close-requested")
	return true
}

// QuitApp 前端处理完未保存内容后调用：直接退出进程，不留后台
func (a *App) QuitApp() {
	forceQuit = true
	runtime.Quit(a.ctx)
}

// showMainWindow 唤出已有窗口（无文件参数双击 exe 时走单实例 /show）。
// WindowShow 底层是 SW_SHOW，对最小化到任务栏的窗口无效，
// 先 Unminimise(SW_RESTORE) 再 Show，保证一定能看见。
func (a *App) showMainWindow() {
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

// SetWindowMode 按当前是否有文档切换窗口尺寸：启动页小窗、编辑态大窗。
// 前端在显示 / 隐藏启动页时调用；模式未变化时不重复设置，避免覆盖用户手动调整的大小。
func (a *App) SetWindowMode(hasDocument bool) {
	if a.ctx == nil {
		return
	}
	mode := "welcome"
	w, h := welcomeWindowWidth, welcomeWindowHeight
	if hasDocument {
		mode = "editor"
		w, h = editorWindowWidth, editorWindowHeight
	}
	if a.windowMode == mode {
		return
	}
	a.windowMode = mode
	runtime.WindowSetSize(a.ctx, w, h)
	runtime.WindowCenter(a.ctx)
}

// serveSingleInstance 单实例服务：只处理「无文件参数时唤出已有窗口」。
// 从已有窗口再打开 .md 一律交给新进程（新窗口），不把文件转发到当前窗口覆盖已有文档。
func (a *App) serveSingleInstance() {
	mux := http.NewServeMux()
	mux.HandleFunc("/show", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-LiteMark-View", "pong")
		a.showMainWindow()
		w.WriteHeader(http.StatusOK)
	})
	_ = http.Serve(a.ln, mux)
}

// GetStartupFile 领取命令行带入的要打开的文件（双击 .md / 文件关联 / 新窗口），取后清空
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

// PickMarkdownPath 只弹出选择对话框返回路径（不读取内容），供「在新窗口打开」使用
func (a *App) PickMarkdownPath() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

// spawnWindow 另起一个进程开新窗口，并把「触发打开的本窗口」位置一并传过去，
// 新窗口据此往右下错开，而不是和本窗口完全重叠。
func (a *App) spawnWindow(args ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmdArgs := []string{"--new-window"}
	if a.ctx != nil {
		x, y := runtime.WindowGetPosition(a.ctx)
		cmdArgs = append(cmdArgs, fmt.Sprintf("--cascade-from=%d,%d", x, y))
	}
	cmdArgs = append(cmdArgs, args...)
	return exec.Command(exe, cmdArgs...).Start()
}

// OpenInNewWindow 在新窗口打开指定 .md 文件（另起一个进程，永不复用当前窗口）
func (a *App) OpenInNewWindow(path string) error {
	if path == "" {
		return nil // 用户取消选择
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	return a.spawnWindow(path)
}

// OpenContentInNewWindow 把只有内容、没有磁盘路径的 .md（WebView 拖放兜底）
// 先写入临时文件，再在新窗口打开，保证任何打开方式都不会覆盖当前窗口。
func (a *App) OpenContentInNewWindow(content, name string) error {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) {
			return '-'
		}
		return r
	}, name)
	if name == "" || name == "." {
		name = "未命名.md"
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext != ".md" && ext != ".markdown" {
		name += ".md"
	}
	dir := filepath.Join(os.TempDir(), "LiteMarkView")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err == nil {
		ext = filepath.Ext(name)
		p = filepath.Join(dir, fmt.Sprintf("%s-%d%s", strings.TrimSuffix(name, ext), time.Now().UnixNano(), ext))
	}
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		return err
	}
	return a.OpenInNewWindow(p)
}

// OpenPath 读取指定 .md 并返回内容；仅用于「启动页复用当前窗口」这一场景
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
