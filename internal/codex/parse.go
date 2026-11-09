package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/rshun/codex-bot/internal/store"
)

var (
	ansiRE      = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	modelLineRE = regexp.MustCompile(`^\s*(\*)?\s*([A-Za-z0-9._-]+)(?:\s+\((current|default)\))?\s*$`)
	modelNameRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
)

// ValidModelName rejects flag injection and malformed identifiers.
func ValidModelName(name string) bool {
	return !strings.HasPrefix(name, "-") && modelNameRE.MatchString(name)
}

// ModelList represents the parsed output of model discovery.
type ModelList struct {
	Default   string
	Current   string
	Names     []string
	Available []string
}

// ParseModels parses `codex models` or `grok models` text output.
func ParseModels(raw string) ModelList {
	clean := ansiRE.ReplaceAllString(raw, "")
	var out ModelList
	seen := make(map[string]bool)
	for _, line := range strings.Split(clean, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "Default model:") {
			name := strings.TrimSpace(strings.TrimPrefix(trim, "Default model:"))
			if name != "" {
				out.Default = name
				if out.Current == "" {
					out.Current = name
				}
			}
			continue
		}
		m := modelLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		name := m[2]
		if !seen[name] {
			seen[name] = true
			out.Available = append(out.Available, name)
			out.Names = append(out.Names, name)
		}
		if m[1] == "*" || m[3] == "current" {
			out.Current = name
			if out.Default == "" {
				out.Default = name
			}
		} else if m[3] == "default" && out.Default == "" {
			out.Default = name
			if out.Current == "" {
				out.Current = name
			}
		}
	}
	return out
}

// QuotaWindow holds one rate-limit window (e.g., primary 5h or secondary 7d).
type QuotaWindow struct {
	UsedPercent        int
	RemainingPercent   int
	WindowDurationMins int
	ResetsAt           time.Time
}

// QuotaBucket holds the rate-limit windows for a specific limit ID (e.g. "codex").
type QuotaBucket struct {
	LimitID   string
	LimitName string
	PlanType  string
	Primary   *QuotaWindow
	Secondary *QuotaWindow
}

// Allowance holds account quota / rate-limit state.
type Allowance struct {
	Tier           string
	PlanType       string
	AccountEmail   string
	UsedPercent    float64
	HasUsedPercent bool
	PeriodKind     string
	PeriodEnd      time.Time
	Buckets        []QuotaBucket
	Truncated      bool
	QueriedAt      time.Time
}

const maxDisplayBuckets = 4

