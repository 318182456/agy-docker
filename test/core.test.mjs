import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.mjs";
import { Runner } from "../src/runner.mjs";
import { SerialQueue } from "../src/queue.mjs";
async function temp(action) {
  const dir = await mkdtemp(join(tmpdir(), "agy-test-"));
  try {
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const runner = (dir) =>
  new Runner({
    dataDir: dir,
    command: process.execPath,
    prefix: [resolve("test/fixtures/fake-cli.mjs")],
    timeout: 3000,
  });
test("account state persists and normal tasks round-robin across enabled accounts", () =>
  temp(async (dir) => {
    const s = await new Store(dir).init();
    const a = await s.create({ name: "one" }),
      b = await s.create({ name: "two" });
    for (const x of [a, b]) {
      s.get(x.id).models = [{ id: "gemini-test-medium" }];
      s.get(x.id).checked_at = new Date().toISOString();
      await s.patch(x.id, { enabled: true });
    }
    assert.deepEqual(
      [s.pick().id, s.pick().id, s.pick().id],
      [a.id, b.id, a.id],
    );
    await s.patch(a.id, { enabled: false });
    assert.equal(s.pick().id, b.id);
    await assert.rejects(s.patch(a.id, { arbitrary: "no" }));
    const restored = await new Store(dir).init();
    assert.equal(restored.list().length, 2);
    assert.equal(restored.get(a.id).enabled, false);
  }));
test("queue stays serial, rejects overflow and removes disconnected queued requests", async () => {
  const q = new SerialQueue(1);
  let done;
  const gate = new Promise((r) => (done = r));
  const log = [];
  const first = q.add(async () => {
    log.push("start");
    await gate;
    log.push("end");
  });
  const abort = new AbortController();
  const waiting = q.add(() => assert.fail("aborted task ran"), abort.signal);
  await assert.rejects(
    q.add(() => {}),
    (e) => e.code === "queue_full",
  );
  abort.abort();
  await assert.rejects(waiting, (e) => e.code === "cancelled");
  done();
  await first;
  assert.deepEqual(log, ["start", "end"]);
  assert.equal(q.status.running, 0);
});
test("runner passes literal content without a shell, parses terminal output and keeps accounts separate", () =>
  temp(async (dir) => {
    const r = runner(dir);
    const a = "a_1111111111111111",
      b = "a_2222222222222222";
    const prompt = '中文 $(touch hacked) `echo no` ; & | " \\';
    const out = await r.execute(a, { prompt, model: "gemini-test-medium" });
    assert.equal(out.response, "回答：" + prompt);
    assert.equal(out.usage.total_tokens, 13);
    const x = JSON.parse((await r.execute(a, { prompt: "PROFILE" })).response),
      y = JSON.parse((await r.execute(b, { prompt: "PROFILE" })).response);
    assert.notEqual(x.home, y.home);
    const config = JSON.parse(
      await readFile(
        join(x.home, ".gemini", "antigravity-cli", "settings.json"),
        "utf8",
      ),
    );
    assert.equal(config.toolPermission, "strict");
    await assert.rejects(r.execute("../escape", { prompt: "x" }));
    await assert.rejects(r.execute(a, { prompt: "x", model: "bad --flag" }));
  }));
test("runner rejects malformed, empty and banned results without exposing stderr", () =>
  temp(async (dir) => {
    const r = runner(dir),
      id = "a_1111111111111111";
    for (const [prompt, code] of [
      ["FAIL_TOS", "account_suspended"],
      ["EMPTY", "empty_result"],
      ["INVALID", "invalid_output"],
    ])
      await assert.rejects(r.execute(id, { prompt }), (e) => e.code === code);
    await assert.rejects(
      r.execute(id, { prompt: "STDERR_SECRET" }),
      (e) => !e.message.includes("must-not-expose"),
    );
  }));
test("runner terminates timed-out and cancelled child processes", () =>
  temp(async (dir) => {
    const id = "a_1111111111111111",
      r = new Runner({
        dataDir: dir,
        command: process.execPath,
        prefix: [resolve("test/fixtures/fake-cli.mjs")],
        timeout: 150,
      });
    await assert.rejects(
      r.execute(id, { prompt: "HANG" }),
      (e) => e.code === "timeout",
    );
    assert.equal(r.activePid, null);
    const controller = new AbortController();
    const job = runner(dir).execute(id, {
      prompt: "HANG",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(job, (e) => e.code === "cancelled");
  }));

test("round robin selects only accounts that report the requested model", () =>
  temp(async (dir) => {
    const s = await new Store(dir).init();
    const a = await s.create({ name: "first" }),
      b = await s.create({ name: "second" });
    s.get(a.id).models = [{ id: "gemini-a" }];
    s.get(a.id).checked_at = new Date().toISOString();
    s.get(b.id).checked_at = new Date().toISOString();
    s.get(b.id).models = [{ id: "gemini-b" }];
    await s.patch(a.id, { enabled: true });
    await s.patch(b.id, { enabled: true });
    assert.equal(s.pick(undefined, "gemini-b").id, b.id);
    assert.throws(
      () => s.pick(a.id, "gemini-b"),
      (e) => e.status === 400,
    );
  }));
