const API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

class DiscordError extends Error {
  constructor(kind, status) {
    super(`Discord ${kind} failed.`);
    this.kind = kind;
    this.status = status;
  }
}

class DiscordRest {
  constructor(token, { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.queue = Promise.resolve();
  }

  request(method, route, body, { immediate = false } = {}) {
    const execute = () => this.execute(method, route, body, immediate);
    // Interaction acknowledgement must not wait behind long replies or rate-limit sleeps.
    if (immediate) return execute();
    const result = this.queue.then(execute);
    this.queue = result.catch(() => {});
    return result;
  }

  async execute(method, route, body, immediate) {
    for (let attempt = 0; ; attempt++) {
      let response;
      let data;
      try {
        response = await this.fetch(API + route, {
          method, headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(immediate ? 2500 : 15000),
        });
        const text = await response.text();
        if (text.length > 1024 * 1024) throw new DiscordError("protocol");
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        // Never include response bodies, credentials, URLs, or raw transport exceptions.
        throw error instanceof DiscordError ? error : new DiscordError("network_or_protocol");
      }
      if (response.ok) return data;
      const retry = data?.retry_after;
      if (response.status === 429 && !immediate && attempt < 2 &&
          typeof retry === "number" && Number.isFinite(retry) && retry >= 0 && retry <= 5) {
        await this.sleep(Math.ceil(retry * 1000) + 100);
        continue;
      }
      throw new DiscordError(response.status === 429 ? "rate_limit" : "http", response.status);
    }
  }
}

function gatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DiscordError("gateway_url"); }
  if (url.protocol !== "wss:" || url.username || url.password || url.port ||
      !(url.hostname === "gateway.discord.gg" || url.hostname.endsWith(".gateway.discord.gg") ||
        /^gateway(?:-[a-z0-9]+)+\.discord\.gg$/.test(url.hostname))) {
    throw new DiscordError("gateway_url");
  }
  url.search = "?v=10&encoding=json";
  return url.href;
}

