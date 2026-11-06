package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 最近打开文件记录：存于用户配置目录。
//   - 最多保留 maxRecentFiles 个文件
//   - 打开记录按自然日「分天」存；全局只保留最近 maxRecentDays 个「有打开记录的日子」，
//     更早的日子连同其中的次数一起过期
const (
	maxRecentFiles = 30
	maxRecentDays  = 7
)

const dayLayout = "2006-01-02"

// DayOpenCount 某个文件在某一天被打开的次数
type DayOpenCount struct {
	Date  string `json:"date"` // 本地日期，格式 2006-01-02
	Count int    `json:"count"`
}

// RecentFile 一条最近打开记录。
// Daily 是分天的打开明细；OpenCount 不单独累计，加载 / 保存时都由「有效天」的 Daily 加总得到，
// 这样过期的天数会自然把旧次数带出统计，不会让很久以前的高频文件一直排在「打开最多」前面。
type RecentFile struct {
	Path      string         `json:"path"`
	OpenedAt  int64          `json:"openedAt"`
	OpenCount int            `json:"openCount"`
	Daily     []DayOpenCount `json:"daily"`
}

type recentStore struct {
	Files []RecentFile `json:"files"`
}

// legacyRecentStore 兼容 v0.23 及更早版本的 {"files":["a.md","b.md"]}
type legacyRecentStore struct {
	Files []string `json:"files"`
}

func recentConfigPath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg, "LiteMarkView", "recent.json"), nil
}

// dayKey 把 Unix 毫秒时间戳换算成本地自然日；0（旧数据无时间）按今天处理
func dayKey(ts int64) string {
	if ts <= 0 {
		return time.Now().Format(dayLayout)
	}
	return time.UnixMilli(ts).Local().Format(dayLayout)
}

func dayNoon(date string) int64 {
	t, err := time.ParseInLocation(dayLayout, date, time.Local)
	if err != nil {
		return 0
	}
	return t.Add(12 * time.Hour).UnixMilli()
}

// mergeDaily 合并同一天的重复项，丢掉无效次数，并按日期倒序（新的在前）
func mergeDaily(in []DayOpenCount) []DayOpenCount {
	byDay := make(map[string]int, len(in))
	for _, d := range in {
		if d.Date == "" || d.Count <= 0 {
			continue
		}
		byDay[d.Date] += d.Count
	}
	out := make([]DayOpenCount, 0, len(byDay))
	for date, n := range byDay {
		out = append(out, DayOpenCount{Date: date, Count: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date > out[j].Date })
	return out
}

// normalizeDaily 兼容旧数据：只有累计 openCount 而没有 daily 时，按最近打开时间所在日补一条
func normalizeDaily(f RecentFile) []DayOpenCount {
	if len(f.Daily) > 0 {
		return mergeDaily(f.Daily)
	}
	n := f.OpenCount
	if n < 1 {
		n = 1
	}
	return []DayOpenCount{{Date: dayKey(f.OpenedAt), Count: n}}
}

// effectiveDays 汇总所有文件里出现过的自然日，取最近 maxRecentDays 个「有记录的日子」。
// 注意这里是按「有记录的日子」计数，不是日历上今天往前 7×24 小时的滚动窗口。
func effectiveDays(list []RecentFile) map[string]bool {
	seen := make(map[string]bool)
	for _, f := range list {
		for _, d := range f.Daily {
			seen[d.Date] = true
		}
	}
	days := make([]string, 0, len(seen))
	for d := range seen {
		days = append(days, d)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(days)))
	if len(days) > maxRecentDays {
		days = days[:maxRecentDays]
	}
	set := make(map[string]bool, len(days))
	for _, d := range days {
		set[d] = true
	}
	return set
}

