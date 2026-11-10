package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadRequiresOnePlatform(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("DISCORD_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_IDS", "")
	t.Setenv("ALLOWED_USER_ID", "")
	t.Setenv("DISCORD_ALLOWED_USER_IDS", "")
	t.Setenv("DISCORD_ALLOWED_USER_ID", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadTelegramOnlyAndLegacyEnvCompat(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "tg-token")
	t.Setenv("DISCORD_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_IDS", "")
	t.Setenv("ALLOWED_USER_ID", "12345")
	t.Setenv("DISCORD_ALLOWED_USER_IDS", "")
	t.Setenv("DEFAULT_MODEL", "")
	t.Setenv("CODEX_MODEL", "o3")
	t.Setenv("CODEX_MODELS", "gpt-5.4, o3, gpt-5.4")
	t.Setenv("CODEX_TIMEOUT", "")
	t.Setenv("CODEX_TIMEOUT_MS", "180000")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TelegramToken != "tg-token" || cfg.DiscordToken != "" {
		t.Fatalf("%#v", cfg)
	}
	if _, ok := cfg.TelegramUsers["12345"]; !ok {
		t.Fatalf("%#v", cfg.TelegramUsers)
	}
	if cfg.DefaultModel != "o3" {
		t.Fatalf("DefaultModel=%q", cfg.DefaultModel)
	}
	if len(cfg.CodexModels) != 2 || cfg.CodexModels[0] != "gpt-5.4" || cfg.CodexModels[1] != "o3" {
		t.Fatalf("CodexModels=%#v", cfg.CodexModels)
	}
	if cfg.CodexTimeout != 3*time.Minute {
		t.Fatalf("CodexTimeout=%v", cfg.CodexTimeout)
	}
	if cfg.DiscordUsers != nil {
		t.Fatalf("%#v", cfg.DiscordUsers)
	}
}

func TestLoadDiscordStripsBotPrefix(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("DISCORD_BOT_TOKEN", "Bot abc.def")
	t.Setenv("ALLOWED_USER_IDS", "")
	t.Setenv("DISCORD_ALLOWED_USER_IDS", "99")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DiscordToken != "abc.def" {
		t.Fatalf("%q", cfg.DiscordToken)
	}
	if _, ok := cfg.DiscordUsers["99"]; !ok {
		t.Fatalf("%#v", cfg.DiscordUsers)
	}
}

func TestLoadRejectsNonNumericDiscordID(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "")
	t.Setenv("DISCORD_BOT_TOKEN", "token")
	t.Setenv("DISCORD_ALLOWED_USER_IDS", "abc")
	if _, err := Load(); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadWebSearch(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "tg-token")
	t.Setenv("DISCORD_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_IDS", "1")
	t.Setenv("WEB_SEARCH", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.WebSearch {
		t.Fatal("web search should default to on")
	}
	t.Setenv("WEB_SEARCH", "false")
	if cfg, err = Load(); err != nil || cfg.WebSearch {
		t.Fatalf("WEB_SEARCH=false: %v %v", cfg.WebSearch, err)
	}
	t.Setenv("WEB_SEARCH", "maybe")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for WEB_SEARCH=maybe")
	}
}

func TestLoadEnvFile(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "tg-token")
	t.Setenv("DISCORD_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_IDS", "1")
	t.Setenv("BOT_ENV_FILE", "")
	cfg, err := Load()
	if err != nil || cfg.EnvFile != "/etc/codex-bot.env" {
		t.Fatalf("%q %v", cfg.EnvFile, err)
	}
	t.Setenv("BOT_ENV_FILE", "/opt/bot/bot.env")
	if cfg, err = Load(); err != nil || cfg.EnvFile != "/opt/bot/bot.env" {
		t.Fatalf("%q %v", cfg.EnvFile, err)
	}

	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("DEFAULT_MODEL=gpt-5.4-mini\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOT_ENV_FILE", "")
	t.Setenv("DEFAULT_MODEL", "")
	loaded := LoadEnvFile("", filepath.Join(dir, "missing.env"), envPath)
	if loaded != envPath || os.Getenv("BOT_ENV_FILE") != envPath || os.Getenv("DEFAULT_MODEL") != "gpt-5.4-mini" {
		t.Fatalf("loaded=%q BOT_ENV_FILE=%q DEFAULT_MODEL=%q", loaded, os.Getenv("BOT_ENV_FILE"), os.Getenv("DEFAULT_MODEL"))
	}
}

func TestLoadTaskSettings(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "tg-token")
	t.Setenv("DISCORD_BOT_TOKEN", "")
	t.Setenv("ALLOWED_USER_IDS", "1")
	t.Setenv("TIMEZONE", "")
	t.Setenv("TASK_LIMIT", "")
	t.Setenv("TASK_MIN_INTERVAL", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Location != time.Local || cfg.TaskLimit != 20 || cfg.TaskMinInterval != time.Hour {
		t.Fatalf("%v %d %v", cfg.Location, cfg.TaskLimit, cfg.TaskMinInterval)
	}
	t.Setenv("TIMEZONE", "UTC")
	t.Setenv("TASK_LIMIT", "5")
	t.Setenv("TASK_MIN_INTERVAL", "90m")
	if cfg, err = Load(); err != nil || cfg.Location.String() != "UTC" || cfg.TaskLimit != 5 || cfg.TaskMinInterval != 90*time.Minute {
		t.Fatalf("%v %d %v %v", cfg.Location, cfg.TaskLimit, cfg.TaskMinInterval, err)
	}
	for env, value := range map[string]string{"TIMEZONE": "Nowhere/Zone", "TASK_LIMIT": "0", "TASK_MIN_INTERVAL": "0s", "CODEX_MAX_TURNS": "-1"} {
		t.Run(env, func(t *testing.T) {
			t.Setenv(env, value)
			if _, err := Load(); err == nil {
				t.Fatalf("%s=%s accepted", env, value)
			}
		})
	}
	t.Setenv("CODEX_MAX_TURNS", "0")
	if cfg, err = Load(); err != nil || cfg.CodexMaxTurns != -1 {
		t.Fatalf("CODEX_MAX_TURNS=0: %d %v", cfg.CodexMaxTurns, err)
	}
}

func TestLoadUserProfile(t *testing.T) {
	home := t.TempDir()
	profile := strings.Join([]string{
		`# user profile`,
		`export THESEUS_API_KEY="placeholder-theseus"`,
		`export RAG_MCP_TOKEN='placeholder$literal'`,
		`UNEXPORTED_MCP_KEY=plain_val # inline comment`,
		`export EXISTING_BOT_VAR="from_profile"`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(home, ".bash_profile"), []byte(profile), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("THESEUS_API_KEY", "")
	t.Setenv("RAG_MCP_TOKEN", "")
	t.Setenv("UNEXPORTED_MCP_KEY", "")
	t.Setenv("EXISTING_BOT_VAR", "from_systemd")

	LoadUserProfile(home)

	if got := os.Getenv("THESEUS_API_KEY"); got != "placeholder-theseus" {
		t.Fatalf("THESEUS_API_KEY = %q", got)
	}
	if got := os.Getenv("RAG_MCP_TOKEN"); got != "placeholder$literal" {
		t.Fatalf("RAG_MCP_TOKEN = %q", got)
	}
	if got := os.Getenv("UNEXPORTED_MCP_KEY"); got != "plain_val" {
		t.Fatalf("UNEXPORTED_MCP_KEY = %q", got)
	}
	if got := os.Getenv("EXISTING_BOT_VAR"); got != "from_systemd" {
		t.Fatalf("EXISTING_BOT_VAR overwritten: %q", got)
	}
}
