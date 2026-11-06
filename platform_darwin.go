//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// RegisterMdAssociation macOS 没有注册表：文件关联由 Info.plist 与 Finder 管理，
// 这里给出等价的手动设置说明，避免设置面板在 macOS 上报「不支持」错误。
func (a *App) RegisterMdAssociation() (string, error) {
	return "macOS 不需要注册表。请在 Finder 中右键任意 .md 文件 → 打开方式 → 选择 LiteMark View；" +
		"若列表里没有，选「其他…」再定位到「应用程序」中的 LiteMark View。\n\n" +
		"想设为默认，可在同一个面板点「更改全部…」。", nil
}

// RevealInExplorer 在 Finder 中显示并选中文件（对应 Windows 的 explorer /select）
func (a *App) RevealInExplorer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("文件不存在: %w", err)
	}
	return exec.Command("open", "-R", abs).Start()
}

// nextWindowCascade macOS 版仅本地自行构建，窗口位置交给系统管理（不做级联）
func nextWindowCascade(fromX, fromY int, hasFrom bool) (int, int, bool) {
	return 0, 0, false
}
