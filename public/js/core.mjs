export const $=id=>document.getElementById(id);
let csrf="";
export function setCsrf(value){csrf=value||"";}
export function el(tag,value="",className=""){const node=document.createElement(tag);node.textContent=value;node.className=className;return node;}
export function note(id,value,error=false){const node=typeof id==="string"?$(id):id;if(node){node.textContent=value;node.className="feedback"+(error?" error":"");}}
export async function api(path,{method="GET",data,signal}={}){
  const response=await fetch(path,{method,headers:{...(data!==undefined?{"content-type":"application/json"}:{}),...(method!=="GET"&&csrf?{"x-csrf-token":csrf}:{})},body:data!==undefined?JSON.stringify(data):undefined,signal});
  let value;try{value=await response.json();}catch{throw Error("服务响应无效（HTTP "+response.status+"）");}
  if(!response.ok){if(response.status===401&&value.error?.code==="admin_session_required"){csrf="";window.dispatchEvent(new Event("agy-auth-required"));}
    const error=Error(value.error?.message||"操作失败");error.code=value.error?.code;error.status=response.status;error.request_id=value.error?.request_id;throw error;}
  return value;
}
export function fmtDate(value,short=false){if(!value||!Number.isFinite(Date.parse(value)))return"—";return new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,...(short?{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}:{})});}
export function number(value){return Number.isFinite(value)?new Intl.NumberFormat("zh-CN").format(value):"未报告";}
export function bytes(value){return Number.isFinite(value)?(value/1024/1024).toFixed(1)+" MB":"未运行";}
export function emptyRows(target,message,columns){target.replaceChildren();const row=el("tr"),cell=el("td",message,"empty");cell.colSpan=columns;row.append(cell);target.append(row);}
export function action(label,run,{danger=false,small=true}={}){const button=el("button",label,"secondary"+(small?" small":"")+(danger?" danger":""));button.type="button";button.onclick=async()=>{
  button.disabled=true;try{await run(button);}catch(error){note("pageFeedback",error.message,true);}finally{if(button.isConnected)button.disabled=false;}
};return button;}
export async function copy(value,button){try{
  if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);
  else{const input=el("textarea");input.value=value;input.readOnly=true;input.className="clipboard-input";document.body.append(input);input.select();const done=document.execCommand("copy");input.remove();if(!done)throw Error("复制失败");}
  if(button){const old=button.textContent;button.textContent="已复制";setTimeout(()=>{if(button.isConnected)button.textContent=old;},1600);}
}catch{if(button)button.textContent="复制失败";else throw Error("复制失败");}}
export function params(values){return new URLSearchParams(Object.entries(values).filter(([,v])=>v!=null&&v!=="")).toString();}
export function fillOptions(select,items,placeholder){const selected=select.value;select.replaceChildren(new Option(placeholder,""));for(const item of items)select.add(new Option(item.name,item.id));select.value=selected;}
export function metric(label,value,detail="",href=null){
  const card=el(href?"a":"article","","metric");if(href)card.href=href;
  card.append(el("span",label,"metric-label"),el("strong",value),el("small",detail));return card;
}
