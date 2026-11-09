package codex

import (
	"context"
	"strings"
	"testing"
)

func TestRedactSensitive(t *testing.T) {
	in := "Authorization: Bearer secret_token_123456 and api_key=my_secret_value and sk-proj1234567890abcd"
	out := RedactSensitive(in)
	if strings.Contains(out, "secret_token_123456") || strings.Contains(out, "my_secret_value") || strings.Contains(out, "proj1234567890abcd") {
		t.Fatalf("failed to redact secrets: %s", out)
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
