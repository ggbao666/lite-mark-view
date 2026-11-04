package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DraftInfo 草稿文件信息
type DraftInfo struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	ModTime string `json:"modTime"`
	Size    int64  `json:"size"`
}

// draftsDir 草稿目录：优先 exe 所在目录下的 drafts（软件目录临时区），
// exe 目录不可写/获取失败时回退到用户配置目录
func draftsDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "drafts")
	}
	if cfg, err := os.UserConfigDir(); err == nil {
		return filepath.Join(cfg, "TyporaLite", "drafts")
	}
	return "drafts"
}

// isInsideDraftDir 校验 path 是否位于草稿目录内（防止误读写删除正式文件）
func isInsideDraftDir(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	dirAbs, err := filepath.Abs(draftsDir())
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(dirAbs, abs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// AutoSaveDraft 自动保存草稿：path 为空时新建时间命名的草稿文件，
// 否则覆写指定草稿（仅允许草稿目录内路径）。返回草稿绝对路径。
func (a *App) AutoSaveDraft(path string, content string) (string, error) {
	dir := draftsDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	if path != "" && isInsideDraftDir(path) {
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return "", err
		}
		return path, nil
	}
	name := fmt.Sprintf("draft-%s.md", time.Now().Format("20060102-150405"))
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, []byte(content), 0644); err != nil {
		return "", err
	}
	return abs, nil
}

// ListDrafts 列出草稿目录下的 .md 草稿，按修改时间倒序
func (a *App) ListDrafts() ([]DraftInfo, error) {
	dir := draftsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []DraftInfo{}, nil // 目录不存在 → 无草稿
	}
	list := []DraftInfo{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, DraftInfo{
			Path:    filepath.Join(dir, e.Name()),
			Name:    strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())),
			ModTime: info.ModTime().Format("2006-01-02 15:04"),
			Size:    info.Size(),
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ModTime > list[j].ModTime })
	return list, nil
}

// ReadDraft 读取草稿内容
func (a *App) ReadDraft(path string) (string, error) {
	if !isInsideDraftDir(path) {
		return "", fmt.Errorf("非法草稿路径")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// DeleteDraft 删除草稿（正式保存成功后由前端调用）
func (a *App) DeleteDraft(path string) error {
	if !isInsideDraftDir(path) {
		return fmt.Errorf("非法草稿路径")
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
