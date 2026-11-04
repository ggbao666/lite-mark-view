package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Settings 应用设置（持久化到用户配置目录）
type Settings struct {
	// AssetMode 图片资源存储模式：
	//   "relative" - 存当前文件所在目录下的 AssetsFolder（默认）
	//   "custom"   - 存 CustomDir 指定目录
	AssetMode string `json:"assetMode"`
	// AssetsFolder 相对模式下的资源目录名
	AssetsFolder string `json:"assetsFolder"`
	// CustomDir 自定义存储目录
	CustomDir string `json:"customDir"`
	// CloseAction 点击窗口关闭按钮的行为：
	//   "ask"        - 每次询问（默认）
	//   "exit"       - 直接退出
	//   "background" - 隐藏到系统托盘
	CloseAction string `json:"closeAction"`
	// OpenAction 已有实例运行时再次打开 .md 文件的行为：
	//   "ask"     - 每次询问（默认）
	//   "current" - 在当前窗口打开
	//   "new"     - 在新窗口打开（多实例）
	OpenAction string `json:"openAction"`
	// Theme 界面主题："dark"（默认）| "light"
	Theme string `json:"theme"`
}

func DefaultSettings() Settings {
	return Settings{
		AssetMode:    "relative",
		AssetsFolder: "assets",
		CustomDir:    "",
		CloseAction:  "ask",
		OpenAction:   "ask",
		Theme:        "dark",
	}
}

func configFilePath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "TyporaLite", "settings.json"), nil
}

// loadSettings 从磁盘读取设置；不存在或损坏时返回默认值
func loadSettings() Settings {
	s := DefaultSettings()
	path, err := configFilePath()
	if err != nil {
		return s
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	_ = json.Unmarshal(data, &s)
	if s.AssetsFolder == "" {
		s.AssetsFolder = "assets"
	}
	if s.AssetMode != "custom" && s.AssetMode != "relative" {
		s.AssetMode = "relative"
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
	return s
}

// saveSettingsToDisk 写入设置
func saveSettingsToDisk(s Settings) error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// DefaultAssetsDir 未保存文件在 relative 模式下的兜底存储目录
func DefaultAssetsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "assets"
	}
	return filepath.Join(home, "Documents", "TyporaLite", "assets")
}
