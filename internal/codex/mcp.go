package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var (
	reBearerSecret = regexp.MustCompile(`(?i)\b(Bearer\s+)([^\s"',;]+)`)
	reTokenPrefix  = regexp.MustCompile(`\b(sk|xai|ghp|gho|github_pat|glpat|xoxb|xoxp)-[A-Za-z0-9_\-]{6,}`)
	reBotURLToken  = regexp.MustCompile(`\b(bot\d+:)[A-Za-z0-9_\-]{10,}`)
	reSecretKV     = regexp.MustCompile(`(?i)\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential)[A-Za-z0-9_]*)\s*([=:])\s*([^\s"',;\n]+)`)
	reParenURL     = regexp.MustCompile(`(?i)\(\s*(?:https?:\s*)?https?://[^)\s]+\s*\)`)
	reHTTPURL      = regexp.MustCompile(`https?://\S+`)
	reMultiSpace   = regexp.MustCompile(`\s{2,}`)
)

// ReservedMCPName is the internal MCP server name managed by codex-bot for
// interactive buttons and media tools; users cannot overwrite or remove it.
const ReservedMCPName = "codexbot"

func isReservedMCPName(name string) bool {
	return strings.EqualFold(name, ReservedMCPName) || strings.EqualFold(name, "grokbot")
}

