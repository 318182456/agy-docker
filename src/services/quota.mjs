import { AppError } from "../common.mjs";
export function normalizeQuota(envelope) {
  if (!envelope || envelope.status !== "SUCCESS" || !Array.isArray(envelope.command?.data?.groups))
    throw new AppError(502,"官方 CLI 没有返回可识别的额度数据","invalid_quota_output");
  const groups=envelope.command.data.groups.slice(0,30).map((g,index)=>({
    name:String(g.name||g.display_name||"额度组 "+(index+1)).slice(0,100),
    buckets:(Array.isArray(g.buckets)?g.buckets:[]).slice(0,20).map(b=>{
      const fraction=typeof b.remaining_fraction==="number"&&Number.isFinite(b.remaining_fraction)&&b.remaining_fraction>=0&&b.remaining_fraction<=1?b.remaining_fraction:null;
      return {id:String(b.id||"").slice(0,100),name:String(b.name||"").slice(0,100),window:String(b.window||"unknown").slice(0,30),
        remaining_fraction:fraction,reset_time:typeof b.reset_time==="string"&&Number.isFinite(Date.parse(b.reset_time))?new Date(b.reset_time).toISOString():null,
        disabled:b.disabled===true||b.is_disabled===true||b.enabled===false};
    }),
  }));
  return {groups,updated_at:new Date().toISOString()};
}
export class Quotas {
  constructor({store,runner,queue,logger}){Object.assign(this,{store,runner,queue,logger});this.pending=new Map();}
  view(id){
    const account=this.store.get(id),quota=account.quota||null;
    const age=quota?.updated_at?Date.now()-Date.parse(quota.updated_at):Infinity;
    return {quota,refreshing:this.pending.has(id),stale:age>this.store.state.settings.quota_cache_seconds*1000,error:account.quota_error||null};
  }
  refresh(id,{force=false}={}){
    const account=this.store.get(id);
    if(this.pending.has(id))return this.pending.get(id);
    if(!force&&!this.view(id).stale)return Promise.resolve(this.view(id));
    const work=this.queue.add(async()=>{
      const started=Date.now();this.logger?.info("quota.started",{account_id:id});
      try{
        const result=await this.runner.execute(id,{quota:true});
        account.quota=result.quota;account.quota_error=null;
        await this.store.save();
        this.logger?.info("quota.completed",{account_id:id,count:account.quota.groups.length,duration_ms:Date.now()-started});
      }catch(error){
        account.quota_error={code:error.code||"quota_failed",message:error.message,at:new Date().toISOString()};
        await this.store.save();
        this.logger?.warn("quota.failed",{account_id:id,code:error.code||"quota_failed",duration_ms:Date.now()-started});
      }
    },undefined,{key:id});
    this.pending.set(id,work);
    const result=work.catch(error=>{account.quota_error={code:error.code||"quota_failed",message:error.message,at:new Date().toISOString()};})
      .finally(()=>this.pending.delete(id)).then(()=>this.view(id));
    this.pending.set(id,result);return result;
  }
}
