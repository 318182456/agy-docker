import {el,number,fmtDate,note,copy,params,fillOptions,emptyRows,action} from "../core.mjs";
export async function mount(ctx){const $=ctx.$;let page=1,applied={},last=null,keys=null;
const local=value=>value&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):"";
const iso=id=>$(id).value?new Date($(id).value).toISOString():"";
function filters(){return{account:$("recordAccount").value,key:$("recordKey").value,model:$("recordModel").value.trim(),result:$("recordResult").value,code:$("recordCode").value.trim(),from:iso("recordFrom"),to:iso("recordTo")};}
function setup(){
 fillOptions($("recordAccount"),ctx.state.accounts,"全部账号");
 const list=[{id:"master",name:"总密钥（.env）"},{id:"panel",name:"管理台"},...(keys?.items||[])];
 fillOptions($("recordKey"),list,"全部密钥");
 for(const [key,id]of [["account","recordAccount"],["key","recordKey"],["model","recordModel"],["result","recordResult"],["code","recordCode"]]){
  const value=ctx.params.get(key)||"";
  if(value&&["recordAccount","recordKey"].includes(id)&&![...$(id).options].some(x=>x.value===value))$(id).add(new Option("历史记录："+value,value));
  if(value)$(id).value=value;
 }
 $("recordFrom").value=local(ctx.params.get("from"));$("recordTo").value=local(ctx.params.get("to"));
 $("recordSize").value=String(ctx.state.settings.page_size);
 applied=filters();
}
async function load(){
 const size=Number($("recordSize").value);
 const data=await ctx.api("/api/records?"+params({...applied,page,size}));last=data;
 if(page>1&&!data.items.length){page=Math.max(1,Math.ceil(data.total/size));return load();}
 $("exportRecords").href="/api/records/export?"+params(applied);
 const stats=data.stats;$("recordSummary").replaceChildren(
  el("span","匹配 "+number(stats.total)+" 条"),el("span","成功 "+number(stats.success),"status-ready"),
  el("span","失败/取消 "+number(stats.failures),stats.failures?"status-error":""),
  el("span",stats.reported?number(stats.total_tokens)+" 报告 Token":"未报告 Token"),
  el("span","平均 "+(stats.average_ms/1000).toFixed(1)+" 秒")
 );
 const target=$("recordRows");target.replaceChildren();
 for(const record of data.items){
  const row=el("tr"),who=el("td",record.account_name||"尚未进入账号调度");who.append(el("small",record.model||"未提供模型"));
  const status=el("td",record.status===200?"成功":record.code==="cancelled"?"已取消":String(record.status),"");
  status.append(el("small",record.stage||record.kind||"历史记录"));status.className=record.status===200?"status-ready":"status-error";
  const usage=el("td",(record.duration_ms/1000).toFixed(1)+" 秒");usage.append(el("small",Number.isFinite(record.total_tokens)?number(record.total_tokens)+" Token":"未报告 Token"));
  const request=el("td"),code=el("code",(record.id||"").slice(0,8)+"…");code.title=record.id||"";
  request.append(code,action("复制",b=>copy(record.id,b)));
  const details=el("td");details.append(action("详情",()=>{const next=row.nextElementSibling;if(next?.dataset.detail===record.id){next.remove();return;}
    const detail=el("tr","","nearby");detail.dataset.detail=record.id;const cell=el("td");cell.colSpan=7;
    cell.append(el("strong","请求详情"),el("pre",JSON.stringify(record,null,2),"metadata"));detail.append(cell);row.after(detail);
  }));
  row.append(el("td",fmtDate(record.at)),who,el("td",record.api_key_name|| (record.kind==="verification"?"管理台校验":"历史未记录")),status,usage,request,details);target.append(row);
 }
 if(!data.items.length)emptyRows(target,"没有匹配记录",7);
 $("recordPagination").textContent=page+" / "+Math.max(1,Math.ceil(data.total/size))+" 页 · "+number(data.total)+" 条";
 $("recordsPrev").disabled=page<=1;$("recordsNext").disabled=page*size>=data.total;
}
keys=await ctx.api("/api/keys");setup();
$("recordFilters").onsubmit=async event=>{event.preventDefault();page=1;applied=filters();try{await load();}catch(e){note("recordFeedback",e.message,true);}};
$("resetRecordFilters").onclick=async()=>{for(const id of ["recordAccount","recordKey","recordModel","recordCode","recordFrom","recordTo"])$(id).value="";$("recordResult").value="all";page=1;applied=filters();await load();};
$("recordsPrev").onclick=async()=>{page=Math.max(1,page-1);await load();};$("recordsNext").onclick=async()=>{page++;await load();};
$("showClearRecords").onclick=()=>{$("clearRecordsText").textContent="将清理当前已应用筛选中的 "+number(last?.total||0)+" 条记录。账号和密钥累计用量保留。";$("clearRecordsPanel").hidden=false;};
$("cancelClearRecords").onclick=()=>{$("clearRecordsPanel").hidden=true;};
$("confirmClearRecords").onclick=async()=>{try{const result=await ctx.api("/api/records/clear",{method:"POST",data:{confirm:true,filters:applied}});$("clearRecordsPanel").hidden=true;page=1;await load();note("recordFeedback","已清理 "+result.deleted+" 条记录");}catch(e){note("recordFeedback",e.message,true);}};
return{render:load};
}
