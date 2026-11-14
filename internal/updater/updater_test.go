package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSemverParseAndCompare(t *testing.T) {
	v, ok := ParseSemver("codex-cli 0.118.2")
	if !ok || v.String() != "0.118.2" {
		t.Fatalf("ParseSemver(codex-cli 0.118.2) = %v, %v", v, ok)
	}
	if _, ok := ParseSemver("dev"); ok {
		t.Fatal("expected dev to fail ParseSemver")
	}

	cases := []struct {
		a, b string
		want int
	}{
		{"v2.1.1", "v2.1.2", -1},
		{"v2.2.0", "2.1.9", 1},
		{"0.118.0", "codex-cli 0.118.0", 0},
		{"v2.1.2-rc.1", "v2.1.2", -1},
		{"v2.1.2-rc.2", "v2.1.2-rc.10", -1},
	}
	for _, tc := range cases {
		got, ok := CompareSemver(tc.a, tc.b)
		if !ok || got != tc.want {
			t.Errorf("CompareSemver(%q, %q) = (%d, %v), want (%d, true)", tc.a, tc.b, got, ok, tc.want)
		}
	}
	if IsStable("v2.1.2-beta.1") {
		t.Fatal("expected beta version to be non-stable")
	}
	if !IsStable("v2.1.2") {
		t.Fatal("expected release version to be stable")
	}
}

func TestLookupSHA256AndAssetName(t *testing.T) {
	name, err := AssetName("linux", "amd64")
	if err != nil || name != "codex-bot-linux-amd64" {
		t.Fatalf("AssetName(linux, amd64) = %q, %v", name, err)
	}
	if _, err := AssetName("plan9", "386"); err == nil {
		t.Fatal("expected unsupported platform error")
	}

	sumA := strings.Repeat("a", 64)
	sumB := strings.Repeat("b", 64)
	manifest := fmt.Sprintf("# checksums\n%s  codex-bot-linux-amd64\n%s *dist/codex-bot-windows-amd64.exe\n", sumA, sumB)

	if got, ok := LookupSHA256(manifest, "codex-bot-linux-amd64"); !ok || got != sumA {
		t.Fatalf("LookupSHA256 linux = %q, %v", got, ok)
	}
	if got, ok := LookupSHA256(manifest, "codex-bot-windows-amd64.exe"); !ok || got != sumB {
		t.Fatalf("LookupSHA256 windows = %q, %v", got, ok)
	}
	if _, ok := LookupSHA256(manifest, "codex-bot-darwin-arm64"); ok {
		t.Fatal("expected missing asset to return false")
	}
}

func TestCheckAndNPMFallback(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "codex-bot")
	if err := os.WriteFile(exePath, []byte("old-bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	npmPrefix := filepath.Join(dir, "npm-global")
	if err := os.MkdirAll(npmPrefix, 0o755); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/rshun/codex-bot/releases/latest":
			_ = json.NewEncoder(w).Encode(ghRelease{
				TagName: "v2.2.0",
				HTMLURL: "https://github.com/rshun/codex-bot/releases/tag/v2.2.0",
			})
		default:
			http.Error(w, "registry offline", http.StatusBadGateway)
		}
	}))
	defer srv.Close()

	mgr := &Manager{
		Repo:          "rshun/codex-bot",
		CurrentBotVer: "v2.1.1",
		ExePath:       exePath,
		GitHubAPIBase: srv.URL,
		NPMRegistry:   srv.URL,
		HTTP:          srv.Client(),
		RunCmd: func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
			joined := name + " " + strings.Join(args, " ")
			switch {
			case strings.HasSuffix(joined, "codex --version"):
				return "codex-cli 0.118.0\n", nil
			case strings.Contains(joined, "config get prefix"):
				return npmPrefix + "\n", nil
			case strings.Contains(joined, "view @openai/codex version"):
				return "0.119.1\n", nil
			default:
				return "", fmt.Errorf("unexpected cmd: %s", joined)
			}
		},
	}

	rep := mgr.Check(context.Background())
	if rep.Bot.Error != "" || !rep.Bot.UpdateAvailable || rep.Bot.Latest != "v2.2.0" || !rep.Bot.Writable {
		t.Fatalf("unexpected Bot status: %+v", rep.Bot)
	}
	if rep.CLI.Error != "" || !rep.CLI.UpdateAvailable || rep.CLI.Current != "0.118.0" || rep.CLI.Latest != "0.119.1" || !rep.CLI.Writable {
		t.Fatalf("unexpected CLI status: %+v", rep.CLI)
	}
}

