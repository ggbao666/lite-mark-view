package main

import (
	"context"
	"embed"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	syswin "golang.org/x/sys/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var trayIconBytes []byte

// viewerMode 图片查看器进程模式（--image-viewer 启动时为 true）
var viewerMode = false

// forceQuit 托盘退出/用户确认退出时置位，绕过关闭拦截
var forceQuit = false

// singleInstanceAddr 单实例通信地址：第二实例通过 HTTP 通知第一实例后退出
const singleInstanceAddr = "127.0.0.1:27182"

// decideOpenAction 决定已有实例运行时如何打开文件：
// 先看设置记忆，未记忆（ask）时弹系统对话框询问用户
func decideOpenAction(path string) string {
	s := loadSettings()
	if s.OpenAction == "current" || s.OpenAction == "new" {
		return s.OpenAction
	}

	name := "新文件"
	if path != "" {
		name = filepath.Base(path)
	}
	text := fmt.Sprintf("检测到 Typora Lite 已在运行。\n\n"+
		"「是」— 在已打开的窗口中打开「%s」\n"+
		"「否」— 在新窗口中打开「%s」\n"+
		"「取消」— 不打开", name, name)

	const (
		mbYesNoCancel = 0x3
		mbIconQ       = 0x20
		mbTopMost     = 0x40000
		idYes         = 6
		idNo          = 7
	)
	r, _ := syswin.MessageBox(0, utf16Ptr(text), utf16Ptr("Typora Lite"), mbYesNoCancel|mbIconQ|mbTopMost)
	switch r {
	case idYes:
		return "current"
	case idNo:
		return "new"
	default:
		return "cancel"
	}
}

func utf16Ptr(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

// localFileHandler 提供本地磁盘文件预览：
// /local-file?path=<绝对路径> 用于在编辑器/查看器中显示本地图片
func localFileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/local-file" {
			http.NotFound(w, r)
			return
		}
		p := r.URL.Query().Get("path")
		if p == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, filepath.Base(p), time.Time{}, f)
	})
}

// notifyExistingInstance 尝试通知已在运行的实例（打开文件或唤出窗口），
// 成功返回 true（当前实例应立即退出）
func notifyExistingInstance(path string) bool {
	action := "/show"
	if path != "" {
		action = "/open?path=" + url.QueryEscape(path)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + singleInstanceAddr + action)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// runTray 系统托盘：显示主窗口 / 完全退出
func runTray(ctx context.Context) {
	systray.Run(func() {
		systray.SetIcon(trayIconBytes)
		systray.SetTooltip("Typora Lite")
		systray.SetTitle("Typora Lite")
		mShow := systray.AddMenuItem("显示主窗口", "显示编辑器窗口")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("退出 Typora Lite", "完全退出软件")
		mShow.Click(func() {
			if ctx != nil {
				forceQuit = false
				wailsruntime.WindowShow(ctx)
			}
		})
		mQuit.Click(func() {
			forceQuit = true
			if ctx != nil {
				wailsruntime.Quit(ctx)
			} else {
				os.Exit(0)
			}
		})
	}, nil)
}

// Viewer 图片查看器窗口的绑定
type Viewer struct {
	ctx  context.Context
	path string
}

func (v *Viewer) startup(ctx context.Context) { v.ctx = ctx }

// ImagePath 返回要查看的图片绝对路径
func (v *Viewer) ImagePath() string { return v.path }

// runImageViewer 以独立窗口模式运行图片查看器
func runImageViewer(path string) {
	v := &Viewer{path: path}
	err := wails.Run(&options.App{
		Title:  "图片查看 - " + filepath.Base(path),
		Width:  960,
		Height: 720,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Handler:    localFileHandler(),
			Middleware: viewerAssetMiddleware,
		},
		OnStartup: v.startup,
		Bind: []interface{}{
			v,
		},
		Windows: &windows.Options{
			Theme: windows.Light,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// viewerAssetMiddleware 把查看器进程的根路径请求重写到 viewer.html
func viewerAssetMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if viewerMode && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			r.URL.Path = "/viewer.html"
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// 查看器模式：TyporaLite.exe --image-viewer <图片路径>
	args := os.Args[1:]
	if len(args) >= 2 && args[0] == "--image-viewer" {
		viewerMode = true
		runImageViewer(args[1])
		return
	}

	// 位置参数：要打开的 .md 文件路径（文件关联 / 拖到 exe 上）
	openPath := ""
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			continue
		}
		openPath = a
	}

	// 单实例：尝试占用通信端口；被占用说明已有实例运行
	ln, err := net.Listen("tcp", singleInstanceAddr)
	if err != nil {
		if openPath == "" {
			// 无文件参数（直接双击 exe）→ 唤出已有窗口即可，不询问
			if notifyExistingInstance("") {
				return
			}
			ln = nil // 通知失败 → 降级为新窗口启动
		} else {
			// 带文件 → 按设置决定：当前窗口 / 新窗口 / 询问
			action := decideOpenAction(openPath)
			switch action {
			case "current":
				if notifyExistingInstance(openPath) {
					return // 已交给现有窗口处理
				}
				// 通知失败（端口被非本应用占用等）→ 降级为新窗口继续启动
			case "new":
				// 新窗口多实例启动
			default:
				return // 用户取消
			}
			ln = nil
		}
	}

	app := NewApp()
	app.startupPath = openPath
	app.ln = ln

	err = wails.Run(&options.App{
		Title:  "Typora Lite",
		Width:  1080,
		Height: 760,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true, // 文件拖放统一由 wails 事件处理，避免 webview 直接打开
		},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Handler:    localFileHandler(),
			Middleware: viewerAssetMiddleware,
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			Theme:                windows.Light,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
	if ln != nil {
		ln.Close()
	}
}
