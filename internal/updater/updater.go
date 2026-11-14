package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/rshun/codex-bot/internal/codex"
)

const (
	DefaultRepo        = "rshun/codex-bot"
	DefaultGitHubAPI   = "https://api.github.com"
	DefaultNPMRegistry = "https://registry.npmjs.org"
	CodexNPMPackage    = "@openai/codex"

	maxMetadataBytes = 2 << 20   // 2 MiB
	maxBinaryBytes   = 128 << 20 // 128 MiB
)

var secretEnvKeys = map[string]bool{
	"TELEGRAM_BOT_TOKEN":       true,
	"DISCORD_BOT_TOKEN":        true,
	"ALLOWED_USER_IDS":         true,
	"ALLOWED_USER_ID":          true,
	"DISCORD_ALLOWED_USER_IDS": true,
	"DISCORD_ALLOWED_USER_ID":  true,
	"BOT_ENV_FILE":             true,
}

// ComponentStatus summarizes the current version, latest version, and permission state of one component.
type ComponentStatus struct {
	Current         string
	Latest          string
	UpdateAvailable bool
	IsDev           bool
	Path            string
	Writable        bool
	WriteHint       string
	ReleaseURL      string
	Error           string
}

// Report contains version check results for both codex-bot and Codex CLI.
type Report struct {
	Bot ComponentStatus
	CLI ComponentStatus
}

// CLIUpgradeResult describes the outcome of upgrading @openai/codex via npm.
type CLIUpgradeResult struct {
	Changed    bool
	OldVersion string
	NewVersion string
}

// StagedBotUpgrade holds a verified new codex-bot binary ready for atomic swap.
type StagedBotUpgrade struct {
	Changed    bool
	ExePath    string
	StagedPath string
	OldVersion string
	NewVersion string
}

// Manager checks and upgrades codex-bot and Codex CLI without elevated privileges.
type Manager struct {
	Repo          string
	CurrentBotVer string
	ExePath       string
	CodexBin      string
	NPMBin        string
	GitHubAPIBase string
	NPMRegistry   string
	GOOS          string
	GOARCH        string
	HTTP          *http.Client
	// RunCmd overrides subprocess execution in tests; nil runs os/exec with secrets scrubbed.
	RunCmd func(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error)
}

