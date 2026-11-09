import {el,number as count,fmtDate,note} from "../core.mjs";
export function mount(ctx){
  const $=ctx.$,text=el,api=ctx.api,refresh=()=>ctx.refresh();
  let state=ctx.state,active=true,quotaLoop=false,resumed=false;
  const selected=new Set(),expanded=new Map(),panels=new Map(),loginPanels=new Map(),loginStates=new Map(),timers=new Set();
  function visibleAccounts(){
    const query=$("accountSearch").value.trim().toLowerCase(),status=$("accountStatus").value;
    return state.accounts.filter(a=>(!query||(a.name+" "+a.id).toLowerCase().includes(query))&&
      (!status||(status==="enabled"?a.enabled:status==="disabled"?!a.enabled:!a.checked_at||["login_required","account_suspended"].includes(a.status))));
  }
  function selectionInfo(){$("selectionCount").textContent=selected.size?"已选 "+selected.size+" 个账号":"未选择账号";$("bulkEnable").disabled=$("bulkDisable").disabled=!selected.size;}
  function feedbackRow(id,title){
    expanded.set(id,title);loginPanels.delete(id);
    const cell=text("td","","detail-cell");cell.colSpan=8;cell.append(text("strong",title));panels.set(id,cell);
    renderAccounts();return cell;
  }
  function renderQuota(account){
    for(const [window,prefix] of [["5h","quota5-"],["weekly","quotaWeek-"]]){
      const cell=$(prefix+account.id);if(!cell)continue;cell.replaceChildren();
      const groups=account.quota?.groups||[];
      if(!groups.length){cell.append(text("small",account.quota_loading?"正在刷新…":account.quota_error?"查询失败":account.checked_at?"待查询":"登录后可查"));if(account.quota_error)cell.title=account.quota_error.message;continue;}
      for(const group of groups){
        const line=text("div","","quota-item"),bucket=group.buckets.find(b=>b.window===window);
        const label=group.name==="Gemini Models"?"Gemini":group.name==="Claude and GPT models"?"Claude / GPT":group.name;
        const top=text("div","","quota-label");top.append(text("span",label),text("strong",!bucket?"未提供":bucket.disabled?"未启用":bucket.remaining_fraction==null?"未提供":(bucket.remaining_fraction*100).toFixed(1)+"%"));
        line.append(top);
        if(bucket&&!bucket.disabled&&bucket.remaining_fraction!=null){const progress=document.createElement("progress");progress.max=1;progress.value=bucket.remaining_fraction;progress.setAttribute("aria-label",group.name+" "+window+" 剩余");line.append(progress);}
        if(bucket?.reset_time){const time=text("small","重置 "+fmtDate(bucket.reset_time,true));time.title=fmtDate(bucket.reset_time)+"（北京时间）";line.append(time);}
        cell.append(line);
      }
      if(window==="weekly"&&account.quota.updated_at)cell.append(text("small",(account.quota_error?"旧快照 ":"更新 ")+fmtDate(account.quota.updated_at,true),"quota-updated"));
      cell.classList.toggle("stale",!!account.quota_error);
      cell.title=(account.quota_error?account.quota_error.message+"；":"")+"额度更新："+fmtDate(account.quota.updated_at);
    }
  }
  function applyQuota(id,value){
    const a=state.accounts.find(a=>a.id===id);if(!a)return;
    a.quota=value.quota;a.quota_error=value.error;a.quota_loading=value.refreshing;renderQuota(a);
  }
  async function refreshQuota(id,force=false){
    const a=state.accounts.find(a=>a.id===id);if(!a)return;
    a.quota_loading=true;renderQuota(a);
    try{
      let value=await api("/api/accounts/"+id+"/quota",{method:"POST",data:{force}});applyQuota(id,value);
      while(active&&value.refreshing){await new Promise(r=>setTimeout(r,900));if(!active)return;value=await api("/api/accounts/"+id+"/quota");applyQuota(id,value);}
    }finally{const current=state.accounts.find(x=>x.id===id);if(current){current.quota_loading=false;renderQuota(current);}}
  }
  async function ensureQuotas(force=false){
    if(quotaLoop)return;quotaLoop=true;
    const accounts=state.accounts.filter(a=>a.checked_at&&a.status==="ready");let count=0;
    try{for(const a of accounts){
      if(!active)break;
      const stale=!a.quota?.updated_at||Date.now()-Date.parse(a.quota.updated_at)>state.settings.quota_cache_seconds*1000;
      const recentError=a.quota_error?.at&&Date.now()-Date.parse(a.quota_error.at)<30000;
      if(force||(stale&&!recentError)){await refreshQuota(a.id,force);count++;}
      $("quotaStatus").textContent="额度后台更新："+count+" 个账号 · 缓存 "+Math.round(state.settings.quota_cache_seconds/60)+" 分钟";
    }}catch(error){note("bulkFeedback",error.message,true);}finally{quotaLoop=false;}
  }
function renderAccounts() {
  const rows = $("accountRows");
  rows.replaceChildren();
  $("accountCount").textContent=visibleAccounts().length+" / "+state.accounts.length;
  for (const a of visibleAccounts()) {
    const row = document.createElement("tr");
    const identity = text("td", a.name);
    identity.append(text("small", a.id));
    const names = {
      not_logged_in: "待登录",
      ready: a.enabled ? "已启用" : "已登录 · 待启用",
      account_suspended: "Google 已停用",
      login_required: "登录已失效",
    };
    const selectCell=text("td"),check=document.createElement("input");
    check.type="checkbox";check.checked=selected.has(a.id);check.setAttribute("aria-label","选择 "+a.name);
    check.onchange=()=>{check.checked?selected.add(a.id):selected.delete(a.id);selectionInfo();};selectCell.append(check);
    const quota5=text("td","","quota-cell"),quotaWeek=text("td","","quota-cell");
    quota5.id="quota5-"+a.id;quotaWeek.id="quotaWeek-"+a.id;
    row.append(selectCell,identity,text("td",names[a.status]||a.status,a.enabled?"status-ready":"muted"),quota5,quotaWeek,
      text("td",count(a.requests)+" / "+count(a.successes)+" / "+count(a.failures)),text("td",a.token_reports?count(a.total_tokens):"未报告"));
    const ops = document.createElement("td"),
      bar = text("div", "", "row-actions");
    const more=text("details","","action-menu");more.append(text("summary","更多"));
    const button = (label, action, danger = false) => {
      const b = text("button", label, "secondary small" + (danger ? " danger" : ""));
      b.onclick = () =>
        action().catch((e) => {
          const target = feedbackRow(a.id, "操作失败");
          target.append(text("p", e.message, "status-error"));
        });
      const primary=label==="刷新额度"||label==="启用"||label==="停用"||(label==="登录 agy"&&!a.checked_at);
      (primary?bar:more).append(b);
      if(["starting","running","submitted","checking"].includes(loginStates.get(a.id))&&label!=="登录 agy")b.disabled=true;
    };
    button("登录 agy",()=>showLogin(a));
    button("刷新额度",()=>refreshQuota(a.id,true));
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
    if(more.childElementCount>1)bar.append(more);
    ops.append(bar);
    row.append(ops);
    rows.append(row);
    renderQuota(a);
    if (expanded.has(a.id)) {
      const detail = document.createElement("tr");
      detail.id = "detail-" + a.id;
      detail.className = "nearby";
      const cell = document.createElement("td");
      cell.colSpan = 8;
      if (panels.has(a.id)) {
        detail.append(panels.get(a.id));
        rows.append(detail);
        continue;
      }
      cell.append(text("strong", expanded.get(a.id)));
      detail.append(cell);
      rows.append(detail);
    }
  }
  if (!visibleAccounts().length) {
    const row = document.createElement("tr"),
      cell = text(
        "td",
        state.accounts.length?"没有匹配的账号":"还没有账号，添加后完成官方授权即可使用。",
        "empty",
      );
    cell.colSpan = 8;
    row.append(cell);
    rows.append(row);
  }
}

async function showLogin(a,resume=false){
      if(!resume)await api("/api/accounts/" + a.id + "/login", {
        method: "POST",
        data: {},
      });
      sessionStorage.setItem("agy.lastLogin",a.id);
      loginStates.set(a.id,"starting");
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
        const b = text("button", label, "secondary small");
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
        if (!active || loginPanels.get(a.id) !== cell) return;
        try {
          const value = await api("/api/accounts/" + a.id + "/login");
          loginStates.set(a.id,value.state);
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
          if (value.state === "verified") {
            status.textContent = "登录与实际调用已通过，可以启用账号。";
            if (!cell.dataset.verifiedRefreshed) {
              cell.dataset.verifiedRefreshed = "true";
              await refresh();
            }
          }
          if (
            ["starting", "running", "submitted", "checking"].includes(
              value.state,
            )
          )
            {pollTimer = setTimeout(poll, 1500);timers.add(pollTimer);}
          else if (value.state !== "verified")
            status.textContent =
              "登录进程已结束；完整日志和退出状态保留在此处。";
        } catch (e) {
          status.textContent = e.message;
        }
      };
      await poll();

}

  $("showAddAccount").onclick=()=>{$("addAccountPanel").hidden=false;$("accountName").focus();};
  $("cancelAddAccount").onclick=()=>{$("addAccountPanel").hidden=true;};
  $("addForm").onsubmit=async event=>{event.preventDefault();try{
    const a=await api("/api/accounts",{method:"POST",data:{name:$("accountName").value}});
    $("accountName").value="";$("addAccountPanel").hidden=true;await refresh();note("bulkFeedback","已添加 "+a.name+"，点击该行“登录 agy”开始授权。");
  }catch(error){note("accountsFeedback",error.message,true);}};
  $("accountSearch").oninput=renderAccounts;$("accountStatus").onchange=renderAccounts;
  const status=ctx.params.get("status");if(status==="ready")$("accountStatus").value="enabled";else if(status==="needs_login")$("accountStatus").value=status;
  $("accountSelectAll").onchange=()=>{for(const a of visibleAccounts())$("accountSelectAll").checked?selected.add(a.id):selected.delete(a.id);renderAccounts();selectionInfo();};
  for(const [id,enabled] of [["bulkEnable",true],["bulkDisable",false]])$(id).onclick=async()=>{try{
    const result=await api("/api/accounts/bulk",{method:"POST",data:{ids:[...selected],enabled}});
    selected.clear();await refresh();selectionInfo();note("bulkFeedback","已更新 "+result.updated+" 个账号"+(result.skipped.length?"，"+result.skipped.length+" 个需先校验":""));
  }catch(error){note("bulkFeedback",error.message,true);}};
  $("refreshAllQuotas").onclick=async()=>{$("refreshAllQuotas").disabled=true;await ensureQuotas(true);$("refreshAllQuotas").disabled=false;};
  return {async render(){
    state=ctx.state;renderAccounts();selectionInfo();$("accountCount").textContent=visibleAccounts().length+" / "+state.accounts.length;
    ensureQuotas();
    if(!resumed){resumed=true;const id=sessionStorage.getItem("agy.lastLogin"),a=state.accounts.find(x=>x.id===id);
      if(a){const view=await api("/api/accounts/"+id+"/login");if(view.state!=="idle")showLogin(a,true);}
    }
  },cleanup(){active=false;for(const timer of timers)clearTimeout(timer);}};
}