func TestUpgradeCLISuccessAndAutoRollback(t *testing.T) {
	dir := t.TempDir()
	npmPrefix := filepath.Join(dir, "npm-global")
	if err := os.MkdirAll(npmPrefix, 0o755); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.120.0"}`))
	}))
	defer srv.Close()

	// Case 1: Successful upgrade
	installedVer := "0.118.0"
	mgr := &Manager{
		NPMRegistry: srv.URL,
		HTTP:        srv.Client(),
		RunCmd: func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
			joined := name + " " + strings.Join(args, " ")
			switch {
			case strings.HasSuffix(joined, "codex --version"):
				return "codex-cli " + installedVer, nil
			case strings.Contains(joined, "config get prefix"):
				return npmPrefix, nil
			case strings.Contains(joined, "install -g @openai/codex@0.120.0"):
				installedVer = "0.120.0"
				return "added 1 package", nil
			default:
				return "", fmt.Errorf("unexpected cmd: %s", joined)
			}
		},
	}
	res, err := mgr.UpgradeCLI(context.Background())
	if err != nil {
		t.Fatalf("UpgradeCLI failed: %v", err)
	}
	if !res.Changed || res.OldVersion != "0.118.0" || res.NewVersion != "0.120.0" {
		t.Fatalf("unexpected CLIUpgradeResult: %+v", res)
	}

	// Case 2: Post-upgrade verification fails -> automatic rollback to 0.118.0
	broken := false
	rolledBack := false
	mgrRollback := &Manager{
		NPMRegistry: srv.URL,
		HTTP:        srv.Client(),
		RunCmd: func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
			joined := name + " " + strings.Join(args, " ")
			switch {
			case strings.HasSuffix(joined, "codex --version"):
				if broken {
					return "", errors.New("Segmentation fault")
				}
				return "codex-cli 0.118.0", nil
			case strings.Contains(joined, "config get prefix"):
				return npmPrefix, nil
			case strings.Contains(joined, "install -g @openai/codex@0.120.0"):
				broken = true
				return "added 1 package", nil
			case strings.Contains(joined, "install -g @openai/codex@0.118.0"):
				broken = false
				rolledBack = true
				return "restored 0.118.0", nil
			default:
				return "", fmt.Errorf("unexpected cmd: %s", joined)
			}
		},
	}
	_, err = mgrRollback.UpgradeCLI(context.Background())
	if err == nil || !strings.Contains(err.Error(), "已自动回滚至 0.118.0") {
		t.Fatalf("expected auto-rollback error message, got: %v", err)
	}
	if !rolledBack {
		t.Fatal("expected rollback npm install to be executed")
	}
}

