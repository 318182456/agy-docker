import {api,$,el,note,setCsrf} from "./core.mjs";
const page=document.body.dataset.page;
let controller=null,timer=null;
const ctx={state:null,api,$,el,note,params:new URLSearchParams(location.search),refresh:async()=>{
  ctx.state=await api("/api/accounts");await controller?.render?.();updateRuntime(ctx.state);
}};
function updateRuntime(data){
  const queue=data.queue;if(queue){$("runtimeBadge").textContent=queue.running?"执行 "+queue.running+" · 排队 "+queue.waiting:"运行正常 · 空闲";$("runtimeBadge").classList.toggle("busy",!!queue.running);}
  const version=data.version||ctx.state?.version;if(version){$("versionBadge").textContent="v"+version;$("sidebarVersion").textContent="v"+version;}
}
async function showWorkspace(){
  $("login").hidden=true;$("workspace").hidden=false;$("refresh").hidden=false;$("logout").hidden=false;$("runtimeBadge").hidden=false;
  ctx.state=await api("/api/accounts");
  const module=await import("./pages/"+page+".mjs");controller=await module.mount(ctx);await controller?.render?.();updateRuntime(ctx.state);
  clearInterval(timer);timer=setInterval(async()=>{if(document.hidden)return;try{updateRuntime(await api("/api/runtime"));}catch{}},20000);
}
function showLogin(){
  clearInterval(timer);controller?.cleanup?.();controller=null;setCsrf("");
  $("login").hidden=false;$("workspace").hidden=true;$("refresh").hidden=true;$("logout").hidden=true;$("runtimeBadge").hidden=true;
}
window.addEventListener("agy-auth-required",showLogin);
$("loginForm").onsubmit=async event=>{event.preventDefault();const button=$("loginForm").querySelector("button");button.disabled=true;
  try{const session=await api("/auth/login",{method:"POST",data:{password:$("password").value}});$("password").value="";setCsrf(session.csrf);await showWorkspace();}
  catch(error){note("loginFeedback",error.message,true);}finally{button.disabled=false;}
};
$("logout").onclick=async()=>{try{await api("/auth/logout",{method:"POST",data:{}});}finally{sessionStorage.removeItem("agy.lastLogin");showLogin();}};
$("refresh").onclick=async()=>{const button=$("refresh");button.disabled=true;try{await ctx.refresh();note("pageFeedback","已更新");}catch(e){note("pageFeedback",e.message,true);}finally{button.disabled=false;}};
const closeNav=()=>{document.body.classList.remove("nav-open");$("navBackdrop").hidden=true;$("menuToggle").setAttribute("aria-expanded","false");};
$("menuToggle").onclick=()=>{const open=!document.body.classList.contains("nav-open");document.body.classList.toggle("nav-open",open);$("navBackdrop").hidden=!open;$("menuToggle").setAttribute("aria-expanded",String(open));};
$("navBackdrop").onclick=closeNav;window.addEventListener("keydown",event=>{if(event.key==="Escape")closeNav();});
let theme=localStorage.getItem("agy.theme")||"light";document.documentElement.dataset.theme=theme;
$("themeToggle").onclick=()=>{theme=theme==="dark"?"light":"dark";document.documentElement.dataset.theme=theme;localStorage.setItem("agy.theme",theme);};
window.addEventListener("beforeunload",()=>controller?.cleanup?.());
try{const session=await api("/auth/session");setCsrf(session.csrf);await showWorkspace();}catch(error){showLogin();if(error.code!=="admin_session_required")note("loginFeedback",error.message,true);}
