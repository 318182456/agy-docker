import {AppError} from "../common.mjs";
import {registerKeys} from "./keys.mjs";
import {registerSettings} from "./settings.mjs";
import {registerRecords,recordStats} from "./records.mjs";
export function registerAdmin(ctx){
  const {register,send,store,body,quotas,logger,sessions}=ctx;
  registerKeys(ctx);registerSettings(ctx);registerRecords(ctx);
  register("GET",/^\/api\/accounts\/(a_[a-f0-9]{16})\/quota$/,"read",async({res,match})=>send(res,quotas.view(match[1])));
  register("POST",/^\/api\/accounts\/(a_[a-f0-9]{16})\/quota$/,"mutation",async({req,res,match})=>{
    const input=await body(req);if(input.force!=null&&typeof input.force!=="boolean")throw new AppError(400,"force 必须为布尔值");
    store.get(match[1]);quotas.refresh(match[1],{force:input.force===true});send(res,quotas.view(match[1]),202);
  });
  register("POST","/api/accounts/bulk","mutation",async({req,res})=>{
    const input=await body(req);
    if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||typeof input.enabled!=="boolean")throw new AppError(400,"请选择1–100个账号和启用状态");
    const accounts=[...new Set(input.ids)].map(id=>store.get(id)),skipped=[];let updated=0;
    for(const a of accounts){
      if(input.enabled&&(!a.checked_at||!a.models.length||["login_required","account_suspended"].includes(a.status))){skipped.push({id:a.id,name:a.name,reason:"需先完成登录校验"});continue;}
      a.enabled=input.enabled;if(a.enabled)a.status="ready";updated++;
    }
    await store.save();
    await sessions?.closeWhere(s => accounts.some(a => a.id === s.account && !a.enabled));
    logger.info("accounts.bulk_updated",{count:updated});send(res,{updated,skipped});
  });
  register("GET","/api/overview","read",async({res})=>{
    store.prune();const accounts=store.list(),records=store.state.events;
    const days=new Map(),models=new Map();
    const since=Date.now()-7*86400000;
    for(const e of records){
      if(Date.parse(e.at)<since)continue;
      const day=new Date(Date.parse(e.at)+8*3600000).toISOString().slice(0,10);
      if(!days.has(day))days.set(day,{day,success:0,failures:0,tokens:0});
      const d=days.get(day);d[e.status===200?"success":"failures"]++;d.tokens+=e.total_tokens||0;
      const name=e.model||"未进入模型调度";if(!models.has(name))models.set(name,{model:name,count:0,tokens:0});
      const m=models.get(name);m.count++;m.tokens+=e.total_tokens||0;
    }
    send(res,{accounts:accounts.length,enabled:accounts.filter(a=>a.enabled).length,
      totals:accounts.reduce((t,a)=>({requests:t.requests+a.requests,successes:t.successes+a.successes,failures:t.failures+a.failures,tokens:t.tokens+a.total_tokens,reports:t.reports+(a.token_reports||0)}),{requests:0,successes:0,failures:0,tokens:0,reports:0}),
      retained:recordStats(records),days:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)),models:[...models.values()].sort((a,b)=>b.count-a.count).slice(0,8),
      ranking:accounts.slice().sort((a,b)=>b.total_tokens-a.total_tokens).slice(0,8).map(a=>({id:a.id,name:a.name,tokens:a.total_tokens,requests:a.requests})),
      retention_days:store.state.settings.log_retention_days,max_entries:store.state.settings.log_max_entries});
  });
}
