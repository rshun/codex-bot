// Package schedule turns Codex's reading of a scheduling request into run times.
package schedule

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	atLayout      = "2006-01-02 15:04"
	clockLayout   = "15:04"
	isoDateLayout = "2006-01-02"
	compactLayout = "20060102"
)

// Spec is when a task runs.
type Spec struct {
	// Kind is once, daily, weekly, monthly, interval, dates or cron.
	Kind string `json:"kind"`
	// At is the local date and time of a once task.
	At string `json:"at,omitempty"`
	// Time is the local HH:MM of a daily, weekly, monthly or dates task.
	Time string `json:"time,omitempty"`
	// Times holds multiple local HH:MM values when a daily, weekly, monthly or dates task runs multiple times per day.
	Times []string `json:"times,omitempty"`
	// Weekdays uses 0 for Sunday through 6 for Saturday.
	Weekdays []int `json:"weekdays,omitempty"`
	// MonthDays uses 1..31, or -1 for the last day of each month.
	MonthDays    []int  `json:"month_days,omitempty"`
	EveryMinutes int    `json:"every_minutes,omitempty"`
	DateFile     string `json:"date_file,omitempty"`
	// Cron holds a standard 5-field cron expression ("min hour dom month dow") when Kind == "cron".
	Cron string `json:"cron,omitempty"`
}

// Parsed is Codex's structured answer to a scheduling request.
type Parsed struct {
	Spec
	// Action is create (default), skip, pause, resume or delete.
	Action  string `json:"action,omitempty"`
	TaskID  int64  `json:"task_id,omitempty"`
	Prompt  string `json:"prompt"`
	Summary string `json:"summary"`
	Error   string `json:"error,omitempty"`
}

// ExistingTask describes a task already scheduled in the chat so Codex can
// match natural-language skip, pause, resume or delete requests without an ID.
type ExistingTask struct {
	ID      int64
	Summary string
	Prompt  string
	NextRun time.Time
	Paused  bool
}

// Schema is passed to codex with --output-schema (OpenAI strict JSON Schema compatible).
const Schema = `{"type":"object","additionalProperties":false,` +
	`"required":["action","task_id","kind","at","time","times","weekdays","month_days","every_minutes","date_file","cron","prompt","summary","error"],` +
	`"properties":{` +
	`"action":{"type":"string","enum":["create","skip","pause","resume","delete","run","update","none"]},` +
	`"task_id":{"type":"integer","description":"ID of the existing task when action is skip, pause, resume, delete, run or update; 0 otherwise"},` +
	`"kind":{"type":"string","enum":["","once","daily","weekly","monthly","interval","dates","cron"]},` +
	`"at":{"type":"string","description":"once: local time YYYY-MM-DD HH:MM; empty string otherwise"},` +
	`"time":{"type":"string","description":"daily, weekly, monthly or dates: primary local HH:MM; empty string otherwise"},` +
	`"times":{"type":"array","items":{"type":"string"},"description":"daily, weekly, monthly or dates with multiple times per day: list of local HH:MM strings in chronological order (e.g. [\"06:01\",\"11:02\",\"16:03\"]); empty array if only one time"},` +
	`"weekdays":{"type":"array","items":{"type":"integer"},"description":"weekly: days of week 0 (Sunday) through 6 (Saturday); empty array otherwise"},` +
	`"month_days":{"type":"array","items":{"type":"integer"},"description":"monthly: days of month 1..31, or -1 for last day of month; empty array otherwise"},` +
	`"every_minutes":{"type":"integer","description":"interval: repeat interval in minutes (>= 1); 0 otherwise"},` +
	`"date_file":{"type":"string","description":"dates: absolute path to a file of YYYY-MM-DD or YYYYMMDD dates; empty string otherwise"},` +
	`"cron":{"type":"string","description":"cron: standard 5-field cron expression (min hour dom month dow); empty string otherwise"},` +
	`"prompt":{"type":"string","description":"instruction to execute when the task runs; empty string if not applicable"},` +
	`"summary":{"type":"string","description":"short Chinese summary of the schedule and task; empty string if not applicable"},` +
	`"error":{"type":"string","description":"short Chinese error message if the schedule is invalid or missing; empty string otherwise"}}}`