// sanitizeRecentList 去重、迁移旧数据、按最近 7 个有记录的自然日裁剪分天记录、
// 从有效天里重新统计打开次数，最后按最近打开时间倒序并裁剪到 30 条
func sanitizeRecentList(list []RecentFile) []RecentFile {
	// 1) 去重、过滤已删除 / 移走的文件，并把旧格式补成 daily
	base := make([]RecentFile, 0, len(list))
	seen := make(map[string]bool, len(list))
	for _, f := range list {
		key := strings.ToLower(f.Path)
		if f.Path == "" || seen[key] {
			continue
		}
		if _, err := os.Stat(f.Path); err != nil {
			continue
		}
		seen[key] = true
		f.Daily = normalizeDaily(f)
		if len(f.Daily) == 0 {
			continue
		}
		base = append(base, f)
	}
	if len(base) == 0 {
		return base
	}

	// 2) 全局有效日
	days := effectiveDays(base)

	// 3) 每个文件只保留有效天；7 个记录日里一次都没打开过的文件移出列表
	out := make([]RecentFile, 0, len(base))
	for _, f := range base {
		daily := make([]DayOpenCount, 0, len(f.Daily))
		total := 0
		for _, d := range f.Daily {
			if !days[d.Date] {
				continue
			}
			daily = append(daily, d)
			total += d.Count
		}
		if total < 1 {
			continue
		}
		f.Daily = daily // 继承倒序
		f.OpenCount = total
		// openedAt 对应的日子已过期时，回退到该文件最近一个有效日的中午，
		// 避免时间 tab 里出现一个早于所有有效日的「幽灵时间」
		if !days[dayKey(f.OpenedAt)] {
			if t := dayNoon(f.Daily[0].Date); t > 0 {
				f.OpenedAt = t
			}
		}
		out = append(out, f)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].OpenedAt > out[j].OpenedAt })
	if len(out) > maxRecentFiles {
		out = out[:maxRecentFiles]
	}
	return out
}

// loadRecentList 读取最近打开列表。旧格式会自动迁移：用文件修改时间近似打开时间
func loadRecentList() []RecentFile {
	path, err := recentConfigPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var store recentStore
	if err := json.Unmarshal(data, &store); err == nil && len(store.Files) > 0 {
		return sanitizeRecentList(store.Files)
	}
	var legacy legacyRecentStore
	if err := json.Unmarshal(data, &legacy); err == nil {
		list := make([]RecentFile, 0, len(legacy.Files))
		for _, p := range legacy.Files {
			var ts int64
			if st, statErr := os.Stat(p); statErr == nil {
				ts = st.ModTime().UnixMilli()
			}
			list = append(list, RecentFile{Path: p, OpenedAt: ts, OpenCount: 1})
		}
		return sanitizeRecentList(list)
	}
	return nil
}

// GetRecentFiles 返回最近打开的文件（按打开时间倒序，最多 30 条）
func (a *App) GetRecentFiles() []RecentFile {
	return loadRecentList()
}

// ClearRecentFiles 清空最近打开记录
func (a *App) ClearRecentFiles() {
	cfgPath, err := recentConfigPath()
	if err != nil {
		return
	}
	_ = os.WriteFile(cfgPath, []byte("{\"files\":[]}"), 0644)
}

// addRecentFile 记录一次打开：当天次数 +1，同一文件提到最前，
// 再统一裁剪有效日、重算次数并写回
func addRecentFile(path string) {
	if path == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	cfgPath, err := recentConfigPath()
	if err != nil {
		return
	}
	cur := loadRecentList()
	now := time.Now()
	today := now.Format(dayLayout)

	// 继承该文件已有的分天记录，并把今天的次数 +1
	var daily []DayOpenCount
	for _, f := range cur {
		if strings.EqualFold(f.Path, abs) {
			daily = append(daily, f.Daily...)
			break
		}
	}
	found := false
	for i := range daily {
		if daily[i].Date == today {
			daily[i].Count++
			found = true
			break
		}
	}
	if !found {
		daily = append(daily, DayOpenCount{Date: today, Count: 1})
	}

	list := []RecentFile{{Path: abs, OpenedAt: now.UnixMilli(), Daily: mergeDaily(daily)}}
	for _, f := range cur {
		if strings.EqualFold(f.Path, abs) {
			continue
		}
		list = append(list, f)
	}
	list = sanitizeRecentList(list)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0755); err != nil {
		return
	}
	data, err := json.MarshalIndent(recentStore{Files: list}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(cfgPath, data, 0644)
}
