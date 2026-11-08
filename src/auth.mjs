import { randomBytes } from "node:crypto";
import { AppError, equalSecret } from "./common.mjs";
export class Auth {
  constructor({ password, key }) {
    if (
      !password ||
      !key ||
      password.length < 20 ||
      key.length < 20 ||
      password === key
    )
      throw Error(
        "ADMIN_PASSWORD and API_KEY must be distinct and at least 20 characters",
      );
    this.password = password;
    this.key = key;
    this.sessions = new Map();
    this.attempts = new Map();
  }
  sameOrigin(req) {
    // ASVS V3/V7: require a browser origin matching the request authority; never trust forwarded-host.
    let origin;
    try { origin = new URL(req.headers.origin); } catch {}
    const site = req.headers["sec-fetch-site"];
    if (!origin || !["http:", "https:"].includes(origin.protocol) ||
        origin.origin !== req.headers.origin || origin.host !== req.headers.host ||
        (site && site !== "same-origin" && site !== "none"))
      throw new AppError(403, "请求来源不匹配", "origin_rejected");
    return origin;
  }
  login(req, password) {
    this.sameOrigin(req);
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let row = this.attempts.get(ip);
    if (!row || row.until < now) row = { count: 0, until: now + 600000 };
    if (this.attempts.size > 1000) this.attempts.clear();
    if (++row.count > 10) throw new AppError(429, "登录尝试过多，请稍后重试");
    this.attempts.set(ip, row);
    if (!equalSecret(password, this.password))
      throw new AppError(401, "管理密码不正确");
    this.attempts.delete(ip);
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    this.sessions.set(token, { csrf, created: now, seen: now });
    for (const [k, v] of this.sessions)
      if (v.created < now - 43200000 || v.seen < now - 1800000)
        this.sessions.delete(k);
    return { token, csrf };
  }
  session(req) {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("agy_session="))
      ?.slice(12);
    const row = this.sessions.get(token);
    const now = Date.now();
    if (!row || row.created < now - 43200000 || row.seen < now - 1800000) {
      if (token) this.sessions.delete(token);
      throw new AppError(401, "请先登录");
    }
    row.seen = now;
    return { ...row, token };
  }
  check(req, access) {
    if (access === "public") return null;
    if (access === "api") {
      if (!equalSecret(req.headers.authorization, "Bearer " + this.key))
        throw new AppError(401, "API 密钥无效");
      if (req.headers.origin) this.sameOrigin(req);
      return { kind: "api" };
    }
    const session = this.session(req);
    if (access === "mutation") {
      this.sameOrigin(req);
      if (!equalSecret(req.headers["x-csrf-token"], session.csrf))
        throw new AppError(403, "会话校验失败，请重新登录");
    }
    return session;
  }
  cookie(token, req) {
    return (
      "agy_session=" +
      token +
      "; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200" +
      (this.sameOrigin(req).protocol === "https:" ? "; Secure" : "")
    );
  }
}
