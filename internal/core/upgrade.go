package core

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/rshun/codex-bot/internal/codex"
	"github.com/rshun/codex-bot/internal/platform"
	"github.com/rshun/codex-bot/internal/store"
	"github.com/rshun/codex-bot/internal/updater"
)

const (
	settingAutoUpgrade          = "auto_upgrade"
	settingPendingUpgradeNotice = "pending_upgrade_notice"
	defaultAutoUpgradeClock     = "04:30"
)

const upgradeUsage = `用法：
/upgrade 或 /upgrade check
    检查 codex-bot 与 Codex CLI 是否有新版本及目录升级权限
/upgrade run [all|bot|cli]
    执行一键升级（默认 all：按需升级 Codex CLI 与 codex-bot，自动备份数据库、校验 SHA-256 并在失败时自动回滚）
/upgrade auto [on|off]
    查看、开启或关闭每日定时自动升级`

type pendingUpgradeNotice struct {
	Platform      string `json:"platform,omitempty"`
	ChatID        string `json:"chat_id,omitempty"`
	OldBotVersion string `json:"old_bot_version"`
	TargetBotVer  string `json:"target_bot_version"`
	CLIOldVersion string `json:"cli_old_version,omitempty"`
	CLINewVersion string `json:"cli_new_version,omitempty"`
	Auto          bool   `json:"auto,omitempty"`
}

func (s *Service) autoUpgradeEnabled(ctx context.Context) bool {
	if s.Store != nil {
		if val, ok, err := s.Store.Setting(ctx, settingAutoUpgrade); err == nil && ok {
			return val == "true"
		}
	}
	return s.AutoUpgrade
}

func (s *Service) autoUpgradeClock() string {
	t := strings.TrimSpace(s.AutoUpgradeTime)
	if t == "" {
		return defaultAutoUpgradeClock
	}
	return t
}

func (s *Service) upgradeCommand(ctx context.Context, in platform.Inbound, arg string) (string, [][]platform.Button, string, error) {
	if s.Updater == nil {
		return "当前实例未启用在线升级模块。", nil, "", nil
	}
	fields := strings.Fields(strings.TrimSpace(arg))
	sub := "check"
	if len(fields) > 0 {
		sub = strings.ToLower(fields[0])
	}

	switch sub {
	case "check", "status":
		rep := s.Updater.Check(ctx)
		autoOn := s.autoUpgradeEnabled(ctx)
		return s.formatUpgradeReport(rep, autoOn), upgradeButtons(rep, autoOn), "", nil

	case "auto":
		return s.upgradeAutoCommand(ctx, fields[1:])

	case "run", "now":
		target := "all"
		if sub == "run" && len(fields) >= 2 {
			target = strings.ToLower(fields[1])
		}
		if target != "all" && target != "bot" && target != "cli" {
			return upgradeUsage, nil, "", nil
		}
		text, restartExe, err := s.executeManualUpgrade(ctx, in, target)
		return text, nil, restartExe, err

	case "help":
		return upgradeUsage, nil, "", nil

	default:
		return upgradeUsage, nil, "", nil
	}
}

func (s *Service) upgradeAutoCommand(ctx context.Context, args []string) (string, [][]platform.Button, string, error) {
	clock := s.autoUpgradeClock()
	if len(args) == 0 {
		enabled := s.autoUpgradeEnabled(ctx)
		state := "已关闭"
		if enabled {
			state = "已开启"
		}
		text := fmt.Sprintf("每日自动升级当前状态：%s（检查时间：每天 %s %s）。\n用法：`/upgrade auto on` 开启，`/upgrade auto off` 关闭。",
			state, clock, s.location().String())
		return text, autoUpgradeToggleButtons(enabled), "", nil
	}

	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "on", "true", "1", "enable":
		if s.Store != nil {
			if err := s.Store.PutSetting(ctx, settingAutoUpgrade, "true"); err != nil {
				return "", nil, "", err
			}
		}
		return fmt.Sprintf("已开启每日自动升级（每天 %s 自动检查并平滑升级 Codex CLI 与 codex-bot）。", clock), autoUpgradeToggleButtons(true), "", nil
	case "off", "false", "0", "disable":
		if s.Store != nil {
			if err := s.Store.PutSetting(ctx, settingAutoUpgrade, "false"); err != nil {
				return "", nil, "", err
			}
		}
		return "已关闭每日自动升级（仍可随时发送 `/upgrade` 手动检查并一键升级）。", autoUpgradeToggleButtons(false), "", nil
	default:
		return "用法：`/upgrade auto on` 开启，或 `/upgrade auto off` 关闭。", nil, "", nil
	}
}

