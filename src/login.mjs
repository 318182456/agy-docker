import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AppError, accountId } from "./common.mjs";
import { profilePaths } from "./runner.mjs";
const activeStates = new Set(["starting", "running", "submitted", "checking"]);
export function loginDisplay(raw) {
  const plain = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  let url = null;
  const links = [
    ...raw.matchAll(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g),
  ].map((m) => m[1]);
  for (const value of [
    ...(plain.match(/https:\/\/[^\s<>"']+/g) || []),
    ...links,
  ]) {
    try {
      const u = new URL(value);
      if (
        [
          "accounts.google.com",
          "antigravity.google",
          "antigravity.google.com",
        ].includes(u.hostname) &&
        !u.username &&
        !u.password &&
        !u.port
      )
        url = u.href;
    } catch {}
  }
  return { url, text: plain };
}
export class LoginManager {
  constructor({ dataDir, queue, store, keyrings = null, launch = spawn }) {
    Object.assign(this, { dataDir, queue, store, keyrings, launch });
    this.current = null;
  }
  view(owner, id) {
    const s = this.current;
    if (!s || s.owner !== owner || s.id !== id)
      return { state: "idle", text: "" };
    return {
      state: s.state,
      text: loginDisplay(s.raw).text,
      url: s.submitted ? null : loginDisplay(s.raw).url,
    };
  }
  start(owner, id) {
    accountId(id);
    this.store.get(id);
    if (
      this.current?.owner === owner &&
      this.current.id === id &&
      activeStates.has(this.current.state)
    )
      return this.view(owner, id);
    if (
      this.queue.running ||
      this.queue.waiting.length ||
      (this.current && activeStates.has(this.current.state))
    )
      throw new AppError(409, "请等待当前任务或登录完成");
    const s = (this.current = {
      id,
      owner,
      state: "starting",
      raw: "",
      child: null,
      submitted: false,
      bytes: 0,
      checkingPromise: null,
    });
    this.queue
      .add(
        async () => {
          let timer, keyring;
          try {
            const p = await profilePaths(this.dataDir, id);
            if (!activeStates.has(s.state)) return;
            keyring = await this.keyrings?.acquire(id, p);
            const allowed = [
              "PATH",
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "ALL_PROXY",
              "NO_PROXY",
              "SSL_CERT_FILE",
            ];
            const env = Object.fromEntries(
              allowed
                .filter((k) => process.env[k])
                .map((k) => [k, process.env[k]]),
            );
            env.HTTPS_PROXY ||= env.HTTP_PROXY;
            Object.assign(env, p.env, keyring?.env, {
              TERM: "xterm-256color",
              LANG: "C.UTF-8",
              SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
            });
            // ASVS V1.2.5: fixed command only; web input reaches the CLI PTY, never a shell command.
            const child = (s.child = this.launch(
              "/usr/bin/script",
              ["-q", "-e", "-c", "/app/scripts/login-pty.sh", "/dev/null"],
              {
                cwd: p.home,
                env,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              },
            ));
            s.state = "running";
            await new Promise((resolve, reject) => {
              const out = new StringDecoder("utf8"),
                err = new StringDecoder("utf8");
              child.stdout.on("data", (b) => this.append(s, out.write(b)));
              child.stderr.on("data", (b) => this.append(s, err.write(b)));
              child.stdin.on("error", () => {});
              child.once("error", () =>
                reject(
                  new AppError(
                    503,
                    "无法启动官方登录进程",
                    "login_unavailable",
                  ),
                ),
              );
              child.once("close", (code) => {
                this.append(
                  s,
                  out.end() +
                    err.end() +
                    "\n[CLI] 进程退出，退出码：" +
                    code +
                    "\n",
                );
                if (activeStates.has(s.state) && s.state !== "checking")
                  s.state = code === 0 ? "finished" : "failed";
                resolve();
              });
              timer = setTimeout(() => {
                s.state = "expired";
                this.kill(s);
              }, 600000);
              timer.unref();
            });
            await s.checkingPromise;
          } catch (error) {
            s.state = "failed";
            this.append(s, "\n[启动错误] " + error.message + "\n");
          } finally {
            clearTimeout(timer);
            s.child = null;
            await keyring?.release();
          }
        },
        undefined,
        { key: id, exclusive: true },
      )
      .catch(() => {
        s.state = "failed";
      });
    return this.view(owner, id);
  }
  input(owner, id, value) {
    const s = this.current;
    if (
      !s ||
      s.owner !== owner ||
      s.id !== id ||
      !s.child ||
      !activeStates.has(s.state)
    )
      throw new AppError(409, "登录已结束，请重新发起");
    const keys = { enter: "\r", up: "\x1b[A", down: "\x1b[B", tab: "\t" };
    if (value.key && keys[value.key] && s.state !== "checking")
      s.child.stdin.write(keys[value.key]);
    else if (
      typeof value.code === "string" &&
      /^[A-Za-z0-9_./~+\-=]{4,2048}$/.test(value.code) &&
      !s.submitted &&
      loginDisplay(s.raw).url
    ) {
      // OAuth stays in official agy. Code is owner-bound and single-use; full CLI output remains in the protected in-memory login log.
      s.submitted = true;
      s.state = "submitted";
      const child = s.child;
      child.stdin.write("\x1b[200~" + value.code + "\x1b[201~");
      setTimeout(() => {
        if (s.child === child) child.stdin.write("\r");
      }, 80).unref();
    } else throw new AppError(400, "仅允许选择菜单或提交官方授权码");
    return this.view(owner, id);
  }
  append(s, text) {
    s.raw += text;
    s.bytes += Buffer.byteLength(text);
    if (s.bytes > 2 * 1024 * 1024 && s.state !== "output_limit") {
      s.state = "output_limit";
      s.raw += "\n[网页] 日志达到2MiB上限，已停止登录进程。\n";
      this.kill(s);
    }
  }
  async finish(owner, id, verify) {
    const s = this.current;
    if (!s || s.owner !== owner || s.id !== id)
      throw new AppError(409, "请先在当前会话发起登录");
    if (s.state === "checking") throw new AppError(409, "正在校验，请等待");
    s.state = "checking";
    this.append(
      s,
      "\n[网页] 正在验证已保存的登录状态；不会提前终止官方登录进程。\n",
    );
    const run = () => verify((part) => this.append(s, part));
    const work = s.child
      ? Promise.resolve().then(run)
      : this.queue.add(run, undefined, { key: id, exclusive: true });
    s.checkingPromise = work.catch(() => {});
    try {
      const value = await work;
      s.state = "verified";
      this.append(s, "\n[网页] 登录状态与实际生成验证通过。\n");
      this.kill(s);
      return value;
    } catch (error) {
      s.state = s.child ? "submitted" : "failed";
      this.append(s, "\n[校验失败] " + error.message + "\n");
      throw error;
    }
  }
  kill(s) {
    if (s.child)
      try {
        process.kill(-s.child.pid, "SIGKILL");
      } catch {}
  }
  stop(owner, id) {
    const s = this.current;
    if (s?.owner === owner && s.id === id) {
      s.state = "stopped";
      this.kill(s);
    }
    return this.view(owner, id);
  }
  close() {
    if (this.current) {
      this.current.state = "stopped";
      this.kill(this.current);
      this.current.raw = "";
    }
  }
}
