//go:build windows

package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed build/windows/icon.ico
var trayIconBytes []byte // Windows 托盘要求 .ico 格式

// RegisterMdAssociation 把 LiteMark View 加入 .md 文件的“打开方式”列表。
// 全部写 HKCU（免管理员），注册后通知资源管理器刷新关联缓存。
func (a *App) RegisterMdAssociation() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe = filepath.Clean(exe)

	const progID = "LiteMarkView.md"
	cmd := fmt.Sprintf(`"%s" "%%1"`, exe)

	// 1) ProgID：打开命令 + 图标 + 友好名称
	steps := []struct {
		path  string
		name  string
		value string
	}{
		{`Software\Classes\` + progID, "", "LiteMark View Markdown"},
		{`Software\Classes\` + progID, "FriendlyTypeName", "LiteMark View Markdown"},
		{`Software\Classes\` + progID + `\DefaultIcon`, "", fmt.Sprintf(`"%s",0`, exe)},
		{`Software\Classes\` + progID + `\shell\open\command`, "", cmd},
		// 2) 应用注册：让“打开方式 / 选择其他应用”列表能稳定展示
		{`Software\Classes\Applications\LiteMarkView.exe`, "FriendlyAppName", "LiteMark View"},
		{`Software\Classes\Applications\LiteMarkView.exe\DefaultIcon`, "", fmt.Sprintf(`"%s",0`, exe)},
		{`Software\Classes\Applications\LiteMarkView.exe\shell\open\command`, "", cmd},
		{`Software\Classes\Applications\LiteMarkView.exe\SupportedTypes`, ".md", ""},
		{`Software\Classes\Applications\LiteMarkView.exe\SupportedTypes`, ".markdown", ""},
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

	// 4) 清理旧名字遗留的注册表项，避免「打开方式」里出现两个入口
	cleanupLegacyAssociation()

	// 5) 通知资源管理器立即刷新文件关联（否则要重启 explorer 才生效）
	notifyAssocChanged()

	return "已注册成功。请右键 .md 文件 → 打开方式 → 选择其他应用，即可看到 LiteMark View。\n\n" +
		"注意：若以后移动了本程序位置，需要重新点此注册。", nil
}

// cleanupLegacyAssociation 删除改名前的 ProgID / Applications 注册表项。
// registry.DeleteKey 只能删空键，所以按「从内到外」的顺序列出；不存在时直接忽略。
func cleanupLegacyAssociation() {
	for _, p := range []string{
		`Software\Classes\Applications\TyporaLite.exe\shell\open\command`,
		`Software\Classes\Applications\TyporaLite.exe\shell\open`,
		`Software\Classes\Applications\TyporaLite.exe\shell`,
		`Software\Classes\Applications\TyporaLite.exe\DefaultIcon`,
		`Software\Classes\Applications\TyporaLite.exe\SupportedTypes`,
		`Software\Classes\Applications\TyporaLite.exe`,
		`Software\Classes\TyporaLite.md\shell\open\command`,
		`Software\Classes\TyporaLite.md\shell\open`,
		`Software\Classes\TyporaLite.md\shell`,
		`Software\Classes\TyporaLite.md\DefaultIcon`,
		`Software\Classes\TyporaLite.md`,
	} {
		_ = registry.DeleteKey(registry.CURRENT_USER, p)
	}
	for _, ext := range []string{".md", ".markdown"} {
		k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+ext+`\OpenWithProgids`, registry.SET_VALUE)
		if err != nil {
			continue
		}
		_ = k.DeleteValue("TyporaLite.md")
		k.Close()
	}
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

// RevealInExplorer 在资源管理器中定位文件（图片、文档等）
func (a *App) RevealInExplorer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("文件不存在: %w", err)
	}
	return exec.Command("explorer", "/select,"+abs).Start()
}
