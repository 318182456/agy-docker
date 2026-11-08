import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AppError, accountId } from "./common.mjs";
import { profilePaths } from "./runner.mjs";
const activeStates = new Set(["starting", "running", "submitted"]);
export function loginDisplay(raw) {
  const plain = raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  let url = null;
  const links = [...raw.matchAll(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(m => m[1]);
  for (const value of [...(plain.match(/https:\/\/[^\s<>"']+/g) || []), ...links]) {
    try { const u = new URL(value); if (["accounts.google.com", "antigravity.google", "antigravity.google.com"].includes(u.hostname) && !u.username && !u.password && !u.port) url = u.href; } catch {}
  }
  return { url, text: plain.replace(/https?:\/\/[^\s<>"']+/g, "[官方授权链接]").slice(-12000) };
}
export class LoginManager {
  constructor({ dataDir, queue, store, launch = spawn }) { Object.assign(this, { dataDir, queue, store, launch }); this.current = null; }
  view(owner, id) {
    const s = this.current;
    if (!s || s.owner !== owner || s.id !== id) return { state: "idle", text: "" };
    return { state: s.state, text: s.submitted ? "授权码已交给官方 agy；请等待处理后结束登录并校验。" : loginDisplay(s.raw).text, url: s.submitted ? null : loginDisplay(s.raw).url };
  }
  start(owner, id) {
    accountId(id); this.store.get(id);
    if (this.queue.running || this.queue.waiting.length || (this.current && activeStates.has(this.current.state))) throw new AppError(409, "请等待当前任务或登录完成");
    const s = this.current = { id, owner, state: "starting", raw: "", child: null, submitted: false };
    this.queue.add(async () => {
      let timer;
      try {
        const p = await profilePaths(this.dataDir, id);
        if (!activeStates.has(s.state)) return;
        const allowed = ["PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE"];
        const env = Object.fromEntries(allowed.filter(k => process.env[k]).map(k => [k, process.env[k]]));
        Object.assign(env, p.env, { TERM: "xterm-256color", LANG: "C.UTF-8", SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22" });
        // ASVS V1.2.5: fixed command only; web input reaches the CLI PTY, never a shell command.
        const child = s.child = this.launch("/usr/bin/script", ["-q", "-e", "-c", "/app/scripts/login-pty.sh", "/dev/null"], { cwd: p.home, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        s.state = "running";
        await new Promise((resolve, reject) => {
          const decoder = new StringDecoder("utf8");
          const consume = b => { if (!s.submitted) s.raw = (s.raw + decoder.write(b)).slice(-24000); };
          child.stdout.on("data", consume); child.stderr.on("data", consume);
          child.stdin.on("error", () => {});
          child.once("error", () => reject(new AppError(503, "无法启动官方登录进程", "login_unavailable")));
          child.once("close", code => { if (activeStates.has(s.state)) s.state = code === 0 ? "finished" : "failed"; resolve(); });
          timer = setTimeout(() => { s.state = "expired"; this.kill(s); }, 600000); timer.unref();
        });
      } catch { s.state = "failed"; s.raw = "登录进程无法启动，请检查镜像中的 agy 和 script。"; }
      finally { clearTimeout(timer); s.child = null; if (s.submitted) s.raw = ""; }
    }, undefined, {key:id, exclusive:true}).catch(() => { s.state = "failed"; });
    return this.view(owner, id);
  }
  input(owner, id, value) {
    const s = this.current;
    if (!s || s.owner !== owner || s.id !== id || !s.child || !activeStates.has(s.state)) throw new AppError(409, "登录已结束，请重新发起");
    const keys = { enter: "\r", up: "\x1b[A", down: "\x1b[B" };
    if (value.key && keys[value.key] && !s.submitted) s.child.stdin.write(keys[value.key]);
    else if (typeof value.code === "string" && /^[A-Za-z0-9_./~+\-=]{4,2048}$/.test(value.code) && !s.submitted && loginDisplay(s.raw).url) {
      // OAuth remains owned by official agy; code is session-bound, one-shot, never logged/persisted/echoed back.
      s.submitted = true; s.raw = ""; s.state = "submitted"; s.child.stdin.write(value.code + "\r");
    } else throw new AppError(400, "仅允许选择菜单或提交官方授权码");
    return this.view(owner, id);
  }
  kill(s) { if (s.child) try { process.kill(-s.child.pid, "SIGKILL"); } catch {} }
  stop(owner, id) { const s = this.current; if (s?.owner === owner && s.id === id) { s.state = "stopped"; this.kill(s); s.raw = ""; } return this.view(owner, id); }
  close() { if (this.current) { this.current.state = "stopped"; this.kill(this.current); this.current.raw = ""; } }
}

