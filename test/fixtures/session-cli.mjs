import {createInterface} from "node:readline";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "models" || args[0] === "--print") { await import("./fake-cli.mjs"); }
else {
  const conversation = randomUUID(), prompts = [];
  let first = true;
  for await (const line of createInterface({input: process.stdin, crlfDelay: Infinity})) {
    const prompt = JSON.parse(line).message.content;
    prompts.push(prompt);
    if (prompt === "PRE_INIT_ERROR") {
      console.log(JSON.stringify({event:"result",result:{status:"ERROR",error:"authentication required"}}));
      continue;
    }
    if (first) { console.log(JSON.stringify({event:"init",init:{model:"gemini-test-medium"}})); first = false; }
    if (prompt === "HANG") await new Promise(r => setTimeout(r, 60000));
    if (prompt === "INVALID") { console.log("invalid"); continue; }
    if (prompt === "CRASH") { process.exit(3); }
    if (prompt === "OVERFLOW") { process.stdout.write("x".repeat(10000)); continue; }
    if (prompt === "REGION") {
      console.log(JSON.stringify({event:"result",result:{status:"ERROR",error:"FAILED_PRECONDITION (code 400): User location is not supported for the API use."}}));
      continue;
    }
    const schemaIndex = args.indexOf("--json-schema");
    let structured;
    if (schemaIndex >= 0) {
      const schema = JSON.parse(readFileSync(args[schemaIndex + 1], "utf8"));
      structured = {content:"",tool_calls:[{name:schema.properties.tool_calls.items.properties.name.enum[0],arguments:'{"a":2,"b":3}'}]};
    }
    const response = prompt === "SPLIT" ? "你好，持续会话" : structured ? JSON.stringify(structured) : JSON.stringify({pid:process.pid,turn:prompts.length,prompts,home:process.env.HOME,auto_update_disabled:process.env.AGY_CLI_DISABLE_AUTO_UPDATE==="true"});
    const usage = {input_tokens:10*prompts.length,output_tokens:3*prompts.length,total_tokens:13*prompts.length};
    if (prompt === "DECREASE") usage.total_tokens = 1;
    const result = JSON.stringify({event:"result",result:{status:"SUCCESS",response,conversation_id:conversation,
      usage,structured_output:structured}});
    if (prompt === "SPLIT") {
      const bytes=Buffer.from(result+"\n"),index=bytes.indexOf(Buffer.from("你"))+1;
      process.stdout.write(bytes.subarray(0,index));
      await new Promise(r=>setTimeout(r,10));
      process.stdout.write(bytes.subarray(index));
    }
    else if (prompt === "DOUBLE") process.stdout.write(result+"\n"+result+"\n");
    else process.stdout.write(result+"\n");
  }
}
