import {createHash, randomUUID} from "node:crypto";
import {AppError} from "./common.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function sessionSelector(value) {
  if (value == null) return null;
  if (value === "new" || (typeof value === "string" && /^s_[a-f0-9]{32}$/.test(value))) return value;
  throw new AppError(400, "session_id 必须为 new 或有效的会话 ID", "invalid_session");
}
export function sessionOwner(principal) {
  if (principal?.key_id) return "api:" + principal.key_id;
  if (principal?.token) return "panel:" + hash(principal.token);
  throw new AppError(401, "请先认证", "authentication_required");
}
const missing = () => new AppError(404, "会话不存在或已关闭，请开始新会话", "session_not_found");

// Resource authorization lives here, independently of the HTTP registrar.
export class Sessions {
  constructor({runner, limit = 2, idleMs = 120000, maxTurns = 50, logger = null}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16 ||
        !Number.isInteger(idleMs) || idleMs < 100 || idleMs > 1800000 ||
        !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
      throw Error("Invalid SESSION_LIMIT / SESSION_IDLE_SECONDS / SESSION_MAX_TURNS");
    Object.assign(this, {runner, limit, idleMs, maxTurns, logger});
    this.entries = new Map();
    this.closing = 0;
    runner.onSessionClosed = id => this.forget(id);
  }
  get(id, owner) {
    if (typeof owner !== "string" || !owner) throw new AppError(401, "请先认证", "authentication_required");
    const s = this.entries.get(id);
    // ASVS V8.3.1: an ID is not authorization; hide foreign resources.
    if (!s || s.closed || s.owner !== owner) throw missing();
    return s;
  }
  view(s) {
    return {id: s.id, account_id: s.account, model: s.model || null, kind: s.kind,
      state: s.busy ? "running" : "ready", turns: s.turns, created_at: s.created,
      expires_at: s.busy ? null : s.expires, max_turns: this.maxTurns};
  }
  list(owner) { return [...this.entries.values()].filter(s => s.owner === owner && !s.closed).map(s => this.view(s)); }
  begin(existing, owner, {account, model, kind, schema, effort, config, messages, prompt}) {
    if (typeof owner !== "string" || !owner) throw new AppError(401, "请先认证", "authentication_required");
    let s = existing;
    const signature = hash({kind, model, schema, effort, config});
    if (s) {
      if (this.get(s.id, owner) !== s) throw missing();
      if (s.busy) throw new AppError(409, "会话正在执行任务", "session_busy");
      if (s.account !== account || s.signature !== signature)
        throw new AppError(409, "会话账号、模型和工具配置不可更改，请开始新会话", "session_mismatch");
      if (s.turns >= this.maxTurns) throw new AppError(409, "会话已达到轮数上限，请关闭后开始新会话", "session_turn_limit");
      if (kind === "chat") {
        if (!Array.isArray(messages) || messages.length <= s.messageCount ||
            hash(messages.slice(0, s.messageCount)) !== s.historyHash)
          throw new AppError(409, "会话 messages 必须完整保留此前消息和回答，并追加新消息", "session_history_mismatch");
        const additions = messages.slice(s.messageCount);
        if (additions.some(m => ["system", "developer", "assistant"].includes(m.role)))
          throw new AppError(409, "会话续接仅可追加 user 或 tool 消息", "session_history_mismatch");
        prompt = "Continue the existing conversation using these NEW client messages only. Do not execute local tools.\n" + JSON.stringify(additions);
      }
    } else {
      if (this.entries.size + this.closing >= this.limit) throw new AppError(429, "常驻会话已满，请关闭不用的会话或等待回收", "session_limit");
      s = {id: "s_" + randomUUID().replaceAll("-", ""), owner, account, model, kind, signature,
        turns: 0, created: new Date().toISOString(), closed: false};
      this.entries.set(s.id, s);
      this.logger?.info("session.opened", {session_id:s.id, account_id:account, model:model||"默认模型"});
    }
    // ASVS V15.4.2: reserve the turn synchronously before any asynchronous launch.
    clearTimeout(s.timer);
    s.busy = true;
    return {session: s, prompt};
  }
  complete(s, {messages, assistant} = {}) {
    if (s.closed) throw missing();
    s.turns++;
    s.busy = false;
    // ASVS V14.2.7: retain only a bounded history fingerprint, never transcript text.
    if (s.kind === "chat") {
      const history = [...messages, {...assistant, content: assistant.content ?? ""}];
      s.messageCount = history.length;
      s.historyHash = hash(history);
    }
    s.expires = new Date(Date.now() + this.idleMs).toISOString();
    s.timer = setTimeout(() => { void this.close(s.id, s.owner, "idle_timeout").catch(() => {}); }, this.idleMs);
    s.timer.unref();
    return this.view(s);
  }
  forget(id, reason = "process_ended") {
    const s = this.entries.get(id);
    if (!s) return;
    s.closed = true;
    clearTimeout(s.timer);
    this.entries.delete(id);
    this.logger?.info("session.closed", {session_id:s.id, account_id:s.account, stage:reason});
  }
  async close(id, owner, reason = "explicit_close") {
    const s = this.get(id, owner);
    this.closing++;
    this.forget(s.id, reason);
    try { await this.runner.closeSession(s.id); } finally { this.closing--; }
  }
  async closeWhere(predicate) {
    await Promise.all([...this.entries.values()].filter(predicate).map(s => this.close(s.id, s.owner)));
  }
  get status() { return {resident: this.entries.size + this.closing, closing: this.closing, limit: this.limit, idle_seconds: this.idleMs / 1000, max_turns: this.maxTurns}; }
}

export function registerSessions({register, send, sessions}) {
  for (const [base, read, mutation] of [["/api/sessions", "read", "mutation"], ["/v1/sessions", "api", "api"]]) {
    register("GET", base, read, async ({res, principal}) => send(res, {sessions: sessions.list(sessionOwner(principal))}));
    register("DELETE", new RegExp("^" + base + "/(s_[a-f0-9]{32})$"), mutation, async ({res, principal, match}) => {
      await sessions.close(match[1], sessionOwner(principal));
      send(res, {closed: true});
    });
  }
}
