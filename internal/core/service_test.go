package core

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rshun/codex-bot/internal/codex"
	"github.com/rshun/codex-bot/internal/platform"
	"github.com/rshun/codex-bot/internal/store"
)

type fakeEngine struct {
	mu       sync.Mutex
	calls    []codex.ReplyOptions
	block    chan struct{}
	replyFor func(codex.ReplyOptions) (codex.HeadlessResult, error)
}

func (f *fakeEngine) Reply(ctx context.Context, opts codex.ReplyOptions) (codex.HeadlessResult, error) {
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return codex.HeadlessResult{}, ctx.Err()
		}
	}
	f.mu.Lock()
	f.calls = append(f.calls, opts)
	f.mu.Unlock()
	if f.replyFor != nil {
		return f.replyFor(opts)
	}
	return codex.HeadlessResult{Text: "pong", SessionID: opts.SessionID}, nil
}

func (f *fakeEngine) Models(context.Context) (codex.ModelList, error) {
	return codex.ModelList{Default: "gpt-5.4", Names: []string{"gpt-5.4", "gpt-5.3-codex"}}, nil
}

func (f *fakeEngine) Allowance(context.Context) (codex.Allowance, error) {
	return codex.Allowance{Tier: "CodexPro", UsedPercent: 2, HasUsedPercent: true, PeriodKind: "USAGE_PERIOD_TYPE_WEEKLY"}, nil
}

type recorder struct {
	mu         sync.Mutex
	msgs       []string
	receipts   int
	receiptErr error
}

func (r *recorder) Send(context.Context, string, string) error {
	return nil
}

func (r *recorder) sendText(_ context.Context, _, text string) error {
	r.mu.Lock()
	r.msgs = append(r.msgs, text)
	r.mu.Unlock()
	return nil
}

func (r *recorder) wait(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		if len(r.msgs) >= n {
			out := append([]string(nil), r.msgs...)
			r.mu.Unlock()
			return out
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("got %d messages, want %d: %#v", len(r.msgs), n, r.msgs)
	return nil
}

type capture struct {
	rec *recorder
}

func (c capture) Send(ctx context.Context, chatID, text string) error {
	return c.rec.sendText(ctx, chatID, text)
}

func (c capture) MarkReceived(context.Context, platform.Inbound) error {
	c.rec.mu.Lock()
	defer c.rec.mu.Unlock()
	c.rec.receipts++
	return c.rec.receiptErr
}

func (r *recorder) receiptCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.receipts
}

func TestReceiptThenResult(t *testing.T) {
	svc, engine := testService(t)
	rec := &recorder{}
	engine.replyFor = func(opts codex.ReplyOptions) (codex.HeadlessResult, error) {
		if rec.receiptCount() != 1 {
			return codex.HeadlessResult{}, errors.New("reply started before receipt")
		}
		return codex.HeadlessResult{Text: "pong", SessionID: opts.SessionID}, nil
	}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "hello", TextMessage: true,
	}, capture{rec})
	got := rec.wait(t, 1)
	if len(got) != 1 || got[0] != "pong" {
		t.Fatalf("%#v", got)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 1 || !engine.calls[0].NewSession {
		t.Fatalf("%#v", engine.calls)
	}
}

func TestQueueReportsAhead(t *testing.T) {
	svc, engine := testService(t)
	engine.block = make(chan struct{})
	rec := &recorder{}
	in := func(text string) {
		svc.Handle(context.Background(), platform.Inbound{
			Platform: "telegram", ChatID: "9", UserID: "1", Text: text, TextMessage: true,
		}, capture{rec})
	}
	in("one")
	in("two")
	got := rec.wait(t, 1)
	if len(got) != 1 || got[0] != "已排队，前面还有 1 条。" || rec.receiptCount() != 2 {
		t.Fatalf("%#v", got)
	}
	close(engine.block)
	got = rec.wait(t, 3)
	if got[1] != "pong" || got[2] != "pong" {
		t.Fatalf("%#v", got)
	}
}

func TestResetClearsSession(t *testing.T) {
	svc, engine := testService(t)
	rec := &recorder{}
	send := func(text string) {
		svc.Handle(context.Background(), platform.Inbound{
			Platform: "telegram", ChatID: "9", UserID: "1", Text: text, TextMessage: true,
		}, capture{rec})
	}
	send("hello")
	rec.wait(t, 1)
	send("/reset")
	rec.wait(t, 2)
	send("again")
	rec.wait(t, 3)
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 2 || !engine.calls[0].NewSession || !engine.calls[1].NewSession {
		t.Fatalf("%#v", engine.calls)
	}
	if engine.calls[0].SessionID == engine.calls[1].SessionID {
		t.Fatal("reset reused the session")
	}
}

