const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];

function isTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields = {
    inputTokens: "input_tokens", cachedInputTokens: "cached_input_tokens",
    outputTokens: "output_tokens", reasoningOutputTokens: "reasoning_output_tokens",
  };
  const tokens = {};
  for (const [key, source] of Object.entries(fields)) {
    tokens[key] = isTokenCount(raw[source]) ? raw[source] : null;
  }
  return Object.values(tokens).some((value) => value !== null) ? tokens : null;
}

function validateReport(report) {
  if (report === null || report === undefined) return true;
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      !["completed", "failed"].includes(report.status) || typeof report.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.at) ||
      !Number.isFinite(Date.parse(report.at))) return false;
  return report.tokens === null || (report.tokens && typeof report.tokens === "object" &&
    !Array.isArray(report.tokens) && TOKEN_FIELDS.every((key) =>
      report.tokens[key] === null || isTokenCount(report.tokens[key])));
}

function copyReport(report) {
  if (!report) return report;
  return { at: report.at, status: report.status,
    tokens: report.tokens ? Object.fromEntries(TOKEN_FIELDS.map((key) => [key, report.tokens[key]])) : null };
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(value));
}

function formatUsage(report, busy = false) {
  const lines = ["当前会话最近一次任务的 CLI 用量报告"];
  if (busy) lines.push("当前任务仍在运行，以下为上次保存的报告。");
  if (!report) {
    lines.push("暂无报告，请先完成一次任务。升级前的用量未补录。");
    return lines.join("\n");
  }
  lines.push(`记录时间：${formatTime(report.at)}（北京时间）`,
    `任务结果：${report.status === "completed" ? "完成" : "失败或中断"}`);
  const display = (value) => isTokenCount(value) ? value.toLocaleString("en-US") : "未知";
  const tokens = report.tokens || {};
  const total = isTokenCount(tokens.inputTokens) && isTokenCount(tokens.outputTokens) &&
    Number.isSafeInteger(tokens.inputTokens + tokens.outputTokens)
    ? tokens.inputTokens + tokens.outputTokens : null;
  lines.push(`输入：${display(tokens.inputTokens)}`, `缓存输入：${display(tokens.cachedInputTokens)}`,
    `输出：${display(tokens.outputTokens)}`, `推理输出：${display(tokens.reasoningOutputTokens)}`,
    `输入 + 输出：${display(total)}`);
  if (!report.tokens) lines.push("CLI 未返回有效统计；未知不代表没有消耗。");
  lines.push("缓存输入不再额外相加；报告不跨任务累加，也不代表账号剩余额度。");
  return lines.join("\n");
}

module.exports = { normalizeUsage, validateReport, copyReport, formatUsage, formatTime };
