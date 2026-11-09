import {el,number,fmtDate,note,action,copy,emptyRows} from "../core.mjs";
export function mount(ctx){const $=ctx.$;let items=[],master=null;const revealed=new Map(),panels=new Map();
const expiry=id=>$(id).value?new Date($(id).value).toISOString():null;
const local=value=>value?new Date(Date.parse(value)-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):"";
function panel(key,title){const cell=el("td","","detail-cell");cell.colSpan=6;cell.append(el("strong",title));panels.set(key.id,cell);renderTable();return cell;}
async function reveal(key){if(!revealed.has(key.id)){const result=await ctx.api("/api/keys/"+key.id+"/reveal",{method:"POST",data:{}});revealed.set(key.id,result.value);}return revealed.get(key.id);}
function renderTable(){
 const target=$("keyRows");target.replaceChildren();$("keyCount").textContent=items.length+" 个";
 const query=$("keySearch").value.toLowerCase(),filter=$("keyStatus").value;
 const list=[master,...items].filter(Boolean).filter(k=>(!query||k.name.toLowerCase().includes(query))&&(!filter||(filter==="active"?k.enabled&&!k.expired:filter==="disabled"?!k.enabled:k.expired)));
 for(const key of list){
  const row=el("tr"),name=el("td",key.name);name.append(el("small",key.source||"项目密钥"));
  const usage=key.usage||{},use=el("td",usage.token_reports?number(usage.total_tokens)+" Token":usage.requests?"未报告 Token":"未调用");
  use.append(el("small",number(usage.requests||0)+" 次 · "+number(usage.successes||0)+" 成功 / "+number(usage.failures||0)+" 失败"));
  const value=el("td","","key-value"),code=el("code",revealed.get(key.id)||"••••"+key.last4);value.append(code);
  const status=key.expired?"已到期":key.enabled?"启用":"停用",ops=el("td"),bar=el("div","","row-actions");
  const records=el("a","请求记录","button secondary small");records.href="/panel/records?key="+encodeURIComponent(key.id);bar.append(records);
  if(key.id!=="master"){
    bar.append(action(revealed.has(key.id)?"隐藏密钥":"查看密钥",async()=>{
      if(revealed.has(key.id))revealed.delete(key.id);else await reveal(key);renderTable();
    }));
    bar.append(action("复制",async b=>copy(await reveal(key),b)));
    bar.append(action(key.enabled?"停用":"启用",async()=>{await ctx.api("/api/keys/"+key.id,{method:"PATCH",data:{enabled:!key.enabled}});await load();}));
    bar.append(action("编辑",()=>{
      const cell=panel(key,"编辑名称和到期时间"),form=el("form","","inline-form"),label=el("label","名称"),input=el("input");input.value=key.name;input.maxLength=100;input.required=true;input.setAttribute("aria-label","密钥名称");
      label.append(input);const dateLabel=el("label","到期（本地时间，可留空）"),date=el("input");date.type="datetime-local";date.value=local(key.expires_at);date.setAttribute("aria-label","密钥到期时间");dateLabel.append(date);
      const save=el("button","保存"),cancel=action("取消",()=>{panels.delete(key.id);renderTable();});
      form.append(label,dateLabel,save,cancel);form.onsubmit=async e=>{e.preventDefault();try{await ctx.api("/api/keys/"+key.id,{method:"PATCH",data:{name:input.value,expires_at:date.value?new Date(date.value).toISOString():null}});panels.delete(key.id);await load();note("keyFeedback","已保存");}catch(error){note("keyFeedback",error.message,true);}};
      cell.append(form);input.focus();
    }));
    bar.append(action("删除",()=>{
      const cell=panel(key,"删除 "+key.name+"？后续请求将被拒绝，历史记录保留。");
      cell.append(action("确认删除",async()=>{await ctx.api("/api/keys/"+key.id,{method:"DELETE"});panels.delete(key.id);revealed.delete(key.id);await load();},{danger:true}),
        action("取消",()=>{panels.delete(key.id);renderTable();}));
    },{danger:true}));
  }
  ops.append(bar);row.append(name,use,value,el("td",status,key.enabled&&!key.expired?"status-ready":"muted"),el("td",key.expires_at?fmtDate(key.expires_at):"永不过期"),ops);target.append(row);
  if(panels.has(key.id)){const detail=el("tr","","nearby");detail.append(panels.get(key.id));target.append(detail);}
 }
 if(!list.length)emptyRows(target,"没有匹配的密钥",6);
}
async function load(){const data=await ctx.api("/api/keys");items=data.items;master=data.master;for(const id of revealed.keys())if(!items.some(k=>k.id===id))revealed.delete(id);renderTable();}
$("showCreateKey").onclick=()=>{$("keyImportPanel").hidden=true;$("keyCreatePanel").hidden=false;$("newKeyName").focus();};
$("cancelCreateKey").onclick=()=>{$("keyCreatePanel").hidden=true;$("newKeyValue").value="";};
$("showImportKeys").onclick=()=>{$("keyCreatePanel").hidden=true;$("keyImportPanel").hidden=false;$("keyImportText").focus();};
$("cancelImportKeys").onclick=()=>{$("keyImportPanel").hidden=true;$("keyImportText").value="";};
$("keyCreateForm").onsubmit=async e=>{e.preventDefault();try{await ctx.api("/api/keys",{method:"POST",data:{name:$("newKeyName").value,expires_at:expiry("newKeyExpiry"),value:$("newKeyValue").value.trim()||undefined}});
$("keyCreateForm").reset();$("keyCreatePanel").hidden=true;await load();note("keyFeedback","已创建，可在对应行查看和复制密钥。");}catch(error){note("keyFeedback",error.message,true);}};
$("keyImportForm").onsubmit=async e=>{e.preventDefault();try{const data=await ctx.api("/api/keys/import",{method:"POST",data:{text:$("keyImportText").value}});$("keyImportText").value="";$("keyImportPanel").hidden=true;await load();note("keyFeedback","已导入 "+data.count+" 项，可继续沿用原客户端密钥。");}catch(error){note("keyFeedback",error.message,true);}};
$("keySearch").oninput=renderTable;$("keyStatus").onchange=renderTable;
return{render:load,cleanup(){revealed.clear();}};
}