class DiscordGateway {
  constructor({ rest, token, onDispatch, onFatal = () => {}, logger = console,
                WebSocketImpl = globalThis.WebSocket, random = Math.random,
                timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
    Object.assign(this, { rest, token, onDispatch, onFatal, logger, WebSocketImpl, random, timers });
    this.stopped = true;
    this.attempts = 0;
    this.lastIdentify = 0;
    this.sequence = null;
    this.sessionId = null;
    this.resumeUrl = null;
  }

  async start() {
    if (!this.stopped) return;
    const info = await this.rest.request("GET", "/gateway/bot");
    this.url = gatewayUrl(info?.url);
    if (info.shards > 1) throw new DiscordError("sharding_unsupported");
    this.remainingStarts = info.session_start_limit?.remaining;
    if (!Number.isSafeInteger(this.remainingStarts) || this.remainingStarts < 1) {
      throw new DiscordError("session_limit");
    }
    this.stopped = false;
    this.connect();
  }

  clearConnectionTimers() {
    this.timers.clearTimeout(this.firstHeartbeat);
    this.timers.clearInterval(this.heartbeatTimer);
    this.timers.clearTimeout(this.readyTimer);
  }

  stop() {
    this.stopped = true;
    this.clearConnectionTimers();
    this.timers.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000); } catch { /* no raw logs */ }
  }

  fatal(kind) {
    this.stop();
    this.logger.error(`Discord gateway stopped: ${kind}.`);
    this.onFatal(kind);
  }

  reconnect({ fresh = false, delay } = {}) {
    if (this.stopped) return;
    this.clearConnectionTimers();
    this.timers.clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(4000); } catch { /* ignore closed sockets */ }
    if (fresh) {
      this.sessionId = null;
      this.resumeUrl = null;
      this.sequence = null;
    }
    if (++this.attempts > 10) { this.fatal("reconnect_exhausted"); return; }
    const backoff = delay ?? Math.min(60000, 1000 * 2 ** (this.attempts - 1)) + this.random() * 1000;
    const wait = this.sessionId ? backoff : Math.max(backoff, 5500 - (Date.now() - this.lastIdentify));
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), wait);
  }

  connect() {
    if (this.stopped) return;
    let socket;
    try { socket = new this.WebSocketImpl(this.sessionId ? this.resumeUrl : this.url); }
    catch { this.reconnect(); return; }
    this.socket = socket;
    this.awaitingAck = false;
    let helloSeen = false;
    this.readyTimer = this.timers.setTimeout(() => {
      if (this.socket === socket) this.reconnect();
    }, 30000);
    const send = (op, d) => {
      if (this.socket !== socket || this.stopped) return;
      try { socket.send(JSON.stringify({ op, d })); } catch { this.reconnect(); }
    };
    const heartbeat = (forced = false) => {
      if (this.socket !== socket || this.stopped) return;
      if (this.awaitingAck && !forced) { this.reconnect(); return; }
      this.awaitingAck = true;
      send(1, this.sequence);
    };
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      let packet;
      try {
        if (typeof event.data !== "string" || event.data.length > 1024 * 1024) throw new Error();
        packet = JSON.parse(event.data);
        if (!packet || typeof packet !== "object" || !Number.isInteger(packet.op)) throw new Error();
      } catch { this.reconnect(); return; }
      if (packet.op === 10) {
        const interval = packet.d?.heartbeat_interval;
        if (helloSeen || !Number.isFinite(interval) || interval < 1000 || interval > 300000) {
          this.reconnect(); return;
        }
        helloSeen = true;
        this.firstHeartbeat = this.timers.setTimeout(() => {
          heartbeat();
          if (this.socket === socket) this.heartbeatTimer = this.timers.setInterval(heartbeat, interval);
        }, this.random() * interval);
        if (this.sessionId) send(6, { token: this.token, session_id: this.sessionId, seq: this.sequence });
        else {
          if (this.remainingStarts-- < 1) { this.fatal("session_limit"); return; }
          this.lastIdentify = Date.now();
          send(2, { token: this.token, intents: INTENTS,
            properties: { os: process.platform, browser: "codex_bot", device: "codex_bot" } });
        }
      } else if (packet.op === 11) this.awaitingAck = false;
      else if (packet.op === 1) heartbeat(true);
      else if (packet.op === 7) this.reconnect();
      else if (packet.op === 9) this.reconnect({ fresh: packet.d !== true, delay: 1000 + this.random() * 4000 });
      else if (packet.op === 0) {
        if (!Number.isSafeInteger(packet.s) || (this.sequence !== null && packet.s <= this.sequence)) return;
        this.sequence = packet.s;
        if (packet.t === "READY") {
          if (typeof packet.d?.session_id !== "string" || !packet.d.session_id) {
            this.fatal("ready_session_id"); return;
          }
          let resumeUrl;
          try {
            resumeUrl = gatewayUrl(packet.d.resume_gateway_url);
          } catch { this.fatal("ready_gateway_url"); return; }
          this.sessionId = packet.d.session_id;
          this.resumeUrl = resumeUrl;
          this.attempts = 0;
          this.timers.clearTimeout(this.readyTimer);
          this.logger.log("Discord gateway ready.");
        } else if (packet.t === "RESUMED") {
          this.attempts = 0;
          this.timers.clearTimeout(this.readyTimer);
          this.logger.log("Discord gateway resumed.");
        }
        Promise.resolve().then(() => this.onDispatch(packet.t, packet.d)).catch(() => {
          if (packet.t === "READY") this.fatal("identity");
          else this.logger.error("Discord event handling failed.");
        });
      }
    });
    socket.addEventListener("error", () => { if (this.socket === socket) this.reconnect(); });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.stopped) return;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
        this.fatal(`close_${event.code}`); return;
      }
      this.reconnect({ fresh: [1000, 1001, 4007, 4009].includes(event.code) });
    });
  }
}

module.exports = { DiscordRest, DiscordGateway, DiscordError, gatewayUrl, INTENTS };