func (s *Service) formatUpgradeReport(rep updater.Report, autoEnabled bool) string {
	var b strings.Builder
	b.WriteString("🔄 版本与升级检查\n\n")

	// 1. codex-bot status
	b.WriteString("• codex-bot：")
	switch {
	case rep.Bot.Error != "":
		fmt.Fprintf(&b, "当前 %s（⚠️ 检查更新失败：%s）\n", rep.Bot.Current, rep.Bot.Error)
	case rep.Bot.IsDev:
		latestNote := ""
		if rep.Bot.Latest != "" {
			latestNote = fmt.Sprintf("，远端最新正式版 %s", rep.Bot.Latest)
		}
		fmt.Fprintf(&b, "当前 %s（开发构建不自动覆盖%s）\n", rep.Bot.Current, latestNote)
	case rep.Bot.UpdateAvailable:
		if rep.Bot.Writable {
			fmt.Fprintf(&b, "%s → 发现新版本 %s ✨（支持直接升级）\n", rep.Bot.Current, rep.Bot.Latest)
		} else {
			fmt.Fprintf(&b, "%s → 发现新版本 %s ⚠️（当前安装目录无写权限）\n", rep.Bot.Current, rep.Bot.Latest)
		}
	default:
		latest := rep.Bot.Latest
		if latest == "" {
			latest = rep.Bot.Current
		}
		fmt.Fprintf(&b, "已是最新版本 (%s)\n", latest)
	}

	// 2. Codex CLI status
	b.WriteString("• Codex CLI：")
	switch {
	case rep.CLI.Error != "":
		if rep.CLI.Current != "" {
			fmt.Fprintf(&b, "当前 %s（⚠️ 检查更新失败：%s）\n", rep.CLI.Current, rep.CLI.Error)
		} else {
			fmt.Fprintf(&b, "⚠️ %s\n", rep.CLI.Error)
		}
	case rep.CLI.UpdateAvailable:
		if rep.CLI.Writable {
			fmt.Fprintf(&b, "%s → 发现新版本 %s ✨（支持 npm 直接升级）\n", rep.CLI.Current, rep.CLI.Latest)
		} else {
			fmt.Fprintf(&b, "%s → 发现新版本 %s ⚠️（npm 全局目录无写权限）\n", rep.CLI.Current, rep.CLI.Latest)
		}
	default:
		fmt.Fprintf(&b, "已是最新版本 (%s)\n", rep.CLI.Current)
	}

	autoState := "已关闭"
	if autoEnabled {
		autoState = "已开启"
	}
	fmt.Fprintf(&b, "• 自动升级：%s（每天 %s）", autoState, s.autoUpgradeClock())

	var hints []string
	if !rep.Bot.IsDev && !rep.Bot.Writable && rep.Bot.WriteHint != "" {
		hints = append(hints, rep.Bot.WriteHint)
	}
	if rep.CLI.Error == "" && !rep.CLI.Writable && rep.CLI.WriteHint != "" {
		hints = append(hints, rep.CLI.WriteHint)
	}
	if len(hints) > 0 {
		b.WriteString("\n\n💡 权限提示：\n")
		b.WriteString(strings.Join(hints, "\n\n"))
	}
	return strings.TrimSpace(b.String())
}