// RedactSensitive masks tokens, API keys, passwords, and auth headers in CLI outputs.
func RedactSensitive(text string) string {
	if text == "" {
		return ""
	}
	out := reBearerSecret.ReplaceAllString(text, "${1}****")
	out = reTokenPrefix.ReplaceAllString(out, "${1}-****")
	out = reBotURLToken.ReplaceAllString(out, "${1}****")
	out = reSecretKV.ReplaceAllStringFunc(out, func(m string) string {
		sub := reSecretKV.FindStringSubmatch(m)
		if len(sub) != 4 {
			return m
		}
		if strings.EqualFold(sub[3], "bearer") {
			return m
		}
		return sub[1] + sub[2] + " ****"
	})
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// Version returns the installed Codex CLI version string.
func (c *Client) Version(ctx context.Context) (string, error) {
	out, err := c.runAdmin(ctx, 10*time.Second, "--version")
	if err != nil {
		return "", err
	}
	return firstLine(out), nil
}

// MCPList returns configured MCP server names without exposing URLs or launch arguments.
func (c *Client) MCPList(ctx context.Context) (string, error) {
	if out, err := c.runAdmin(ctx, 20*time.Second, "mcp", "list", "--json"); err == nil {
		return FormatMCPList(out), nil
	}
	out, err := c.runAdmin(ctx, 20*time.Second, "mcp", "list")
	if err != nil {
		return "", err
	}
	return FormatMCPList(out), nil
}

type mcpListEntry struct {
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled"`
	Status  string `json:"status"`
}

// FormatMCPList extracts MCP server names from `codex mcp list` JSON, table, or text output,
// filtering reserved internal channels and stripping all URLs and command arguments.
func FormatMCPList(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "[") {
		var entries []mcpListEntry
		if err := json.Unmarshal([]byte(trimmed), &entries); err == nil {
			return formatMCPEntries(entries)
		}
	}
	if strings.HasPrefix(trimmed, "{") {
		var wrapped struct {
			Servers []mcpListEntry `json:"servers"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapped); err == nil && wrapped.Servers != nil {
			return formatMCPEntries(wrapped.Servers)
		}
	}
	lowerTrimmed := strings.ToLower(trimmed)
	if strings.HasPrefix(lowerTrimmed, "no mcp servers") || strings.HasPrefix(lowerTrimmed, "no mcp server") {
		return ""
	}

	var lines []string
	inSpaceTable := false
	for _, rawLine := range strings.Split(trimmed, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || isTableRuleLine(line) {
			continue
		}
		if strings.HasSuffix(line, ":") {
			inSpaceTable = false
			continue
		}
		if strings.HasPrefix(line, "|") || strings.HasPrefix(line, "│") {
			name, disabled, header := parsePipeTableRow(line)
			if header || name == "" || isReservedMCPName(name) {
				continue
			}
			lines = append(lines, formatMCPName(name, disabled))
			continue
		}
		if cols := reMultiSpace.Split(line, -1); len(cols) >= 2 {
			if isSpaceTableHeader(cols) {
				inSpaceTable = true
				continue
			}
			if inSpaceTable {
				name := strings.TrimSpace(cols[0])
				if name == "" || isReservedMCPName(name) {
					continue
				}
				disabled := false
				for _, col := range cols[1:] {
					c := strings.Trim(strings.TrimSpace(col), "()")
					if strings.EqualFold(c, "disabled") {
						disabled = true
						break
					}
				}
				lines = append(lines, formatMCPName(name, disabled))
				continue
			}
		}
		if idx := strings.IndexByte(line, ':'); idx > 0 && !strings.ContainsAny(line[:idx], " \t(") {
			name := strings.TrimSpace(line[:idx])
			rest := strings.TrimSpace(line[idx+1:])
			if name == "" || rest == "" || isReservedMCPName(name) {
				continue
			}
			disabled := strings.HasSuffix(strings.ToLower(rest), "(disabled)") || strings.EqualFold(rest, "disabled")
			lines = append(lines, formatMCPName(name, disabled))
			continue
		}
		cleaned := reParenURL.ReplaceAllString(line, "")
		cleaned = reHTTPURL.ReplaceAllString(cleaned, "")
		fields := strings.Fields(cleaned)
		if len(fields) == 0 {
			continue
		}
		name := strings.TrimSpace(fields[0])
		if name == "" || isReservedMCPName(name) {
			continue
		}
		disabled := false
		for _, tok := range fields[1:] {
			if strings.EqualFold(strings.Trim(tok, "()"), "disabled") {
				disabled = true
				break
			}
		}
		lines = append(lines, formatMCPName(name, disabled))
	}
	return strings.Join(lines, "\n")
}

func formatMCPEntries(entries []mcpListEntry) string {
	var lines []string
	for _, e := range entries {
		name := strings.TrimSpace(e.Name)
		if name == "" || isReservedMCPName(name) {
			continue
		}
		disabled := (e.Enabled != nil && !*e.Enabled) || strings.EqualFold(strings.TrimSpace(e.Status), "disabled")
		lines = append(lines, formatMCPName(name, disabled))
	}
	return strings.Join(lines, "\n")
}

func formatMCPName(name string, disabled bool) string {
	if disabled {
		return name + " (disabled)"
	}
	return name
}

func isTableRuleLine(line string) bool {
	for _, r := range line {
		switch r {
		case '+', '-', '=', '_', '|', '│', '─', '━', '┼', '├', '┤', '┌', '┐', '└', '┘', '┬', '┴', ' ':
		default:
			return false
		}
	}
	return true
}

func parsePipeTableRow(line string) (name string, disabled bool, isHeader bool) {
	normalized := strings.ReplaceAll(line, "│", "|")
	rawCols := strings.Split(normalized, "|")
	var cols []string
	for _, c := range rawCols {
		c = strings.TrimSpace(c)
		if c != "" {
			cols = append(cols, c)
		}
	}
	if len(cols) == 0 {
		return "", false, false
	}
	if isSpaceTableHeader(cols) {
		return "", false, true
	}
	for _, col := range cols[1:] {
		if strings.EqualFold(strings.Trim(col, "()"), "disabled") {
			disabled = true
			break
		}
	}
	return cols[0], disabled, false
}

func isSpaceTableHeader(cols []string) bool {
	if len(cols) < 2 || !strings.EqualFold(strings.TrimSpace(cols[0]), "name") {
		return false
	}
	for _, col := range cols[1:] {
		switch strings.ToLower(strings.TrimSpace(col)) {
		case "status", "url", "command", "args", "env", "cwd", "transport", "enabled", "auth", "working directory":
			return true
		}
	}
	return false
}

// MCPDoctor diagnoses MCP server configuration and handshake connectivity.
func (c *Client) MCPDoctor(ctx context.Context, name string) (string, error) {
	args := []string{"mcp", "doctor"}
	name = strings.TrimSpace(name)
	if name != "" {
		if err := checkMCPName(name); err != nil {
			return "", err
		}
		args = append(args, name)
	}
	out, err := c.runAdmin(ctx, 45*time.Second, args...)
	if err != nil {
		if trimmed := strings.TrimSpace(RedactSensitive(out)); trimmed != "" {
			return trimmed, nil
		}
		if listOut, listErr := c.MCPList(ctx); listErr == nil && listOut != "" {
			return listOut, nil
		}
		return "", err
	}
	return strings.TrimSpace(RedactSensitive(out)), nil
}

// MCPAdd adds or updates a user-scoped MCP server and resets the codex leader daemon.
func (c *Client) MCPAdd(ctx context.Context, rawArgs []string) (string, error) {
	built, err := buildMCPAddArgs(rawArgs)
	if err != nil {
		return "", err
	}
	out, err := c.runAdmin(ctx, 25*time.Second, built...)
	if err != nil {
		return "", err
	}
	c.ResetLeader(ctx)
	return strings.TrimSpace(RedactSensitive(out)), nil
}

// MCPRemove removes a user-scoped MCP server and resets the codex leader daemon.
func (c *Client) MCPRemove(ctx context.Context, name string) (string, error) {
	name = strings.TrimSpace(name)
	if err := checkMCPName(name); err != nil {
		return "", err
	}
	out, err := c.runAdmin(ctx, 15*time.Second, "mcp", "remove", name)
	if err != nil {
		return "", err
	}
	c.ResetLeader(ctx)
	return strings.TrimSpace(RedactSensitive(out)), nil
}

// MCPEnable enables or disables an MCP server and resets the codex leader daemon.
func (c *Client) MCPEnable(ctx context.Context, name string, enable bool) (string, error) {
	name = strings.TrimSpace(name)
	if err := checkMCPName(name); err != nil {
		return "", err
	}
	sub := "disable"
	if enable {
		sub = "enable"
	}
	out, err := c.runAdmin(ctx, 15*time.Second, "mcp", sub, name)
	if err != nil {
		return "", err
	}
	c.ResetLeader(ctx)
	return strings.TrimSpace(RedactSensitive(out)), nil
}

func checkMCPName(name string) error {
	if name == "" {
		return errors.New("请指定 MCP 服务名称。")
	}
	if strings.HasPrefix(name, "-") {
		return errors.New("MCP 服务名称不能以 - 开头。")
	}
	if isReservedMCPName(name) {
		return errors.New("codexbot 是机器人内置通信通道，不能修改或删除。")
	}
	return nil
}

func buildMCPAddArgs(rawArgs []string) ([]string, error) {
	if len(rawArgs) == 0 {
		return nil, errors.New("参数不足。")
	}
	var opts []string
	var pos []string
	var afterDashDash []string
	hasDashDash := false

	for i := 0; i < len(rawArgs); i++ {
		tok := rawArgs[i]
		if hasDashDash {
			afterDashDash = append(afterDashDash, tok)
			continue
		}
		if tok == "--" {
			hasDashDash = true
			continue
		}
		switch {
		case tok == "-s" || tok == "--scope" || strings.HasPrefix(tok, "--scope="):
			return nil, errors.New("无需指定 --scope，默认固定写入当前用户的 ~/.codex/config.toml。")
		case tok == "--leader-socket" || strings.HasPrefix(tok, "--leader-socket=") ||
			tok == "--debug-file" || strings.HasPrefix(tok, "--debug-file="):
			return nil, errors.New("不允许传递该底层调试参数。")
		case tok == "-t" || tok == "--transport" || tok == "-e" || tok == "--env" || tok == "-H" || tok == "--header":
			if i+1 >= len(rawArgs) {
				return nil, fmt.Errorf("参数 %s 缺少对应的值。", tok)
			}
			opts = append(opts, tok, rawArgs[i+1])
			i++
		case strings.HasPrefix(tok, "--transport=") || strings.HasPrefix(tok, "--env=") || strings.HasPrefix(tok, "--header="):
			opts = append(opts, tok)
		case strings.HasPrefix(tok, "-"):
			return nil, fmt.Errorf("不支持的选项：%s", tok)
		default:
			pos = append(pos, tok)
		}
	}

	if len(pos) == 0 {
		return nil, errors.New("请提供 MCP 名称和地址/启动命令。")
	}
	name := pos[0]
	if err := checkMCPName(name); err != nil {
		return nil, err
	}
	restPos := pos[1:]
	if len(restPos) == 0 && len(afterDashDash) == 0 {
		return nil, errors.New("请提供 MCP 的 HTTP/SSE URL 或本地启动命令。")
	}

	built := []string{"mcp", "add"}
	built = append(built, opts...)
	built = append(built, name)

	if hasDashDash {
		built = append(built, restPos...)
		if len(afterDashDash) > 0 {
			built = append(built, "--")
			built = append(built, afterDashDash...)
		}
		return built, nil
	}

	target := restPos[0]
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		if len(restPos) > 1 {
			return nil, errors.New("远程 URL 模式只需要一个地址参数；请求头请用 -H \"Header: Value\"。")
		}
		built = append(built, "--url", target)
		return built, nil
	}
	built = append(built, "--")
	built = append(built, restPos...)
	return built, nil
}

func (c *Client) runAdmin(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	bin := c.bin()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = envWithoutUpdate()
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cmd.Dir = home
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	combined := strings.TrimSpace(ansiRE.ReplaceAllString(stdout.String(), ""))
	if combined == "" {
		combined = strings.TrimSpace(ansiRE.ReplaceAllString(stderr.String(), ""))
	} else if se := strings.TrimSpace(ansiRE.ReplaceAllString(stderr.String(), "")); se != "" {
		combined = combined + "\n" + se
	}
	if err != nil {
		if ctx.Err() != nil {
			return combined, ctx.Err()
		}
		detail := firstLine(RedactSensitive(stderr.String()))
		if detail == "" {
			detail = firstLine(RedactSensitive(stdout.String()))
		}
		if detail != "" {
			return combined, &RunError{Message: detail}
		}
		return combined, err
	}
	return combined, nil
}
