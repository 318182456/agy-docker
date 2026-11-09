const $ = (id) => document.getElementById(id);
let csrf = "",
  state = null,
  abortTask = null;
const expanded = new Map();
const loginPanels = new Map();
const text = (tag, value, className = "") => {
  const n = document.createElement(tag);
  n.textContent = value;
  n.className = className;
  return n;
};
function note(id, value, error = false) {
  $(id).textContent = value;
  $(id).className = "feedback" + (error ? " error" : "");
}
async function api(path, { method = "GET", data, signal } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(data ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" && csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    signal,
  });
  const value = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      value.error?.code === "admin_session_required"
    )
      showLogin();
    throw Error(value.error?.message || "操作失败");
  }
  return value;
}
function showLogin() {
  loginPanels.clear();
  $("login").hidden = false;
  $("workspace").hidden = true;
  $("refresh").hidden = true;
  $("logout").hidden = true;
  csrf = "";
}
function showWorkspace() {
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("refresh").hidden = false;
  $("logout").hidden = false;
}
const bytes = (n) =>
  n == null ? "未运行" : (n / 1024 / 1024).toFixed(1) + " MiB";
const count = (n) => new Intl.NumberFormat("zh-CN").format(n || 0);
function feedbackRow(id, title) {
  expanded.set(id, title);
  renderAccounts();
  return document.getElementById("detail-" + id).firstChild;
}
function renderAccounts() {
  const rows = $("accountRows");
  rows.replaceChildren();
  for (const a of state.accounts) {
    const row = document.createElement("tr");
    const identity = text("td", a.name);
    identity.append(text("small", a.id));
    const names = {
      not_logged_in: "待登录",
      ready: a.enabled ? "已启用" : "已登录 · 待启用",
      account_suspended: "Google 已停用",
      login_required: "登录已失效",
    };
    row.append(
      identity,
      text(
        "td",
        names[a.status] || a.status,
        a.enabled ? "status-ready" : "status-error",
      ),
      text(
        "td",
        `${count(a.requests)} / ${count(a.successes)} / ${count(a.failures)}`,
      ),
      text("td", a.token_reports ? count(a.total_tokens) : "未报告"),
    );
    const ops = document.createElement("td"),
      bar = text("div", "", "row-actions");
    const button = (label, action, danger = false) => {
      const b = text("button", label, "secondary" + (danger ? " danger" : ""));
      b.onclick = () =>
        action().catch((e) => {
          const target = feedbackRow(a.id, "操作失败");
          target.append(text("p", e.message, "status-error"));
        });
      bar.append(b);
    };
    button("登录 agy", async () => {
      await api("/api/accounts/" + a.id + "/login", {
        method: "POST",
        data: {},
      });
      loginPanels.delete(a.id);
      const cell = feedbackRow(a.id, "登录官方 agy");
      loginPanels.set(a.id, cell);
      cell.append(
        text(
          "p",
          "首次设置自动完成，默认不启用互动数据收集。只需打开官方授权页并粘贴一次授权码，程序会自动校验实际调用；Google 密码只在 Google 页面输入。",
        ),
      );
      const terminal = text("pre", "正在启动官方登录…", "login-terminal");
      terminal.setAttribute("aria-label", "官方 agy 登录状态");
      const status = text("p", "", "feedback");
      status.setAttribute("aria-live", "polite");
      const fullLog = text("details", "", "login-details");
      const logText = text("pre", "", "login-terminal");
      fullLog.append(text("summary", "完整 CLI 日志"), logText);
      const manual = text("details", "", "login-details");
      manual.append(text("summary", "手动控制（自动设置遇到新菜单时使用）"));
      const link = text("a", "打开 Google 官方授权页面", "button-link");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.hidden = true;
      const controls = text("div", "", "row-actions");
      for (const [label, key] of [
        ["上一个", "up"],
        ["下一个", "down"],
        ["确认/下一步", "enter"],
        ["切换焦点", "tab"],
      ]) {
        const b = text("button", label, "secondary");
        b.type = "button";
        b.onclick = async () => {
          try {
            await api("/api/accounts/" + a.id + "/login-input", {
              method: "POST",
              data: { key },
            });
            await poll();
          } catch (e) {
            status.textContent = e.message;
          }
        };
        controls.append(b);
      }
      const form = document.createElement("form");
      form.className = "inline-form";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = "粘贴 Google 显示的授权码";
      input.setAttribute("aria-label", "Google 一次性授权码");
      input.maxLength = 2048;
      const submit = text("button", "提交授权码");
      form.append(input, submit);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        input.value = "";
        submit.disabled = true;
        try {
          await api("/api/accounts/" + a.id + "/login-input", {
            method: "POST",
            data: { code },
          });
          await poll();
        } catch (err) {
          status.textContent = err.message;
          submit.disabled = false;
        }
      };
      let pollTimer;
      const end = text("button", "校验登录（实际调用）", "secondary"),
        cancel = text("button", "取消登录", "secondary");
      const finish = async (verify) => {
        end.disabled = true;
        try {
          if (verify) {
            status.textContent = "正在校验已保存的登录状态与实际生成…";
            await api("/api/accounts/" + a.id + "/login-finish", {
              method: "POST",
              data: {},
            });
          } else
            await api("/api/accounts/" + a.id + "/login-stop", {
              method: "POST",
              data: {},
            });
          input.value = "";
          await poll();
          await refresh();
          status.textContent = verify
            ? "登录与实际调用通过，可以启用账号。"
            : "登录已取消，完整日志保留在此处。";
        } catch (e) {
          await poll().catch(() => {});
          status.textContent = e.message;
        } finally {
          end.disabled = false;
        }
      };
      end.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      manual.append(controls, end);
      cell.append(status, link, form, terminal, fullLog, manual, cancel);
      const poll = async () => {
        clearTimeout(pollTimer);
        if (loginPanels.get(a.id) !== cell) return;
        try {
          const value = await api("/api/accounts/" + a.id + "/login");
          const follow =
            terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <
            32;
          terminal.textContent = value.screen || value.text || "正在启动官方登录…";
          logText.textContent = value.text || "";
          status.textContent = value.setup || "正在自动完成官方首次设置…";
          if (follow) terminal.scrollTop = terminal.scrollHeight;
          link.hidden = !value.url;
          if (value.url) link.href = value.url;
          form.hidden = !value.url && value.state !== "submitted";
          end.disabled = value.state === "checking";
          controls.hidden = !["running", "submitted"].includes(value.state);
          if (["submitted", "checking", "verified"].includes(value.state)) {
            submit.disabled = true;
          }
          if (value.state === "submitted")
            status.textContent =
              "授权码已提交，正在自动完成首次设置并校验实际调用，请稍候。";
          if (value.state === "checking")
            status.textContent = "正在验证持久化登录与真实生成，请等待…";
          if (value.state === "verified")
            status.textContent = "登录与实际调用已通过，可以启用账号。";
          if (
            ["starting", "running", "submitted", "checking"].includes(
              value.state,
            )
          )
            pollTimer = setTimeout(poll, 1500);
          else if (value.state !== "verified")
            status.textContent =
              "登录进程已结束；完整日志和退出状态保留在此处。";
        } catch (e) {
          status.textContent = e.message;
        }
      };
      await poll();
    });
    button("校验并测试", async () => {
      feedbackRow(a.id, "正在校验并实际测试（消耗额度）…");
      await api("/api/accounts/" + a.id + "/verify", {
        method: "POST",
        data: {},
      });
      await refresh();
      feedbackRow(a.id, "模型目录与实际调用均验证通过，可以启用账号。");
    });
    button(a.enabled ? "停用" : "启用", async () => {
      await api("/api/accounts/" + a.id, {
        method: "PATCH",
        data: { enabled: !a.enabled },
      });
      await refresh();
    });
    button("改名", async () => {
      const cell = feedbackRow(a.id, "修改账号名称");
      const input = document.createElement("input");
      input.value = a.name;
      input.maxLength = 100;
      input.setAttribute("aria-label", "新账号名称");
      const save = text("button", "保存");
      save.onclick = async () => {
        try {
          await api("/api/accounts/" + a.id, {
            method: "PATCH",
            data: { name: input.value },
          });
          expanded.delete(a.id);
          await refresh();
        } catch (e) {
          cell.append(text("p", e.message, "status-error"));
        }
      };
      cell.append(input, save);
      input.focus();
    });
    button(
      "移除",
      async () => {
        const cell = feedbackRow(a.id, "移除账号记录（登录目录仍保留）");
        const confirm = text("button", "确认移除", "secondary danger");
        confirm.onclick = async () => {
          try {
            await api("/api/accounts/" + a.id, { method: "DELETE" });
            expanded.delete(a.id);
            await refresh();
          } catch (e) {
            cell.append(text("p", e.message, "status-error"));
          }
        };
        cell.append(confirm);
      },
      true,
    );
    ops.append(bar);
    row.append(ops);
    rows.append(row);
    if (expanded.has(a.id)) {
      const detail = document.createElement("tr");
      detail.id = "detail-" + a.id;
      detail.className = "nearby";
      const cell = document.createElement("td");
      cell.colSpan = 5;
      if (loginPanels.has(a.id)) {
        detail.append(loginPanels.get(a.id));
        rows.append(detail);
        continue;
      }
      cell.append(text("strong", expanded.get(a.id)));
      detail.append(cell);
      rows.append(detail);
    }
  }
  if (!state.accounts.length) {
    const row = document.createElement("tr"),
      cell = text(
        "td",
        "还没有账号。添加后，点击“登录 agy”完成官方授权。",
        "empty",
      );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
  }
}
function render() {
  $("versionBadge").textContent = state.version
    ? "v" + state.version
    : "AGY Docker";
  const enabled = state.accounts.filter((a) => a.enabled);
  $("readyCount").textContent = enabled.length + " / " + state.accounts.length;
  $("concurrencyLabel").textContent = "最大并发 " + state.queue.concurrency;
  $("queueCount").textContent =
    state.queue.running + " / " + state.queue.waiting;
  $("gatewayMemory").textContent = bytes(state.memory.gateway_rss);
  $("cliMemory").textContent = bytes(state.memory.cli_rss);
  renderAccounts();
  const selection = $("taskAccount").value;
  $("taskAccount").replaceChildren(new Option("自动轮询", ""));
  for (const a of enabled) $("taskAccount").add(new Option(a.name, a.id));
  $("taskAccount").value = selection;
  renderModels();
  $("eventRows").replaceChildren();
  for (const event of state.events) {
    const row = document.createElement("tr");
    const who = text("td", event.account_name);
    who.append(text("small", event.model));
    row.append(
      text("td", new Date(event.at).toLocaleString("zh-CN", { hour12: false })),
      who,
      text(
        "td",
        event.status === 200
          ? "成功"
          : event.status + " · " + (event.code || "失败"),
        event.status === 200 ? "status-ready" : "status-error",
      ),
      text("td", (event.duration_ms / 1000).toFixed(1) + " 秒"),
      text(
        "td",
        event.total_tokens == null ? "未报告" : count(event.total_tokens),
      ),
    );
    $("eventRows").append(row);
  }
  if (!state.events.length) {
    const row = document.createElement("tr"),
      cell = text("td", "尚无任务记录", "empty");
    cell.colSpan = 5;
    row.append(cell);
    $("eventRows").append(row);
  }
}
function renderModels() {
  const selected = $("taskModel").value;
  const pool = state.accounts.filter(
    (a) =>
      a.enabled && (!$("taskAccount").value || a.id === $("taskAccount").value),
  );
  const models = new Map();
  for (const a of pool) for (const m of a.models) models.set(m.id, m.name);
  $("taskModel").replaceChildren(new Option("沿用 CLI 默认模型", ""));
  for (const [id, name] of models)
    $("taskModel").add(new Option(name + " · " + id, id));
  if (models.has(selected)) $("taskModel").value = selected;
}
async function refresh() {
  state = await api("/api/status");
  render();
}
$("loginForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    note("loginFeedback", "正在登录…");
    const value = await api("/auth/login", {
      method: "POST",
      data: { password: $("password").value },
    });
    $("password").value = "";
    csrf = value.csrf;
    showWorkspace();
    await refresh();
    note("loginFeedback", "");
  } catch (e) {
    note("loginFeedback", e.message, true);
  }
};
$("logout").onclick = async () => {
  await api("/auth/logout", { method: "POST", data: {} });
  showLogin();
};
$("refresh").onclick = () =>
  refresh().catch((e) => note("accountsFeedback", e.message, true));
