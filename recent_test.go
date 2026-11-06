package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testDay(base time.Time, daysAgo int) string {
	return base.AddDate(0, 0, -daysAgo).Format(dayLayout)
}

// testTs 返回 daysAgo 天前当天 10:30 的时间戳，保证 dayKey(testTs(n)) == testDay(n)
func testTs(base time.Time, daysAgo int) int64 {
	d := base.AddDate(0, 0, -daysAgo)
	return time.Date(d.Year(), d.Month(), d.Day(), 10, 30, 0, 0, time.Local).UnixMilli()
}

func testFiles(t *testing.T, n int) []string {
	t.Helper()
	dir := t.TempDir()
	out := make([]string, n)
	for i := range out {
		p := filepath.Join(dir, fmt.Sprintf("doc%02d.md", i))
		if err := os.WriteFile(p, []byte("# test"), 0644); err != nil {
			t.Fatal(err)
		}
		out[i] = p
	}
	return out
}

// 超过 7 个「有记录的日子」时，只保留最近 7 个；
// 只在被裁掉的日子里出现过的文件要从列表移除。
func TestSevenRecordedDaysWindow(t *testing.T) {
	base := time.Now()
	paths := testFiles(t, 2)

	// 全局有记录日 = 0..8 共 9 天；有效日应为 0..6
	fresh := make([]DayOpenCount, 0, 7)
	for i := 0; i <= 6; i++ {
		fresh = append(fresh, DayOpenCount{Date: testDay(base, i), Count: 1})
	}
	list := []RecentFile{
		{
			Path:     paths[0],
			OpenedAt: testTs(base, 8),
			Daily: []DayOpenCount{
				{Date: testDay(base, 8), Count: 5},
				{Date: testDay(base, 7), Count: 5},
			},
		},
		{Path: paths[1], OpenedAt: testTs(base, 0), Daily: fresh},
	}

	got := sanitizeRecentList(list)
	if len(got) != 1 {
		t.Fatalf("只应保留 1 个文件，实际 %d", len(got))
	}
	if got[0].Path != paths[1] {
		t.Fatalf("保留的应是新文件，实际 %s", got[0].Path)
	}
	if got[0].OpenCount != 7 {
		t.Fatalf("有效天内 7 天各 1 次，累计应为 7，实际 %d", got[0].OpenCount)
	}
	if len(got[0].Daily) != 7 {
		t.Fatalf("应保留 7 条分天记录，实际 %d", len(got[0].Daily))
	}
}

// 次数必须由「有效天」的 daily 加总而来，且同一天的重复项要合并；
// 结构体里残留的旧 openCount 字段不能覆盖统计结果。
func TestOpenCountIsSumOfDaily(t *testing.T) {
	base := time.Now()
	paths := testFiles(t, 1)
	list := []RecentFile{{
		Path:      paths[0],
		OpenedAt:  testTs(base, 0),
		OpenCount: 999, // 旧字段故意塞错值，应被 daily 重算覆盖
		Daily: []DayOpenCount{
			{Date: testDay(base, 0), Count: 2},
			{Date: testDay(base, 0), Count: 3}, // 同一天重复 → 合并成 5
			{Date: testDay(base, 1), Count: 4},
			{Date: testDay(base, 2), Count: 0}, // 无效次数应丢弃
		},
	}}
	got := sanitizeRecentList(list)
	if len(got) != 1 {
		t.Fatalf("应保留 1 个文件，实际 %d", len(got))
	}
	if got[0].OpenCount != 9 {
		t.Fatalf("2+3+4 应为 9，实际 %d", got[0].OpenCount)
	}
	if len(got[0].Daily) != 2 || got[0].Daily[0].Count != 5 || got[0].Daily[1].Count != 4 {
		t.Fatalf("分天记录合并/排序不正确：%+v", got[0].Daily)
	}
}

// 旧版本记录（只有 openCount、没有 daily）自动补成一条按天记录
func TestLegacyRecordMigration(t *testing.T) {
	base := time.Now()
	paths := testFiles(t, 2)
	list := []RecentFile{
		{Path: paths[0], OpenedAt: testTs(base, 2), OpenCount: 4},
		{Path: paths[1], OpenedAt: 0}, // 连时间都没有的旧记录
	}
	got := sanitizeRecentList(list)
	if len(got) != 2 {
		t.Fatalf("应保留 2 个文件，实际 %d", len(got))
	}
	for _, f := range got {
		if len(f.Daily) != 1 {
			t.Fatalf("%s 应补出 1 条分天记录，实际 %+v", f.Path, f.Daily)
		}
	}
	// paths[0] 的次数应继承 4
	for _, f := range got {
		if f.Path == paths[0] && (f.OpenCount != 4 || f.Daily[0].Count != 4) {
			t.Fatalf("旧次数未被继承：%+v", f)
		}
	}
}

// 有效日不足 7 个时不做裁剪，跨度再大也全部保留
func TestFewerThanSevenDaysKeepsAll(t *testing.T) {
	base := time.Now()
	paths := testFiles(t, 1)
	list := []RecentFile{{
		Path:     paths[0],
		OpenedAt: testTs(base, 0),
		Daily: []DayOpenCount{
			{Date: testDay(base, 0), Count: 1},
			{Date: testDay(base, 40), Count: 2}, // 40 天前，但只有 3 个记录日
			{Date: testDay(base, 100), Count: 3},
		},
	}}
	got := sanitizeRecentList(list)
	if len(got) != 1 || got[0].OpenCount != 6 {
		t.Fatalf("3 个记录日应全部保留且累计 6 次，实际 %+v", got)
	}
}

// 文件数仍受 30 条上限约束，且按最近打开时间倒序
func TestMaxRecentFiles(t *testing.T) {
	base := time.Now()
	paths := testFiles(t, 35)
	list := make([]RecentFile, 0, 35)
	for i, p := range paths {
		list = append(list, RecentFile{
			Path:     p,
			OpenedAt: testTs(base, 0) - int64(i)*1000,
			Daily:    []DayOpenCount{{Date: testDay(base, 0), Count: 1}},
		})
	}
	got := sanitizeRecentList(list)
	if len(got) != maxRecentFiles {
		t.Fatalf("应裁剪到 %d 条，实际 %d", maxRecentFiles, len(got))
	}
	if got[0].Path != paths[0] {
		t.Fatalf("第一条应是最近打开的文件，实际 %s", got[0].Path)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].OpenedAt < got[i].OpenedAt {
			t.Fatalf("未按打开时间倒序：%d", i)
		}
	}
}
