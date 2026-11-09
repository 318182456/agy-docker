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
