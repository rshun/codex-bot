package config

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultModel = "gpt-5.4"
)

// Config is the process configuration. Secrets come from the environment,
// which systemd loads from /etc/codex-bot.env.
type Config struct {
	TelegramToken string
	DiscordToken  string
	TelegramUsers map[string]struct{}
	DiscordUsers  map[string]struct{}
	DataDir       string
	DefaultModel  string
	// CodexModels are user-configured candidate model IDs for /model selection.
	CodexModels  []string
	CodexBin     string
	CodexHome    string
	AuthPath     string
	CodexTimeout time.Duration
	CodexMaxTurns int
	QueueLimit   int
	WebSearch    bool
	LinkPrefetch bool
	AllowShell   bool
	ShowProgress bool
	EnvFile      string
	// Location is the time zone for scheduled tasks.
	Location        *time.Location
	TaskLimit       int
	TaskMinInterval time.Duration
	// ScriptDirs are the only directories whose scripts may be bound to /task script tasks.
	ScriptDirs []string
	// ScriptTimeout bounds one script task run.
	ScriptTimeout time.Duration
	// AutoUpgrade enables daily background checks and upgrades for codex-bot and Codex CLI.
	AutoUpgrade bool
	// AutoUpgradeTime is the daily HH:MM check time in Location (defaults to "04:30").
	AutoUpgradeTime string
	// UpgradeRepo is the GitHub owner/repo for codex-bot releases (defaults to "rshun/codex-bot").
	UpgradeRepo string
	// NPMBin is the npm executable used to check and upgrade @openai/codex (defaults to "npm").
	NPMBin  string
	Version string
}

