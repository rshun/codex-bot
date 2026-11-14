package codex

import (
	"context"
	"strings"
	"testing"
)

func TestRedactSensitive(t *testing.T) {
	in := "Authorization: Bearer your_token_here and api_key=your_api_key_here and sk-proj_placeholder_1234 and https://api.telegram.org/bot123456789:AAFakeUnitTestPlaceholderToken/getUpdates"
	out := RedactSensitive(in)
	for _, leak := range []string{"your_token_here", "your_api_key_here", "proj_placeholder_1234", "AAFakeUnitTestPlaceholderToken"} {
		if strings.Contains(out, leak) {
			t.Fatalf("failed to redact %q in: %s", leak, out)
		}
	}
	if !strings.Contains(out, "bot123456789:****/getUpdates") {
		t.Fatalf("expected bot<id>:**** redaction, got: %s", out)
	}
}

func TestFormatMCPList(t *testing.T) {
	jsonInput := `[
		{"name": "Theseus-mcp", "url": "https://internal.example.com/mcp", "enabled": true},
		{"name": "rag-mcp", "url": "http://10.0.0.8:8080/mcp", "enabled": false},
		{"name": "fetch", "command": "uvx", "args": ["mcp-server-fetch"], "enabled": true},
		{"name": "codexbot", "url": "http://127.0.0.1:41234/mcp", "enabled": true}
	]`
	want := "Theseus-mcp\nrag-mcp (disabled)\nfetch"
	if got := FormatMCPList(jsonInput); got != want {
		t.Fatalf("FormatMCPList(json) = %q, want %q", got, want)
	}

	colonInput := "  Theseus-mcp: https://internal.example.com/mcp\n  rag-mcp: http://10.0.0.8:8080/mcp (disabled)\n  fetch: uvx mcp-server-fetch\n  codexbot: http://127.0.0.1:41234/mcp\n"
	if got := FormatMCPList(colonInput); got != want {
		t.Fatalf("FormatMCPList(colon) = %q, want %q", got, want)
	}

	tableInput := strings.Join([]string{
		"Configured MCP Servers:",
		"+-------------+----------+----------------------------------+",
		"| Name        | Status   | Url                              |",
		"+-------------+----------+----------------------------------+",
		"| Theseus-mcp | enabled  | https://internal.example.com/mcp |",
		"| rag-mcp     | disabled | http://10.0.0.8:8080/mcp         |",
		"| fetch       | enabled  | uvx mcp-server-fetch             |",
		"| codexbot    | enabled  | http://127.0.0.1:41234/mcp       |",
		"+-------------+----------+----------------------------------+",
	}, "\n")
	if got := FormatMCPList(tableInput); got != want {
		t.Fatalf("FormatMCPList(table) = %q, want %q", got, want)
	}

	spaceTableInput := strings.Join([]string{
		"Name          Url                               Status",
		"Theseus-mcp   https://internal.example.com/mcp  enabled",
		"rag-mcp       http://10.0.0.8:8080/mcp          disabled",
		"fetch         uvx mcp-server-fetch              enabled",
		"codexbot      http://127.0.0.1:41234/mcp        enabled",
	}, "\n")
	if got := FormatMCPList(spaceTableInput); got != want {
		t.Fatalf("FormatMCPList(spaceTable) = %q, want %q", got, want)
	}

	for _, emptyCase := range []string{
		"",
		"[]",
		`{"servers":[]}`,
		`[{"name":"codexbot","enabled":true}]`,
		"No MCP servers configured yet. Try `codex mcp add`.",
	} {
		if got := FormatMCPList(emptyCase); got != "" {
			t.Fatalf("FormatMCPList(%q) = %q, want empty", emptyCase, got)
		}
	}
}

func TestMCPValidationAndReservedName(t *testing.T) {
	c := &Client{Bin: "codex"}
	ctx := context.Background()

	if _, err := c.MCPAdd(ctx, []string{"codexbot", "--", "npx"}); err == nil || !strings.Contains(err.Error(), "codexbot") {
		t.Fatalf("expected reserved name error, got %v", err)
	}
	if _, err := c.MCPRemove(ctx, "codexbot"); err == nil || !strings.Contains(err.Error(), "codexbot") {
		t.Fatalf("expected reserved name error on remove, got %v", err)
	}
	if _, err := c.MCPEnable(ctx, "codexbot", false); err == nil || !strings.Contains(err.Error(), "codexbot") {
		t.Fatalf("expected reserved name error on enable/disable, got %v", err)
	}
	if _, err := c.MCPAdd(ctx, []string{"-flag", "https://example.com"}); err == nil {
		t.Fatal("expected invalid server name error")
	}
}
