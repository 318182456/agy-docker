import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(
    "gemini-test-medium\tGemini Test (Medium)\ngemini-other-high  Gemini Other (High)",
  );
  process.exit(0);
}
if (args[0] === "--print" && args[1] === "/usage") {
  console.log(JSON.stringify({status:"SUCCESS",usage:{total_tokens:0},command:{name:"usage",data:{groups:[
    {name:"Gemini Models",buckets:[{id:"gemini-5h",window:"5h",remaining_fraction:0.75,reset_time:"2026-11-09T05:00:00Z"},{id:"gemini-weekly",window:"weekly",remaining_fraction:0.9,reset_time:"2026-11-15T05:00:00Z"}]},
    {name:"Gemini 4 Argon",buckets:[{id:"argon-weekly",window:"weekly",remaining_fraction:1,reset_time:"2026-11-16T05:00:00Z"}]},
    {name:"Claude and GPT models",buckets:[{id:"3p-5h",window:"5h",remaining_fraction:0,reset_time:"2026-11-09T06:00:00Z"},{id:"3p-weekly",window:"weekly",remaining_fraction:0.5,reset_time:"2026-11-16T06:00:00Z"}]},
  ]}}}));process.exit(0);
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
let response =
  message === "PROFILE"
    ? JSON.stringify({
        home: process.env.HOME,
        config: process.env.XDG_CONFIG_HOME,
      })
    : "回答：" + message;
let structured;
const schemaIndex = args.indexOf("--json-schema");
if (schemaIndex >= 0) {
  const schema = JSON.parse(readFileSync(args[schemaIndex + 1], "utf8"));
  const hasResult = message.includes('"role":"tool"');
  const choices = schema.properties.tool_calls.items.properties.name.enum;
  structured = {
    content: hasResult || schema.properties.tool_calls.maxItems === 0 ? "5" : "",
    tool_calls: hasResult || schema.properties.tool_calls.maxItems === 0 ? [] : [
      {name: message.includes("TOOL_UNKNOWN") ? "undeclared" : choices[0],
       arguments: JSON.stringify(message.includes("TOOL_BAD_ARGUMENTS") ? {a: "wrong", b: 3} : {a: 2, b: 3})},
    ],
  };
  response = JSON.stringify(structured);
}
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
      ...(structured ? {structured_output: structured} : {}),
      ...(message.includes("TOOL_PARTIAL") ? {finished_reason: "print_timeout"} : {}),
      conversation_id: "test-conversation",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  }),
);
