import {spawn} from "node:child_process";
import {StringDecoder} from "node:string_decoder";
import {AppError, classifyFailure} from "./common.mjs";

const invalid = () => new AppError(502, "agy 会话返回了无效的结构化输出", "invalid_output");
const usageKeys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];

// One official CLI process owns exactly one conversation. It is never a
// cross-request pool: callers must explicitly bind requests to this session.
export class CliConversation {
  constructor({command, args, cwd, env, timeout, outputLimit, onPid, onClose}) {
    Object.assign(this, {timeout, outputLimit});
    this.decoder = new StringDecoder("utf8");
    this.errDecoder = new StringDecoder("utf8");
    this.buffer = "";
    this.stderr = "";
    this.bytes = 0;
    this.turns = 0;
    this.previousUsage = {};
    this.pending = null;
    this.closed = false;
    this.done = new Promise(resolve => { this.finishClose = resolve; });
    // ASVS V1.2.5: fixed server-owned arguments, no shell; prompts only on stdin.
    this.child = spawn(command, args, {cwd, env, stdio: ["pipe", "pipe", "pipe"],
      shell: false, windowsHide: true, detached: process.platform !== "win32"});
    onPid(this.child.pid);
    this.child.stdin.on("error", () => this.fail(new AppError(502, "agy 会话输入已关闭，请开始新会话", "session_closed")));
    this.child.stdout.on("data", part => this.collect(part, false));
    this.child.stderr.on("data", part => this.collect(part, true));
    this.child.on("error", () => this.fail(new AppError(503, "无法启动 agy，请确认官方 CLI 已安装", "cli_unavailable")));
    this.child.on("close", async code => {
      this.closed = true;
      this.decoder.end();
      this.errDecoder.end();
      const error = this.failure || (code === 0
        ? new AppError(410, "agy 会话已结束，请开始新会话", "session_closed")
        : classifyFailure(this.stderr));
      const pending = this.pending;
      this.pending = null;
      pending?.cleanup();
      try { await onClose(this.child.pid); } catch {}
      finally { pending?.reject(error); this.finishClose(); }
    });
  }

  collect(part, isError) {
    if (this.closed || this.failure) return;
    this.bytes += part.length;
    if (this.bytes > this.outputLimit) {
      this.fail(new AppError(502, "agy 输出超过安全上限", "output_limit"));
      return;
    }
    const value = (isError ? this.errDecoder : this.decoder).write(part);
    this.pending?.onOutput?.(value);
    if (isError) { this.stderr += value; return; }
    this.buffer += value;
    try {
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.event(JSON.parse(line));
      }
      // Validate the entire received chunk before resolving its result.
      const pending = this.pending;
      if (pending?.result) {
        pending.cleanup();
        this.pending = null;
        this.turns++;
        pending.resolve(pending.result);
      }
    } catch (error) { this.fail(error instanceof AppError ? error : invalid()); }
  }

  event(event) {
    if (!event || typeof event !== "object") throw invalid();
    if (event.event === "init") {
      if (this.initialized) throw invalid();
      this.initialized = true;
      this.model = event.init?.model || null;
      return;
    }
    if (event.event !== "result") return;
    if (!this.pending || this.pending.result) throw invalid();
    const result = event.result;
    if (!result || result.status !== "SUCCESS") throw classifyFailure(String(result?.error || ""));
    if (result.finished_reason) throw new AppError(502, "agy 返回未完成的结果", "incomplete_result");
    if (typeof result.response !== "string" || !result.response.trim())
      throw new AppError(502, "agy 返回空内容", "empty_result");
    if (this.conversationId && result.conversation_id !== this.conversationId) throw invalid();
    this.conversationId = result.conversation_id;
    const usage = {}, current = {};
    // The official stream's counters are cumulative, not per turn. Never
    // double-charge prior turns, or invent a delta when a counter was missing.
    for (const key of usageKeys) {
      const n = result.usage?.[key], previous = this.previousUsage[key];
      if (!Number.isFinite(n) || n < 0) continue;
      current[key] = n;
      if (!this.turns) usage[key] = n;
      else if (Number.isFinite(previous)) {
        if (n < previous) throw invalid();
        usage[key] = n - previous;
      }
    }
    this.previousUsage = current;
    this.pending.result = {response: result.response, usage, conversation_id: result.conversation_id,
      structured_output: result.structured_output, model: this.model};
  }

  turn({prompt, signal, onOutput}) {
    if (this.closed || this.failure) return Promise.reject(new AppError(410, "agy 会话已结束，请开始新会话", "session_closed"));
    if (this.pending) return Promise.reject(new AppError(409, "会话正在执行任务", "session_busy"));
    if (signal?.aborted) return this.close(new AppError(499, "请求已取消，会话已关闭", "cancelled")).then(() => { throw this.failure; });
    this.bytes = 0;
    this.stderr = "";
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(new AppError(499, "请求已取消，会话已关闭", "cancelled"));
      const timer = setTimeout(() => this.fail(new AppError(504, "agy 执行超时，会话已关闭", "timeout")), this.timeout);
      this.pending = {resolve, reject, onOutput, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
      }};
      signal?.addEventListener("abort", abort, {once: true});
      this.child.stdin.write(JSON.stringify({event: "user", message: {content: prompt}}) + "\n");
    });
  }

  fail(error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {}
  }

  async close(error = new AppError(410, "会话已关闭，请开始新会话", "session_closed")) {
    this.fail(error);
    await this.done;
  }
}
