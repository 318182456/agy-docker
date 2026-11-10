import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SerialQueue } from "../src/queue.mjs";
import { LoginManager, loginDisplay } from "../src/login.mjs";
import { Store } from "../src/store.mjs";
const tick = () => new Promise((r) => setTimeout(r, 15));
test("configured concurrency preserves account serialization and exclusive login barriers", async () => {
  const q = new SerialQueue(10, 2),
    log = [],
    gates = {};
  const run = (id, key, exclusive = false) =>
    q.add(
      async () => {
        log.push(id);
        await new Promise((r) => (gates[id] = r));
      },
      undefined,
      { key, exclusive },
    );
  const a = run("a", "one"),
    a2 = run("a2", "one"),
    b = run("b", "two"),
    login = run("login", "three", true),
    c = run("c", "four");
  await tick();
  assert.deepEqual(log, ["a", "b"]);
  assert.equal(q.status.running, 2);
  gates.b();
  await b;
  assert.deepEqual(log, ["a", "b"]);
  gates.a();
  await a;
  await tick();
  assert.deepEqual(log, ["a", "b", "a2"]);
  gates.a2();
  await a2;
  await tick();
  assert.equal(log.at(-1), "login");
  assert.equal(q.status.running, 1);
  gates.login();
  await login;
  await tick();
  assert.equal(log.at(-1), "c");
  gates.c();
  await c;
  assert.equal(q.status.running, 0);
  assert.throws(() => new SerialQueue(32, 0));
  assert.throws(() => new SerialQueue(32, 17));
});
test("login parser uses full official OSC link and rejects untrusted destinations", () => {
  const url =
    "https://accounts.google.com/o/oauth2/auth?state=synthetic-long-value";
  const value = loginDisplay(
    "\x1b]8;;" + url + "\x07https://accounts.google.com/o/\x1b]8;;\x07",
  );
  assert.equal(value.url, url);
  assert.ok(value.text.includes("https://accounts.google.com/o/"));
  assert.equal(loginDisplay("https://evil.example/auth").url, null);
  assert.equal(loginDisplay("Terms: https://antigravity.google/terms").url, null);
  assert.equal(loginDisplay("https://accounts.google.com/").url, null);
  assert.equal(loginDisplay(url + "\nTerms: https://antigravity.google/terms").url, url);
  assert.equal(
    loginDisplay("https://accounts.google.com.evil.example").url,
    null,
  );
});
test("login code is one-shot, owner-bound, excluded from environment and fully visible only to its owner and never saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-login-test-"));
  const store = await new Store(dir).init();
  const a = await store.create({ name: "login" });
  const q = new SerialQueue(32, 3);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let written = "";
  child.stdin.on("data", (b) => (written += b));
  let env;
  const manager = new LoginManager({
    dataDir: dir,
    store,
    queue: q,
    launch: (command, args, options) => {
      assert.equal(command, "/usr/bin/script");
      assert.deepEqual(args, [
        "-q",
        "-e",
        "-c",
        "/app/scripts/login-pty.sh",
        "/dev/null",
      ]);
      assert.equal(options.cwd, join(dir, "accounts", a.id, "login-workspace"));
      assert.notEqual(options.cwd, options.env.HOME);
      env = options.env;
      return child;
    },
  });
  try {
    manager.start("owner", a.id);
    for (let n = 0; n < 100 && !manager.current.child; n++) await tick();
    assert.equal(env.ADMIN_PASSWORD, undefined);
    assert.equal(env.API_KEY, undefined);
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    assert.equal(q.exclusive, true);
    child.stdout.write(
      "Authorize https://accounts.google.com/o/oauth2/auth?state=synthetic\n",
    );
    assert.equal(manager.view("other", a.id).state, "idle");
    assert.throws(() =>
      manager.input("other", a.id, { code: "synthetic-code" }),
    );
    assert.throws(() => manager.input("owner", a.id, { code: "bad\ncommand" }));
    manager.input("owner", a.id, { code: "synthetic-code" });
    child.stdout.write("echo synthetic-code secret");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(written, "\x1b[200~synthetic-code\x1b[201~\r");
    assert.equal(
      manager.view("owner", a.id).text.includes("synthetic-code"),
      true,
    );
    assert.equal(manager.view("owner", a.id).url, null);
    manager.input("owner", a.id, { key: "down" });
    manager.input("owner", a.id, { key: "enter" });
    manager.input("owner", a.id, { key: "tab" });
    assert.ok(written.endsWith("\x1b[B\r\t"));
    assert.throws(() => manager.input("other", a.id, { key: "enter" }));
    manager.current.state = "checking";
    assert.throws(() => manager.input("owner", a.id, { key: "enter" }));
    manager.current.state = "submitted";

    assert.throws(() =>
      manager.input("owner", a.id, { code: "synthetic-code" }),
    );
    assert.equal(
      (await readFile(join(dir, "state.json"), "utf8")).includes(
        "synthetic-code",
      ),
      false,
    );
    manager.stop("owner", a.id);
    child.emit("close", 0);
    await tick();
    assert.equal(q.running, 0);
  } finally {
    manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("finishing login verifies before stopping and keeps the exclusive barrier until verification ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-finish-test-"));
  const store = await new Store(dir).init(),
    a = await store.create({ name: "finish" }),
    q = new SerialQueue(32, 3);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const manager = new LoginManager({
    dataDir: dir,
    store,
    queue: q,
    launch: () => child,
  });
  try {
    manager.start("owner", a.id);
    for (let i = 0; i < 100 && !manager.current.child; i++) await tick();
    await assert.rejects(manager.finish("other", a.id, () => {}));
    await assert.rejects(
      manager.finish("owner", a.id, async (log) => {
        log("original provider failure");
        throw Error("not signed in");
      }),
    );
    assert.ok(manager.current.child);
    assert.equal(manager.view("owner", a.id).state, "running");
    assert.equal(q.exclusive, true);
    assert.ok(
      manager.view("owner", a.id).text.includes("original provider failure"),
    );
    let complete;
    const pending = manager.finish(
      "owner",
      a.id,
      () => new Promise((r) => (complete = r)),
    );
    await tick();
    let otherRan = false;
    const other = q.add(
      () => {
        otherRan = true;
      },
      undefined,
      { key: "other" },
    );
    child.emit("close", 0);
    await tick();
    assert.equal(otherRan, false);
    complete({ ok: true });
    assert.deepEqual(await pending, { ok: true });
    await other;
    assert.equal(otherRan, true);
    assert.equal(manager.view("owner", a.id).state, "verified");
  } finally {
    manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("failed verification restores unsubmitted code input; consumed codes require a fresh owner-bound flow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-restart-test-"));
  const store = await new Store(dir).init(), account = await store.create({name:"retry"}), queue = new SerialQueue();
  const children = [];
  const manager = new LoginManager({dataDir:dir,store,queue,launch:()=>{
    const child = new EventEmitter();
    child.stdout = new PassThrough();child.stderr = new PassThrough();child.stdin = new PassThrough();
    children.push(child);return child;
  }});
  manager.kill = s => {clearTimeout(s.verifyTimer);if(s.child)queueMicrotask(()=>s.child?.emit("close",0));};
  const waitChild = async n => {for(let i=0;i<100&&children.length<n;i++)await tick();assert.equal(children.length,n);};
  try {
    manager.start("owner",account.id);await waitChild(1);
    let probes=0;manager.verify=async()=>{probes++;};
    manager.autoVerify(manager.current);
    await new Promise(r=>setTimeout(r,3100));
    assert.equal(probes,0,"do not probe stale saved credentials before the new OAuth page is ready");
    manager.verify=null;
    children[0].stdout.write("https://accounts.google.com/o/oauth2/auth?state=synthetic-first\n");
    assert.equal(manager.view("owner",account.id).can_submit_code,true);
    let fail;
    const verifying = manager.finish("owner",account.id,()=>new Promise((_,reject)=>{fail=reject;}));
    await tick();
    assert.equal(manager.view("owner",account.id).can_submit_code,false);
    assert.throws(()=>manager.input("owner",account.id,{code:"synthetic-code"}));
    await assert.rejects(manager.restart("owner",account.id),/正在校验/);
    fail(Error("synthetic login not saved"));await assert.rejects(verifying);
    const failed = manager.view("owner",account.id);
    assert.equal(failed.can_submit_code,true);
    assert.equal(failed.code_submitted,false);
    assert.equal(failed.verification_error.message,"synthetic login not saved");
    manager.input("owner",account.id,{code:"synthetic-code"});
    await new Promise(r=>setTimeout(r,100));
    await assert.rejects(manager.finish("owner",account.id,async()=>{throw Error("synthetic invalid grant");}));
    const consumed = manager.view("owner",account.id);
    assert.equal(consumed.can_submit_code,false);assert.equal(consumed.code_submitted,true);assert.equal(consumed.url,null);
    await assert.rejects(manager.restart("other",account.id));
    assert.throws(()=>manager.input("owner",account.id,{code:"synthetic-code"}));
    await manager.restart("owner",account.id);await waitChild(2);
    children[1].stdout.write("https://accounts.google.com/o/oauth2/auth?state=synthetic-second\n");
    const fresh = manager.view("owner",account.id);
    assert.equal(fresh.code_submitted,false);assert.equal(fresh.can_submit_code,true);assert.equal(fresh.verification_error,null);
    assert.equal(fresh.text.includes("synthetic-first"),false);assert.equal(queue.running,1);
    manager.stop("owner",account.id);await manager.current.work;assert.equal(queue.running,0);
  } finally {manager.close();await rm(dir,{recursive:true,force:true});}
});


