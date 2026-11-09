package codex

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var (
	mcpNameRE      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	bearerSecretRE = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`)
	kvSecretRE     = regexp.MustCompile(`(?i)((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',;]{6,}`)
	skSecretRE     = regexp.MustCompile(`\b(xai-|sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{10,}`)
)

// ReservedMCPName is the internal MCP server name managed by codex-bot for
// interactive buttons and media tools; users cannot overwrite or remove it.
const ReservedMCPName = "codexbot"

// RedactSensitive masks bearer tokens, API keys, and key=value secrets.
func RedactSensitive(s string) string {
	s = bearerSecretRE.ReplaceAllString(s, "${1}[REDACTED]")
	s = kvSecretRE.ReplaceAllString(s, "${1}[REDACTED]")
	s = skSecretRE.ReplaceAllString(s, "${1}[REDACTED]")
	return s
}

func validMCPName(name string) bool {
	return !strings.HasPrefix(name, "-") && mcpNameRE.MatchString(name)
}

func validTransport(t string) bool {
	switch t {
	case "http", "sse", "stdio":
		return true
	}
	return false
}

// Version returns the installed Codex CLI version string.
func (c *Client) Version(ctx context.Context) (string, error) {
	return c.runQuick(ctx, 10*time.Second, "--version")
}

// MCPList lists configured MCP servers.
func (c *Client) MCPList(ctx context.Context) (string, error) {
	return c.runQuick(ctx, 15*time.Second, "mcp", "list")
}

// MCPDoctor checks MCP server health (falls back to `mcp list` if `doctor` is unsupported).
func (c *Client) MCPDoctor(ctx context.Context) (string, error) {
	out, err := c.runQuick(ctx, 30*time.Second, "mcp", "doctor")
	if err != nil {
		if listOut, listErr := c.runQuick(ctx, 15*time.Second, "mcp", "list"); listErr == nil {
			return listOut, nil
		}
	}
	return out, err
}

// MCPAdd registers a new MCP server.
func (c *Client) MCPAdd(ctx context.Context, transport, name, target string, extraArgs []string) (string, error) {
	if !validTransport(transport) {
		return "", errors.New("invalid transport (expected http, sse, or stdio)")
	}
	if !validMCPName(name) {
		return "", errors.New("invalid server name (use letters, digits, '-' or '_')")
	}
	if strings.EqualFold(name, ReservedMCPName) {
		return "", errors.New("server name 'codexbot' is reserved")
	}
	target = strings.TrimSpace(target)
	if target == "" || strings.HasPrefix(target, "-") {
		return "", errors.New("invalid target URL or command")
	}
	for _, a := range extraArgs {
		if strings.ContainsRune(a, 0) {
			return "", errors.New("invalid argument")
		}
	}
	if transport == "stdio" {
		args := []string{"mcp", "add", name, "--", target}
		args = append(args, extraArgs...)
		return c.runQuick(ctx, 15*time.Second, args...)
	}
	args := []string{"mcp", "add", "--transport", transport, name, target}
	if len(extraArgs) > 0 {
		args = append(args, "--")
		args = append(args, extraArgs...)
	}
	return c.runQuick(ctx, 15*time.Second, args...)
}

// MCPRemove unregisters an MCP server by name.
func (c *Client) MCPRemove(ctx context.Context, name string) (string, error) {
	if !validMCPName(name) {
		return "", errors.New("invalid server name")
	}
	if strings.EqualFold(name, ReservedMCPName) {
		return "", errors.New("server name 'codexbot' is reserved")
	}
	return c.runQuick(ctx, 15*time.Second, "mcp", "remove", name)
}

// MCPEnable enables or disables an MCP server by name.
func (c *Client) MCPEnable(ctx context.Context, name string, enable bool) (string, error) {
	if !validMCPName(name) {
		return "", errors.New("invalid server name")
	}
	if strings.EqualFold(name, ReservedMCPName) {
		return "", errors.New("server name 'codexbot' is reserved")
	}
	sub := "disable"
	if enable {
		sub = "enable"
	}
	return c.runQuick(ctx, 15*time.Second, "mcp", sub, name)
}

func (c *Client) runQuick(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, c.bin(), args...)
	if c.Workspace != "" {
		cmd.Dir = c.Workspace
	}
	cmd.Env = envWithoutUpdate()
	out, err := cmd.CombinedOutput()
	clean := strings.TrimSpace(ansiRE.ReplaceAllString(string(out), ""))
	clean = RedactSensitive(clean)
	if err != nil {
		if clean != "" {
			return "", errors.New(clean)
		}
		return "", errors.New("codex command failed")
	}
	return clean, nil
}
