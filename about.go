package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// wails.json 在编译期嵌入，让「关于」里的版本号与发版配置保持同一数据源
//
//go:embed wails.json
var wailsConfig []byte

const repoURL = "https://github.com/ggbao666/lite-mark-view"

// AppInfo 「关于」弹窗展示的产品信息
type AppInfo struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	Repository string `json:"repository"`
	Tech       string `json:"tech"`
}

func loadAppInfo() AppInfo {
	info := AppInfo{
		Name:       "LiteMark View",
		Version:    "dev",
		Repository: repoURL,
		Tech:       "Go + Wails + Tiptap / CodeMirror",
	}
	var cfg struct {
		Info struct {
			ProductName    string `json:"productName"`
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(wailsConfig, &cfg); err == nil {
		if cfg.Info.ProductName != "" {
			info.Name = cfg.Info.ProductName
		}
		if cfg.Info.ProductVersion != "" {
			info.Version = cfg.Info.ProductVersion
		}
	}
	return info
}

// GetAppInfo 返回「关于」弹窗所需的产品信息
func (a *App) GetAppInfo() AppInfo {
	return loadAppInfo()
}

// OpenExternalLink 在系统默认浏览器打开链接；只允许本项目仓库地址及其子页面
func (a *App) OpenExternalLink(link string) error {
	if link != repoURL && !strings.HasPrefix(link, repoURL+"/") {
		return fmt.Errorf("不允许打开此链接: %s", link)
	}
	runtime.BrowserOpenURL(a.ctx, link)
	return nil
}
