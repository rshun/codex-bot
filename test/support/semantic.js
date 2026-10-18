// A protocol stub, not a natural-language model. Linguistic quality requires live acceptance.
function context(options) { return JSON.parse(options.prompt.split("\n").at(-1)); }
function response(options, action = "chat", entries = [], message = "普通回答", delivery = "current") {
  return { ok: true, text: JSON.stringify({ nonce: context(options).nonce, action, message, delivery, entries }) };
}
const entry = (kind, time, text, id = "") => ({ id, kind, time, text });
module.exports = { context, response, entry };