func (s *Service) executeManualUpgrade(ctx context.Context, in platform.Inbound, target string) (string, string, error) {
	if !s.upgradeMu.TryLock() {
		return "⏳ 当前已有升级任务正在进行中，请稍候再试。", "", nil
	}
	defer s.upgradeMu.Unlock()

	excludeKey := in.Platform + "\x00" + in.ChatID
	if !s.waitOtherLanesIdle(ctx, excludeKey, 30*time.Second) {
		return "⚠️ 其他会话正在处理对话或任务，为避免中断回复，请稍后再执行 `/upgrade run`。", "", nil
	}

	wantCLI := target == "all" || target == "cli"
	wantBot := target == "all" || target == "bot"

	var notes []string
	var cliChanged updater.CLIUpgradeResult

	if wantCLI {
		res, err := s.Updater.UpgradeCLI(ctx)
		if err != nil {
			if target == "cli" {
				return "⚠️ Codex CLI 升级失败：\n" + err.Error(), "", nil
			}
			notes = append(notes, "⚠️ Codex CLI 升级未完成："+err.Error())
		} else if res.Changed {
			cliChanged = res
			if mcpEng, ok := s.Engine.(MCPEngine); ok {
				mcpEng.ResetLeader(ctx)
			}
			notes = append(notes, fmt.Sprintf("✅ Codex CLI 已升级：%s → %s", res.OldVersion, res.NewVersion))
		} else if target == "cli" {
			notes = append(notes, fmt.Sprintf("Codex CLI 已是最新版本 (%s)，无需升级。", res.NewVersion))
		}
	}

	if wantBot {
		staged, err := s.Updater.StageBotUpgrade(ctx)
		if err != nil {
			if target == "bot" && len(notes) == 0 {
				return "⚠️ codex-bot 升级失败：\n" + err.Error(), "", nil
			}
			notes = append(notes, "⚠️ codex-bot 升级未完成："+err.Error())
		} else if staged.Changed {
			if s.Store != nil {
				if _, bakErr := s.Store.BackupBeforeUpgrade(ctx, staged.OldVersion); bakErr != nil {
					notes = append(notes, "⚠️ 升级前备份 bot.db 失败，已中止替换二进制："+codex.RedactSensitive(bakErr.Error()))
					return strings.Join(notes, "\n\n"), "", nil
				}
			}
			if _, commitErr := updater.CommitBotBinary(staged.ExePath, staged.StagedPath); commitErr != nil {
				notes = append(notes, "⚠️ 替换 codex-bot 二进制失败："+codex.RedactSensitive(commitErr.Error()))
				return strings.Join(notes, "\n\n"), "", nil
			}
			s.savePendingNotice(ctx, pendingUpgradeNotice{
				Platform:      in.Platform,
				ChatID:        in.ChatID,
				OldBotVersion: staged.OldVersion,
				TargetBotVer:  staged.NewVersion,
				CLIOldVersion: cliChanged.OldVersion,
				CLINewVersion: cliChanged.NewVersion,
				Auto:          false,
			})
			notes = append(notes, fmt.Sprintf("⏳ 数据库已备份且 SHA-256 校验通过，正在将 codex-bot (%s → %s) 平滑重启切换，重启完成后会自动通知你…",
				staged.OldVersion, staged.NewVersion))
			return strings.Join(notes, "\n\n"), staged.ExePath, nil
		} else if target == "bot" {
			notes = append(notes, fmt.Sprintf("codex-bot 已是最新版本 (%s)，无需升级。", staged.NewVersion))
		}
	}

	if len(notes) == 0 {
		rep := s.Updater.Check(ctx)
		return fmt.Sprintf("codex-bot (%s) 与 Codex CLI (%s) 均已是最新版本，无需升级。", rep.Bot.Current, rep.CLI.Current), "", nil
	}
	return strings.Join(notes, "\n\n"), "", nil
}

// StartAutoUpgrader runs a background daily timer that checks and upgrades Codex CLI and codex-bot
// when auto-upgrade is enabled and all chat lanes are idle.
func (s *Service) StartAutoUpgrader(ctx context.Context) {
	if s.Updater == nil {
		return
	}
	go func() {
		for {
			delay := nextClockDelay(s.now(), s.autoUpgradeClock(), s.location())
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if !s.autoUpgradeEnabled(ctx) {
				continue
			}
			restarting := s.runScheduledAutoUpgrade(ctx)
			if restarting {
				return
			}
		}
	}()
}

func (s *Service) runScheduledAutoUpgrade(ctx context.Context) bool {
	if s.Updater == nil {
		return false
	}
	if !s.upgradeMu.TryLock() {
		return false
	}
	defer s.upgradeMu.Unlock()

	rep := s.Updater.Check(ctx)
	if !rep.Bot.UpdateAvailable && !rep.CLI.UpdateAvailable {
		slog.Info("auto-upgrade check completed: already up to date", "bot", rep.Bot.Current, "cli", rep.CLI.Current)
		return false
	}
	if !s.waitOtherLanesIdle(ctx, "", 10*time.Minute) {
		slog.Warn("auto-upgrade skipped: chat lanes remained busy")
		return false
	}

	var msgs []string
	var cliRes updater.CLIUpgradeResult
	if rep.CLI.UpdateAvailable {
		res, err := s.Updater.UpgradeCLI(ctx)
		if err != nil {
			msgs = append(msgs, "⚠️ Codex CLI 自动升级失败："+err.Error())
		} else if res.Changed {
			cliRes = res
			if mcpEng, ok := s.Engine.(MCPEngine); ok {
				mcpEng.ResetLeader(ctx)
			}
			msgs = append(msgs, fmt.Sprintf("✅ Codex CLI：%s → %s", res.OldVersion, res.NewVersion))
		}
	}

	if rep.Bot.UpdateAvailable {
		staged, err := s.Updater.StageBotUpgrade(ctx)
		if err != nil {
			msgs = append(msgs, "⚠️ codex-bot 自动升级失败："+err.Error())
		} else if staged.Changed {
			bakOK := true
			if s.Store != nil {
				if _, bakErr := s.Store.BackupBeforeUpgrade(ctx, staged.OldVersion); bakErr != nil {
					bakOK = false
					msgs = append(msgs, "⚠️ 备份 bot.db 失败，已中止 codex-bot 自动升级："+codex.RedactSensitive(bakErr.Error()))
				}
			}
			if bakOK {
				if _, commitErr := updater.CommitBotBinary(staged.ExePath, staged.StagedPath); commitErr != nil {
					msgs = append(msgs, "⚠️ 替换 codex-bot 二进制失败："+codex.RedactSensitive(commitErr.Error()))
				} else {
					s.savePendingNotice(ctx, pendingUpgradeNotice{
						OldBotVersion: staged.OldVersion,
						TargetBotVer:  staged.NewVersion,
						CLIOldVersion: cliRes.OldVersion,
						CLINewVersion: cliRes.NewVersion,
						Auto:          true,
					})
					if s.RequestRestart != nil {
						s.RequestRestart(staged.ExePath)
						return true
					}
				}
			}
		}
	}

	if len(msgs) > 0 {
		s.broadcastUpgradeNotice(ctx, "🔄 自动升级报告\n\n"+strings.Join(msgs, "\n"))
	}
	return false
}

