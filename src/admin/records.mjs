import {AppError} from "../common.mjs";
export function recordFilters(input={}) {
  const out={};
  for(const key of ["account","key","model","result","from","to","code"]){
    const value=input[key];
    if(value==null||value==="")continue;
    if(typeof value!=="string"||value.length>200)throw new AppError(400,"记录筛选条件无效");
    out[key]=value;
  }
  if(out.result&&!["all","success","error"].includes(out.result))throw new AppError(400,"结果筛选无效");
  for(const key of ["from","to"])if(out[key]&&!Number.isFinite(Date.parse(out[key])))throw new AppError(400,"时间筛选无效");
  if(out.from&&out.to&&Date.parse(out.from)>Date.parse(out.to))throw new AppError(400,"开始时间不能晚于结束时间");
  if(out.code&&!/^[1-5](?:\d\d|xx)$/.test(out.code))throw new AppError(400,"状态码筛选无效");
  return out;
}
export function selectRecords(records,filters={}) {
  return records.filter(e=>
    (!filters.account||e.account_id===filters.account)&&(!filters.key||e.api_key_id===filters.key)&&
    (!filters.model||String(e.model||"").toLowerCase().includes(filters.model.toLowerCase()))&&
    (!filters.from||Date.parse(e.at)>=Date.parse(filters.from))&&(!filters.to||Date.parse(e.at)<=Date.parse(filters.to))&&
    (!filters.result||filters.result==="all"||(filters.result==="success"?e.status===200:e.status!==200))&&
    (!filters.code||(filters.code.endsWith("xx")?Math.floor(e.status/100)===Number(filters.code[0]):e.status===Number(filters.code)))
  );
}
export function recordStats(records) {
  const total=records.length,success=records.filter(x=>x.status===200).length;
  return {total,success,failures:total-success,total_tokens:records.reduce((n,x)=>n+(x.total_tokens||0),0),
    reported:records.filter(x=>Number.isFinite(x.total_tokens)).length,
    average_ms:total?Math.round(records.reduce((n,x)=>n+(x.duration_ms||0),0)/total):0};
}
export function registerRecords({register,send,store,body,logger}){
  register("GET","/api/records","read",async({req,res})=>{
    store.prune();const query=Object.fromEntries(new URL(req.url,"http://internal").searchParams);
    const filters=recordFilters(query),items=selectRecords(store.state.events,filters);
    const page=Number(query.page||1),size=Number(query.size||store.state.settings.page_size);
    if(!Number.isInteger(page)||page<1||page>100000||![10,20,50,100].includes(size))throw new AppError(400,"分页参数无效");
    send(res,{items:items.slice((page-1)*size,page*size),total:items.length,page,size,stats:recordStats(items)});
  });
  register("GET","/api/records/export","read",async({req,res})=>{
    const filters=recordFilters(Object.fromEntries(new URL(req.url,"http://internal").searchParams));
    res.writeHead(200,{"content-type":"application/json; charset=utf-8","content-disposition":'attachment; filename="agy-requests.json"'});
    res.end(JSON.stringify({exported_at:new Date().toISOString(),filters,items:selectRecords(store.state.events,filters)},null,2));
  });
  register("POST","/api/records/clear","mutation",async({req,res})=>{
    const input=await body(req);if(input.confirm!==true)throw new AppError(400,"请先确认清理范围");
    const matching=new Set(selectRecords(store.state.events,recordFilters(input.filters)));
    store.state.events=store.state.events.filter(x=>!matching.has(x));await store.save();
    logger.info("records.cleared",{count:matching.size});send(res,{deleted:matching.size});
  });
}
