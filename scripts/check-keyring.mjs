import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keyrings } from "../src/keyrings.mjs";
import { profilePaths } from "../src/runner.mjs";
const dir = await mkdtemp(join(tmpdir(), "agy-keyring-test-"));
const manager = new Keyrings();
const value = randomBytes(16).toString("hex");
async function tool(profile, lease, args, input) {
  return new Promise((resolve, reject) => {
    const c = spawn("secret-tool", args, {
      env: { PATH: process.env.PATH, ...profile.env, ...lease.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      c.kill("SIGKILL");
      reject(Error("Keyring self-test timed out"));
    }, 12000);
    c.stdout.on("data", (b) => (output += b));
    c.stderr.resume();
    c.on("error", reject);
    c.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
    c.stdin.on("error", () => {});
    c.stdin.end(input || "");
  });
}
try {
  const a = await profilePaths(dir, "a_1111111111111111"),
    b = await profilePaths(dir, "a_2222222222222222");
  let first = await manager.acquire("a", a);
  assert.equal(
    (
      await tool(
        a,
        first,
        ["store", "--label=agy-docker-selftest", "agy-docker", "selftest"],
        value,
      )
    ).code,
    0,
  );
  await first.release();
  first = await manager.acquire("a", a);
  const read = await tool(a, first, ["lookup", "agy-docker", "selftest"]);
  assert.equal(read.code, 0);
  assert.equal(read.output, value);
  const second = await manager.acquire("b", b);
  const other = await tool(b, second, ["lookup", "agy-docker", "selftest"]);
  assert.notEqual(other.code, 0);
  assert.notEqual(other.output, value);
  await second.release();
  await first.release();
  console.log("Linux keyring persistence and account isolation: PASS");
} finally {
  await manager.close();
  await rm(dir, { recursive: true, force: true });
}