func Load() (Config, error) {
	token := strings.TrimSpace(os.Getenv("TELEGRAM_BOT_TOKEN"))
	discordToken := strings.TrimSpace(os.Getenv("DISCORD_BOT_TOKEN"))
	discordToken = strings.TrimPrefix(discordToken, "Bot ")
	if token == "" && discordToken == "" {
		return Config{}, fmt.Errorf("TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN is required")
	}
	var allowed map[string]struct{}
	var discordUsers map[string]struct{}
	var err error
	if token != "" {
		rawUsers := strings.TrimSpace(os.Getenv("ALLOWED_USER_IDS"))
		if rawUsers == "" {
			rawUsers = strings.TrimSpace(os.Getenv("ALLOWED_USER_ID"))
		}
		allowed, err = parseUsers(rawUsers, "ALLOWED_USER_IDS", "Telegram")
		if err != nil {
			return Config{}, err
		}
	}
	if discordToken != "" {
		rawUsers := strings.TrimSpace(os.Getenv("DISCORD_ALLOWED_USER_IDS"))
		if rawUsers == "" {
			rawUsers = strings.TrimSpace(os.Getenv("DISCORD_ALLOWED_USER_ID"))
		}
		discordUsers, err = parseUsers(rawUsers, "DISCORD_ALLOWED_USER_IDS", "Discord")
		if err != nil {
			return Config{}, err
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("home directory: %w", err)
	}
	dataDir := strings.TrimSpace(os.Getenv("DATA_DIR"))
	if dataDir == "" {
		dataDir = "data"
	}
	timeout := 10 * time.Minute
	if raw := strings.TrimSpace(os.Getenv("CODEX_TIMEOUT")); raw != "" {
		timeout, err = time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("CODEX_TIMEOUT: %w", err)
		}
	} else if rawMS := strings.TrimSpace(os.Getenv("CODEX_TIMEOUT_MS")); rawMS != "" {
		ms, err := strconv.Atoi(rawMS)
		if err != nil || ms < 1000 {
			return Config{}, fmt.Errorf("CODEX_TIMEOUT_MS must be an integer >= 1000")
		}
		timeout = time.Duration(ms) * time.Millisecond
	}
	maxTurns := 50
	if raw := strings.TrimSpace(os.Getenv("CODEX_MAX_TURNS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return Config{}, fmt.Errorf("CODEX_MAX_TURNS must be a non-negative integer")
		}
		if n == 0 {
			maxTurns = -1
		} else {
			maxTurns = n
		}
	}
	queueLimit := 8
	if raw := strings.TrimSpace(os.Getenv("QUEUE_LIMIT")); raw != "" {
		queueLimit, err = strconv.Atoi(raw)
		if err != nil || queueLimit < 1 {
			return Config{}, fmt.Errorf("QUEUE_LIMIT must be a positive integer")
		}
	}
	webSearch := true
	if raw := strings.TrimSpace(os.Getenv("WEB_SEARCH")); raw != "" {
		webSearch, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("WEB_SEARCH must be true or false")
		}
	}
	linkPrefetch := true
	if raw := strings.TrimSpace(os.Getenv("LINK_PREFETCH")); raw != "" {
		linkPrefetch, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("LINK_PREFETCH must be true or false")
		}
	}
	allowShell := false
	if raw := strings.TrimSpace(os.Getenv("ALLOW_SHELL")); raw != "" {
		allowShell, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("ALLOW_SHELL must be true or false")
		}
	}
	showProgress := false
	if raw := strings.TrimSpace(os.Getenv("SHOW_PROGRESS")); raw != "" {
		showProgress, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("SHOW_PROGRESS must be true or false")
		}
	}
	envFile := strings.TrimSpace(os.Getenv("BOT_ENV_FILE"))
	if envFile == "" {
		envFile = "/etc/codex-bot.env"
	}
	location := time.Local
	if raw := strings.TrimSpace(os.Getenv("TIMEZONE")); raw != "" {
		location, err = time.LoadLocation(raw)
		if err != nil {
			return Config{}, fmt.Errorf("TIMEZONE: %w", err)
		}
	}
	taskLimit := 20
	if raw := strings.TrimSpace(os.Getenv("TASK_LIMIT")); raw != "" {
		taskLimit, err = strconv.Atoi(raw)
		if err != nil || taskLimit < 1 {
			return Config{}, fmt.Errorf("TASK_LIMIT must be a positive integer")
		}
	}
	minInterval := time.Hour
	if raw := strings.TrimSpace(os.Getenv("TASK_MIN_INTERVAL")); raw != "" {
		minInterval, err = time.ParseDuration(raw)
		if err != nil || minInterval <= 0 {
			return Config{}, fmt.Errorf("TASK_MIN_INTERVAL must be a positive duration such as 60m")
		}
	}
	model := strings.TrimSpace(os.Getenv("DEFAULT_MODEL"))
	if model == "" {
		model = strings.TrimSpace(os.Getenv("CODEX_MODEL"))
	}
	if model == "" {
		model = defaultModel
	}
	models := parseCSVList(os.Getenv("CODEX_MODELS"))
	scriptDirs := parseScriptDirs(os.Getenv("SCRIPT_DIRS"), home)
	scriptTimeout := 30 * time.Minute
	if raw := strings.TrimSpace(os.Getenv("SCRIPT_TIMEOUT")); raw != "" {
		scriptTimeout, err = time.ParseDuration(raw)
		if err != nil || scriptTimeout <= 0 {
			return Config{}, fmt.Errorf("SCRIPT_TIMEOUT must be a positive duration such as 30m")
		}
	}
	bin := strings.TrimSpace(os.Getenv("CODEX_BIN"))
	if bin == "" {
		bin = "codex"
	}
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	auth := strings.TrimSpace(os.Getenv("CODEX_AUTH_PATH"))
	if auth == "" {
		auth = filepath.Join(codexHome, "auth.json")
	}
	autoUpgrade := false
	if raw := strings.TrimSpace(os.Getenv("AUTO_UPGRADE")); raw != "" {
		autoUpgrade, err = strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("AUTO_UPGRADE must be true or false")
		}
	}
	autoUpgradeTime := strings.TrimSpace(os.Getenv("AUTO_UPGRADE_TIME"))
	if autoUpgradeTime == "" {
		autoUpgradeTime = "04:30"
	} else {
		normTime, timeErr := normalizeClockHHMM(autoUpgradeTime)
		if timeErr != nil {
			return Config{}, fmt.Errorf("AUTO_UPGRADE_TIME: %w", timeErr)
		}
		autoUpgradeTime = normTime
	}
	upgradeRepo := strings.TrimSpace(os.Getenv("UPGRADE_REPO"))
	if upgradeRepo == "" {
		upgradeRepo = "rshun/codex-bot"
	}
	npmBin := strings.TrimSpace(os.Getenv("NPM_BIN"))
	if npmBin == "" {
		npmBin = "npm"
	}
	return Config{
		TelegramToken:   token,
		DiscordToken:    discordToken,
		TelegramUsers:   allowed,
		DiscordUsers:    discordUsers,
		DataDir:         dataDir,
		DefaultModel:    model,
		CodexModels:     models,
		CodexBin:        bin,
		CodexHome:       codexHome,
		AuthPath:        auth,
		CodexTimeout:    timeout,
		CodexMaxTurns:   maxTurns,
		QueueLimit:      queueLimit,
		WebSearch:       webSearch,
		LinkPrefetch:    linkPrefetch,
		AllowShell:      allowShell,
		ShowProgress:    showProgress,
		EnvFile:         envFile,
		Location:        location,
		TaskLimit:       taskLimit,
		TaskMinInterval: minInterval,
		ScriptDirs:      scriptDirs,
		ScriptTimeout:   scriptTimeout,
		AutoUpgrade:     autoUpgrade,
		AutoUpgradeTime: autoUpgradeTime,
		UpgradeRepo:     upgradeRepo,
		NPMBin:          npmBin,
	}, nil
}

