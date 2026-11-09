import {el,number as count,note,copy,fillOptions} from "../core.mjs";
export function mount(ctx){const $=ctx.$,api=ctx.api;let state=ctx.state,abortTask=null;
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
$("taskAccount").onchange=renderModels;
$("taskForm").onsubmit=async event=>{event.preventDefault();abortTask=new AbortController();$("sendTask").disabled=true;$("cancelTask").hidden=false;note("taskFeedback","任务已提交，正在排队或执行…");
try{const result=await api("/api/tasks",{method:"POST",data:{prompt:$("prompt").value,model:$("taskModel").value,account_id:$("taskAccount").value||undefined},signal:abortTask.signal});
$("answer").textContent=result.response;$("taskMeta").textContent="执行账号："+result.account.name+" · "+(result.usage.total_tokens==null?"未报告":count(result.usage.total_tokens)+" Token")+" · 请求 "+result.request_id;
$("taskResult").hidden=false;$("taskEmpty").hidden=true;note("taskFeedback","任务完成");await ctx.refresh();
}catch(error){note("taskFeedback",error.name==="AbortError"?"任务已取消":error.message,true);}
finally{abortTask=null;$("sendTask").disabled=false;$("cancelTask").hidden=true;}};
$("cancelTask").onclick=()=>abortTask?.abort();$("copyAnswer").onclick=()=>copy($("answer").textContent,$("copyAnswer"));
return{render(){state=ctx.state;fillOptions($("taskAccount"),state.accounts.filter(a=>a.enabled),"自动轮询");renderModels();},cleanup(){abortTask?.abort();}};}
