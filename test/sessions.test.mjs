import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {Runner} from "../src/runner.mjs";
import {Sessions} from "../src/sessions.mjs";
import {createApplication} from "../src/server.mjs";
import {Store} from "../src/store.mjs";
import {SerialQueue} from "../src/queue.mjs";
import {LoginManager} from "../src/login.mjs";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
const aid = "a_1111111111111111";
async function fixture(action, timeout = 2000) {
  const dir = await mkdtemp(join(tmpdir(), "agy-session-test-"));
  const runner = new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/session-cli.mjs")],timeout});
  try { await action(runner,dir); }
  finally { await runner.close(); await rm(dir,{recursive:true,force:true}); }
}
test("explicit sessions reuse one official-style process; independent requests never inherit context; usage is a delta", () =>
  fixture(async runner => {
    const first=await runner.execute(aid,{sessionId:"test",prompt:"SECRET-A",model:"gemini-test-medium"});
    const second=await runner.execute(aid,{sessionId:"test",prompt:"NEXT",model:"gemini-test-medium"});
    assert.equal(JSON.parse(first.response).pid,JSON.parse(second.response).pid);
    assert.equal(JSON.parse(first.response).auto_update_disabled,true);
    assert.deepEqual(JSON.parse(second.response).prompts,["SECRET-A","NEXT"]);
    assert.equal(first.usage.total_tokens,13);assert.equal(second.usage.total_tokens,13);
    assert.equal((await runner.execute(aid,{sessionId:"test",prompt:"SPLIT",model:"gemini-test-medium"})).response,"你好，持续会话");
    const independent=await runner.execute(aid,{prompt:"SEPARATE"});
    assert.equal(JSON.parse(independent.response).auto_update_disabled,true);
    assert.deepEqual(JSON.parse(independent.response).prompts,["SEPARATE"]);
    await assert.rejects(runner.execute("a_2222222222222222",{sessionId:"test",prompt:"foreign",model:"gemini-test-medium"}),e=>e.code==="session_mismatch");
    await runner.closeSession("test");assert.equal(runner.activePids.size,0);
  }));
test("session cancellation, timeout, malformed results, duplicate results and regressing counters destroy the worker", () =>
  fixture(async runner => {
    for(const prompt of ["INVALID","DOUBLE","CRASH"]) {
      await assert.rejects(runner.execute(aid,{sessionId:prompt,prompt}));
      assert.equal(runner.sessions.size,0);
    }
    await runner.execute(aid,{sessionId:"usage",prompt:"FIRST"});
    await assert.rejects(runner.execute(aid,{sessionId:"usage",prompt:"DECREASE"}),e=>e.code==="invalid_output");
    await assert.rejects(runner.execute(aid,{sessionId:"region",prompt:"REGION"}),e=>e.code==="unsupported_region"&&e.status===403);
    await assert.rejects(runner.execute(aid,{sessionId:"preinit",prompt:"PRE_INIT_ERROR"}),e=>e.code==="login_required");
    const abort=new AbortController();
    const task=runner.execute(aid,{sessionId:"abort",prompt:"HANG",signal:abort.signal});
    setTimeout(()=>abort.abort(),100);
    await assert.rejects(task,e=>e.code==="cancelled");
    runner.timeout=100;
    await assert.rejects(runner.execute(aid,{sessionId:"timeout",prompt:"HANG"}),e=>e.code==="timeout");
    assert.equal(runner.sessions.size,0);assert.equal(runner.activePids.size,0);
    runner.outputLimit=1000;
    await assert.rejects(runner.execute(aid,{sessionId:"overflow",prompt:"OVERFLOW"}),e=>e.code==="output_limit");
    assert.equal(runner.activePids.size,0);
  }));
