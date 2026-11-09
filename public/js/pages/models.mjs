import {el,fmtDate} from "../core.mjs";
export function mount(ctx){const $=ctx.$,text=el;let state=ctx.state;
function renderModelCatalog() {
  const query = $("modelSearch").value.trim().toLowerCase();
  const availableOnly = $("modelAvailability").value === "available";
  const models = new Map();
  for (const account of state.accounts) {
    for (const model of account.models || []) {
      if (!models.has(model.id))
        models.set(model.id, {id: model.id, name: model.name, accounts: [], available: [], checked: null});
      const entry = models.get(model.id);
      entry.accounts.push(account.name);
      if (account.enabled && account.status === "ready" && account.checked_at) entry.available.push(account.name);
      if (account.checked_at && (!entry.checked || account.checked_at > entry.checked)) entry.checked = account.checked_at;
    }
  }
  const list = [...models.values()].filter((model) =>
    (!availableOnly || model.available.length) &&
    (!query || (model.id + " " + model.name).toLowerCase().includes(query)),
  ).sort((a, b) => a.id.localeCompare(b.id));
  $("modelCount").textContent = list.length + " / " + models.size + " 个模型";
  $("modelRows").replaceChildren();
  for (const model of list) {
    const row = document.createElement("tr");
    const identity = text("td", "");
    identity.append(text("code", model.id));
    if (model.name !== model.id) identity.append(text("small", model.name));
    const accounts = text("td", model.available.length + " / " + model.accounts.length,
      model.available.length ? "status-ready" : "muted");
    accounts.append(text("small", model.available.length ? model.available.join("、") : "暂无已启用账号"));
    accounts.title = "曾返回此模型的账号：" + model.accounts.join("、");
    const actions = text("td", ""), copy = text("button", "复制 ID", "secondary");
    copy.type = "button"; copy.setAttribute("aria-label", "复制模型 " + model.id);
    copy.onclick = async () => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(model.id);
        else {
          const input = document.createElement("textarea");
          input.value = model.id; input.readOnly = true;
          input.style.cssText = "position:fixed;opacity:0";
          document.body.append(input); input.select();
          const copied = document.execCommand("copy"); input.remove(); copy.focus();
          if (!copied) throw Error("复制不可用");
        }
        copy.textContent = "已复制";
      } catch { copy.textContent = "复制失败"; }
      setTimeout(() => { copy.textContent = "复制 ID"; }, 1800);
    };
    actions.append(copy);
    row.append(identity, accounts, text("td", model.checked
      ? fmtDate(model.checked) : "未完成校验"), actions);
    $("modelRows").append(row);
  }
  if (!list.length) {
    const row = document.createElement("tr"), cell = text("td",
      models.size ? "没有匹配的模型" : "尚未获取模型。请先添加账号并完成网页登录和校验。", "empty");
    cell.colSpan = 4; row.append(cell); $("modelRows").append(row);
  }
}

$("modelSearch").oninput=renderModelCatalog;$("modelAvailability").onchange=renderModelCatalog;return{render(){state=ctx.state;renderModelCatalog();}};}
