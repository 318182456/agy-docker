import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createApplication} from "../src/server.mjs";
import {Store} from "../src/store.mjs";
import {Runner} from "../src/runner.mjs";
import {Logger} from "../src/runtime/logger.mjs";
const password="synthetic-admin-password-123456789",master="synthetic-master-key-123456789";
async function fixture(action){
 const dir=await mkdtemp(join(tmpdir(),"agy-admin-test-")),logs=[];
 const app=await createApplication({dataDir:dir,password,key:master,logger:new Logger({sink:line=>logs.push(line)}),
 runner:new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/fake-cli.mjs")],timeout:3000})});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const origin="http://127.0.0.1:"+app.server.address().port;
 let cookie="",csrf="";
 const call=(path,{method="GET",data,headers={}}={})=>fetch(origin+path,{method,headers:{cookie,origin,"x-csrf-token":csrf,...(data!==undefined?{"content-type":"application/json"}:{}),...headers},body:data!==undefined?JSON.stringify(data):undefined});
 const login=async()=>{const res=await call("/auth/login",{method:"POST",data:{password}});cookie=res.headers.get("set-cookie").split(";")[0];csrf=(await res.json()).csrf;};
 const account=async(name="test")=>{const a=await(await call("/api/accounts",{method:"POST",data:{name}})).json();await call("/api/accounts/"+a.id+"/verify",{method:"POST",data:{}});await call("/api/accounts/"+a.id,{method:"PATCH",data:{enabled:true}});return a;};
 try{await login();await action({app,call,account,logs,dir,origin});}
 finally{app.loginManager.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.store.pending;await rm(dir,{recursive:true,force:true});}
}
test("managed keys keep old master access, enforce expiry/revocation, count usage and never expose secrets through status/logs",()=>fixture(async({app,call,account,logs})=>{
 const a=await account(),value="synthetic-imported-key-123456789";
 const created=await call("/api/keys",{method:"POST",data:{name:"project",value}});assert.equal(created.status,201);
 const key=await created.json();assert.ok(!("value" in key));assert.equal(key.expires_at,null);
 const wrong=await call("/v1/models",{headers:{authorization:value}});assert.equal(wrong.status,401);
 const denied=await call("/api/accounts",{headers:{cookie:"",authorization:"Bearer "+value}});assert.equal(denied.status,401);
 const noCsrf=await call("/api/keys/"+key.id+"/reveal",{method:"POST",data:{},headers:{"x-csrf-token":""}});assert.equal(noCsrf.status,403);
 const reveal=await(await call("/api/keys/"+key.id+"/reveal",{method:"POST",data:{}})).json();assert.equal(reveal.value,value);
 const headers={authorization:"Bearer "+value};
 const result=await call("/v1/chat/completions",{method:"POST",headers,data:{messages:[{role:"user",content:"PRIVATE_PROMPT_NOT_IN_LOG"}]}});
 assert.equal(result.status,200);const response=await result.json();const id=result.headers.get("x-request-id");assert.equal(response.agy.request_id,id);
 const record=app.store.state.events.find(e=>e.id===id);assert.equal(record.api_key_id,key.id);assert.equal(record.api_key_name,"project");
 const bad=await call("/v1/chat/completions",{method:"POST",headers,data:{temperature:"invalid",messages:[{role:"user",content:"x"}]}});
 assert.equal(bad.status,400);const failedId=bad.headers.get("x-request-id");assert.equal(app.store.state.events.find(e=>e.id===failedId).stage,"request_prepare");
 const data=await(await call("/api/keys")).json(),usage=data.items[0].usage;
 assert.equal(usage.requests,2);assert.equal(usage.successes,1);assert.equal(usage.failures,1);assert.equal(usage.total_tokens,13);
 const records=await(await call("/api/records?key="+key.id)).json();assert.equal(records.total,2);
 const status=await(await call("/api/status")).text();for(const secret of [password,master,value,"PRIVATE_PROMPT_NOT_IN_LOG"]){assert.ok(!status.includes(secret));assert.ok(!logs.join("\n").includes(secret));}
 assert.ok(logs.some(line=>line.includes('"event":"request.completed"')&&line.includes(id)));
 await call("/api/keys/"+key.id,{method:"PATCH",data:{enabled:false}});
 assert.equal((await call("/v1/models",{headers})).status,401);
 await call("/api/keys/"+key.id,{method:"PATCH",data:{enabled:true,expires_at:"2020-01-01T00:00:00Z"}});
 assert.equal((await call("/v1/models",{headers})).status,401);
 assert.equal((await call("/v1/models",{headers:{authorization:"Bearer "+master}})).status,200);
 await call("/api/keys/"+key.id,{method:"DELETE"});assert.equal((await(await call("/api/records?key="+key.id)).json()).total,2);
}));
test("New API tab imports are atomic and metadata/settings survive a store reload",()=>fixture(async({call,app,dir})=>{
 const text="project one\tsynthetic-project-one-123456789\nproject two\tsynthetic-project-two-123456789";
 const res=await call("/api/keys/import",{method:"POST",data:{text}});assert.equal(res.status,201);assert.equal((await res.json()).count,2);
 const duplicate=await call("/api/keys/import",{method:"POST",data:{text:"new\tsynthetic-project-new-123456789\nold\tsynthetic-project-one-123456789"}});assert.equal(duplicate.status,409);
 assert.equal(app.store.state.keys.length,2);
 await call("/api/settings",{method:"PATCH",data:{page_size:50,quota_cache_seconds:600,log_retention_days:14}});
 const reloaded=await new Store(dir).init();assert.equal(reloaded.listKeys().length,2);assert.equal(reloaded.state.settings.page_size,50);
 assert.equal((await call("/api/settings",{method:"PATCH",data:{data_dir:"elsewhere"}})).status,400);
}));
test("official quota command reports independent windows without generation and uses a shared fresh cache",()=>fixture(async({app,call,account})=>{
 const a=await account();const before=app.store.get(a.id).requests;
 const first=app.quotas.refresh(a.id,{force:true}),same=app.quotas.refresh(a.id,{force:true});assert.equal(first,same);
 const view=await first;assert.equal(view.refreshing,false);assert.equal(view.quota.groups.length,3);
 const gemini=view.quota.groups.find(g=>g.name==="Gemini Models");assert.equal(gemini.buckets.find(b=>b.window==="5h").remaining_fraction,.75);
 const argon=view.quota.groups.find(g=>g.name==="Gemini 4 Argon");assert.equal(argon.buckets.length,1);
 assert.equal(app.store.get(a.id).requests,before);
 const snapshot=view.quota.updated_at;await app.quotas.refresh(a.id);assert.equal(app.quotas.view(a.id).quota.updated_at,snapshot);
 const response=await(await call("/api/accounts/"+a.id+"/quota")).json();assert.equal(response.quota.groups[0].name,"Gemini Models");
}));
test("record filtering/export/clear retains lifetime counters; retention and pagination are bounded",()=>fixture(async({app,call,account})=>{
 const a=await account();await app.store.event({id:"failure",account_id:a.id,status:429,model:"sample",code:"rate_limited",duration_ms:23});
 const before=app.store.get(a.id).requests;
 const filtered=await(await call("/api/records?result=error&code=4xx&model=sample")).json();assert.equal(filtered.total,1);
 const exported=await call("/api/records/export?result=error");assert.equal(exported.status,200);assert.equal((await exported.json()).items[0].id,"failure");
 assert.equal((await call("/api/records?size=10000")).status,400);
 assert.equal((await call("/api/records/clear",{method:"POST",data:{filters:{result:"error"}}})).status,400);
 await call("/api/records/clear",{method:"POST",data:{confirm:true,filters:{result:"error"}}});
 assert.equal(app.store.get(a.id).requests,before);assert.ok(!app.store.state.events.some(x=>x.id==="failure"));
 app.store.state.events.push({id:"expired",at:new Date(Date.now()-20*86400000).toISOString(),status:200});app.store.prune();assert.ok(!app.store.state.events.some(x=>x.id==="expired"));
}));
test("eight distinct pages are reachable after refresh while data APIs remain session protected",()=>fixture(async({call})=>{
 for(const page of ["overview","accounts","models","tasks","records","keys","access","settings"]){
  const response=await call("/panel/"+page);assert.equal(response.status,200);assert.ok((await response.text()).includes('data-page="'+page+'"'));
 }
 assert.equal((await call("/api/keys",{headers:{cookie:""}})).status,401);
 assert.equal((await call("/js/../../state.json")).status,404);
}));
test("pre-existing metadata files migrate without losing accounts or counters",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"agy-migration-test-"));
 try{await writeFile(join(dir,"state.json"),JSON.stringify({accounts:[{id:"a_0123456789abcdef",name:"legacy",requests:15}],cursor:4,events:[]}));
 const store=await new Store(dir).init();assert.equal(store.get("a_0123456789abcdef").requests,15);assert.equal(store.state.settings.log_retention_days,7);assert.equal(store.state.keys.length,0);assert.equal(store.state.cursor,4);}
 finally{await rm(dir,{recursive:true,force:true});}
});