test("resource ownership, fixed configuration, capacity, idle reclamation and transcript fingerprints are enforced inside Sessions", () =>
  fixture(async runner => {
    const sessions=new Sessions({runner,limit:1,idleMs:120,maxTurns:2});
    const messages=[{role:"user",content:"private"}];
    const first=sessions.begin(null,"api:key-a",{account:aid,model:"",kind:"chat",messages,prompt:"private"});
    await runner.execute(aid,{sessionId:first.session.id,prompt:first.prompt});
    sessions.complete(first.session,{messages,assistant:{role:"assistant",content:"answer"}});
    assert.throws(()=>sessions.get(first.session.id,"api:key-b"),e=>e.status===404);
    assert.deepEqual(sessions.list("api:key-b"),[]);
    assert.throws(()=>sessions.begin(null,"api:key-b",{account:aid,kind:"task"}),e=>e.code==="session_limit");
    assert.throws(()=>sessions.begin(first.session,"api:key-a",{account:aid,model:"other",kind:"chat",messages}),e=>e.code==="session_mismatch");
    assert.throws(()=>sessions.begin(first.session,"api:key-a",{account:aid,model:"",kind:"chat",messages:[{role:"user",content:"changed"}]}),e=>e.code==="session_history_mismatch");
    assert.equal(first.session.prompt,undefined);assert.equal(first.session.messages,undefined);
    await new Promise(r=>setTimeout(r,220));
    assert.equal(sessions.entries.size,0);assert.equal(runner.sessions.size,0);
  }));

