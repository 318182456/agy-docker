import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AppError, accountId } from "./common.mjs";
import { profilePaths } from "./runner.mjs";
import { Onboarding } from "./onboarding.mjs";
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
      // ASVS V1.2.2: terms/privacy links are not OAuth authorization requests.
      if (
        u.hostname === "accounts.google.com" &&
        /^\/(?:o\/oauth2\/|signin\/oauth\/)/.test(u.pathname) &&
        !u.username && !u.password && !u.port
      )
        url = u.href;
    } catch {}
  }
  return { url, text: plain };
}
export class LoginManager {
  constructor({ dataDir, queue, store, keyrings = null, launch = spawn, verify = null, logger = null, beforeLogin = null }) {
    Object.assign(this, { dataDir, queue, store, keyrings, launch, verify, logger, beforeLogin });
    this.current = null;
  }
  view(owner, id) {
    const s = this.current;
    if (!s || s.owner !== owner || s.id !== id)
      return { state: "idle", text: "" };
    return {
      state: s.state,
      code_submitted: s.submitted,
      can_submit_code: s.state === "running" && !!s.child && !s.submitted && !s.onboarding?.done.has("complete") && !!loginDisplay(s.raw).url,
      verification_error: s.verificationError || null,
      text: loginDisplay(s.raw).text,
      screen: s.onboarding?.screen || "",
      setup: s.setup || "正在初始化官方 CLI…",
      url: s.submitted || s.onboarding?.done.has("complete") ? null : loginDisplay(s.raw).url,
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
    this.logger?.info("login.started",{account_id:id});
    s.work = this.queue
      .add(
        async () => {
          let timer, keyring;
          try {
            await this.beforeLogin?.();
            const p = await profilePaths(this.dataDir, id);
            const workspace = resolve(join(this.dataDir, "accounts", id, "login-workspace"));
            await mkdir(workspace, {recursive: true, mode: 0o700});
            if (await realpath(workspace) !== workspace)
              throw new AppError(400, "登录工作目录不能是符号链接");
            if (!activeStates.has(s.state)) return;
            keyring = await this.keyrings?.acquire(id, p);
            if (!activeStates.has(s.state)) return;
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
              AGY_CLI_DISABLE_AUTO_UPDATE: "true",
              TERM: "xterm-256color",
              LANG: "C.UTF-8",
              SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
            });
            // ASVS V1.2.5: fixed command only; web input reaches the CLI PTY, never a shell command.
            const child = (s.child = this.launch(
              "/usr/bin/script",
              ["-q", "-e", "-c", "/app/scripts/login-pty.sh", "/dev/null"],
              {
                cwd: workspace,
                env,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              },
            ));
            s.onboarding = new Onboarding({
              workspace,
              send: (data) => {
                if (s.child === child && ["running", "submitted"].includes(s.state))
                  child.stdin.write(data);
              },
              changed: (message) => { s.setup = message; this.logger?.info("login.stage",{account_id:id,stage:message}); },
              completed: () => this.autoVerify(s),
            });
            s.state = "running";
            if (this.store.get(id).checked_at) this.autoVerify(s);
            await new Promise((resolve, reject) => {
              const out = new StringDecoder("utf8"),
                err = new StringDecoder("utf8");
              child.stdout.on("data", (b) => {
                s.onboarding.write(b);
                this.append(s, out.write(b));
              });
              child.stderr.on("data", (b) => {
                s.onboarding.write(b);
                this.append(s, err.write(b));
              });
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
            clearTimeout(s.verifyTimer);
            s.onboarding?.close();
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
      s.state === "running" && !s.onboarding?.done.has("complete") &&
      typeof value.code === "string" &&
      /^[A-Za-z0-9_./~+\-=]{4,2048}$/.test(value.code) &&
      !s.submitted &&
      loginDisplay(s.raw).url
    ) {
      // OAuth stays in official agy. Code is owner-bound and single-use; full CLI output remains in the protected in-memory login log.
      this.logger?.info("login.code_submitted",{account_id:id});
      s.submitted = true;
      s.state = "submitted";
      const child = s.child;
      child.stdin.write("\x1b[200~" + value.code + "\x1b[201~");
      setTimeout(() => {
        if (s.child === child) {
          child.stdin.write("\r");
          this.autoVerify(s);
        }
      }, 80).unref();
    } else throw new AppError(400, "仅允许选择菜单或提交官方授权码");
    return this.view(owner, id);
  }
  autoVerify(s) {
    if (!this.verify || s.autoVerified) return;
    clearTimeout(s.verifyTimer);
    s.verifyTimer = setTimeout(() => {
      if (this.current !== s || !["running", "submitted"].includes(s.state)) return;
      const screen = s.onboarding?.screen || "";
      if (/Choose your color scheme:|help improve Antigravity CLI|Do you trust the contents of this project|Select login method:/i.test(screen)) {
        this.autoVerify(s);
        return;
      }
      if (!s.submitted && !s.onboarding?.done.has("complete")) {
        s.setup = "等待 Google 官方授权和首次设置完成…";
        return;
      }
      s.autoVerified = true;
      s.setup = "正在验证登录和实际调用…";
      this.finish(s.owner, s.id, (log) => this.verify(s.id, log))
        .then(() => { s.setup = "登录与实际调用通过，可以启用账号。"; })
        .catch(() => { s.autoVerified = false; s.setup = "自动校验未通过，原始错误见完整日志；可在此重试校验。"; });
    }, 3000);
    s.verifyTimer.unref();
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
    s.verificationError = null;
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
      this.logger?.info("login.verified",{account_id:id});
      s.state = "verified";
      this.append(s, "\n[网页] 登录状态与实际生成验证通过。\n");
      this.kill(s);
      return value;
    } catch (error) {
      s.verificationError = {code:error.code || "verification_failed",message:error.message};
      this.logger?.warn("login.verification_failed",{account_id:id,code:error.code||"verification_failed"});
      s.state = s.child ? (s.submitted ? "submitted" : "running") : "failed";
      this.append(s, "\n[校验失败] " + error.message + "\n");
      throw error;
    }
  }
  async restart(owner, id) {
    accountId(id);
    const s = this.current;
    // ASVS V2.3/V3.5: restart only the owner's flow; never interrupt verification or replay a code.
    if (s && (s.owner !== owner || s.id !== id))
      throw new AppError(409, "请先结束当前登录，再重新发起授权");
    if (s?.state === "checking") throw new AppError(409, "正在校验，请等待完成后再重新授权");
    if (s) {
      s.state = "stopped";
      this.kill(s);
      await s.work;
    }
    return this.start(owner, id);
  }
  kill(s) {
    clearTimeout(s.verifyTimer);
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
