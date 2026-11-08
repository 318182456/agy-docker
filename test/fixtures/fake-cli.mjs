import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(
    "gemini-test-medium  Gemini Test (Medium)\ngemini-other-high  Gemini Other (High)",
  );
  process.exit(0);
}
let input = "";
for await (const c of process.stdin) input += c;
const message = JSON.parse(input).message.content;
if (message === "FAIL_TOS") {
  console.error(
    "This service has been disabled in this account for violation of Terms of Service.",
  );
  process.exit(1);
}
if (message === "HANG") {
  await new Promise((r) => setTimeout(r, 60000));
}
if (message === "INVALID") {
  process.stdout.write("not json");
  process.exit(0);
}
if (message === "EMPTY") {
  console.log(
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "" },
    }),
  );
  process.exit(0);
}
if (message === "STDERR_SECRET") {
  console.error("private diagnostic with tokens must-not-expose");
  process.exit(1);
}
const leaks = ["API_KEY", "ADMIN_PASSWORD", "GEMINI_API_KEY"].filter(
  (x) => process.env[x],
);
if (leaks.length) {
  console.error("secret env leaked");
  process.exit(1);
}
const response =
  message === "PROFILE"
    ? JSON.stringify({
        home: process.env.HOME,
        config: process.env.XDG_CONFIG_HOME,
      })
    : "回答：" + message;
console.log(
  JSON.stringify({
    event: "init",
    init: { model: args[args.indexOf("--model") + 1] || "gemini-test-medium" },
  }),
);
console.log(
  JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response,
      conversation_id: "test-conversation",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  }),
);