test("HTTP sessions are key-owned, bind accounts, validate OpenAI history, count per-turn tokens and close on disable/logout", async () => {
  await fixture(async(runner,dir)=>{
    const app=await createApplication({dataDir:dir,runner,password:"session-test-admin-password",key:"session-test-master-api-key",logger:{info(){},warn(){},error(){}}});
    await new Promise(r=>app.server.listen(0,"127.0.0.1",r));
    const base="http://127.0.0.1:"+app.server.address().port;
    const login=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json",origin:base},body:JSON.stringify({password:"session-test-admin-password"})});
    const cookie=login.headers.get("set-cookie").split(";")[0],{csrf}=await login.json();
    const call=(path,data,{key,method="POST",session=false}={})=>fetch(base+path,{method,headers:{
      "content-type":"application/json",origin:base,
      ...(session?{cookie,"x-csrf-token":csrf}:{authorization:"Bearer "+(key||"session-test-master-api-key")}),
    },body:data===undefined?undefined:JSON.stringify(data)});
    try{
      const a=await app.store.create({name:"one"});app.store.get(a.id).models=[{id:"gemini-test-medium"}];app.store.get(a.id).checked_at=new Date().toISOString();await app.store.patch(a.id,{enabled:true});
      const [other]=await app.store.createKeys([{name:"other",value:"other-session-client-key-12345"}]);
      const otherValue=app.store.getKey(other.id).value;
      const messages=[{role:"user",content:"remember"}];
      const firstRes=await call("/v1/chat/completions",{messages,session_id:"new"});
      assert.equal(firstRes.status,200);const first=await firstRes.json(),sid=first.agy.session.id;
      assert.equal(first.usage.total_tokens,13);
      const foreignList=await call("/v1/sessions",undefined,{key:otherValue,method:"GET"});
      assert.deepEqual((await foreignList.json()).sessions,[]);
      const foreign=await call("/v1/chat/completions",{messages,session_id:sid},{key:otherValue});
      assert.equal(foreign.status,404);
      const wrong=await call("/v1/chat/completions",{messages:[{role:"user",content:"rewrite"}],session_id:sid});
      assert.equal(wrong.status,409);
      const nextMessages=[...messages,first.choices[0].message,{role:"user",content:"next"}];
      const secondRes=await call("/v1/chat/completions",{messages:nextMessages,session_id:sid});
      assert.equal(secondRes.status,200);const second=await secondRes.json();
      assert.equal(second.usage.total_tokens,13);
      const trace=JSON.parse(second.choices[0].message.content);
      assert.equal(trace.turn,2);assert.ok(!trace.prompts[1].includes("remember"));
      assert.equal(app.store.get(a.id).total_tokens,26);
      assert.equal((await call("/api/sessions",undefined,{method:"GET",session:true})).status,200);
      assert.equal((await call("/api/sessions/"+sid,undefined,{method:"DELETE",session:true})).status,404);
      assert.equal((await call("/v1/sessions/"+sid,undefined,{method:"DELETE",key:otherValue})).status,404);
      const concurrentMessages=[...nextMessages,second.choices[0].message,{role:"user",content:"once"}];
      const concurrent=await Promise.all([call("/v1/chat/completions",{messages:concurrentMessages,session_id:sid}),call("/v1/chat/completions",{messages:concurrentMessages,session_id:sid})]);
      assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
      assert.equal(app.store.get(a.id).total_tokens,39);
      await call("/api/accounts/"+a.id,{enabled:false},{method:"PATCH",session:true});
      assert.equal(app.sessions.entries.size,0);assert.equal(runner.sessions.size,0);
      await app.store.patch(a.id,{enabled:true});
      const keySession=await (await call("/v1/chat/completions",{messages,session_id:"new"},{key:otherValue})).json();
      assert.ok(keySession.agy.session.id);
      await call("/api/keys/"+other.id,{enabled:false},{method:"PATCH",session:true});
      assert.equal(runner.sessions.size,0);
      assert.equal((await call("/v1/sessions",undefined,{key:otherValue,method:"GET"})).status,401);
      const tools=[{type:"function",function:{name:"add",parameters:{type:"object",properties:{a:{type:"number"},b:{type:"number"}},required:["a","b"]}}}];
      const toolFirst=await (await call("/v1/chat/completions",{messages,tools,session_id:"new"})).json();
      const toolMessage=toolFirst.choices[0].message;
      const toolSecond=await call("/v1/chat/completions",{session_id:toolFirst.agy.session.id,tools,messages:[...messages,toolMessage,{role:"tool",tool_call_id:toolMessage.tool_calls[0].id,content:"5"}]});
      assert.equal(toolSecond.status,200);
      await call("/v1/sessions/"+toolFirst.agy.session.id,undefined,{method:"DELETE"});
      const panel=await (await call("/api/tasks",{prompt:"panel",session_id:"new"},{session:true})).json();
      assert.ok(panel.session.id);
      let release;
      const gate=app.queue.add(()=>new Promise(r=>{release=r;}),undefined,{key:a.id});
      const waiting=call("/api/tasks",{prompt:"MUST-NOT-RUN-AFTER-LOGOUT",session_id:"new"},{session:true});
      try{
        for(let n=0;n<100&&app.queue.waiting.length===0;n++)await new Promise(r=>setTimeout(r,5));
        assert.equal(app.queue.waiting.length,1);
        await call("/auth/logout",{}, {session:true});
      }finally{release();await gate;}
      assert.equal((await waiting).status,401);
      assert.equal(runner.sessions.size,0);
    }finally{await app.sessions.closeWhere(()=>true);app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
  });
});

test("closing workers continue to consume capacity until disposal has completed", async()=>{
  let finish;
  const runner={closeSession:()=>new Promise(r=>{finish=r;})};
  const sessions=new Sessions({runner,limit:1});
  const turn=sessions.begin(null,"owner",{account:aid,model:"",kind:"task",prompt:"x"});
  const closed=sessions.close(turn.session.id,"owner");
  assert.throws(()=>sessions.begin(null,"owner",{account:aid,kind:"task"}),e=>e.code==="session_limit");
  assert.equal(sessions.status.resident,1);
  finish();await closed;
  assert.equal(sessions.status.resident,0);
});

test("exclusive login releases warm CLI workers before launching its interactive process",()=>fixture(async(runner,dir)=>{
  const store=await new Store(dir).init(),account=await store.create({name:"login"});
  const sessions=new Sessions({runner});
  const turn=sessions.begin(null,"owner",{account:account.id,model:"",kind:"task",prompt:"before-login"});
  await runner.execute(account.id,{sessionId:turn.session.id,prompt:turn.prompt});
  sessions.complete(turn.session);
  const queue=new SerialQueue();
  const child=new EventEmitter();
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  let prepared=false;
  const manager=new LoginManager({dataDir:dir,store,queue,
    beforeLogin:async()=>{assert.equal(queue.exclusive,true);await sessions.closeWhere(()=>true);prepared=true;},
    launch:()=>{assert.equal(prepared,true);assert.equal(runner.sessions.size,0);return child;}});
  try{
    manager.start("owner",account.id);
    for(let n=0;n<100&&!manager.current.child;n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(manager.current.child,child);
    child.emit("close",0);
    await manager.current.work;
    assert.equal(queue.running,0);
  }finally{manager.close();}
}));
