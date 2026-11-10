import {AppError} from "../common.mjs";
export function registerKeys({register,send,body,store,auth,logger,sessions}){
  register("GET","/api/keys","read",async({res})=>send(res,{items:store.listKeys(),master:{id:"master",name:"总密钥（.env）",enabled:true,last4:auth.key.slice(-4),source:".env",usage:store.state.master_usage}}));
  register("POST","/api/keys","mutation",async({req,res})=>{
    const input=await body(req);const items=await store.createKeys([input],{reserved:[auth.password,auth.key]});logger.info("keys.created",{count:1});send(res,items[0],201);
  });
  register("POST","/api/keys/import","mutation",async({req,res})=>{
    const input=await body(req);let rows=[];
    if(typeof input.text==="string"){
      const text=input.text.trim();if(text.length>200000)throw new AppError(400,"导入内容过大");
      if(text.startsWith("[")){try{rows=JSON.parse(text);}catch{throw new AppError(400,"导入JSON无效");}}
      else rows=text.split(/\r?\n/).filter(x=>x.trim()).map(line=>{
        const parts=line.includes("\t")?line.trim().split(/\t+/):[line.trim().slice(0,line.trim().lastIndexOf(" ")),line.trim().slice(line.trim().lastIndexOf(" ")+1)];if(parts.length!==2||parts.some(x=>!x.trim()))throw new AppError(400,"每行格式：名称 TAB sk-密钥");return{name:parts[0],value:parts[1]};
      });
    }else if(Array.isArray(input.items))rows=input.items;
    const items=await store.createKeys(rows,{reserved:[auth.password,auth.key]});logger.info("keys.imported",{count:items.length});send(res,{items,count:items.length},201);
  });
  register("PATCH",/^\/api\/keys\/(k_[a-f0-9]{16})$/,"mutation",async({req,res,match})=>{
    const key=await store.patchKey(match[1],await body(req));
    if(!key.enabled || (key.expires_at && Date.parse(key.expires_at)<=Date.now()))
      await sessions?.closeWhere(s=>s.owner==="api:"+match[1]);
    send(res,key);
  });
  register("POST",/^\/api\/keys\/(k_[a-f0-9]{16})\/reveal$/,"mutation",async({res,match})=>send(res,{value:store.getKey(match[1]).value}));
  register("DELETE",/^\/api\/keys\/(k_[a-f0-9]{16})$/,"mutation",async({res,match})=>{
    store.getKey(match[1]);store.state.keys=store.state.keys.filter(k=>k.id!==match[1]);await store.save();
    await sessions?.closeWhere(s=>s.owner==="api:"+match[1]);
    logger.info("keys.deleted",{});send(res,{deleted:true});
  });
}
