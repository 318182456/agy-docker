import test from "node:test";
import assert from "node:assert/strict";
import {prepareChat, toolMessage} from "../src/chat.mjs";
const input = (extra = {}) => ({messages: [{role: "user", content: "help"}], ...extra});
const tool = (parameters) => ({type: "function", function: {name: "state", parameters}});
const prepare = (x) => prepareChat(x, (params) => params);
test("tool schemas support Go arbitrary JSON, local refs and modern schema dialects without remote fetching", () => {
  for (const parameters of [
    {type: "object", properties: {value: true, items: {type: "array", items: true}}},
    {$schema: "https://json-schema.org/draft/2020-12/schema", $ref: "#/$defs/Args", $defs: {Args: {type: "object", properties: {value: true}}}},
    {$schema: "https://json-schema.org/draft/2019-09/schema", type: "object"},
  ]) {
    const p = prepare(input({tools: [tool(parameters)]}));
    const message = toolMessage({structured_output: {content: "", tool_calls: [{name: "state", arguments: JSON.stringify({value: [1, {x: null}], items: ["a", 1]})}]}}, p.tooling);
    assert.equal(message.tool_calls[0].function.name, "state");
  }
  assert.throws(() => prepare(input({tools: [tool({$ref: "https://evil.invalid/schema"})]})), /Schema/);
});
test("tool choice, parallel limits, supplied schemas and message pairing are enforced", () => {
  const p = prepare(input({tools: [tool({type: "object"})], parallel_tool_calls: false, tool_choice: "required"}));
  const call = {name: "state", arguments: "{}"};
  assert.throws(() => toolMessage({structured_output: {content: "done", tool_calls: []}}, p.tooling));
  assert.throws(() => toolMessage({structured_output: {content: "", tool_calls: [call, call]}}, p.tooling));
  assert.throws(() => toolMessage({structured_output: {content: "", tool_calls: [{name: "other", arguments: "{}"}]}}, p.tooling));
  assert.throws(() => prepare(input({tools: [tool(false)], messages: [{role: "user", content: [{type: "image_url", image_url: {url: "x"}}]}]})));
  assert.throws(() => prepare(input({tools: [tool({type: "object"})], tool_choice: "unknown"})));
  const empty = prepare(input({tools: [tool(false)], tool_choice: "none"}));
  assert.equal(toolMessage({structured_output: {content: "hello", tool_calls: []}}, empty.tooling).content, "hello");
});
