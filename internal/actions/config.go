package actions

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// marker is the first line of a config file the bot owns and may rewrite.
const marker = "# managed by codex-bot; do not edit"

// TokenEnv is the environment variable that carries the per-turn token to codex.
const TokenEnv = "CODEXBOT_TURN_TOKEN"

// ErrUnmanaged means the config file exists but was not written by the bot.
var ErrUnmanaged = errors.New("config.toml 不是 bot 生成的")

// renderConfig returns the codex config that points the codexbot MCP server at port.
// Codex reads the bearer token from the environment variable named in bearer_token_env_var.
func renderConfig(port int) string {
	var b strings.Builder
	b.WriteString(marker + "\n")
	b.WriteString("[mcp_servers.codexbot]\n")
	fmt.Fprintf(&b, "url = \"http://127.0.0.1:%d/mcp\"\n", port)
	b.WriteString("bearer_token_env_var = \"" + TokenEnv + "\"\n")
	b.WriteString("headers = { Authorization = \"Bearer ${" + TokenEnv + "}\" }\n")
	return b.String()
}

// WriteConfig writes the codex project config at path. It refuses to replace a
// file the bot did not write.
func WriteConfig(path string, port int) error {
	current, err := os.ReadFile(path)
	switch {
	case err == nil:
		if !strings.HasPrefix(string(current), marker+"\n") {
			return ErrUnmanaged
		}
	case !errors.Is(err, os.ErrNotExist):
		return err
	}
	content := renderConfig(port)
	if string(current) == content {
		return nil
	}
	return writeAtomic(path, content)
}

// writeAtomic replaces the file at path in one rename.
func writeAtomic(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.toml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