$("addForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const a = await api("/api/accounts", {
      method: "POST",
      data: { name: $("accountName").value },
    });
    $("accountName").value = "";
    await refresh();
    note("accountsFeedback", "已添加 " + a.name + "，请点击该行“登录说明”。");
  } catch (e) {
    note("accountsFeedback", e.message, true);
  }
};
$("taskAccount").onchange = renderModels;
$("taskForm").onsubmit = async (event) => {
  event.preventDefault();
  abortTask = new AbortController();
  $("sendTask").disabled = true;
  $("cancelTask").hidden = false;
  $("taskResult").hidden = true;
  note("taskFeedback", "任务已提交，正在排队或执行…");
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      data: {
        prompt: $("prompt").value,
        model: $("taskModel").value,
        account_id: $("taskAccount").value || undefined,
      },
      signal: abortTask.signal,
    });
    $("answer").textContent = result.response;
    $("taskMeta").textContent =
      "执行账号：" +
      result.account.name +
      " · " +
      (result.usage.total_tokens == null
        ? "未报告"
        : count(result.usage.total_tokens)) +
      " Token";
    $("taskResult").hidden = false;
    note("taskFeedback", "任务完成");
    await refresh();
  } catch (e) {
    note(
      "taskFeedback",
      e.name === "AbortError" ? "任务已取消" : e.message,
      true,
    );
    await refresh().catch(() => {});
  } finally {
    abortTask = null;
    $("sendTask").disabled = false;
    $("cancelTask").hidden = true;
  }
};
$("cancelTask").onclick = () => abortTask?.abort();
$("apiUrl").textContent = location.origin + "/v1";
(async () => {
  try {
    const value = await api("/auth/session");
    csrf = value.csrf;
    showWorkspace();
    await refresh();
  } catch {
    showLogin();
  }
})();