// Prompt asks Codex to read text as a schedule or task management request relative to now.
func Prompt(text string, now time.Time, loc *time.Location, tasks ...ExistingTask) string {
	local := now.In(loc)
	var taskBlock strings.Builder
	if len(tasks) > 0 {
		taskBlock.WriteString("\nExisting tasks in this chat:\n")
		for _, t := range tasks {
			status := "active, next " + t.NextRun.In(loc).Format(atLayout)
			if t.Paused {
				status = "paused"
			}
			fmt.Fprintf(&taskBlock, "- #%d: %s (prompt: %s; %s)\n", t.ID, t.Summary, t.Prompt, status)
		}
	}
	return fmt.Sprintf(`Current local time: %s %s (%s, %s).%s
Turn the scheduling request below into JSON (fill unused string fields with "", unused array fields with [], and unused integer fields with 0).
- To create a new scheduled task, set "action" to "create":
  - kind "once": set "at" to the local time as YYYY-MM-DD HH:MM.
  - kind "daily": set "time" to HH:MM. If multiple specific times of day are requested (e.g. "每天早上6点1分，11点2分，16点3分"), set "times" to ["06:01","11:02","16:03"] and "time" to the first time "06:01" (do NOT use kind "cron" when different hours have different minutes).
  - kind "weekly": set "time" to HH:MM (or "times" if multiple times per day) and "weekdays" (0 = Sunday ... 6 = Saturday; e.g. weekdays [1,2,3,4,5] for workdays/weekdays).
  - kind "monthly": set "time" to HH:MM (or "times" if multiple times per day) and "month_days" (1..31, or -1 for the last day of each month; e.g. "每月1号和15号早上9点" -> [1,15], "每月最后一天18:00" -> [-1]).
  - kind "interval": set "every_minutes".
  - kind "dates": when the request says to run according to dates in a file, set "date_file" to the file path and "time" to HH:MM (or "times" if multiple times per day; default "09:00" if no time of day is specified).
  - kind "cron": when the user provides a 5-field cron expression or a recurring schedule where all hours share the same minute pattern (e.g. "每小时整点", "工作日9点到15点每小时"), set "cron" to a standard 5-field cron expression "min hour dom month dow".
  - "prompt": what Codex should do each time the task runs, as an instruction in the user's language, without the schedule.
  - "summary": one short Chinese line such as "每天 09:00：总结科技新闻" or "每天 06:01/11:02/16:03：发送测试消息".
- To manage an existing task in natural language:
  - "action" = "run": immediately run/test an existing task once right now without changing its schedule (e.g. "现在试跑一下定时任务", "请试运行一下任务2", "运行一下#2", "马上执行一次任务1", "跑一下抽单词那个任务").
  - "action" = "update": change an existing task's schedule/time (e.g. "把定时任务改到每天 10:00", "把任务2改成每个工作日 09:30"); fill the new schedule fields ("kind", "at"/"time"/"times"/"weekdays"/"every_minutes"/"date_file") and set "summary" to reflect the new schedule ("prompt" may be "" if unchanged).
  - "action" = "skip": cancel/skip only the next run (e.g. "取消明天的定时任务", "明天不用执行了", "跳过下次"), keeping future runs.
  - "action" = "pause": pause an active task until resumed (e.g. "暂停定时任务", "先停一下任务2").
  - "action" = "resume": resume a paused task (e.g. "恢复定时任务", "恢复任务2").
  - "action" = "delete": permanently cancel/remove a task (e.g. "删除定时任务", "删掉任务2", "取消#2").
  - Set "task_id" to the matching task's ID from the existing tasks list ("任务2" / "#2" -> task_id 2; if there is only one existing task and no ID is given, use its ID; if multiple tasks exist and the target is ambiguous, set "error" to "请说明要操作哪个定时任务").
- If the message is an ordinary chat question or conversation rather than creating/running/modifying/deleting a scheduled task, set "action" to "none".
- If the user clearly intends to create or update a scheduled task but gives an invalid or missing time, set "error" to "<short reason in Chinese>".

Request: %s`, local.Format(atLayout), local.Weekday(), local.Format("MST"), loc.String(), taskBlock.String(), text)
}

