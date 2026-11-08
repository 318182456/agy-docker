import { AppError } from "./common.mjs";
export class SerialQueue {
  constructor(limit = 32, concurrency = 1) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw Error("QUEUE_LIMIT must be 1–1000 and MAX_CONCURRENCY 1–16");
    Object.assign(this,{limit,concurrency});this.waiting=[];this.running=0;this.activeKeys=new Set();this.exclusive=false;
  }
  get activeAccount(){return this.activeKeys.values().next().value || null;}
  add(action, signal, { key = null, exclusive = false } = {}) {
    if(signal?.aborted)return Promise.reject(new AppError(499,"请求已取消","cancelled"));
    if(this.waiting.length>=this.limit)return Promise.reject(new AppError(429,"任务队列已满，请稍后重试","queue_full"));
    return new Promise((resolve,reject)=>{const job={action,signal,resolve,reject,key,exclusive};job.abort=()=>{const i=this.waiting.indexOf(job);if(i>=0){this.waiting.splice(i,1);reject(new AppError(499,"请求已取消","cancelled"));this.drain();}};signal?.addEventListener("abort",job.abort,{once:true});this.waiting.push(job);this.drain();});
  }
  drain(){
    while(!this.exclusive && this.running<this.concurrency && this.waiting.length){
      let index=-1;
      for(let i=0;i<this.waiting.length;i++){const j=this.waiting[i];if(j.exclusive){if(i===0&&this.running===0)index=i;break;}if(!j.key||!this.activeKeys.has(j.key)){index=i;break;}}
      if(index<0)return;
      const [job]=this.waiting.splice(index,1);job.signal?.removeEventListener("abort",job.abort);
      if(job.signal?.aborted){job.reject(new AppError(499,"请求已取消","cancelled"));continue;}
      this.running++;if(job.key)this.activeKeys.add(job.key);if(job.exclusive)this.exclusive=true;
      const finish=()=>{this.running--;if(job.key)this.activeKeys.delete(job.key);if(job.exclusive)this.exclusive=false;this.drain();};
      Promise.resolve().then(job.action).then(v=>{finish();job.resolve(v);},e=>{finish();job.reject(e);});
    }
  }
  get status(){return{running:this.running,waiting:this.waiting.length,limit:this.limit,concurrency:this.concurrency,active_account:this.activeAccount,active_accounts:[...this.activeKeys]};}
}
