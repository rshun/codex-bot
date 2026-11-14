package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rshun/codex-bot/internal/platform"
	"github.com/rshun/codex-bot/internal/store"
	"github.com/rshun/codex-bot/internal/updater"
)

func TestUpgradeCheckAutoToggleAndRunFlow(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "data")
	st, err := store.Open(dataDir, "gpt-5.4")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	binDir := filepath.Join(tmp, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exeName := "codex-bot"
	if runtime.GOOS == "windows" {
		exeName = "codex-bot.exe"
	}
	exePath := filepath.Join(binDir, exeName)
	if err := os.WriteFile(exePath, []byte("old-bot-v2.1.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	npmPrefix := filepath.Join(tmp, "npm-global")
	if err := os.MkdirAll(npmPrefix, 0o755); err != nil {
		t.Fatal(err)
	}

	assetName, err := updater.AssetName(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skipf("unsupported test platform %s/%s: %v", runtime.GOOS, runtime.GOARCH, err)
	}
	newBotBytes := []byte("new-bot-v2.2.0")
	sum := sha256.Sum256(newBotBytes)
	sumHex := hex.EncodeToString(sum[:])

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/rshun/codex-bot/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v2.2.0",
				"html_url": "https://github.com/rshun/codex-bot/releases/tag/v2.2.0",
				"assets": []map[string]string{
					{"name": assetName, "browser_download_url": srv.URL + "/dl/" + assetName},
					{"name": "SHA256SUMS", "browser_download_url": srv.URL + "/dl/SHA256SUMS"},
				},
			})
		case r.URL.Path == "/dl/SHA256SUMS":
			_, _ = fmt.Fprintf(w, "%s  %s\n", sumHex, assetName)
		case r.URL.Path == "/dl/"+assetName:
			_, _ = w.Write(newBotBytes)
		case strings.Contains(r.URL.EscapedPath(), "codex/latest") || strings.Contains(r.URL.Path, "codex/latest"):
			_, _ = w.Write([]byte(`{"version":"0.120.0"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cliVer := "0.118.0"
	mgr := &updater.Manager{
		Repo:          "rshun/codex-bot",
		CurrentBotVer: "v2.1.1",
		ExePath:       exePath,
		GitHubAPIBase: srv.URL,
		NPMRegistry:   srv.URL,
		HTTP:          srv.Client(),
		RunCmd: func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
			joined := name + " " + strings.Join(args, " ")
			switch {
			case strings.Contains(name, ".codex-bot.upgrade.new") && len(args) == 1 && args[0] == "--version":
				return "codex-bot v2.2.0", nil
			case strings.HasSuffix(joined, "codex --version"):
				return "codex-cli " + cliVer, nil
			case strings.Contains(joined, "config get prefix"):
				return npmPrefix, nil
			case strings.Contains(joined, "install -g @openai/codex@0.120.0"):
				cliVer = "0.120.0"
				return "updated", nil
			default:
				return "", fmt.Errorf("unexpected cmd: %s", joined)
			}
		},
	}

	eng := &fakeMCPEngine{}
	tgOut := &buttonCaptureOut{}
	dcOut := &buttonCaptureOut{}

	var restartedExe string
	var msgCountAtRestart int

	svc := &Service{
		Store:           st,
		Engine:          eng,
		Version:         "v2.1.1",
		Updater:         mgr,
		AutoUpgrade:     false,
		AutoUpgradeTime: "04:30",
		AllowedUsers: map[string]map[string]struct{}{
			platform.Telegram: {"u1": {}},
			platform.Discord:  {"u2": {}},
		},
		Senders: map[string]platform.Replier{
			platform.Telegram: tgOut,
			platform.Discord:  dcOut,
		},
		RequestRestart: func(p string) {
			restartedExe = p
			msgCountAtRestart = tgOut.count()
		},
	}

	sendTG := func(text string) (string, [][]platform.Button) {
		t.Helper()
		svc.Handle(context.Background(), platform.Inbound{
			Platform: platform.Telegram, ChatID: "tg-1", UserID: "u1", Text: text, TextMessage: true,
		}, tgOut)
		waitIdle(t, svc, platform.Telegram, "tg-1")
		return tgOut.last()
	}

	// 1. /upgrade check displays both updates and interactive buttons
	checkReply, checkBtns := sendTG("/upgrade")
	if !strings.Contains(checkReply, "v2.1.1 → 发现新版本 v2.2.0") || !strings.Contains(checkReply, "0.118.0 → 发现新版本 0.120.0") {
		t.Fatalf("unexpected /upgrade check reply:\n%s", checkReply)
	}
	for _, wantCmd := range []string{"/upgrade run all", "/upgrade run bot", "/upgrade run cli", "/upgrade auto on"} {
		if !hasButtonCommand(checkBtns, wantCmd) {
			t.Fatalf("missing button %q in %#v", wantCmd, checkBtns)
		}
	}

	// 2. Toggle auto-upgrade on and verify persistence
	autoReply, autoBtns := sendTG("/upgrade auto on")
	if !strings.Contains(autoReply, "已开启每日自动升级") || !hasButtonCommand(autoBtns, "/upgrade auto off") {
		t.Fatalf("unexpected /upgrade auto on reply: %s", autoReply)
	}
	if !svc.autoUpgradeEnabled(context.Background()) {
		t.Fatal("expected autoUpgradeEnabled to be true")
	}

	// 3. Execute full upgrade (/upgrade run all): upgrades CLI + backs up DB + swaps binary + schedules restart AFTER reply
	beforeMsgs := tgOut.count()
	runReply, _ := sendTG("/upgrade run all")
	if !strings.Contains(runReply, "Codex CLI 已升级：0.118.0 → 0.120.0") || !strings.Contains(runReply, "v2.1.1 → v2.2.0") {
		t.Fatalf("unexpected /upgrade run all reply:\n%s", runReply)
	}
	if restartedExe != exePath {
		t.Fatalf("expected RequestRestart(%q), got %q", exePath, restartedExe)
	}
	if msgCountAtRestart <= beforeMsgs {
		t.Fatalf("expected reply message to be sent BEFORE RequestRestart fired (before=%d atRestart=%d)", beforeMsgs, msgCountAtRestart)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "backups", "bot.db.pre-v2.1.1")); err != nil {
		t.Fatalf("expected pre-upgrade SQLite backup file, got err=%v", err)
	}

	// 4. Simulate new v2.2.0 daemon booting up and sending the post-restart confirmation
	svcRestarted := &Service{
		Store:   st,
		Version: "v2.2.0",
		Senders: map[string]platform.Replier{
			platform.Telegram: tgOut,
			platform.Discord:  dcOut,
		},
	}
	svcRestarted.SendPendingUpgradeNotice(context.Background())

	noticeText, _ := tgOut.last()
	if !strings.Contains(noticeText, "✅ 升级已完成") || !strings.Contains(noticeText, "v2.1.1 → v2.2.0") || !strings.Contains(noticeText, "0.118.0 → 0.120.0") {
		t.Fatalf("unexpected post-restart notice:\n%s", noticeText)
	}
}

func TestPostRestartRollbackWarningNotice(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "data"), "gpt-5.4")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	tgOut := &buttonCaptureOut{}
	svc := &Service{
		Store:   st,
		Version: "v2.1.1", // still on old version after failed restart!
		Senders: map[string]platform.Replier{platform.Telegram: tgOut},
	}
	svc.savePendingNotice(context.Background(), pendingUpgradeNotice{
		Platform:      platform.Telegram,
		ChatID:        "tg-1",
		OldBotVersion: "v2.1.1",
		TargetBotVer:  "v2.2.0",
	})

	svc.SendPendingUpgradeNotice(context.Background())
	warnText, _ := tgOut.last()
	if !strings.Contains(warnText, "⚠️") || !strings.Contains(warnText, "未能切换至目标版本 v2.2.0") {
		t.Fatalf("expected rollback warning, got:\n%s", warnText)
	}
}