// SendPendingUpgradeNotice checks if the previous process restarted for a binary upgrade and delivers
// the post-restart confirmation (or rollback warning) to the originating chat or all platforms.
func (s *Service) SendPendingUpgradeNotice(ctx context.Context) {
	if s.Store == nil {
		return
	}
	raw, ok, err := s.Store.Setting(ctx, settingPendingUpgradeNotice)
	if err != nil || !ok || strings.TrimSpace(raw) == "" {
		return
	}
	_ = s.Store.PutSetting(ctx, settingPendingUpgradeNotice, "")

	var notice pendingUpgradeNotice
	if err := json.Unmarshal([]byte(raw), &notice); err != nil || notice.TargetBotVer == "" {
		return
	}

	curVer := strings.TrimSpace(s.Version)
	matched := curVer == notice.TargetBotVer
	if !matched {
		if cmp, valid := updater.CompareSemver(curVer, notice.TargetBotVer); valid && cmp == 0 {
			matched = true
		}
	}

	var b strings.Builder
	if matched {
		if notice.Auto {
			b.WriteString("✅ 自动升级已完成\n\n")
		} else {
			b.WriteString("✅ 升级已完成，新版本服务运行正常\n\n")
		}
		fmt.Fprintf(&b, "• codex-bot：%s → %s\n", notice.OldBotVersion, curVer)
		if notice.CLINewVersion != "" {
			fmt.Fprintf(&b, "• Codex CLI：%s → %s\n", notice.CLIOldVersion, notice.CLINewVersion)
		}
	} else {
		fmt.Fprintf(&b, "⚠️ codex-bot 升级重启后未能切换至目标版本 %s（当前运行版本：%s），请检查服务日志。", notice.TargetBotVer, curVer)
	}
	msg := strings.TrimSpace(b.String())

	if !notice.Auto && notice.Platform != "" && notice.ChatID != "" {
		if sender := s.Senders[notice.Platform]; sender != nil {
			s.send(ctx, sender, notice.ChatID, msg)
			return
		}
	}
	s.broadcastUpgradeNotice(ctx, msg)
}

func (s *Service) savePendingNotice(ctx context.Context, notice pendingUpgradeNotice) {
	if s.Store == nil {
		return
	}
	if data, err := json.Marshal(notice); err == nil {
		_ = s.Store.PutSetting(ctx, settingPendingUpgradeNotice, string(data))
	}
}

func (s *Service) broadcastUpgradeNotice(ctx context.Context, text string) {
	for _, target := range s.taskTargets(ctx, store.Task{}) {
		s.send(ctx, target.Sender, target.ChatID, text)
	}
}

func (s *Service) waitOtherLanesIdle(ctx context.Context, excludeKey string, maxWait time.Duration) bool {
	deadline := time.Now().Add(maxWait)
	for {
		busy := false
		s.mu.Lock()
		for k, ln := range s.lanes {
			if k == excludeKey {
				continue
			}
			if ln.busy() {
				busy = true
				break
			}
		}
		s.mu.Unlock()
		if !busy {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func nextClockDelay(now time.Time, hhmm string, loc *time.Location) time.Duration {
	if loc == nil {
		loc = time.Local
	}
	hour, minute := 4, 30
	if parts := strings.Split(strings.TrimSpace(hhmm), ":"); len(parts) == 2 {
		if h, err1 := strconv.Atoi(parts[0]); err1 == nil && h >= 0 && h <= 23 {
			if m, err2 := strconv.Atoi(parts[1]); err2 == nil && m >= 0 && m <= 59 {
				hour, minute = h, m
			}
		}
	}
	localNow := now.In(loc)
	target := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), hour, minute, 0, 0, loc)
	if !target.After(localNow) {
		target = target.AddDate(0, 0, 1)
	}
	d := target.Sub(localNow)
	if d < time.Second {
		return time.Second
	}
	return d
}
