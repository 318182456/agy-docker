import {el, number as count, note, copy, fillOptions} from "../core.mjs";

export function mount(ctx) {
  const $ = ctx.$, api = ctx.api;
  let state = ctx.state, abortTask = null, timer = null, disposed = false, session = null, endingSession = false;
  const duration = ms => {
    const seconds = Math.floor(ms / 1000);
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  };

  function renderModels() {
    const selected = $("taskModel").value;
    const pool = state.accounts.filter(a => a.enabled && (!$("taskAccount").value || a.id === $("taskAccount").value));
    const models = new Map();
    for (const a of pool) for (const m of a.models) models.set(m.id, m.name || m.id);
    $("taskModel").replaceChildren(new Option("沿用 CLI 默认模型", ""));
    for (const [id, name] of models) $("taskModel").add(new Option(name === id ? id : name + " · " + id, id));
    if (models.has(selected)) $("taskModel").value = selected;
  }

  function setState(value, label, title, detail) {
    $("taskOutput").dataset.state = value;
    $("taskStatus").textContent = label;
    $("taskStateTitle").textContent = title;
    $("taskStateDetail").textContent = detail;
    $("taskEmpty").hidden = value === "success";
    $("taskResult").hidden = value !== "success";
    $("taskResult").setAttribute("aria-busy", String(value === "pending"));
    $("taskWaitingTime").hidden = value !== "pending";
    $("copyAnswer").disabled = value !== "success";
  }

  function showRequest(id) {
    $("taskRequestId").textContent = id || "";
    $("taskRequest").hidden = !id;
  }
  function renderSession() {
    $("taskSessionBar").hidden = !session;
    $("taskSessionInfo").textContent = session ? (session.unavailable
      ? "上次任务未完成或会话已结束，请开始新对话"
      : "连续对话 · 已完成 " + session.turns + " 轮 · 空闲后自动关闭") : "";
    $("taskAccount").disabled = !!session;
    $("taskModel").disabled = !!session;
  }
  async function endSession() {
    if (abortTask || endingSession) return;
    endingSession = true;
    $("sendTask").disabled = true;
    $("taskSessionMode").disabled = true;
    $("endTaskSession").disabled = true;
    try {
      if (session) await api("/api/sessions/" + session.id, {method: "DELETE"});
      session = null;
      note("taskFeedback", "已结束上一段对话，下次发送将使用新的上下文。");
    } catch (error) {
      if (error.status === 404) session = null;
      else { $("taskSessionMode").checked = !!session; note("taskFeedback", error.message, true); }
    } finally {
      endingSession = false;
      if (!disposed) {
        $("sendTask").disabled = false;
        $("taskSessionMode").disabled = false;
        $("endTaskSession").disabled = false;
        renderSession();
      }
    }
  }
  $("endTaskSession").onclick = endSession;
  $("taskSessionMode").onchange = () => { if (!$("taskSessionMode").checked) void endSession(); };

  $("taskAccount").onchange = renderModels;
  $("taskForm").onsubmit = async event => {
    event.preventDefault();
    if (abortTask || endingSession) return;
    const controller = new AbortController();
    abortTask = controller;
    const started = performance.now();
    const data = {prompt: $("prompt").value, model: $("taskModel").value, account_id: $("taskAccount").value || undefined,
      session_id: $("taskSessionMode").checked ? session?.id || "new" : undefined};
    $("sendTask").disabled = true;
    $("sendTaskLabel").textContent = "等待响应";
    $("taskInputs").disabled = true;
    $("taskSessionMode").disabled = true;
    $("endTaskSession").disabled = true;
    $("cancelTask").hidden = false;
    $("cancelTask").disabled = false;
    $("taskElapsed").hidden = false;
    $("answer").textContent = "";
    $("taskMeta").replaceChildren();
    showRequest(null);
    setState("pending", "等待响应", "任务已发送，正在等待回答", "请求可能正在排队或执行，结果会在任务结束后显示。");
    note("taskFeedback", "任务已发送，可继续等待或取消。");
    const tick = () => {
      const elapsed = performance.now() - started;
      $("taskElapsed").textContent = "已等待 " + duration(elapsed);
      $("taskWaitingTime").textContent = duration(elapsed);
      if (elapsed >= 30000) $("taskStateDetail").textContent = "仍在等待响应，部分模型需要更长时间。你可以继续等待，或取消本次任务。";
    };
    tick();
    timer = setInterval(tick, 1000);
    try {
      const result = await api("/api/tasks", {method: "POST", data, signal: controller.signal});
      if (disposed) return;
      clearInterval(timer);
      session = result.session || null;
      if (session) {
        $("taskAccount").value = session.account_id;
        renderModels();
        $("taskModel").value = session.model || "";
      }
      renderSession();
      // ASVS V1.2.1: model output and account metadata stay plain text.
      $("answer").textContent = result.response;
      const metadata = [
        ["执行账号", result.account.name],
        ["模型", result.model || data.model || "CLI 默认模型（未报告名称）"],
        ["总耗时（含排队）", duration(performance.now() - started)],
        ["Token 用量", result.usage?.total_tokens == null ? "未报告" : count(result.usage.total_tokens)],
      ];
      for (const [label, value] of metadata) {
        const item = el("div");
        item.append(el("dt", label), el("dd", value));
        $("taskMeta").append(item);
      }
      showRequest(result.request_id);
      setState("success", "已完成", "", "");
      note("taskFeedback", "任务完成，回答与用量已更新。");
      // A refresh failure must not turn a successful task into an error.
      void ctx.refresh().catch(() => {});
    } catch (error) {
      if (disposed) return;
      const cancelled = error.name === "AbortError" || error.code === "cancelled";
      if (session && (cancelled || error.status === 404 || error.status >= 500)) session.unavailable = true;
      // ASVS V16.5.1: show the API's safe message, never raw CLI diagnostics.
      setState(cancelled ? "cancelled" : "error", cancelled ? "已取消" : "执行失败",
        cancelled ? "本次任务已取消" : "任务未能完成",
        cancelled ? "任务内容已保留，可以调整后重新发送。" : error.message);
      showRequest(error.request_id);
      note("taskFeedback", cancelled ? "任务已取消，内容已保留。" : error.message, !cancelled);
    } finally {
      clearInterval(timer);
      timer = null;
      abortTask = null;
      if (!disposed) {
        $("taskElapsed").textContent = "总耗时 " + duration(performance.now() - started);
        $("sendTask").disabled = false;
        $("sendTaskLabel").textContent = "发送任务";
        $("taskInputs").disabled = false;
        $("taskSessionMode").disabled = false;
        $("endTaskSession").disabled = false;
        renderSession();
        $("cancelTask").hidden = true;
      }
    }
  };
  $("cancelTask").onclick = () => {
    $("cancelTask").disabled = true;
    abortTask?.abort();
  };
  $("copyAnswer").onclick = () => copy($("answer").textContent, $("copyAnswer"));
  return {
    render() {
      state = ctx.state;
      if (abortTask) return;
      if (!session) {
        fillOptions($("taskAccount"), state.accounts.filter(a => a.enabled), "自动轮询");
        renderModels();
      }
      renderSession();
    },
    cleanup() {
      disposed = true;
      clearInterval(timer);
      abortTask?.abort();
      if (session) void api("/api/sessions/" + session.id, {method: "DELETE"}).catch(() => {});
    },
  };
}
