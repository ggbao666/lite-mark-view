package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// 最近打开文件记录：存于用户配置目录，最多保留 maxRecentFiles 条
const maxRecentFiles = 10

type recentStore struct {
	Files []string `json:"files"`
}

func recentConfigPath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "TyporaLite", "recent.json"), nil
}

// loadRecentList 读取最近打开列表，并过滤掉已被移动/删除的文件
func loadRecentList() []string {
	path, err := recentConfigPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var store recentStore
	if err := json.Unmarshal(data, &store); err != nil {
		return nil
	}
	list := make([]string, 0, len(store.Files))
	for _, f := range store.Files {
		if f == "" {
			continue
		}
		if _, err := os.Stat(f); err == nil {
			list = append(list, f)
		}
	}
	return list
}

// GetRecentFiles 返回最近打开的文件（最近的在前）
func (a *App) GetRecentFiles() []string {
	return loadRecentList()
}

// addRecentFile 记录一次打开：已存在则提到最前，超出上限丢弃最旧
func addRecentFile(path string) {
	if path == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	cur := loadRecentList()
	if len(cur) > 0 && strings.EqualFold(cur[0], abs) {
		return // 已在首位，无需重写
	}
	list := []string{abs}
	for _, f := range cur {
		if strings.EqualFold(f, abs) {
			continue
		}
		if len(list) >= maxRecentFiles {
			break
		}
		list = append(list, f)
	}
	cfgPath, err := recentConfigPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		return
	}
	data, err := json.MarshalIndent(recentStore{Files: list}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(cfgPath, data, 0644)
}
