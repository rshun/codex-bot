package codex

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestBuildArgsAndPermissions(t *testing.T) {
	c := &Client{DefaultModel: "gpt-5.4", InboxDir: t.TempDir()}

	t.Run("default read-only no search", func(t *testing.T) {
		args, cleanup, err := c.buildArgs(ReplyOptions{
			Model:     "gpt-5.4",
			WebSearch: false,
			Sandbox:   "workspace-write",
		})
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()

		if len(args) < 3 || args[0] != "exec" || args[1] != "--json" {
			t.Fatalf("expected exec --json, got %v", args)
		}
		if !slices.Contains(args, `sandbox_mode="read-only"`) {
			t.Fatalf("expected -c sandbox_mode=\"read-only\", got %v", args)
		}
		if !slices.Contains(args, `web_search="disabled"`) {
			t.Fatalf("expected web_search disabled, got %v", args)
		}
		if !slices.Contains(args, "shell_tool") {
			t.Fatalf("expected --disable shell_tool, got %v", args)
		}
		if args[len(args)-1] != "-" {
			t.Fatalf("expected trailing '-' stdin arg, got %v", args)
		}
	})

	t.Run("resume existing session with write dirs and shell", func(t *testing.T) {
		args, cleanup, err := c.buildArgs(ReplyOptions{
			SessionID:  "thread_abc",
			Model:      "gpt-5.4",
			WebSearch:  true,
			WriteDirs:  []string{"/tmp/work"},
			ShellTools: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()

		if len(args) < 2 || args[0] != "exec" || args[1] != "resume" {
			t.Fatalf("expected exec resume, got %v", args)
		}
		if !slices.Contains(args, `sandbox_mode="workspace-write"`) {
			t.Fatalf("expected -c sandbox_mode=\"workspace-write\", got %v", args)
		}
		if !slices.Contains(args, `sandbox_workspace_write.writable_roots=["/tmp/work"]`) {
			t.Fatalf("expected writable_roots override, got %v", args)
		}
		if slices.Contains(args, "shell_tool") {
			t.Fatalf("did not expect --disable shell_tool when ShellTools=true: %v", args)
		}
		if args[len(args)-2] != "thread_abc" || args[len(args)-1] != "-" {
			t.Fatalf("expected session id followed by '-', got %v", args)
		}
	})

	t.Run("json schema writes temp file and cleans up", func(t *testing.T) {
		args, cleanup, err := c.buildArgs(ReplyOptions{
			Model:      "gpt-5.4",
			JSONSchema: `{"type":"object"}`,
		})
		if err != nil {
			t.Fatal(err)
		}
		idx := slices.Index(args, "--output-schema")
		if idx < 0 || idx+1 >= len(args) {
			cleanup()
			t.Fatalf("expected --output-schema in %v", args)
		}
		schemaPath := args[idx+1]
		data, err := os.ReadFile(schemaPath)
		if err != nil {
			cleanup()
			t.Fatalf("expected schema file to exist: %v", err)
		}
		if string(data) != `{"type":"object"}` {
			cleanup()
			t.Fatalf("unexpected schema content: %s", string(data))
		}
		cleanup()
		if _, err := os.Stat(schemaPath); !os.IsNotExist(err) {
			t.Fatalf("expected schema file to be removed after cleanup")
		}
	})

	t.Run("attached images write temp files and clean up", func(t *testing.T) {
		args, cleanup, err := c.buildArgs(ReplyOptions{
			Model: "gpt-5.4",
			Images: []Image{
				{MIME: "image/png", Data: []byte("PNGDATA")},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		idx := slices.Index(args, "-i")
		if idx < 0 || idx+1 >= len(args) {
			cleanup()
			t.Fatalf("expected -i in %v", args)
		}
		imgPath := args[idx+1]
		if !strings.HasSuffix(imgPath, ".png") {
			cleanup()
			t.Fatalf("expected .png suffix, got %s", imgPath)
		}
		cleanup()
		if _, err := os.Stat(imgPath); !os.IsNotExist(err) {
			t.Fatalf("expected image temp file to be removed after cleanup")
		}
	})
}

func TestSystemPromptForFeatures(t *testing.T) {
	sp := systemPromptFor(ReplyOptions{
		WebSearch:    true,
		Actions:      true,
		React:        true,
		SendFile:     true,
		Pronounce:    true,
		SendWebImage: true,
		Memories:     []string{"User prefers Go", "line1\nline2"},
	})
	for _, want := range []string{
		"codexbot__propose_actions",
		"codexbot__react",
		"codexbot__send_file",
		"codexbot__pronounce",
		"codexbot__send_web_image",
		"- User prefers Go",
		"- line1 line2",
	} {
		if !strings.Contains(sp, want) {
			t.Fatalf("expected %q in system prompt, got:\n%s", want, sp)
		}
	}
}

func TestResetLeader(t *testing.T) {
	dir := t.TempDir()
	codexDir := filepath.Join(dir, ".codex")
	if err := os.MkdirAll(codexDir, 0o700); err != nil {
		t.Fatal(err)
	}
	leader := filepath.Join(codexDir, "leader.json")
	if err := os.WriteFile(leader, []byte(`{"epoch":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c := &Client{Workspace: dir}
	c.ResetLeader(t.Context())
	if _, err := os.Stat(leader); !os.IsNotExist(err) {
		t.Fatalf("expected leader.json to be removed")
	}
}

func TestEnvWithoutUpdateScrubsSecrets(t *testing.T) {
	t.Setenv("TELEGRAM_BOT_TOKEN", "test_tg_token_placeholder")
	t.Setenv("DISCORD_BOT_TOKEN", "test_dc_token_placeholder")
	t.Setenv("SAFE_VAR_FOR_TEST", "keep_me")

	env := envWithoutUpdate()
	for _, kv := range env {
		if strings.HasPrefix(kv, "TELEGRAM_BOT_TOKEN=") || strings.HasPrefix(kv, "DISCORD_BOT_TOKEN=") {
			t.Fatalf("secret leaked into subprocess env: %s", kv)
		}
	}
	if !slices.Contains(env, "SAFE_VAR_FOR_TEST=keep_me") {
		t.Fatalf("expected SAFE_VAR_FOR_TEST to be preserved")
	}
	if !slices.Contains(env, "NO_COLOR=1") {
		t.Fatalf("expected NO_COLOR=1 in env")
	}
}
