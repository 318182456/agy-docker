import {el,bytes,note} from "../core.mjs";
export function mount(ctx){const $=ctx.$;let initialized=false,dirty=false,current=null;
$("settingsForm").oninput=()=>dirty=true;
async function render(){
 const [data,run]=await Promise.all([ctx.api("/api/settings"),ctx.api("/api/runtime")]);current=data;
 if(!initialized||!dirty){$("settingRetention").value=data.settings.log_retention_days;$("settingMaxEntries").value=data.settings.log_max_entries;$("settingQuotaTtl").value=data.settings.quota_cache_seconds;$("settingPageSize").value=data.settings.page_size;$("settingLogLevel").value=data.runtime.log_level;initialized=true;}
 $("settingLogLevel").disabled=data.runtime.log_level_locked;$("logLevelSource").textContent=data.runtime.log_level_locked?"由 LOG_LEVEL 环境变量固定":"日志写入 Docker 标准输出，受容器日志轮转限制";
 const target=$("runtimeSettings");target.replaceChildren();
 for(const [label,value]of [["运行版本","v"+data.runtime.version],["Node.js",data.runtime.node],["最大并发",data.runtime.concurrency],["排队上限",data.runtime.queue_limit],["模型任务超时",data.runtime.task_timeout_seconds+" 秒"],["数据目录",data.runtime.data_dir],["网关内存",bytes(run.memory.gateway_rss)],["CLI 内存",bytes(run.memory.cli_rss)],["队列",run.queue.running+" 执行 / "+run.queue.waiting+" 排队"]])target.append(el("dt",label),el("dd",String(value)));
}
$("settingsForm").onsubmit=async e=>{e.preventDefault();const data={log_retention_days:Number($("settingRetention").value),log_max_entries:Number($("settingMaxEntries").value),quota_cache_seconds:Number($("settingQuotaTtl").value),page_size:Number($("settingPageSize").value)};
if(!current.runtime.log_level_locked)data.log_level=$("settingLogLevel").value;
try{await ctx.api("/api/settings",{method:"PATCH",data});dirty=false;await ctx.refresh();note("settingsFeedback","设置已保存并生效");}catch(error){note("settingsFeedback",error.message,true);}};
return{render};
}
