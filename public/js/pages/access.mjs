import {el,copy,note} from "../core.mjs";
export function mount(ctx){const $=ctx.$;
function render(){
 const enabled=ctx.state.accounts.filter(a=>a.enabled&&a.status==="ready"),target=$("endpointRows");target.replaceChildren();
 note("accessStatus",enabled.length?"当前 "+enabled.length+" 个账号可用于调用":"请先完成账号登录校验并启用账号");
 for(const [label,url]of [["Base URL",location.origin+"/v1"],["Chat Completions",location.origin+"/v1/chat/completions"],["模型列表",location.origin+"/v1/models"]]){
  const row=el("div","","endpoint-row"),body=el("div");body.append(el("small",label),el("code",url));
  const button=el("button","复制","secondary small");button.type="button";button.disabled=!enabled.length;button.onclick=()=>copy(url,button);row.append(body,button);row.classList.toggle("inactive",!enabled.length);target.append(row);
 }
 const first=enabled.flatMap(a=>a.models)[0]?.id||"MODEL_ID";
 const value="curl '"+location.origin+"/v1/chat/completions' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '"+JSON.stringify({model:first,messages:[{role:"user",content:"你好"}]})+"'";
 $("curlExample").textContent=value;$("copyCurl").onclick=()=>copy(value,$("copyCurl"));
}
return{render};}