test("ready saved profiles verify despite historical OAuth output without accepting another code", async () => {
  const dir=await mkdtemp(join(tmpdir(),"agy-ready-profile-")),store=await new Store(dir).init(),a=await store.create({name:"saved"}),queue=new SerialQueue();
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();let probes=0;
  const manager=new LoginManager({dataDir:dir,store,queue,launch:()=>child,verify:async()=>{probes++;return{ok:true};}});
  manager.kill=s=>{clearTimeout(s.verifyTimer);if(s.child)queueMicrotask(()=>s.child?.emit("close",0));};
  try {
    manager.start("owner",a.id);for(let i=0;i<100&&!manager.current.child;i++)await tick();
    child.stdout.write("https://accounts.google.com/o/oauth2/auth?state=synthetic-old\r\n");
    const workspace=join(dir,"accounts",a.id,"login-workspace");
    child.stdout.write("\x1b[2J\x1b[H"+workspace+"\r\n>\r\n? for shortcuts\r\nGemini 3.8 Flash · high");
    for(let i=0;i<100&&!manager.current.onboarding.done.has("complete");i++)await tick();
    assert.throws(()=>manager.input("owner",a.id,{code:"synthetic-new-code"}));
    for(let i=0;i<240&&manager.view("owner",a.id).state!=="verified";i++)await tick();
    assert.equal(probes,1);const view=manager.view("owner",a.id);assert.equal(view.state,"verified");assert.equal(view.can_submit_code,false);assert.equal(view.url,null);
    await manager.current.work;
  } finally {manager.close();await rm(dir,{recursive:true,force:true});}
});