// Decode reads the structured output, falling back to JSON in the reply text.
func Decode(structured json.RawMessage, text string) (Parsed, error) {
	raw := []byte(strings.TrimSpace(string(structured)))
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte(stripFence(text))
	}
	var p Parsed
	if err := json.Unmarshal(raw, &p); err != nil {
		return Parsed{}, fmt.Errorf("decode schedule: %w", err)
	}
	p.DateFile = strings.TrimSpace(p.DateFile)
	p.Cron = strings.TrimSpace(p.Cron)
	p.normalizeTimes()
	if p.DateFile != "" {
		p.Kind = "dates"
	} else if p.Cron != "" && p.Kind == "" {
		p.Kind = "cron"
	}
	if p.Kind == "dates" && strings.TrimSpace(p.Time) == "" && len(p.Times) == 0 {
		p.Time = "09:00"
	}
	return p, nil
}

func (s *Spec) normalizeTimes() {
	var raw []string
	if len(s.Times) > 0 {
		raw = append(raw, s.Times...)
	}
	if strings.TrimSpace(s.Time) != "" {
		parts := strings.FieldsFunc(s.Time, func(r rune) bool {
			return r == ',' || r == '，' || r == '、' || r == ';' || r == '；'
		})
		if len(parts) > 1 {
			raw = append(raw, parts...)
		} else if len(raw) == 0 {
			s.Time = strings.TrimSpace(s.Time)
			return
		} else {
			raw = append([]string{s.Time}, raw...)
		}
	}
	seen := make(map[string]bool, len(raw))
	var cleaned []string
	for _, item := range raw {
		t := strings.TrimSpace(item)
		if t == "" {
			continue
		}
		if hr, min, err := clock(t); err == nil {
			t = fmt.Sprintf("%02d:%02d", hr, min)
		}
		if !seen[t] {
			seen[t] = true
			cleaned = append(cleaned, t)
		}
	}
	sort.SliceStable(cleaned, func(i, j int) bool {
		hi, mi, errI := clock(cleaned[i])
		hj, mj, errJ := clock(cleaned[j])
		if errI == nil && errJ == nil {
			return hi*60+mi < hj*60+mj
		}
		return cleaned[i] < cleaned[j]
	})
	switch len(cleaned) {
	case 0:
		s.Times = nil
		s.Time = strings.TrimSpace(s.Time)
	case 1:
		s.Time = cleaned[0]
		s.Times = nil
	default:
		s.Time = cleaned[0]
		s.Times = cleaned
	}
}

func (s Spec) clocks() ([][2]int, error) {
	var list []string
	if len(s.Times) > 0 {
		list = append(list, s.Times...)
		if t := strings.TrimSpace(s.Time); t != "" {
			found := false
			for _, v := range list {
				if strings.TrimSpace(v) == t {
					found = true
					break
				}
			}
			if !found {
				list = append([]string{t}, list...)
			}
		}
	} else if t := strings.TrimSpace(s.Time); t != "" {
		list = []string{t}
	}
	if len(list) == 0 {
		return nil, errors.New("时刻格式不对")
	}
	seen := make(map[[2]int]bool, len(list))
	out := make([][2]int, 0, len(list))
	for _, item := range list {
		hr, min, err := clock(strings.TrimSpace(item))
		if err != nil {
			return nil, err
		}
		hm := [2]int{hr, min}
		if !seen[hm] {
			seen[hm] = true
			out = append(out, hm)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i][0]*60+out[i][1] < out[j][0]*60+out[j][1]
	})
	return out, nil
}

func stripFence(text string) string {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "```") {
		return text
	}
	if i := strings.IndexByte(text, '\n'); i >= 0 {
		text = text[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(text), "```"))
}

