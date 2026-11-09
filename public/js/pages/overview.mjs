import {el,metric,number,bytes,params} from "../core.mjs";
export function mount(ctx){const $=ctx.$;let timer=null;
function ranking(target,items,{label,value,href,detail}){
 target.replaceChildren();if(!items.length){target.append(el("p","暂无数据","empty"));return;}
 const max=Math.max(1,...items.map(value));
 for(const [i,item] of items.entries()){
  const row=el("a","","rank-row");row.href=href(item);
  const top=el("div","","rank-label");top.append(el("span",String(i+1).padStart(2,"0"),"rank-index"),el("span",label(item)),el("strong",number(value(item))));
  const bar=document.createElement("progress");bar.max=max;bar.value=value(item);bar.setAttribute("aria-label",label(item));
  row.append(top,bar);if(detail)row.append(el("small",detail(item)));target.append(row);
 }
}
function chart(days){
 const target=$("requestChart");target.replaceChildren();
 const map=new Map(days.map(x=>[x.day,x]));
 const list=Array.from({length:7},(_,i)=>{const day=new Date(Date.now()+8*3600000-(6-i)*86400000).toISOString().slice(0,10);return map.get(day)||{day,success:0,failures:0};});
 const max=Math.max(1,...list.map(d=>d.success+d.failures)),ns="http://www.w3.org/2000/svg";
 const svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 700 240");svg.setAttribute("role","img");svg.setAttribute("aria-label","近7天成功与失败请求");
 for(let y=30;y<=200;y+=56){const line=document.createElementNS(ns,"line");for(const [k,v]of Object.entries({x1:0,x2:700,y1:y,y2:y}))line.setAttribute(k,v);line.setAttribute("class","gridline");svg.append(line);}
 list.forEach((d,i)=>{
  const link=document.createElementNS(ns,"a");link.setAttribute("href","/panel/records?"+params({from:d.day+"T00:00:00+08:00",to:d.day+"T23:59:59.999+08:00"}));
  const total=d.success+d.failures,h=total/max*150,failed=d.failures/max*150;
  const title=document.createElementNS(ns,"title");title.textContent=d.day+"：成功 "+d.success+"，失败/取消 "+d.failures;link.append(title);
  for(const [height,y,type]of [[h,200-h,"chart-success"],[failed,200-h,"chart-error"]]){
   const rect=document.createElementNS(ns,"rect");for(const [k,v]of Object.entries({x:i*100+22,y,width:56,height,rx:4}))rect.setAttribute(k,v);rect.setAttribute("class",type);link.append(rect);
  }
  const label=document.createElementNS(ns,"text");label.setAttribute("x",i*100+50);label.setAttribute("y","224");label.setAttribute("text-anchor","middle");label.textContent=d.day.slice(5);link.append(label);
  if(total){const count=document.createElementNS(ns,"text");count.setAttribute("x",i*100+50);count.setAttribute("y",190-h);count.setAttribute("text-anchor","middle");count.textContent=number(total);link.append(count);}
  svg.append(link);
 });target.append(svg);
}
async function render(){
 const [data,runtime]=await Promise.all([ctx.api("/api/overview"),ctx.api("/api/runtime")]);
 const totals=data.totals,complete=totals.successes+totals.failures;
 $("overviewMetrics").replaceChildren(
  metric("可用账号",data.enabled+" / "+data.accounts,"已启用账号","/panel/accounts?status=ready"),
  metric("累计请求",number(totals.requests),"当前账号累计","/panel/records"),
  metric("成功率",complete?(totals.successes/complete*100).toFixed(1)+"%":"—","按已完成任务计算","/panel/records?result=error"),
  metric("累计报告 Token",totals.reports?number(totals.tokens):"未报告","不估算未报告部分","/panel/records")
 );
 chart(data.days);
 ranking($("accountRanking"),data.ranking,{label:x=>x.name,value:x=>x.tokens,href:x=>"/panel/records?account="+encodeURIComponent(x.id),detail:x=>number(x.requests)+" 次请求"});
 ranking($("modelRanking"),data.models,{label:x=>x.model,value:x=>x.count,href:x=>"/panel/records?model="+encodeURIComponent(x.model),detail:x=>number(x.tokens)+" 报告 Token"});
 const info=$("overviewRuntime");info.replaceChildren();
 for(const [label,value]of [["运行版本","v"+runtime.version],["任务队列",runtime.queue.running+" 执行 / "+runtime.queue.waiting+" 排队"],["最大并发",runtime.queue.concurrency],["网关内存",bytes(runtime.memory.gateway_rss)],["CLI 内存",bytes(runtime.memory.cli_rss)],["保留记录",number(data.retained.total)+" 条"]]){
  info.append(el("dt",label),el("dd",String(value)));
 }
 $("overviewNote").textContent="账号累计计数独立保留；趋势、热门模型和请求明细只统计保留记录（"+data.retention_days+" 天，最多 "+number(data.max_entries)+" 条），不包含已清理内容。";
}
timer=setInterval(()=>{if(!document.hidden)render().catch(()=>{});},30000);
return{render,cleanup(){clearInterval(timer);}};
}
