package codex

import (
	"strings"
	"testing"
)

func TestParseStreamCodexJSONL(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"thread.started","thread_id":"019d57be-6612-77f2-8c53-9178f0302558"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls -la"}}`,
		`{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"codexbot","tool":"react","arguments":{"emoji":"👍"}}}`,
		`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"First part"}}`,
		`{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Second part"}}`,
		`{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":250,"reasoning_output_tokens":50}}`,
	}, "\n")

	var tools []string
	res, err := ParseStream(strings.NewReader(stream), func(tu ToolUse) {
		tools = append(tools, tu.Name)
	})
	if err != nil {
		t.Fatalf("ParseStream: %v", err)
	}
	if res.SessionID != "019d57be-6612-77f2-8c53-9178f0302558" {
		t.Fatalf("SessionID = %q", res.SessionID)
	}
	if res.Text != "First part\n\nSecond part" {
		t.Fatalf("Text = %q", res.Text)
	}
	if len(tools) != 2 || tools[0] != "Bash" || tools[1] != "mcp__codexbot__react" {
		t.Fatalf("tools = %v", tools)
	}
	if res.Usage == nil || res.Usage.InputTokens == nil || *res.Usage.InputTokens != 1000 || res.Usage.OutputTokens == nil || *res.Usage.OutputTokens != 250 {
		t.Fatalf("Usage = %+v", res.Usage)
	}
}

func TestParseStreamTurnFailed(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"thread.started","thread_id":"t_123"}`,
		`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"partial reply"}}`,
		`{"type":"turn.failed","error":{"message":"rate limit reached"}}`,
	}, "\n")

	_, err := ParseStream(strings.NewReader(stream), nil)
	if err == nil {
		t.Fatal("expected error on turn.failed")
	}
	re, ok := err.(*RunError)
	if !ok {
		t.Fatalf("expected *RunError, got %T", err)
	}
	if re.SessionID != "t_123" || re.PartialText != "partial reply" || re.Message != "rate limit reached" {
		t.Fatalf("unexpected RunError: %+v", re)
	}
}

func TestParseStreamTopLevelErrorStringMessage(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"thread.started","thread_id":"t_456"}`,
		`{"type":"error","message":"Reconnecting... 1/5"}`,
		`{"type":"error","message":"invalid_request_error: unknown model"}`,
	}, "\n")

	_, err := ParseStream(strings.NewReader(stream), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	re, ok := err.(*RunError)
	if !ok {
		t.Fatalf("expected *RunError, got %T", err)
	}
	if re.Message != "invalid_request_error: unknown model" || re.SessionID != "t_456" {
		t.Fatalf("unexpected RunError: %+v", re)
	}
}