// Validate checks a spec before it is saved. Errors are short Chinese reasons.
func (s Spec) Validate(now time.Time, loc *time.Location, minInterval time.Duration) error {
	switch s.Kind {
	case "once":
		at, err := time.ParseInLocation(atLayout, s.At, loc)
		if err != nil {
			return errors.New("时间格式不对")
		}
		if !at.After(now) {
			return errors.New("这个时间已经过去了")
		}
	case "daily":
		clocks, err := s.clocks()
		if err != nil {
			return err
		}
		if err := validateClocksInterval(clocks, minInterval); err != nil {
			return err
		}
	case "weekly":
		clocks, err := s.clocks()
		if err != nil {
			return err
		}
		if err := validateClocksInterval(clocks, minInterval); err != nil {
			return err
		}
		if len(s.Weekdays) == 0 {
			return errors.New("没有说是星期几")
		}
		for _, d := range s.Weekdays {
			if d < 0 || d > 6 {
				return errors.New("星期几不对")
			}
		}
	case "monthly":
		clocks, err := s.clocks()
		if err != nil {
			return err
		}
		if err := validateClocksInterval(clocks, minInterval); err != nil {
			return err
		}
		if len(s.MonthDays) == 0 {
			return errors.New("没有说是每月几号")
		}
		for _, d := range s.MonthDays {
			if d == 0 || d < -1 || d > 31 {
				return errors.New("每月日期需在 1..31 之间（或 -1 表示月末最后一天）")
			}
		}
	case "interval":
		if s.EveryMinutes <= 0 {
			return errors.New("没有说间隔多久")
		}
		if time.Duration(s.EveryMinutes)*time.Minute < minInterval {
			return fmt.Errorf("周期任务的间隔不能少于 %d 分钟", int(minInterval/time.Minute))
		}
	case "dates":
		clocks, err := s.clocks()
		if err != nil {
			return err
		}
		if err := validateClocksInterval(clocks, minInterval); err != nil {
			return err
		}
		if _, err := readDateFile(s.DateFile, loc); err != nil {
			return err
		}
		if _, ok := s.Next(now, loc); !ok {
			return errors.New("日期文件中没有未来的执行时间")
		}
	case "cron":
		if _, err := ParseCron(s.Cron); err != nil {
			return err
		}
		t1, ok1 := NextCron(s.Cron, now, loc)
		if !ok1 {
			return errors.New("Cron 表达式没有未来的执行时间")
		}
		if minInterval > time.Minute {
			if t2, ok2 := NextCron(s.Cron, t1, loc); ok2 && t2.Sub(t1) < minInterval {
				return fmt.Errorf("周期任务的间隔不能少于 %d 分钟", int(minInterval/time.Minute))
			}
		}
	default:
		return errors.New("不支持这种时间规则")
	}
	return nil
}

func validateClocksInterval(clocks [][2]int, minInterval time.Duration) error {
	if len(clocks) <= 1 || minInterval <= time.Minute {
		return nil
	}
	minMins := int(minInterval / time.Minute)
	for i := 1; i < len(clocks); i++ {
		diff := (clocks[i][0]*60 + clocks[i][1]) - (clocks[i-1][0]*60 + clocks[i-1][1])
		if diff < minMins {
			return fmt.Errorf("周期任务的间隔不能少于 %d 分钟", minMins)
		}
	}
	return nil
}

func clock(text string) (hour, minute int, err error) {
	t, err := time.Parse(clockLayout, text)
	if err != nil {
		return 0, 0, errors.New("时刻格式不对")
	}
	return t.Hour(), t.Minute(), nil
}

