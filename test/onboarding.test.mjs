import test from "node:test";
import assert from "node:assert/strict";
import { Onboarding } from "../src/onboarding.mjs";
const wait = () => new Promise((r) => setTimeout(r, 260));

test("official setup is automatic, opts out of optional collection, and does not replay stale screens", async () => {
  const keys = [], messages = [];
  let completed = 0;
  const tui = new Onboarding({send: (key) => keys.push(key), changed: (s) => messages.push(s), completed: () => completed++});
  const frame = async (s) => { tui.write("\x1b[2J\x1b[H" + s); await wait(); };
  try {
    await frame("Select login method:\r\n > 1. Google OAuth\r\n 2. Use a Google Cloud project");
    assert.deepEqual(keys, ["\r"]);
    await frame("Open the URL below in your browser:\r\nauthorization code...");
    assert.equal(keys.length, 1);
    await frame("Choose your color scheme:\r\n > terminal\r\n[Next]");
    assert.equal(keys.at(-1), "\t\r");
    await frame("Choose your color scheme:\r\n > terminal\r\n[Next]");
    assert.equal(keys.length, 2);
    await frame("[x] Yes, I agree to help improve Antigravity CLI\r\n[Previous] [Done]");
    assert.equal(keys.at(-1), " ");
    await frame("[ ] Yes, I agree to help improve Antigravity CLI\r\n[Previous] [Done]");
    assert.equal(keys.at(-1), "\t\t\r");
    await frame("Ready for your message");
    assert.equal(completed, 1);
    assert.ok(!tui.screen.includes("Choose your color scheme"));
    assert.ok(!tui.screen.includes("Yes, I agree"));
    await frame("Ready for your message");
    assert.equal(completed, 1);
    await frame("Unknown future prompt: delete all files? Press Enter");
    assert.equal(keys.length, 4);
    assert.ok(messages.length >= 4);
  } finally { tui.close(); }
  assert.ok(tui.screen.includes("Unknown future prompt"));
});

test("terminal status queries are answered and no optional data collection is enabled when already unchecked", async () => {
  const keys = [];
  const tui = new Onboarding({send: (key) => keys.push(key)});
  try {
    tui.write("\x1b[6n");
    await wait();
    assert.equal(keys[0], "\x1b[1;1R");
    tui.write("\x1b[2J\x1b[H[ ] Yes, I agree to help improve Antigravity CLI\r\n[Previous] [Done]");
    await wait();
    assert.equal(keys.at(-1), "\t\t\r");
    assert.ok(!keys.includes(" "));
  } finally { tui.close(); }
});

test("workspace trust is automatic only for the exact dedicated directory, never the credentials home", async () => {
  const keys = [];
  let done = 0;
  const workspace = "/data/accounts/a_0123456789abcdef/login-workspace";
  const tui = new Onboarding({workspace, send: (key) => keys.push(key), completed: () => done++});
  const frame = async (path, selected = "> Yes, I trust this folder") => {
    tui.write("\x1b[2J\x1b[HAccessing workspace:\r\n\r\n" + path + "\r\n\r\nDo you trust the contents of this project?\r\n" + selected + "\r\nNo, exit");
    await wait();
  };
  try {
    await frame("/data/accounts/a_0123456789abcdef/home");
    assert.equal(keys.length, 0);
    await frame(workspace, "> No, exit");
    assert.equal(keys.length, 0);
    await frame(workspace);
    assert.deepEqual(keys, ["\r"]);
    await frame(workspace);
    assert.equal(keys.length, 1);
    tui.write("\x1b[2J\x1b[HCopy the authorization code and paste it below:\r\nauthorization code...");
    await wait();
    assert.equal(done, 0);
    tui.write("\x1b[2J\x1b[HReady for your message");
    await wait();
    assert.equal(done, 1);
  } finally { tui.close(); }
});


test("saved profiles reaching the native prompt skip setup and complete once even with the plan notice", async () => {
  const workspace="/data/accounts/a_0123456789abcdef/login-workspace",keys=[];let completed=0;
  const tui=new Onboarding({workspace,send:key=>keys.push(key),completed:()=>completed++});
  const frame=async value=>{tui.write("\x1b[2J\x1b[H"+value);await wait();};
  try {
    await frame(workspace+"\r\nauthorization code...\r\n>");assert.equal(completed,0);
    await frame("/different/workspace\r\n>\r\n? for shortcuts\r\nGemini 3.8 Flash · high");assert.equal(completed,0);
    const ready=workspace+"\r\nChanges to third-party model access\r\nesc to dismiss\r\n>\r\n? for shortcuts\r\nGemini 3.8 Flash · high";
    await frame(ready);assert.equal(completed,1);assert.deepEqual(keys,[]);
    await frame(ready);assert.equal(completed,1);
  } finally {tui.close();}
});