func normalizeClockHHMM(raw string) (string, error) {
	parts := strings.Split(strings.TrimSpace(raw), ":")
	if len(parts) != 2 {
		return "", fmt.Errorf("must be HH:MM (e.g. 04:30)")
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return "", fmt.Errorf("must be HH:MM between 00:00 and 23:59")
	}
	return fmt.Sprintf("%02d:%02d", h, m), nil
}

func parseCSVList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	seen := make(map[string]bool)
	var out []string
	for _, part := range strings.Split(raw, ",") {
		item := strings.TrimSpace(part)
		if item != "" && !seen[item] {
			seen[item] = true
			out = append(out, item)
		}
	}
	return out
}

// parseScriptDirs splits SCRIPT_DIRS (comma or OS path-list separated); it defaults to ~/bin.
func parseScriptDirs(raw, home string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{filepath.Join(home, "bin")}
	}
	var out []string
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == os.PathListSeparator
	}) {
		part = strings.TrimSpace(part)
		if part != "" && filepath.IsAbs(part) {
			out = append(out, filepath.Clean(part))
		}
	}
	return out
}

func parseUsers(raw, envName, platformName string) (map[string]struct{}, error) {
	out := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		if !digits(id) {
			return nil, fmt.Errorf("%s contains %q, which is not a numeric %s user id", envName, id, platformName)
		}
		out[id] = struct{}{}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s is required", envName)
	}
	return out, nil
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// LoadEnvFile populates unset environment variables from the first readable KEY=VALUE file
// and returns the resolved path of the loaded file (or "" if none was readable).
func LoadEnvFile(paths ...string) string {
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, raw := range strings.Split(string(data), "\n") {
			line := strings.TrimSpace(raw)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			k = strings.TrimSpace(k)
			v = strings.Trim(strings.TrimSpace(v), `"'`)
			if k != "" && os.Getenv(k) == "" {
				_ = os.Setenv(k, v)
			}
		}
		resolved := p
		if abs, absErr := filepath.Abs(p); absErr == nil {
			resolved = abs
		}
		if os.Getenv("BOT_ENV_FILE") == "" {
			_ = os.Setenv("BOT_ENV_FILE", resolved)
		}
		return resolved
	}
	return ""
}

