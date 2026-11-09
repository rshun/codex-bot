package codex

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"

	"github.com/rshun/codex-bot/internal/store"
)

// ToolUse represents a single tool invocation emitted by the CLI during a turn.
type ToolUse struct {
	Name  string
	Input json.RawMessage
}

// ParseStream consumes `--json` / `stream-json` JSONL from r, invokes onTool for
// each tool invocation observed, and returns the final HeadlessResult.
// It supports both Codex CLI JSONL events (`thread.started`, `item.started`,
// `item.completed`, `turn.completed`, `turn.failed`, `error`) and Grok-style
// stream-json events (`assistant`, `user`, `result`, `error`).
func ParseStream(r io.Reader, onTool func(ToolUse)) (HeadlessResult, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var (
		res           HeadlessResult
		lastAssistant string
		agentMessages []string
		seenItems     = make(map[string]bool)
		seenImages    = make(map[string]bool)
		gotFinal      bool
	)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var ev streamEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		if ev.SessionID != "" {
			res.SessionID = ev.SessionID
		}
		if ev.ThreadID != "" {
			res.SessionID = ev.ThreadID
		}

		switch ev.Type {
		case "thread.started":
			if ev.ThreadID != "" {
				res.SessionID = ev.ThreadID
			}

		case "item.started", "item.completed":
			if ev.Item == nil {
				continue
			}
			item := ev.Item
			switch item.Type {
			case "command_execution":
				if onTool != nil && item.ID != "" && !seenItems[item.ID] {
					seenItems[item.ID] = true
					inp, _ := json.Marshal(map[string]string{"command": item.Command})
					onTool(ToolUse{Name: "Bash", Input: inp})
				} else if onTool != nil && item.ID == "" && ev.Type == "item.started" {
					inp, _ := json.Marshal(map[string]string{"command": item.Command})
					onTool(ToolUse{Name: "Bash", Input: inp})
				}
			case "mcp_tool_call":
				if onTool != nil && (item.ID == "" || !seenItems[item.ID]) {
					if item.ID != "" {
						seenItems[item.ID] = true
					}
					name := item.Tool
					if item.Server != "" && item.Tool != "" && !strings.Contains(item.Tool, "__") {
						name = "mcp__" + item.Server + "__" + item.Tool
					}
					inp := item.Arguments
					if len(inp) == 0 {
						inp = json.RawMessage(`{}`)
					}
					onTool(ToolUse{Name: name, Input: inp})
				}
			case "web_search", "web_search_call":
				if onTool != nil && (item.ID == "" || !seenItems[item.ID]) {
					if item.ID != "" {
						seenItems[item.ID] = true
					}
					inp, _ := json.Marshal(map[string]string{"query": item.Query})
					onTool(ToolUse{Name: "web_search", Input: inp})
				}
			case "agent_message":
				if ev.Type == "item.completed" && strings.TrimSpace(item.Text) != "" {
					agentMessages = append(agentMessages, strings.TrimSpace(item.Text))
					lastAssistant = strings.TrimSpace(item.Text)
				}
			}

		case "turn.completed":
			if ev.Usage != nil {
				res.Usage = NormalizeUsage(ev.Usage)
			}
			if len(agentMessages) > 0 {
				res.Text = strings.Join(agentMessages, "\n\n")
				if strings.HasPrefix(strings.TrimSpace(res.Text), "{") && len(res.Structured) == 0 {
					var js json.RawMessage
					if json.Unmarshal([]byte(strings.TrimSpace(res.Text)), &js) == nil {
						res.Structured = js
					}
				}
			}
			gotFinal = true

		case "turn.failed":
			msg := extractErrorMessage(ev.Error, ev.Message, ev.Result, "")
			return HeadlessResult{}, &RunError{
				Message:     msg,
				SessionID:   res.SessionID,
				PartialText: strings.TrimSpace(lastAssistant),
			}

		case "assistant":
			if ev.MessageBody == nil {
				continue
			}
			var textParts []string
			for _, c := range ev.MessageBody.Content {
				switch c.Type {
				case "tool_use":
					if onTool != nil && c.Name != "" {
						onTool(ToolUse{Name: c.Name, Input: c.Input})
					}
				case "text":
					if c.Text != "" {
						textParts = append(textParts, c.Text)
					}
				}
			}
			if len(textParts) > 0 {
				lastAssistant = strings.Join(textParts, "")
			}

		case "user":
			if ev.MessageBody == nil {
				continue
			}
			for _, c := range ev.MessageBody.Content {
				if c.Type != "tool_result" || len(c.Content) == 0 {
					continue
				}
				for _, p := range extractGeneratedImagePaths(c.Content) {
					if !seenImages[p] {
						seenImages[p] = true
						res.GeneratedImages = append(res.GeneratedImages, p)
					}
				}
			}

		case "error":
			msg := extractErrorMessage(ev.Error, ev.Message, ev.Result, "")
			return HeadlessResult{}, &RunError{
				Message:     msg,
				SessionID:   res.SessionID,
				PartialText: strings.TrimSpace(lastAssistant),
			}

		case "result":
			if ev.IsError {
				msg := extractErrorMessage(ev.Error, ev.Message, ev.Result, "")
				return HeadlessResult{}, &RunError{
					Message:     msg,
					SessionID:   res.SessionID,
					PartialText: strings.TrimSpace(lastAssistant),
				}
			}
			if ev.Result != nil {
				res.Text = *ev.Result
			}
			if ev.Usage != nil {
				res.Usage = NormalizeUsage(ev.Usage)
			}
			res.StopReason = ev.StopReason
			res.Structured = ev.StructuredOutput
			gotFinal = true
		}
	}

	if err := sc.Err(); err != nil && !gotFinal {
		return res, &RunError{
			Message:     "Stream interrupted while reading Codex output.",
			SessionID:   res.SessionID,
			PartialText: strings.TrimSpace(lastAssistant),
		}
	}
	if !gotFinal && lastAssistant != "" {
		res.Text = lastAssistant
	}
	return res, nil
}

