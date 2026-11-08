import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { profilePaths } from "../src/runner.mjs";
const [action, id] = process.argv.slice(2);
if (action !== "login" || !id) {
  console.error("用法：node scripts/account.mjs login <账号ID>");
  process.exit(1);
}
const p = await profilePaths(resolve(process.env.DATA_DIR || "data"), id);
const env = { ...process.env, ...p.env };
delete env.ADMIN_PASSWORD;
delete env.API_KEY;
const child = spawn(process.env.AGY_BIN || "agy", [], {
  env,
  cwd: p.home,
  stdio: "inherit",
  shell: false,
});
child.on("error", () => {
  console.error("无法启动官方 agy");
  process.exit(1);
});
child.on("exit", (code) => process.exit(code || 0));