// ParseAllowanceRPC parses the JSON-RPC responses from `codex app-server`
// (`account/read` and `account/rateLimits/read`) into an Allowance struct.
func ParseAllowanceRPC(accountJSON, rateLimitsJSON json.RawMessage, queriedAt time.Time) (Allowance, error) {
	var acct struct {
		Account *struct {
			Type     string `json:"type"`
			Email    string `json:"email"`
			PlanType string `json:"planType"`
		} `json:"account"`
	}
	if len(accountJSON) > 0 {
		_ = json.Unmarshal(accountJSON, &acct)
	}

	type rawWindow struct {
		UsedPercent        *float64 `json:"usedPercent"`
		WindowDurationMins *int     `json:"windowDurationMins"`
		ResetsAt           *int64   `json:"resetsAt"`
	}
	type rawBucket struct {
		LimitID   string     `json:"limitId"`
		LimitName string     `json:"limitName"`
		PlanType  string     `json:"planType"`
		Primary   *rawWindow `json:"primary"`
		Secondary *rawWindow `json:"secondary"`
	}
	var rl struct {
		RateLimits          *rawBucket            `json:"rateLimits"`
		RateLimitsByLimitID map[string]*rawBucket `json:"rateLimitsByLimitId"`
	}
	if len(rateLimitsJSON) > 0 {
		if err := json.Unmarshal(rateLimitsJSON, &rl); err != nil {
			return Allowance{}, fmt.Errorf("decode rateLimits: %w", err)
		}
	}

	rawBuckets := make([]*rawBucket, 0, 4)
	if len(rl.RateLimitsByLimitID) > 0 {
		keys := make([]string, 0, len(rl.RateLimitsByLimitID))
		for k := range rl.RateLimitsByLimitID {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i] == "codex" {
				return true
			}
			if keys[j] == "codex" {
				return false
			}
			return keys[i] < keys[j]
		})
		for _, k := range keys {
			if b := rl.RateLimitsByLimitID[k]; b != nil {
				if b.LimitID == "" {
					b.LimitID = k
				}
				rawBuckets = append(rawBuckets, b)
			}
		}
	} else if rl.RateLimits != nil {
		rawBuckets = append(rawBuckets, rl.RateLimits)
	}

	convertWindow := func(w *rawWindow) *QuotaWindow {
		if w == nil || w.UsedPercent == nil {
			return nil
		}
		used := int(math.Round(*w.UsedPercent))
		if used < 0 {
			used = 0
		}
		if used > 100 {
			used = 100
		}
		qw := &QuotaWindow{
			UsedPercent:      used,
			RemainingPercent: 100 - used,
		}
		if w.WindowDurationMins != nil && *w.WindowDurationMins > 0 {
			qw.WindowDurationMins = *w.WindowDurationMins
		}
		if w.ResetsAt != nil && *w.ResetsAt > 0 {
			qw.ResetsAt = time.Unix(*w.ResetsAt, 0)
		}
		return qw
	}

	var buckets []QuotaBucket
	for _, b := range rawBuckets {
		primary := convertWindow(b.Primary)
		secondary := convertWindow(b.Secondary)
		if primary == nil && secondary == nil {
			continue
		}
		limitID := strings.TrimSpace(b.LimitID)
		if limitID == "" {
			limitID = "codex"
		}
		buckets = append(buckets, QuotaBucket{
			LimitID:   limitID,
			LimitName: strings.TrimSpace(b.LimitName),
			PlanType:  strings.TrimSpace(b.PlanType),
			Primary:   primary,
			Secondary: secondary,
		})
	}

	if len(buckets) == 0 {
		return Allowance{}, fmt.Errorf("Codex CLI 未返回可用的账号额度窗口")
	}

	truncated := false
	if len(buckets) > maxDisplayBuckets {
		buckets = buckets[:maxDisplayBuckets]
		truncated = true
	}

	out := Allowance{
		Buckets:   buckets,
		Truncated: truncated,
		QueriedAt: queriedAt,
	}
	if acct.Account != nil {
		out.PlanType = strings.TrimSpace(acct.Account.PlanType)
		out.AccountEmail = strings.TrimSpace(acct.Account.Email)
		out.Tier = out.PlanType
	}
	if out.Tier == "" && buckets[0].PlanType != "" {
		out.Tier = buckets[0].PlanType
		out.PlanType = buckets[0].PlanType
	}
	if buckets[0].Primary != nil {
		out.UsedPercent = float64(buckets[0].Primary.UsedPercent)
		out.HasUsedPercent = true
		out.PeriodKind = formatWindowDuration(buckets[0].Primary.WindowDurationMins)
		out.PeriodEnd = buckets[0].Primary.ResetsAt
	} else if buckets[0].Secondary != nil {
		out.UsedPercent = float64(buckets[0].Secondary.UsedPercent)
		out.HasUsedPercent = true
		out.PeriodKind = formatWindowDuration(buckets[0].Secondary.WindowDurationMins)
		out.PeriodEnd = buckets[0].Secondary.ResetsAt
	}
	return out, nil
}

func formatWindowDuration(mins int) string {
	if mins <= 0 {
		return ""
	}
	const weekMins = 7 * 24 * 60
	const dayMins = 24 * 60
	if mins%weekMins == 0 {
		w := mins / weekMins
		if w == 1 {
			return "7d"
		}
		return fmt.Sprintf("%dw", w)
	}
	if mins%dayMins == 0 {
		return fmt.Sprintf("%dd", mins/dayMins)
	}
	if mins%60 == 0 {
		return fmt.Sprintf("%dh", mins/60)
	}
	return fmt.Sprintf("%dm", mins)
}

func formatQuotaWindowLine(label string, w *QuotaWindow) string {
	if w == nil {
		return ""
	}
	dur := formatWindowDuration(w.WindowDurationMins)
	title := label
	if dur != "" {
		title = fmt.Sprintf("%s（%s）", label, dur)
	}
	line := fmt.Sprintf("%s：剩余 %d%%（已用 %d%%）", title, w.RemainingPercent, w.UsedPercent)
	if !w.ResetsAt.IsZero() {
		line += fmt.Sprintf("，重置于 %s", w.ResetsAt.Local().Format("2006-01-02 15:04:05"))
	}
	return line
}

