import {normalizeQuota} from "./services/quota.mjs";
import { Keyrings } from "./keyrings.mjs";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, accountId, classifyFailure, modelId } from "./common.mjs";
import {CliConversation} from "./cli-conversation.mjs";

function cliEnvironment(profile, work) {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE"];
  const env = Object.fromEntries(allowed.filter(k => process.env[k]).map(k => [k, process.env[k]]));
  env.HTTPS_PROXY ||= env.HTTP_PROXY;
  return Object.assign(env, profile.env, {LANG: "C.UTF-8", NO_COLOR: "1", TERM: "dumb",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true", TMPDIR: work, TEMP: work, TMP: work});
}
export async function profilePaths(dataDir, id) {
  accountId(id);
  const home = join(dataDir, "accounts", id, "home");
  await mkdir(join(home, ".gemini", "antigravity-cli"), {
    recursive: true,
    mode: 0o700,
  });
  const settings = join(home, ".gemini", "antigravity-cli", "settings.json");
  let old = {};
  try {
    old = JSON.parse(await readFile(settings, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // ASVS V1.2.5: text-only execution keeps CLI tool approvals strict; never enable YOLO.
  await writeFile(
    settings,
    JSON.stringify({
      ...old,
      toolPermission: "strict",
      allowNonWorkspaceAccess: false,
    }),
    { mode: 0o600 },
  );
  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
    },
  };
}
export class Runner {
  constructor({
    dataDir,
    command = "agy",
    prefix = [],
    timeout = 180000,
    outputLimit = 4 * 1024 * 1024,
  }) {
    Object.assign(this, { dataDir, command, prefix, timeout, outputLimit });
    this.activePids = new Set();
    this.sessions = new Map();
    this.keyrings =
      process.platform === "linux" && command === "agy" ? new Keyrings() : null;
  }
  async execute(
    id,
    { prompt, model = "", probe = false, signal, onOutput, schema, effort, quota = false, sessionId } = {},
  ) {
    modelId(model);
    if (effort != null && !["low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new AppError(400, "reasoning_effort 无效", "unsupported_parameter");
    if (sessionId) {
      if (probe || quota) throw new AppError(400, "查询命令不能复用对话会话");
      return this.executeSession(id, sessionId, {prompt, model, signal, onOutput, schema, effort});
    }
    const profile = await profilePaths(this.dataDir, id);
    const work = join(this.dataDir, "work", randomUUID());
    await mkdir(work, { recursive: true, mode: 0o700 });
    const env = cliEnvironment(profile, work);
    const schemaPath = join(work, "response-schema.json");
    if (schema != null) {
      // ASVS V1.2.5: server-owned fixed path, no shell or user-provided CLI arguments.
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    }
    const args = quota ? ["--print", "/usage", "--output-format", "json"] : probe
      ? ["models"]
      : [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
          ...(schema != null ? ["--json-schema", schemaPath] : []),
          ...(effort != null ? ["--effort", effort] : []),
          ...(model ? ["--model", model] : []),
        ];
    let keyring;
    try {
      keyring = await this.keyrings?.acquire(id, profile);
      if (keyring) Object.assign(env, keyring.env);
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new AppError(499, "请求已取消", "cancelled"));
          return;
        }
        // ASVS V1.2.5: no shell; prompts travel as structured stdin, never command strings.
        const child = spawn(this.command, [...this.prefix, ...args], {
          cwd: work,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
        if (child.pid) this.activePids.add(child.pid);
        let stdout = "",
          stderr = "",
          bytes = 0,
          failure = null;
        const outDecoder = new StringDecoder("utf8"),
          errDecoder = new StringDecoder("utf8");
        const kill = () => {
          try {
            if (process.platform !== "win32" && child.pid)
              process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        };
        const timer = setTimeout(() => {
          failure = new AppError(504, "agy 执行超时，已终止任务", "timeout");
          kill();
        }, quota ? Math.min(this.timeout,15000) : this.timeout);
        const abort = () => {
          failure = new AppError(499, "请求已取消", "cancelled");
          kill();
        };
        signal?.addEventListener("abort", abort, { once: true });
        const collect = (part, type) => {
          bytes += part.length;
          if (bytes > this.outputLimit) {
            failure = new AppError(502, "agy 输出超过安全上限", "output_limit");
            kill();
            return;
          }
          const value =
            type === "out" ? outDecoder.write(part) : errDecoder.write(part);
          onOutput?.(value);
          if (type === "out") stdout += value;
          else stderr += value;
        };
        child.stdout.on("data", (p) => collect(p, "out"));
        child.stderr.on("data", (p) => collect(p, "err"));
        child.stdin.on("error", () => {});
        child.on("error", () => {
          failure = new AppError(
            503,
            "无法启动 agy，请确认官方 CLI 已安装",
            "cli_unavailable",
          );
        });
        child.on("close", (code) => {
          stdout += outDecoder.end();
          stderr += errDecoder.end();
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.activePids.delete(child.pid);
          if (failure) {
            reject(failure);
            return;
          }
          if (code !== 0) {
            reject(classifyFailure(stdout + "\n" + stderr));
            return;
          }
          if (quota) {
            try { resolve({quota:normalizeQuota(JSON.parse(stdout))}); }
            catch(error) { reject(error instanceof AppError?error:new AppError(502,"官方CLI额度输出无效","invalid_quota_output")); }
            return;
          }
          if (probe) {
            const models = [];
            for (const line of stdout.split(/\r?\n/)) {
              const m = line
                .replace(/\x1b\[[0-9;]*m/g, "")
                .trim()
                .match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,159})(?:\t+| {2,})(.+)$/);
              if (m) models.push({ id: m[1], name: m[2].slice(0, 150) });
            }
            if (!models.length) {
              reject(classifyFailure(stdout + "\n" + stderr));
              return;
            }
            resolve({ models });
            return;
          }
          try {
            const events = stdout
              .split(/\r?\n/)
              .filter((x) => x.trim())
              .map((x) => JSON.parse(x));
            const terminal = events.filter((e) => e.event === "result");
            if (terminal.length !== 1)
              throw new AppError(
                502,
                "agy 未返回唯一的结束结果",
                "incomplete_result",
              );
            const result = terminal[0].result;
            if (!result || result.status !== "SUCCESS")
              throw classifyFailure(String(result?.error || ""));
            if (result.finished_reason) throw new AppError(502, "agy 返回未完成的结果", "incomplete_result");
            if (typeof result.response !== "string" || !result.response.trim())
              throw new AppError(502, "agy 返回空内容", "empty_result");
            const usage = {};
            for (const key of [
              "input_tokens",
              "output_tokens",
              "thinking_tokens",
              "cache_read_tokens",
              "total_tokens",
            ]) {
              const n = result.usage?.[key];
              if (Number.isFinite(n) && n >= 0) usage[key] = n;
            }
            resolve({
              response: result.response,
              ...(schema != null ? {structured_output: result.structured_output} : {}),
              usage,
              conversation_id: result.conversation_id,
              model:
                model ||
                events.find((e) => e.event === "init")?.init?.model ||
                null,
            });
          } catch (e) {
            reject(
              e instanceof AppError
                ? e
                : new AppError(
                    502,
                    "agy 返回了无效的结构化输出",
                    "invalid_output",
                  ),
            );
          }
        });
        if (probe || quota) child.stdin.end();
        else
          child.stdin.end(
            JSON.stringify({ event: "user", message: { content: prompt } }) +
              "\n",
          );
      });
    } finally {
      await keyring?.release();
      await rm(work, { recursive: true, force: true });
    }
  }
  get activePid() {
    return this.activePids.values().next().value || null;
  }
  async executeSession(id, sessionId, options) {
    accountId(id);
    const signature = JSON.stringify({model: options.model, schema: options.schema, effort: options.effort});
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = {account: id, signature};
      this.sessions.set(sessionId, entry);
      entry.ready = this.openSession(id, sessionId, options, entry).catch(error => {
        if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
        throw error;
      });
    }
    // Internal callers also cannot accidentally reuse a worker across identities/configs.
    if (entry.account !== id || entry.signature !== signature)
      throw new AppError(409, "会话账号、模型和生成配置不可更改", "session_mismatch");
    const worker = await entry.ready;
    const result = await worker.turn(options);
    return {...result, model: options.model || result.model};
  }
  async openSession(id, sessionId, {model, schema, effort}, entry) {
    const profile = await profilePaths(this.dataDir, id);
    const work = join(this.dataDir, "work", randomUUID());
    await mkdir(work, {recursive: true, mode: 0o700});
    let keyring;
    const cleanup = async pid => {
      this.activePids.delete(pid);
      this.onSessionClosed?.(sessionId);
      try { await keyring?.release(); } finally {
        try { await rm(work, {recursive: true, force: true}); } finally {
          if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
        }
      }
    };
    try {
      const env = cliEnvironment(profile, work);
      const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"];
      if (schema != null) {
        const schemaPath = join(work, "response-schema.json");
        await writeFile(schemaPath, JSON.stringify(schema), {mode: 0o600});
        args.push("--json-schema", schemaPath);
      }
      if (effort != null) args.push("--effort", effort);
      if (model) args.push("--model", model);
      keyring = await this.keyrings?.acquire(id, profile);
      Object.assign(env, keyring?.env);
      return new CliConversation({command: this.command, args: [...this.prefix, ...args], cwd: work, env,
        timeout: this.timeout, outputLimit: this.outputLimit,
        onPid: pid => { if (pid) this.activePids.add(pid); }, onClose: cleanup});
    } catch (error) { await cleanup(); throw error; }
  }
  async closeSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const worker = await entry.ready.catch(() => null);
    await worker?.close();
  }
  async close() {
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)));
    for (const pid of this.activePids) {
      try { if (process.platform !== "win32") process.kill(-pid, "SIGKILL"); else process.kill(pid, "SIGKILL"); } catch {}
    }
    await this.keyrings?.close();
  }
  async memory() {
    if (process.platform !== "linux" || !this.activePids.size) return null;
    const values = await Promise.all(
      [...this.activePids].map(async (pid) => {
        try {
          const s = await readFile("/proc/" + pid + "/status", "utf8");
          return Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024 || 0;
        } catch {
          return 0;
        }
      }),
    );
    return values.reduce((a, b) => a + b, 0) || null;
  }
}
