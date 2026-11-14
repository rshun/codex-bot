package discord

import (
	"testing"

	"github.com/bwmarrin/discordgo"

	"github.com/rshun/codex-bot/internal/platform"
)

func TestMessageInbound(t *testing.T) {
	in, ok := messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		ChannelID: "c1",
		Content:   " hello ",
		Author:    &discordgo.User{ID: "42"},
	}}, "bot")
	if !ok || in.Platform != platform.Discord || in.ChatID != "c1" || in.UserID != "42" || in.Text != "hello" || !in.TextMessage {
		t.Fatalf("ok=%v in=%#v", ok, in)
	}

	if _, ok := messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		Content: "hi",
		Author:  &discordgo.User{ID: "42", Bot: true},
	}}, "bot"); ok {
		t.Fatal("accepted a bot")
	}
	if _, ok := messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		Content: "hi",
		Author:  &discordgo.User{ID: "bot"},
	}}, "bot"); ok {
		t.Fatal("accepted self")
	}
	if _, ok := messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		GuildID: "g1",
		Content: "hi",
		Author:  &discordgo.User{ID: "42"},
	}}, "bot"); ok {
		t.Fatal("accepted a guild message")
	}

	in, ok = messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		ChannelID:         "c1",
		Content:           "caption",
		Author:            &discordgo.User{ID: "42"},
		Attachments:       []*discordgo.MessageAttachment{{ID: "a", Filename: "dates.txt"}},
		ReferencedMessage: &discordgo.Message{Content: "quoted task output"},
	}}, "bot")
	if !ok || !in.TextMessage || len(in.Files) != 1 || in.Files[0].Name != "dates.txt" || in.ReplyToText != "quoted task output" {
		t.Fatalf("ok=%v in=%#v", ok, in)
	}
	if _, ok := messageInbound(&discordgo.MessageCreate{Message: &discordgo.Message{
		Content: "   ",
		Author:  &discordgo.User{ID: "42"},
	}}, "bot"); ok {
		t.Fatal("accepted empty text")
	}
}

func TestCommandText(t *testing.T) {
	if got := commandText(discordgo.ApplicationCommandInteractionData{Name: "usage"}); got != "/usage" {
		t.Fatalf("%q", got)
	}
	if got := commandText(discordgo.ApplicationCommandInteractionData{Name: "quota"}); got != "/quota" {
		t.Fatalf("%q", got)
	}
	if got := commandText(discordgo.ApplicationCommandInteractionData{Name: "model"}); got != "/model" {
		t.Fatalf("%q", got)
	}
	got := commandText(discordgo.ApplicationCommandInteractionData{
		Name: "model",
		Options: []*discordgo.ApplicationCommandInteractionDataOption{
			{Name: "name", Type: discordgo.ApplicationCommandOptionString, Value: " gpt-5.4 "},
		},
	})
	if got != "/model gpt-5.4" {
		t.Fatalf("%q", got)
	}
}

func TestCommandTextSubcommands(t *testing.T) {
	sub := func(command, name string, opts ...*discordgo.ApplicationCommandInteractionDataOption) discordgo.ApplicationCommandInteractionData {
		return discordgo.ApplicationCommandInteractionData{
			Name: command,
			Options: []*discordgo.ApplicationCommandInteractionDataOption{
				{Name: name, Type: discordgo.ApplicationCommandOptionSubCommand, Options: opts},
			},
		}
	}
	str := func(name, value string) *discordgo.ApplicationCommandInteractionDataOption {
		return &discordgo.ApplicationCommandInteractionDataOption{Name: name, Type: discordgo.ApplicationCommandOptionString, Value: value}
	}
	cases := []struct {
		data discordgo.ApplicationCommandInteractionData
		want string
	}{
		{sub("dir", "list"), "/dir"},
		{sub("dir", "add", str("mode", "rw"), str("path", " /srv/a ")), "/dir add rw /srv/a"},
		{sub("dir", "del", str("path", "/srv/a")), "/dir del /srv/a"},
		{sub("task", "add", str("text", "每天九点看新闻")), "/task 每天九点看新闻"},
		{sub("task", "add", str("text", "每天九点看新闻"), str("platform", "dc")), "/task -p dc 每天九点看新闻"},
		{sub("task", "platform", &discordgo.ApplicationCommandInteractionDataOption{Name: "id", Type: discordgo.ApplicationCommandOptionInteger, Value: float64(2)}, str("target", "tg")), "/task platform 2 tg"},
		{sub("task", "list"), "/task list"},
		{sub("task", "del", &discordgo.ApplicationCommandInteractionDataOption{Name: "id", Type: discordgo.ApplicationCommandOptionInteger, Value: float64(3)}), "/task del 3"},
		{sub("upgrade", "check"), "/upgrade check"},
		{sub("upgrade", "run"), "/upgrade run all"},
		{sub("upgrade", "run", str("target", "cli")), "/upgrade run cli"},
		{sub("upgrade", "auto", str("mode", "on")), "/upgrade auto on"},
	}
	for _, tc := range cases {
		if got := commandText(tc.data); got != tc.want {
			t.Errorf("got %q, want %q", got, tc.want)
		}
	}
}