type streamEvent struct {
	Type             string             `json:"type"`
	SessionID        string             `json:"session_id"`
	ThreadID         string             `json:"thread_id"`
	MessageBody      *streamMsg         `json:"message"`
	Item             *codexItem         `json:"item"`
	Usage            *store.UsageTokens `json:"usage"`
	Result           *string            `json:"result"`
	IsError          bool               `json:"is_error"`
	StopReason       string             `json:"stop_reason"`
	StructuredOutput json.RawMessage    `json:"structured_output"`
	Error            any                `json:"error"`
	Message          string             `json:"message"`
}

type codexItem struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Command   string          `json:"command"`
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Query     string          `json:"query"`
}

type streamMsg struct {
	Content []streamContent `json:"content"`
}

type streamContent struct {
	Type    string          `json:"type"`
	Name    string          `json:"name"`
	Text    string          `json:"text"`
	Input   json.RawMessage `json:"input"`
	Content json.RawMessage `json:"content"`
}

func extractGeneratedImagePaths(raw json.RawMessage) []string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return parseImagePayload(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var out []string
		for _, b := range blocks {
			if b.Text != "" {
				out = append(out, parseImagePayload(b.Text)...)
			}
		}
		return out
	}
	return nil
}

func parseImagePayload(s string) []string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "{") {
		return nil
	}
	var payload struct {
		OK     bool `json:"ok"`
		Images []struct {
			Path string `json:"path"`
		} `json:"images"`
	}
	if err := json.Unmarshal([]byte(s), &payload); err != nil || !payload.OK {
		return nil
	}
	var paths []string
	for _, img := range payload.Images {
		if p := strings.TrimSpace(img.Path); p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}
