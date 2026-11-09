package codex

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/rshun/codex-bot/internal/store"
)

func TestParseModels(t *testing.T) {
	raw := "\x1b[32m* gpt-5.4 (current)\x1b[0m\n  gpt-5.3-codex\n  o3 (default)\n"
	got := ParseModels(raw)
	if got.Current != "gpt-5.4" {
		t.Fatalf("Current = %q, want gpt-5.4", got.Current)
	}
	if len(got.Available) != 3 {
		t.Fatalf("Available = %v, want 3 models", got.Available)
	}
}

func TestValidModelName(t *testing.T) {
	if !ValidModelName("gpt-5.4") || !ValidModelName("gpt-5.3-codex") {
		t.Fatal("expected valid model names")
	}
	if ValidModelName("-m") || ValidModelName("bad name") || ValidModelName("") {
		t.Fatal("expected invalid model names to be rejected")
	}
}

func TestParseAllowanceRPCAndFormat(t *testing.T) {
	acct := json.RawMessage(`{"account":{"type":"chatgpt","email":"user@example.com","planType":"pro"}}`)
	rl := json.RawMessage(`{
		"rateLimitsByLimitId": {
			"codex": {
				"limitId": "codex",
				"limitName": "Codex",
				"planType": "pro",
				"primary": {"usedPercent": 12.4, "windowDurationMins": 300, "resetsAt": 1775498400},
				"secondary": {"usedPercent": 35.8, "windowDurationMins": 10080, "resetsAt": 1776000000}
			}
		}
	}`)
	now := time.Unix(1775490000, 0)
	a, err := ParseAllowanceRPC(acct, rl, now)
	if err != nil {
		t.Fatalf("ParseAllowanceRPC: %v", err)
	}
	if a.PlanType != "pro" || !a.HasUsedPercent || a.UsedPercent != 12 {
		t.Fatalf("unexpected allowance: %+v", a)
	}
	text := FormatAllowance(a)
	for _, want := range []string{
		"当前账号剩余额度：",
		"套餐：pro",
		"主窗口（5h）：剩余 88%（已用 12%）",
		"次窗口（7d）：剩余 64%（已用 36%）",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("expected %q in formatted allowance:\n%s", want, text)
		}
	}
}

func TestFormatUsage(t *testing.T) {
	empty := FormatUsage(nil, false)
	if !strings.Contains(empty, "暂无用量记录") {
		t.Fatalf("unexpected empty usage message: %s", empty)
	}

	i64 := func(v int64) *int64 { return &v }
	rep := &store.UsageReport{
		At:     time.Unix(1775490000, 0),
		Status: "completed",
		Tokens: &store.UsageTokens{
			InputTokens:           i64(12345),
			CachedInputTokens:     i64(2345),
			OutputTokens:          i64(678),
			ReasoningOutputTokens: i64(120),
		},
	}
	got := FormatUsage(rep, true)
	for _, want := range []string{
		"当前有任务正在执行",
		"最近一次请求用量：",
		"输入：12,345 tokens",
		"缓存输入：2,345 tokens",
		"输出：678 tokens",
		"推理输出：120 tokens",
		"输入 + 输出：13,023 tokens",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in FormatUsage output:\n%s", want, got)
		}
	}
}

func TestParseHeadlessAndIsMaxTurns(t *testing.T) {
	raw := `{"type":"result","result":"hello world","session_id":"sess_1","stop_reason":"end_turn"}`
	res, err := ParseHeadless([]byte(raw), "")
	if err != nil {
		t.Fatalf("ParseHeadless: %v", err)
	}
	if res.Text != "hello world" || res.SessionID != "sess_1" {
		t.Fatalf("unexpected result: %+v", res)
	}

	errRaw := `{"type":"error","error":"maximum number of turns reached","session_id":"sess_2"}`
	_, err = ParseHeadless([]byte(errRaw), "")
	if !IsMaxTurns(err) {
		t.Fatalf("expected IsMaxTurns=true for %v", err)
	}
}
