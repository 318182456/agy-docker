import { Keyrings } from "./keyrings.mjs";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, accountId, classifyFailure, modelId } from "./common.mjs";
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
    this.keyrings =
      process.platform === "linux" && command === "agy" ? new Keyrings() : null;
  }
  async execute(
    id,
    { prompt, model = "", probe = false, signal, onOutput } = {},
  ) {
    modelId(model);
    const profile = await profilePaths(this.dataDir, id);
    const work = join(this.dataDir, "work", randomUUID());
    await mkdir(work, { recursive: true, mode: 0o700 });
    const allowed = [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
    ];
    const env = Object.fromEntries(
      allowed.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
    );
    env.HTTPS_PROXY ||= env.HTTP_PROXY;
    Object.assign(env, profile.env, {
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      TERM: "dumb",
      TMPDIR: work,
      TEMP: work,
      TMP: work,
    });
    const args = probe
      ? ["models"]
      : [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
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
        }, this.timeout);
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
          if (probe) {
            const models = [];
            for (const line of stdout.split(/\r?\n/)) {
              const m = line
                .replace(/\x1b\[[0-9;]*m/g, "")
                .trim()
                .match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s{2,}(.+)$/);
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
        if (probe) child.stdin.end();
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