// FormatAllowance formats the account rate-limit windows into a readable Chinese summary.
func FormatAllowance(a Allowance) string {
	if len(a.Buckets) > 0 {
		lines := []string{"当前账号剩余额度："}
		plan := a.PlanType
		if plan == "" {
			plan = a.Tier
		}
		if plan != "" {
			lines = append(lines, fmt.Sprintf("套餐：%s", plan))
		}
		multi := len(a.Buckets) > 1
		for _, b := range a.Buckets {
			prefix := ""
			if multi {
				label := b.LimitName
				if label == "" {
					label = b.LimitID
				}
				prefix = fmt.Sprintf("[%s] ", label)
			}
			if b.Primary != nil {
				lines = append(lines, prefix+formatQuotaWindowLine("主窗口", b.Primary))
			}
			if b.Secondary != nil {
				lines = append(lines, prefix+formatQuotaWindowLine("次窗口", b.Secondary))
			}
		}
		if a.Truncated {
			lines = append(lines, "其余额度桶已省略。")
		}
		if !a.QueriedAt.IsZero() {
			lines = append(lines, fmt.Sprintf("查询时间：%s", a.QueriedAt.Local().Format("2006-01-02 15:04:05")))
		}
		return strings.Join(lines, "\n")
	}

	var b strings.Builder
	if a.Tier != "" {
		fmt.Fprintf(&b, "套餐：%s\n", a.Tier)
	}
	if !a.HasUsedPercent {
		return strings.TrimSpace(b.String())
	}
	remaining := 100 - a.UsedPercent
	if remaining < 0 {
		remaining = 0
	}
	if remaining > 100 {
		remaining = 100
	}
	fmt.Fprintf(&b, "本期剩余：%.0f%%（已用 %.0f%%）\n", remaining, a.UsedPercent)
	if a.PeriodKind != "" && !a.PeriodEnd.IsZero() {
		fmt.Fprintf(&b, "重置时间（%s）：%s\n", a.PeriodKind, a.PeriodEnd.In(time.Local).Format("2006-01-02 15:04 MST"))
	}
	return strings.TrimSpace(b.String())
}

// NormalizeUsage clamps any negative token counts in a UsageTokens struct to 0.
func NormalizeUsage(raw *store.UsageTokens) *store.UsageTokens {
	if raw == nil {
		return nil
	}
	norm := func(p *int64) *int64 {
		if p == nil {
			return nil
		}
		v := max(int64(0), *p)
		return &v
	}
	return &store.UsageTokens{
		InputTokens:           norm(raw.InputTokens),
		CachedInputTokens:     norm(raw.CachedInputTokens),
		OutputTokens:          norm(raw.OutputTokens),
		ReasoningOutputTokens: norm(raw.ReasoningOutputTokens),
	}
}

func formatTokenCount(p *int64) string {
	if p == nil {
		return "未知"
	}
	return formatIntWithCommas(*p) + " tokens"
}

func formatIntWithCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var out []byte
	rem := len(s) % 3
	if rem > 0 {
		out = append(out, s[:rem]...)
		if len(s) > rem {
			out = append(out, ',')
		}
	}
	for i := rem; i < len(s); i += 3 {
		out = append(out, s[i:i+3]...)
		if i+3 < len(s) {
			out = append(out, ',')
		}
	}
	return string(out)
}

// FormatUsage renders the last turn's CLI token usage snapshot in Chinese.
func FormatUsage(report *store.UsageReport, busy bool) string {
	const unavailableNote = "说明：Codex CLI 当前只返回 token 用量，不提供账户剩余额度百分比（如需查询账户窗口额度请使用 /quota）。"
	if report == nil {
		if busy {
			return strings.Join([]string{
				"当前正在处理上一条消息，本次用量尚未生成。",
				"请稍后再试。",
				unavailableNote,
			}, "\n")
		}
		return strings.Join([]string{
			"暂无用量记录。",
			"先发送一条普通消息后再执行 /usage。",
			unavailableNote,
		}, "\n")
	}

	var lines []string
	if busy {
		lines = append(lines, "当前有任务正在执行，以下为最近一次已完成请求的数据：")
	}
	switch report.Status {
	case "succeeded", "completed":
		lines = append(lines, "最近一次请求用量：")
	case "cancelled":
		lines = append(lines, "最近一次请求已取消。")
	default:
		lines = append(lines, "最近一次请求执行失败。")
	}
	if !report.At.IsZero() {
		lines = append(lines, fmt.Sprintf("时间：%s", report.At.Local().Format("2006-01-02 15:04:05")))
	}
	if report.Tokens != nil {
		u := NormalizeUsage(report.Tokens)
		var total *int64
		if u.InputTokens != nil || u.OutputTokens != nil {
			var sum int64
			if u.InputTokens != nil {
				sum += *u.InputTokens
			}
			if u.OutputTokens != nil {
				sum += *u.OutputTokens
			}
			total = &sum
		}
		lines = append(lines,
			fmt.Sprintf("输入：%s", formatTokenCount(u.InputTokens)),
			fmt.Sprintf("缓存输入：%s", formatTokenCount(u.CachedInputTokens)),
			fmt.Sprintf("输出：%s", formatTokenCount(u.OutputTokens)),
			fmt.Sprintf("推理输出：%s", formatTokenCount(u.ReasoningOutputTokens)),
			fmt.Sprintf("输入 + 输出：%s", formatTokenCount(total)),
		)
	} else {
		lines = append(lines, "Codex CLI 未返回 token 统计。")
	}
	lines = append(lines, unavailableNote)
	return strings.Join(lines, "\n")
}