var skipShellVars = map[string]bool{
	"_":                     true,
	"PWD":                   true,
	"OLDPWD":                true,
	"SHLVL":                 true,
	"BASH_EXECUTION_STRING": true,
}

// LoadUserProfile loads unset environment variables (such as MCP auth tokens)
// from ~/.bash_profile, ~/.bash_login, ~/.profile (and ~/.zprofile static exports),
// and ensures standard user/Homebrew bin directories are in PATH on Unix so
// systemd, cron, and launchd runs inherit the same CLI tools as an interactive login shell.
func LoadUserProfile(home string) {
	home = strings.TrimSpace(home)
	if home == "" {
		return
	}
	LoadShellProfiles(
		filepath.Join(home, ".bash_profile"),
		filepath.Join(home, ".bash_login"),
		filepath.Join(home, ".profile"),
	)
	loadProfileStatic(filepath.Join(home, ".zprofile"))
	if runtime.GOOS != "windows" {
		ensureUnixPath(home)
	}
}

func ensureUnixPath(home string) {
	cur := os.Getenv("PATH")
	seen := map[string]bool{}
	var parts []string
	for _, p := range strings.Split(cur, ":") {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] {
			seen[p] = true
			parts = append(parts, p)
		}
	}
	candidates := []string{
		filepath.Join(home, "bin"),
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".bun", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
	}
	changed := false
	for _, dir := range candidates {
		if seen[dir] {
			continue
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			seen[dir] = true
			parts = append(parts, dir)
			changed = true
		}
	}
	if changed {
		_ = os.Setenv("PATH", strings.Join(parts, ":"))
	}
}

// LoadShellProfiles sources the given shell profile files via bash when available
// (supporting `source`, `$HOME`/`$PATH` expansion, and unexported assignments),
// and falls back to static line parsing. Existing env vars (except PATH) are kept.
func LoadShellProfiles(paths ...string) {
	var existing []string
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			existing = append(existing, p)
		}
	}
	if len(existing) == 0 {
		return
	}
	if runtime.GOOS != "windows" {
		if bashBin, err := exec.LookPath("bash"); err == nil {
			if loadViaBash(bashBin, existing) {
				return
			}
		}
	}
	for _, p := range existing {
		loadProfileStatic(p)
	}
}

func loadViaBash(bashBin string, files []string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	const script = `set -a; for f in "$@"; do [ -r "$f" ] && . "$f" >/dev/null 2>&1 || true; done; env -0`
	args := append([]string{"-c", script, "_"}, files...)
	out, err := exec.CommandContext(ctx, bashBin, args...).Output()
	if err != nil || len(out) == 0 {
		return false
	}
	for _, entry := range bytes.Split(out, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		k, v, ok := strings.Cut(string(entry), "=")
		if !ok || k == "" || skipShellVars[k] {
			continue
		}
		if k == "PATH" {
			if v != "" {
				_ = os.Setenv("PATH", v)
			}
			continue
		}
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
	return true
}

func loadProfileStatic(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") || strings.HasPrefix(line, "export\t") {
			line = strings.TrimSpace(line[len("export"):])
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if !validEnvKey(k) {
			continue
		}
		val, expand := parseShellValue(strings.TrimSpace(v))
		if expand {
			val = os.ExpandEnv(val)
		}
		if k == "PATH" {
			if val != "" {
				_ = os.Setenv("PATH", val)
			}
			continue
		}
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, val)
		}
	}
}

func validEnvKey(k string) bool {
	if k == "" {
		return false
	}
	for i, r := range k {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

func parseShellValue(s string) (val string, expand bool) {
	if len(s) >= 2 && s[0] == '\'' {
		if end := strings.IndexByte(s[1:], '\''); end >= 0 {
			return s[1 : 1+end], false
		}
	}
	if len(s) >= 2 && s[0] == '"' {
		if end := strings.IndexByte(s[1:], '"'); end >= 0 {
			return s[1 : 1+end], true
		}
	}
	// Strip trailing inline comment (`foo # comment`).
	if idx := strings.Index(s, " #"); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	return s, true
}