func TestUsageQuotaAndModel(t *testing.T) {
	svc, engine := testService(t)
	rec := &recorder{}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "/usage", TextMessage: true,
	}, capture{rec})
	got := rec.wait(t, 1)
	if len(got) != 1 || !strings.Contains(got[0], "本期剩余：98%") {
		t.Fatalf("%#v", got)
	}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "/quota", TextMessage: true,
	}, capture{rec})
	got = rec.wait(t, 2)
	if len(got) != 2 || !strings.Contains(got[1], "本期剩余：98%") {
		t.Fatalf("%#v", got)
	}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "/model gpt-5.3-codex", TextMessage: true,
	}, capture{rec})
	got = rec.wait(t, 3)
	if len(got) != 3 || got[2] != "已切换到 gpt-5.3-codex。下一条消息开始使用。" || rec.receiptCount() != 0 {
		t.Fatalf("%#v", got)
	}

	// Verify that when a chat turn returns Usage tokens, /usage includes the last turn token snapshot.
	inTok := int64(1200)
	outTok := int64(340)
	engine.replyFor = func(opts codex.ReplyOptions) (codex.HeadlessResult, error) {
		return codex.HeadlessResult{
			Text:      "pong",
			SessionID: opts.SessionID,
			Usage: &store.UsageTokens{
				InputTokens:  &inTok,
				OutputTokens: &outTok,
			},
		}, nil
	}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "count tokens", TextMessage: true,
	}, capture{rec})
	rec.wait(t, 4)
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "/usage", TextMessage: true,
	}, capture{rec})
	got = rec.wait(t, 5)
	if !strings.Contains(got[4], "本期剩余：98%") || !strings.Contains(got[4], "1,200 tokens") || !strings.Contains(got[4], "340 tokens") {
		t.Fatalf("expected /usage to include both quota and last turn tokens, got: %q", got[4])
	}
}

func TestRejectsOtherUsers(t *testing.T) {
	svc, _ := testService(t)
	rec := &recorder{}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "2", Text: "hi", TextMessage: true,
	}, capture{rec})
	got := rec.wait(t, 1)
	if got[0] != "没有权限。" {
		t.Fatalf("%#v", got)
	}
	if rec.receiptCount() != 0 {
		t.Fatal("marked an unauthorized message as received")
	}
}

func TestReceiptFailureStillReplies(t *testing.T) {
	svc, _ := testService(t)
	rec := &recorder{receiptErr: errors.New("synthetic receipt failure")}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "hello", TextMessage: true,
	}, capture{rec})
	got := rec.wait(t, 1)
	if len(got) != 1 || got[0] != "pong" || rec.receiptCount() != 1 {
		t.Fatalf("%#v", got)
	}
}

func testService(t *testing.T) (*Service, *fakeEngine) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "data"), "gpt-5.4")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	engine := &fakeEngine{}
	return &Service{
		Store:  db,
		Engine: engine,
		AllowedUsers: map[string]map[string]struct{}{
			"telegram": {"1": {}},
		},
		QueueLimit: 8,
	}, engine
}

func TestAllowlistIsPerPlatform(t *testing.T) {
	svc, _ := testService(t)
	svc.AllowedUsers["discord"] = map[string]struct{}{"7": {}}
	rec := &recorder{}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "discord", ChatID: "c", UserID: "1", Text: "hi", TextMessage: true,
	}, capture{rec})
	got := rec.wait(t, 1)
	if got[0] != "没有权限。" {
		t.Fatalf("%#v", got)
	}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "discord", ChatID: "c", UserID: "7", Text: "hi", TextMessage: true,
	}, capture{rec})
	got = rec.wait(t, 2)
	if len(got) != 2 || got[1] != "pong" || rec.receiptCount() != 1 {
		t.Fatalf("%#v", got)
	}
}

func TestChatPassesWebSearchIncludingRebuild(t *testing.T) {
	svc, engine := testService(t)
	svc.WebSearch = true
	if err := svc.Store.SetSession(context.Background(), "telegram", "9", "old"); err != nil {
		t.Fatal(err)
	}
	engine.replyFor = func(opts codex.ReplyOptions) (codex.HeadlessResult, error) {
		if !opts.NewSession {
			return codex.HeadlessResult{}, errors.New("Session old not found")
		}
		return codex.HeadlessResult{Text: "pong", SessionID: opts.SessionID}, nil
	}
	rec := &recorder{}
	svc.Handle(context.Background(), platform.Inbound{
		Platform: "telegram", ChatID: "9", UserID: "1", Text: "hello", TextMessage: true,
	}, capture{rec})
	rec.wait(t, 1)
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.calls) != 2 {
		t.Fatalf("%#v", engine.calls)
	}
	for i, call := range engine.calls {
		if !call.WebSearch {
			t.Fatalf("call %d without web search", i)
		}
	}
}