func TestStageCommitAndRollbackBotBinary(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "codex-bot")
	oldBytes := []byte("old-binary-v2.1.1")
	newBytes := []byte("new-binary-v2.2.0")
	if err := os.WriteFile(exePath, oldBytes, 0o755); err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256(newBytes)
	sumHex := hex.EncodeToString(sum[:])
	tamperedManifest := false

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/rshun/codex-bot/releases/latest":
			_ = json.NewEncoder(w).Encode(ghRelease{
				TagName: "v2.2.0",
				Assets: []ghAsset{
					{Name: "codex-bot-linux-amd64", BrowserDownloadURL: srv.URL + "/dl/codex-bot-linux-amd64"},
					{Name: "SHA256SUMS", BrowserDownloadURL: srv.URL + "/dl/SHA256SUMS"},
				},
			})
		case "/dl/SHA256SUMS":
			digest := sumHex
			if tamperedManifest {
				digest = strings.Repeat("0", 64)
			}
			_, _ = fmt.Fprintf(w, "%s  codex-bot-linux-amd64\n", digest)
		case "/dl/codex-bot-linux-amd64":
			_, _ = w.Write(newBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	mgr := &Manager{
		Repo:          "rshun/codex-bot",
		CurrentBotVer: "v2.1.1",
		ExePath:       exePath,
		GOOS:          "linux",
		GOARCH:        "amd64",
		GitHubAPIBase: srv.URL,
		HTTP:          srv.Client(),
		RunCmd: func(_ context.Context, _ time.Duration, name string, args ...string) (string, error) {
			if len(args) == 1 && args[0] == "--version" {
				return "codex-bot v2.2.0\n", nil
			}
			return "", fmt.Errorf("unexpected command: %s %v", name, args)
		},
	}

	// 1. Tampered SHA256 must abort without touching original binary
	tamperedManifest = true
	if _, err := mgr.StageBotUpgrade(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected SHA-256 mismatch error, got: %v", err)
	}
	gotOrig, _ := os.ReadFile(exePath)
	if string(gotOrig) != string(oldBytes) {
		t.Fatal("original binary was modified despite checksum failure")
	}

	// 2. Valid SHA256 -> stage, commit, and rollback across OS modes
	tamperedManifest = false
	staged, err := mgr.StageBotUpgrade(context.Background())
	if err != nil {
		t.Fatalf("StageBotUpgrade failed: %v", err)
	}
	if !staged.Changed || staged.NewVersion != "v2.2.0" {
		t.Fatalf("unexpected StagedBotUpgrade: %+v", staged)
	}

	for _, osMode := range []string{"linux", "windows"} {
		modeDir := filepath.Join(dir, osMode)
		if err := os.MkdirAll(modeDir, 0o755); err != nil {
			t.Fatal(err)
		}
		targetExe := filepath.Join(modeDir, "codex-bot")
		targetStaged := filepath.Join(modeDir, stagedFilename(osMode))
		if err := os.WriteFile(targetExe, oldBytes, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(targetStaged, newBytes, 0o755); err != nil {
			t.Fatal(err)
		}

		if _, err := commitBotBinaryForOS(osMode, targetExe, targetStaged); err != nil {
			t.Fatalf("commitBotBinaryForOS(%s) failed: %v", osMode, err)
		}
		afterCommit, err := os.ReadFile(targetExe)
		if err != nil || string(afterCommit) != string(newBytes) {
			t.Fatalf("(%s) expected new binary after commit, got %q (err=%v)", osMode, string(afterCommit), err)
		}

		if err := rollbackBotBinaryForOS(osMode, targetExe); err != nil {
			t.Fatalf("rollbackBotBinaryForOS(%s) failed: %v", osMode, err)
		}
		afterRollback, err := os.ReadFile(targetExe)
		if err != nil || string(afterRollback) != string(oldBytes) {
			t.Fatalf("(%s) expected old binary after rollback, got %q (err=%v)", osMode, string(afterRollback), err)
		}
	}
}

func TestScrubbedEnvStripsSecrets(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "placeholder_tg_secret")
	t.Setenv("DISCORD_BOT_TOKEN", "placeholder_dc_secret")
	t.Setenv("ALLOWED_USER_IDS", "12345")
	t.Setenv("BOT_ENV_FILE", "/etc/codex-bot.env")

	env := scrubbedEnv()
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.ToUpper(k) {
		case "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "ALLOWED_USER_IDS", "BOT_ENV_FILE":
			t.Fatalf("secret key %s leaked into scrubbedEnv", k)
		}
	}
}