// HeadlessResult is the normalized output from a single Codex turn.
type HeadlessResult struct {
	Text            string
	SessionID       string
	StopReason      string
	Structured      json.RawMessage
	GeneratedImages []string
	Usage           *store.UsageTokens
}

// RunError represents an error returned by the Codex CLI.
type RunError struct {
	Message     string
	SessionID   string
	PartialText string
}

func (e *RunError) Error() string { return e.Message }

// IsMaxTurns reports whether err indicates the CLI hit its max-turns cap.
func IsMaxTurns(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "max_turns") ||
		strings.Contains(msg, "max turns") ||
		strings.Contains(msg, "maximum turns") ||
		strings.Contains(msg, "maximum number of turns")
}

// UserFacing returns a clean, redacted error message suitable for end users.
func UserFacing(err error) string {
	var re *RunError
	if errors.As(err, &re) {
		return RedactSensitive(re.Message)
	}
	return "Codex failed to process the request."
}

// ParseHeadless parses single-line or multi-line JSON output from headless runs.
func ParseHeadless(stdout []byte, stderr string) (HeadlessResult, error) {
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var env struct {
			Type             string          `json:"type"`
			Result           *string         `json:"result"`
			IsError          bool            `json:"is_error"`
			StopReason       string          `json:"stop_reason"`
			SessionID        string          `json:"session_id"`
			ThreadID         string          `json:"thread_id"`
			StructuredOutput json.RawMessage `json:"structured_output"`
			Error            any             `json:"error"`
			Message          string          `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			continue
		}
		sid := env.SessionID
		if sid == "" {
			sid = env.ThreadID
		}
		if env.Type == "error" || env.IsError {
			msg := extractErrorMessage(env.Error, env.Message, env.Result, stderr)
			return HeadlessResult{}, &RunError{Message: msg, SessionID: sid}
		}
		if env.Result != nil || len(env.StructuredOutput) > 0 {
			text := ""
			if env.Result != nil {
				text = *env.Result
			}
			return HeadlessResult{
				Text:       text,
				SessionID:  sid,
				StopReason: env.StopReason,
				Structured: env.StructuredOutput,
			}, nil
		}
	}
	if msg := summarizeStderr(stderr); msg != "" {
		return HeadlessResult{}, &RunError{Message: msg}
	}
	return HeadlessResult{}, &RunError{Message: "Codex returned an empty or unreadable response."}
}

func extractErrorMessage(errField any, message string, result *string, stderr string) string {
	switch v := errField.(type) {
	case string:
		if v != "" {
			return v
		}
	case map[string]any:
		if m, ok := v["message"].(string); ok && m != "" {
			return m
		}
	}
	if message != "" {
		return message
	}
	if result != nil && *result != "" {
		return *result
	}
	if s := summarizeStderr(stderr); s != "" {
		return s
	}
	return "Codex CLI reported an unknown error."
}

func summarizeStderr(stderr string) string {
	clean := strings.TrimSpace(ansiRE.ReplaceAllString(stderr, ""))
	if clean == "" {
		return ""
	}
	var keep []string
	for _, line := range strings.Split(clean, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "at ") || strings.HasPrefix(t, "node:") {
			continue
		}
		keep = append(keep, t)
	}
	if len(keep) == 0 {
		return "Codex CLI exited with an error."
	}
	if len(keep) > 3 {
		keep = keep[len(keep)-3:]
	}
	return RedactSensitive(strings.Join(keep, " | "))
}