type ghRelease struct {
	TagName    string    `json:"tag_name"`
	HTMLURL    string    `json:"html_url"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Assets     []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// AssetName maps a Go OS/arch pair to the release artifact filename published by .github/workflows/release.yml.
func AssetName(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "codex-bot-linux-amd64", nil
	case "linux/arm64":
		return "codex-bot-linux-arm64", nil
	case "darwin/arm64":
		return "codex-bot-darwin-arm64", nil
	case "darwin/amd64":
		return "codex-bot-darwin-amd64", nil
	case "windows/amd64":
		return "codex-bot-windows-amd64.exe", nil
	default:
		return "", fmt.Errorf("当前平台 %s/%s 暂无预编译升级包", goos, goarch)
	}
}

// LookupSHA256 extracts the expected lowercase 64-hex SHA-256 digest for filename from a SHA256SUMS manifest.
func LookupSHA256(manifest, filename string) (string, bool) {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		return "", false
	}
	for _, raw := range strings.Split(manifest, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 || !isHex(sum) {
			continue
		}
		name := strings.TrimPrefix(fields[1], "*")
		name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
		if name == filename {
			return sum, true
		}
	}
	return "", false
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

// Check queries both GitHub Releases and the npm registry in parallel.
func (m *Manager) Check(ctx context.Context) Report {
	var (
		rep Report
		wg  sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		rep.Bot = m.CheckBot(ctx)
	}()
	go func() {
		defer wg.Done()
		rep.CLI = m.CheckCLI(ctx)
	}()
	wg.Wait()
	return rep
}

// CheckBot checks the current codex-bot version, directory write permission, and latest GitHub Release.
func (m *Manager) CheckBot(ctx context.Context) ComponentStatus {
	cur := strings.TrimSpace(m.CurrentBotVer)
	if cur == "" {
		cur = "dev"
	}
	st := ComponentStatus{
		Current: cur,
		IsDev:   cur == "dev" || ! func() bool { _, ok := ParseSemver(cur); return ok }(),
	}
	exePath, err := m.resolveExePath()
	if err == nil {
		st.Path = exePath
		if wErr := checkDirWritable(filepath.Dir(exePath)); wErr == nil {
			st.Writable = true
		} else {
			st.WriteHint = botWriteHint(exePath)
		}
	} else {
		st.WriteHint = "无法解析当前可执行文件路径：" + err.Error()
	}

	rel, err := m.fetchLatestRelease(ctx)
	if err != nil {
		st.Error = codex.RedactSensitive(err.Error())
		return st
	}
	st.Latest = strings.TrimSpace(rel.TagName)
	st.ReleaseURL = strings.TrimSpace(rel.HTMLURL)
	if !st.IsDev && IsStable(st.Latest) {
		if cmp, ok := CompareSemver(st.Latest, st.Current); ok && cmp > 0 {
			st.UpdateAvailable = true
		}
	}
	return st
}

// CheckCLI checks the installed Codex CLI version, npm global prefix write permission, and latest npm version.
func (m *Manager) CheckCLI(ctx context.Context) ComponentStatus {
	st := ComponentStatus{}
	rawOut, err := m.execCmd(ctx, 10*time.Second, m.codexBin(), "--version")
	if err != nil {
		st.Error = "读取本地 Codex CLI 版本失败：" + codex.RedactSensitive(err.Error())
		return st
	}
	line := firstLine(rawOut)
	if sem, ok := ParseSemver(line); ok {
		st.Current = sem.String()
	} else {
		st.Current = line
	}

	prefix, wErr := m.checkNPMWritable(ctx)
	st.Path = prefix
	if wErr == nil {
		st.Writable = true
	} else {
		st.WriteHint = npmWriteHint(prefix, wErr)
	}

	latest, err := m.fetchLatestCLIVersion(ctx)
	if err != nil {
		st.Error = codex.RedactSensitive(err.Error())
		return st
	}
	st.Latest = latest
	if IsStable(st.Latest) {
		if cmp, ok := CompareSemver(st.Latest, st.Current); ok && cmp > 0 {
			st.UpdateAvailable = true
		}
	}
	return st
}

// UpgradeCLI upgrades @openai/codex via npm, verifies the binary runs, and rolls back automatically on failure.
func (m *Manager) UpgradeCLI(ctx context.Context) (CLIUpgradeResult, error) {
	st := m.CheckCLI(ctx)
	if st.Error != "" {
		return CLIUpgradeResult{}, errors.New(st.Error)
	}
	if !st.UpdateAvailable {
		return CLIUpgradeResult{
			Changed:    false,
			OldVersion: st.Current,
			NewVersion: st.Current,
		}, nil
	}
	if !st.Writable {
		return CLIUpgradeResult{}, errors.New(st.WriteHint)
	}

	targetPkg := fmt.Sprintf("%s@%s", CodexNPMPackage, st.Latest)
	if _, err := m.execCmd(ctx, 5*time.Minute, m.npmBin(), "install", "-g", targetPkg, "--no-fund", "--no-audit"); err != nil {
		return CLIUpgradeResult{}, fmt.Errorf("执行 npm 升级失败：%s", codex.RedactSensitive(err.Error()))
	}

	verifyOut, verifyErr := m.execCmd(ctx, 15*time.Second, m.codexBin(), "--version")
	if verifyErr != nil {
		rollbackMsg := "未找到可回滚的旧版本号"
		if oldSem, ok := ParseSemver(st.Current); ok {
			oldPkg := fmt.Sprintf("%s@%s", CodexNPMPackage, oldSem.String())
			if _, rbErr := m.execCmd(ctx, 5*time.Minute, m.npmBin(), "install", "-g", oldPkg, "--no-fund", "--no-audit"); rbErr == nil {
				rollbackMsg = "已自动回滚至 " + oldSem.String()
			} else {
				rollbackMsg = "自动回滚失败：" + codex.RedactSensitive(rbErr.Error())
			}
		}
		return CLIUpgradeResult{}, fmt.Errorf("升级后 Codex CLI 自检失败（%s），%s", codex.RedactSensitive(verifyErr.Error()), rollbackMsg)
	}

	newVer := firstLine(verifyOut)
	if sem, ok := ParseSemver(newVer); ok {
		newVer = sem.String()
	}
	if newVer == "" {
		newVer = st.Latest
	}
	return CLIUpgradeResult{
		Changed:    true,
		OldVersion: st.Current,
		NewVersion: newVer,
	}, nil
}

// StageBotUpgrade downloads the latest release binary into the target directory, verifies its SHA-256
// checksum against SHA256SUMS, and runs `--version` to confirm the binary executes cleanly.
func (m *Manager) StageBotUpgrade(ctx context.Context) (StagedBotUpgrade, error) {
	cur := strings.TrimSpace(m.CurrentBotVer)
	if cur == "" {
		cur = "dev"
	}
	if cur == "dev" {
		return StagedBotUpgrade{}, errors.New("当前 codex-bot 为本地 dev 开发构建，已跳过自动覆盖；请使用正式 Release 版本后再执行自升级")
	}
	if _, ok := ParseSemver(cur); !ok {
		return StagedBotUpgrade{}, fmt.Errorf("当前版本号 %q 非标准语义化版本，无法自动比对升级", cur)
	}

	exePath, err := m.resolveExePath()
	if err != nil {
		return StagedBotUpgrade{}, fmt.Errorf("解析当前可执行文件路径失败：%w", err)
	}
	exeDir := filepath.Dir(exePath)
	if wErr := checkDirWritable(exeDir); wErr != nil {
		return StagedBotUpgrade{}, errors.New(botWriteHint(exePath))
	}

	assetName, err := AssetName(m.goos(), m.goarch())
	if err != nil {
		return StagedBotUpgrade{}, err
	}

	rel, err := m.fetchLatestRelease(ctx)
	if err != nil {
		return StagedBotUpgrade{}, err
	}
	latest := strings.TrimSpace(rel.TagName)
	if rel.Draft || rel.Prerelease || !IsStable(latest) {
		return StagedBotUpgrade{Changed: false, ExePath: exePath, OldVersion: cur, NewVersion: cur}, nil
	}
	cmp, ok := CompareSemver(latest, cur)
	if !ok || cmp <= 0 {
		return StagedBotUpgrade{Changed: false, ExePath: exePath, OldVersion: cur, NewVersion: cur}, nil
	}

	var binURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case assetName:
			binURL = a.BrowserDownloadURL
		case "SHA256SUMS":
			sumsURL = a.BrowserDownloadURL
		}
	}
	if binURL == "" {
		return StagedBotUpgrade{}, fmt.Errorf("Release %s 中未找到当前平台产物 %s", latest, assetName)
	}
	if sumsURL == "" {
		return StagedBotUpgrade{}, fmt.Errorf("Release %s 缺少 SHA256SUMS 校验文件，已中止升级", latest)
	}

	sumsBytes, err := m.httpGetBytes(ctx, sumsURL, maxMetadataBytes)
	if err != nil {
		return StagedBotUpgrade{}, fmt.Errorf("下载 SHA256SUMS 失败：%w", err)
	}
	expectedSum, ok := LookupSHA256(string(sumsBytes), assetName)
	if !ok {
		return StagedBotUpgrade{}, fmt.Errorf("SHA256SUMS 中未找到 %s 的校验条目", assetName)
	}

	stagedPath := filepath.Join(exeDir, stagedFilename(m.goos()))
	actualSum, err := m.downloadToFile(ctx, binURL, stagedPath)
	if err != nil {
		return StagedBotUpgrade{}, fmt.Errorf("下载新版本二进制失败：%w", err)
	}
	if actualSum != expectedSum {
		return StagedBotUpgrade{}, fmt.Errorf("SHA-256 校验不匹配（期望 %s，实际 %s），已拒绝替换", expectedSum[:12], actualSum[:12])
	}

	verifyOut, err := m.execCmd(ctx, 15*time.Second, stagedPath, "--version")
	if err != nil {
		return StagedBotUpgrade{}, fmt.Errorf("新二进制可执行性自检失败：%s", codex.RedactSensitive(err.Error()))
	}
	if !strings.Contains(strings.ToLower(verifyOut), "codex-bot") {
		return StagedBotUpgrade{}, fmt.Errorf("新二进制自检输出异常：%q", firstLine(verifyOut))
	}

	return StagedBotUpgrade{
		Changed:    true,
		ExePath:    exePath,
		StagedPath: stagedPath,
		OldVersion: cur,
		NewVersion: latest,
	}, nil
}

// CommitBotBinary backs up the running binary to `<exePath>.prev` and atomically swaps stagedPath into exePath.
func CommitBotBinary(exePath, stagedPath string) (string, error) {
	return commitBotBinaryForOS(runtime.GOOS, exePath, stagedPath)
}

func commitBotBinaryForOS(goos, exePath, stagedPath string) (string, error) {
	prevPath := exePath + ".prev"
	if goos == "windows" {
		if err := os.Rename(exePath, prevPath); err != nil {
			return "", fmt.Errorf("备份当前可执行文件失败：%w", err)
		}
		if err := os.Rename(stagedPath, exePath); err != nil {
			_ = os.Rename(prevPath, exePath)
			return "", fmt.Errorf("替换新可执行文件失败（已回滚旧文件）：%w", err)
		}
		return prevPath, nil
	}
	if err := copyExecutable(exePath, prevPath); err != nil {
		return "", fmt.Errorf("备份当前可执行文件失败：%w", err)
	}
	if err := os.Rename(stagedPath, exePath); err != nil {
		return "", fmt.Errorf("原子替换新可执行文件失败：%w", err)
	}
	return prevPath, nil
}

// RollbackBotBinary restores `<exePath>.prev` back to `exePath` if a post-commit restart fails.
func RollbackBotBinary(exePath string) error {
	return rollbackBotBinaryForOS(runtime.GOOS, exePath)
}

func rollbackBotBinaryForOS(goos, exePath string) error {
	prevPath := exePath + ".prev"
	info, err := os.Stat(prevPath)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return fmt.Errorf("未找到有效的旧版备份文件 %s", prevPath)
	}
	if goos == "windows" {
		return os.Rename(prevPath, exePath)
	}
	tmpPath := filepath.Join(filepath.Dir(exePath), ".codex-bot.rollback.tmp")
	if err := copyExecutable(prevPath, tmpPath); err != nil {
		return err
	}
	return os.Rename(tmpPath, exePath)
}

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, 0o755)
}

func stagedFilename(goos string) string {
	if goos == "windows" {
		return ".codex-bot.upgrade.new.exe"
	}
	return ".codex-bot.upgrade.new"
}

func (m *Manager) fetchLatestRelease(ctx context.Context) (ghRelease, error) {
	apiURL := fmt.Sprintf("%s/repos/%s/releases/latest", strings.TrimRight(m.githubAPIBase(), "/"), m.repo())
	body, err := m.httpGetBytesWithHeaders(ctx, apiURL, maxMetadataBytes, map[string]string{
		"Accept":     "application/vnd.github+json",
		"User-Agent": "codex-bot-updater",
	})
	if err != nil {
		return ghRelease{}, fmt.Errorf("查询 GitHub 最新版本失败：%w", err)
	}
	var rel ghRelease
	if err := json.Unmarshal(body, &rel); err != nil {
		return ghRelease{}, fmt.Errorf("解析 GitHub Release 响应失败：%w", err)
	}
	if strings.TrimSpace(rel.TagName) == "" {
		return ghRelease{}, errors.New("GitHub Release 未返回有效 tag_name")
	}
	return rel, nil
}

func (m *Manager) fetchLatestCLIVersion(ctx context.Context) (string, error) {
	escapedPkg := strings.ReplaceAll(url.PathEscape(CodexNPMPackage), "/", "%2f")
	regURL := fmt.Sprintf("%s/%s/latest", strings.TrimRight(m.npmRegistry(), "/"), escapedPkg)
	reqCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if body, err := m.httpGetBytesWithHeaders(reqCtx, regURL, maxMetadataBytes, map[string]string{
		"Accept":     "application/json",
		"User-Agent": "codex-bot-updater",
	}); err == nil {
		var meta struct {
			Version string `json:"version"`
		}
		if jsonErr := json.Unmarshal(body, &meta); jsonErr == nil {
			if sem, ok := ParseSemver(meta.Version); ok {
				return sem.String(), nil
			}
		}
	}

	// Fallback to local `npm view` (honors custom ~/.npmrc mirror registries).
	out, err := m.execCmd(ctx, 20*time.Second, m.npmBin(), "view", CodexNPMPackage, "version")
	if err != nil {
		return "", fmt.Errorf("查询 npm 最新版本失败：%s", codex.RedactSensitive(err.Error()))
	}
	if sem, ok := ParseSemver(firstLine(out)); ok {
		return sem.String(), nil
	}
	return "", fmt.Errorf("npm 返回了无法解析的版本号：%q", firstLine(out))
}

func (m *Manager) checkNPMWritable(ctx context.Context) (string, error) {
	out, err := m.execCmd(ctx, 10*time.Second, m.npmBin(), "config", "get", "prefix")
	if err != nil {
		return "", fmt.Errorf("无法执行 npm（请确认已安装 Node.js/npm 并在 PATH 中）：%s", codex.RedactSensitive(err.Error()))
	}
	prefix := firstLine(out)
	if prefix == "" || prefix == "undefined" {
		return "", errors.New("npm config get prefix 返回空路径")
	}

	var dirs []string
	if m.goos() == "windows" {
		dirs = []string{prefix, filepath.Join(prefix, "node_modules"), filepath.Join(prefix, "node_modules", "@openai", "codex")}
	} else {
		dirs = []string{
			prefix,
			filepath.Join(prefix, "bin"),
			filepath.Join(prefix, "lib"),
			filepath.Join(prefix, "lib", "node_modules"),
			filepath.Join(prefix, "lib", "node_modules", "@openai", "codex"),
		}
	}
	checked := 0
	for _, d := range dirs {
		info, statErr := os.Stat(d)
		if statErr != nil || !info.IsDir() {
			continue
		}
		checked++
		if wErr := checkDirWritable(d); wErr != nil {
			return prefix, wErr
		}
	}
	if checked == 0 {
		parent := filepath.Dir(prefix)
		if wErr := checkDirWritable(parent); wErr != nil {
			return prefix, wErr
		}
	}
	return prefix, nil
}

func (m *Manager) httpGetBytes(ctx context.Context, rawURL string, maxBytes int64) ([]byte, error) {
	return m.httpGetBytesWithHeaders(ctx, rawURL, maxBytes, map[string]string{
		"User-Agent": "codex-bot-updater",
	})
}

func (m *Manager) httpGetBytesWithHeaders(ctx context.Context, rawURL string, maxBytes int64, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("响应超出大小限制 (%d bytes)", maxBytes)
	}
	return data, nil
}

func (m *Manager) downloadToFile(ctx context.Context, rawURL, dstPath string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "codex-bot-updater")
	resp, err := m.httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return "", err
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(out, hasher), io.LimitReader(resp.Body, maxBinaryBytes+1))
	if copyErr != nil {
		_ = out.Close()
		return "", copyErr
	}
	if written == 0 {
		_ = out.Close()
		return "", errors.New("下载到的文件为空")
	}
	if written > maxBinaryBytes {
		_ = out.Close()
		return "", fmt.Errorf("二进制文件超出安全体积上限 (%d MiB)", maxBinaryBytes>>20)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(dstPath, 0o755); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func (m *Manager) resolveExePath() (string, error) {
	if p := strings.TrimSpace(m.ExePath); p != "" {
		if real, err := filepath.EvalSymlinks(p); err == nil && real != "" {
			return real, nil
		}
		return filepath.Abs(p)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil && real != "" {
		return real, nil
	}
	return filepath.Abs(exe)
}

func (m *Manager) execCmd(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	if m.RunCmd != nil {
		return m.RunCmd(ctx, timeout, name, args...)
	}
	return runScrubbedCmd(ctx, timeout, name, args...)
}

func runScrubbedCmd(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, name, args...)
	cmd.Env = scrubbedEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	combined := strings.TrimSpace(stdout.String())
	errText := strings.TrimSpace(stderr.String())
	if err != nil {
		if runCtx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("命令执行超时 (%s)", timeout)
		}
		if errText != "" {
			return "", fmt.Errorf("%s", firstLine(errText))
		}
		if combined != "" {
			return "", fmt.Errorf("%s", firstLine(combined))
		}
		return "", err
	}
	if combined != "" {
		return combined, nil
	}
	return errText, nil
}

// scrubbedEnv strips bot tokens and allowlists before invoking external tools (npm, binary verification).
func scrubbedEnv() []string {
	raw := os.Environ()
	env := make([]string, 0, len(raw)+2)
	for _, kv := range raw {
		k, _, _ := strings.Cut(kv, "=")
		if secretEnvKeys[strings.ToUpper(k)] {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "NO_COLOR=1", "NPM_CONFIG_UPDATE_NOTIFIER=false")
}

func (m *Manager) repo() string {
	if r := strings.TrimSpace(m.Repo); r != "" {
		return r
	}
	return DefaultRepo
}

func (m *Manager) githubAPIBase() string {
	if u := strings.TrimSpace(m.GitHubAPIBase); u != "" {
		return u
	}
	return DefaultGitHubAPI
}

func (m *Manager) npmRegistry() string {
	if u := strings.TrimSpace(m.NPMRegistry); u != "" {
		return u
	}
	return DefaultNPMRegistry
}

func (m *Manager) codexBin() string {
	if b := strings.TrimSpace(m.CodexBin); b != "" {
		return b
	}
	return "codex"
}

func (m *Manager) npmBin() string {
	if b := strings.TrimSpace(m.NPMBin); b != "" {
		return b
	}
	return "npm"
}

func (m *Manager) goos() string {
	if o := strings.TrimSpace(m.GOOS); o != "" {
		return o
	}
	return runtime.GOOS
}

func (m *Manager) goarch() string {
	if a := strings.TrimSpace(m.GOARCH); a != "" {
		return a
	}
	return runtime.GOARCH
}

func (m *Manager) httpClient() *http.Client {
	if m.HTTP != nil {
		return m.HTTP
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func botWriteHint(exePath string) string {
	dir := filepath.Dir(exePath)
	return fmt.Sprintf(
		"codex-bot 当前安装在 %s（目录 %s 对服务运行用户不可写）。\n"+
			"为保障安全不授予 sudo，可将二进制迁移至运行用户自有目录（如 ~/bin/codex-bot）并更新 systemd ExecStart，或手动执行 sudo sh deploy/upgrade.sh 升级。",
		exePath, dir,
	)
}

func npmWriteHint(prefix string, err error) string {
	if prefix == "" {
		return err.Error()
	}
	return fmt.Sprintf(
		"npm 全局目录 (%s) 当前运行用户无写入权限。\n"+
			"可在服务器上切到运行用户执行一次迁移，后续即可免 root 自动升级 Codex CLI：\n"+
			"mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global\n"+
			"echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.profile\n"+
			"npm install -g @openai/codex@latest",
		prefix,
	)
}