// Next returns the first run strictly after after. ok is false when a once task has passed.
func (s Spec) Next(after time.Time, loc *time.Location) (time.Time, bool) {
	switch s.Kind {
	case "once":
		at, err := time.ParseInLocation(atLayout, s.At, loc)
		if err != nil || !at.After(after) {
			return time.Time{}, false
		}
		return at, true
	case "interval":
		if s.EveryMinutes <= 0 {
			return time.Time{}, false
		}
		return after.Add(time.Duration(s.EveryMinutes) * time.Minute), true
	case "daily", "weekly":
		clocks, err := s.clocks()
		if err != nil {
			return time.Time{}, false
		}
		local := after.In(loc)
		for i := 0; i <= 7; i++ {
			day := local.AddDate(0, 0, i)
			for _, hm := range clocks {
				candidate := time.Date(day.Year(), day.Month(), day.Day(), hm[0], hm[1], 0, 0, loc)
				if candidate.After(after) && (s.Kind == "daily" || s.onWeekday(candidate.Weekday())) {
					return candidate, true
				}
			}
		}
	case "monthly":
		clocks, err := s.clocks()
		if err != nil || len(s.MonthDays) == 0 {
			return time.Time{}, false
		}
		local := after.In(loc)
		for i := 0; i <= 1465; i++ {
			baseDay := time.Date(local.Year(), local.Month(), local.Day()+i, 0, 0, 0, 0, loc)
			if !s.onMonthDay(baseDay) {
				continue
			}
			for _, hm := range clocks {
				candidate := time.Date(baseDay.Year(), baseDay.Month(), baseDay.Day(), hm[0], hm[1], 0, 0, loc)
				if candidate.After(after) {
					return candidate, true
				}
			}
		}
	case "cron":
		return NextCron(s.Cron, after, loc)
	case "dates":
		clocks, err := s.clocks()
		if err != nil {
			return time.Time{}, false
		}
		dates, err := readDateFile(s.DateFile, loc)
		if err != nil {
			return time.Time{}, false
		}
		var best time.Time
		for _, d := range dates {
			for _, hm := range clocks {
				candidate := time.Date(d.Year(), d.Month(), d.Day(), hm[0], hm[1], 0, 0, loc)
				if candidate.After(after) && (best.IsZero() || candidate.Before(best)) {
					best = candidate
				}
			}
		}
		if best.IsZero() {
			return time.Time{}, false
		}
		return best, true
	}
	return time.Time{}, false
}

func (s Spec) onWeekday(day time.Weekday) bool {
	for _, d := range s.Weekdays {
		if time.Weekday(d) == day {
			return true
		}
	}
	return false
}

func (s Spec) onMonthDay(day time.Time) bool {
	dom := day.Day()
	isLast := day.AddDate(0, 0, 1).Day() == 1
	for _, d := range s.MonthDays {
		if d == dom || (d == -1 && isLast) {
			return true
		}
	}
	return false
}

func readDateFile(path string, loc *time.Location) ([]time.Time, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("没有指定日期文件")
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("日期文件需使用绝对路径")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("无法读取日期文件")
	}
	content := strings.TrimPrefix(string(data), "\ufeff")
	lines := strings.Split(content, "\n")
	var dates []time.Time
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		d, err := parseDateLine(line, loc)
		if err != nil {
			return nil, fmt.Errorf("日期文件第 %d 行格式不对（需为 YYYY-MM-DD 或 YYYYMMDD）", i+1)
		}
		dates = append(dates, d)
	}
	if len(dates) == 0 {
		return nil, errors.New("日期文件为空")
	}
	return dates, nil
}

func parseDateLine(line string, loc *time.Location) (time.Time, error) {
	switch len(line) {
	case len(isoDateLayout):
		return time.ParseInLocation(isoDateLayout, line, loc)
	case len(compactLayout):
		return time.ParseInLocation(compactLayout, line, loc)
	default:
		return time.Time{}, errors.New("invalid date format")
	}
}

// MatchesRun reports whether a cron trigger at now should execute a task whose
// recorded nextRun is nextRun. It honours skipped runs (nextRun in the future)
// and re-checks DateFile live for "dates" tasks.
func (s Spec) MatchesRun(now, nextRun time.Time, loc *time.Location) bool {
	if loc == nil {
		loc = time.Local
	}
	if !nextRun.IsZero() && nextRun.After(now.Add(45*time.Second)) {
		return false
	}
	if s.Kind == "monthly" {
		return s.onMonthDay(now.In(loc))
	}
	if s.Kind == "dates" {
		dates, err := readDateFile(s.DateFile, loc)
		if err != nil {
			return false
		}
		local := now.In(loc)
		for _, d := range dates {
			if d.Year() == local.Year() && d.Month() == local.Month() && d.Day() == local.Day() {
				return true
			}
		}
		return false
	}
	return true
}
