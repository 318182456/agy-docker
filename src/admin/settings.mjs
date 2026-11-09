import {AppError} from "../common.mjs";
export const defaultSettings={log_retention_days:7,log_max_entries:2000,quota_cache_seconds:300,page_size:20,log_level:"info"};
export function settingsInput(input){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new AppError(400,"设置必须为对象");
  const ranges={log_retention_days:[1,90],log_max_entries:[100,20000],quota_cache_seconds:[60,3600]};
  const out={};
  for(const [key,value] of Object.entries(input)){
    if(key in ranges){const [min,max]=ranges[key];if(!Number.isInteger(value)||value<min||value>max)throw new AppError(400,key+" 超出允许范围");}
    else if(key==="page_size"){if(![10,20,50,100].includes(value))throw new AppError(400,"每页条数无效");}
    else if(key==="log_level"){if(!["debug","info","warn","error"].includes(value))throw new AppError(400,"日志级别无效");}
    else throw new AppError(400,"不可修改设置 "+key);
    out[key]=value;
  }
  return out;
}
export function registerSettings({register,send,body,store,queue,runner,logger,dataDir,version}){
  const view=()=>({settings:store.state.settings,runtime:{version,node:process.version,concurrency:queue.concurrency,queue_limit:queue.limit,task_timeout_seconds:runner.timeout/1000,data_dir:dataDir,
    log_level:process.env.LOG_LEVEL||store.state.settings.log_level,log_level_locked:!!process.env.LOG_LEVEL,api_key_source:".env / API_KEY"}});
  register("GET","/api/settings","read",async({res})=>send(res,view()));
  register("PATCH","/api/settings","mutation",async({req,res})=>{
    const input=settingsInput(await body(req));
    if(process.env.LOG_LEVEL&&input.log_level&&input.log_level!==process.env.LOG_LEVEL)throw new AppError(409,"LOG_LEVEL 已由部署环境配置");
    Object.assign(store.state.settings,input);store.prune();
    logger.level=process.env.LOG_LEVEL||store.state.settings.log_level;
    await store.save();logger.info("settings.updated",{});send(res,view());
  });
}
