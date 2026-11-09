import test from "node:test";
import { AppError } from "../src/common.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplication } from "../src/server.mjs";
import { Runner } from "../src/runner.mjs";
const password = "test-admin-password-1234567890",
  key = "test-api-key-1234567890123456";
async function appTest(action) {
  const dir = await mkdtemp(join(tmpdir(), "agy-http-"));
  const app = await createApplication({
    dataDir: dir,
    password,
    key,
    runner: new Runner({
      dataDir: dir,
      command: process.execPath,
      prefix: [resolve("test/fixtures/fake-cli.mjs")],
      timeout: 3000,
    }),
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "",
    csrf = "";
  const call = async (
    path,
    { method = "GET", data, headers = {}, session = true } = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(session ? { cookie, "x-csrf-token": csrf, origin } : {}),
        ...(data ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  const login = async () => {
    const res = await call("/auth/login", {
      method: "POST",
      data: { password },
    });
    assert.equal(res.status, 200);
    cookie = res.headers.get("set-cookie").split(";")[0];
    csrf = (await res.json()).csrf;
  };
  try {
    await action({ app, origin, call, login });
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
test("endpoint catalog consistently protects admin and separates API credentials from browser sessions", () =>
  appTest(async ({ app, call, login }) => {
    for (const route of app.catalog.filter(
      (r) => r.access !== "public" && !r.path.startsWith("/^"),
    )) {
      const res = await call(route.path, {
        method: route.method,
        session: false,
      });
      assert.equal(res.status, 401, route.path);
    }
    assert.equal(
      (
        await call("/api/status", {
          headers: { authorization: "Bearer " + key },
          session: false,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/auth/login", {
          method: "POST",
          data: { password },
          headers: { origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    await login();
    assert.equal((await call("/api/status")).status, 200);
    assert.equal(
      (
        await call("/api/accounts", {
          method: "POST",
          data: { name: "x" },
          headers: { "x-csrf-token": "" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/accounts", {
          method: "POST",
          data: { name: "x" },
          headers: { origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal((await call("/v1/models")).status, 401);
    assert.equal(
      (await call("/api/status", { method: "POST", data: {} })).status,
      405,
    );
    assert.equal((await call("/unknown")).status, 404);
  }));
test("real subprocess probes, account edits, normal request rotation and restart-safe metadata", () =>
  appTest(async ({ app, call, login }) => {
    await login();
    const ids = [];
    for (const name of ["first", "second"]) {
      const a = await (
        await call("/api/accounts", { method: "POST", data: { name } })
      ).json();
      ids.push(a.id);
      assert.equal(
        (
          await call("/api/accounts/" + a.id, {
            method: "PATCH",
            data: { enabled: true },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("/api/accounts/" + a.id + "/verify", {
            method: "POST",
            data: {},
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call("/api/accounts/" + a.id, {
            method: "PATCH",
            data: { enabled: true },
          })
        ).status,
        200,
      );
    }
    const accounts = [];
    for (let i = 0; i < 3; i++) {
      const res = await call("/api/tasks", {
        method: "POST",
        data: { prompt: "hello" },
      });
      assert.equal(res.status, 200);
      accounts.push((await res.json()).account.id);
    }
    assert.deepEqual(accounts, [ids[0], ids[1], ids[0]]);
    await call("/api/accounts/" + ids[0], {
      method: "PATCH",
      data: { name: "renamed" },
    });
    assert.equal(app.store.get(ids[0]).name, "renamed");
    const status = await (await call("/api/status")).json();
    assert.equal(status.events.length, 5);
    assert.ok(!JSON.stringify(status.events).includes("hello"));
    assert.equal(status.accounts[0].total_tokens, 39);
    const failed = await call("/api/tasks", {
      method: "POST",
      data: { prompt: "FAIL_TOS", account_id: ids[0] },
    });
    assert.equal(failed.status, 403);
    assert.equal(app.store.get(ids[0]).enabled, false);
    assert.equal(app.store.get(ids[1]).requests, 2);
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          data: { prompt: "x", account_id: "../../etc" },
        })
      ).status,
      400,
    );
  }));
test("OpenAI text and buffered SSE return real CLI output; malformed tools and unsupported controls fail explicitly", () =>
  appTest(async ({ call, login }) => {
    await login();
    const a = await (
      await call("/api/accounts", { method: "POST", data: { name: "test" } })
    ).json();
    await call("/api/accounts/" + a.id + "/verify", {
      method: "POST",
      data: {},
    });
    await call("/api/accounts/" + a.id, {
      method: "PATCH",
      data: { enabled: true },
    });
    const headers = { authorization: "Bearer " + key };
    assert.equal((await call("/v1/models", { headers })).status, 200);
    for (const extra of [
      { tools: [{}] },
      { temperature: "hot" },
      { stream: "yes" },
    ])
      assert.equal(
        (
          await call("/v1/chat/completions", {
            method: "POST",
            headers,
            data: { messages: [{ role: "user", content: "hi" }], ...extra },
          })
        ).status,
        400,
      );
    const res = await call("/v1/chat/completions", {
      method: "POST",
      headers,
      data: {
        model: "gemini-test-medium",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.status, 200);
    assert.match((await res.json()).choices[0].message.content, /hi/);
    const stream = await call("/v1/chat/completions", {
      method: "POST",
      headers,
      data: { stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(stream.headers.get("x-stream-mode"), "buffered");
    const output = await stream.text();
    assert.match(output, /chat.completion.chunk/);
    assert.match(output, /\[DONE\]/);
  }));

test("admin task requests reject local-file expansion and oversized bodies", () =>
  appTest(async ({ call, login }) => {
    await login();
    for (const prompt of [
      "@/data/accounts/secret",
      "@../home",
      '@"/etc/passwd',
    ]) {
      const response = await call("/api/tasks", {
        method: "POST",
        data: { prompt },
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error.code,
        "unsupported_file_reference",
      );
    }
    assert.equal(
      (
        await call("/api/tasks", {
          method: "POST",
          data: { prompt: "x".repeat(530000) },
        })
      ).status,
      413,
    );
  }));

test("model directory success cannot enable an account when actual generation fails", () =>
  appTest(async ({ app, call, login }) => {
    await login();
    const a = await (
      await call("/api/accounts", {
        method: "POST",
        data: { name: "blocked-test" },
      })
    ).json();
    app.runner.execute = async (id, options) => {
      if (options.probe) return { models: [{ id: "gemini-test-medium" }] };
      throw new AppError(403, "Google 已停用", "account_suspended");
    };
    const response = await call("/api/accounts/" + a.id + "/verify", {
      method: "POST",
      data: {},
    });
    assert.equal(response.status, 403);
    assert.equal(app.store.get(a.id).enabled, false);
    assert.equal(app.store.get(a.id).checked_at, null);
    assert.equal(app.store.get(a.id).failures, 1);
    assert.equal(
      (
        await call("/api/accounts/" + a.id, {
          method: "PATCH",
          data: { enabled: true },
        })
      ).status,
      409,
    );
  }));

test("browser origins follow each request Host, reject spoofed forwarding, and set secure cookies for HTTPS", async () => {
  const { Auth } = await import("../src/auth.mjs");
  const auth = new Auth({ password, key });
  const request = (origin, host, extra = {}) => ({
    headers: { origin, host, ...extra },
    socket: { remoteAddress: "test" },
  });
  for (const [origin, host] of [
    ["http://sa6400:18861", "sa6400:18861"],
    ["http://192.168.1.10:18861", "192.168.1.10:18861"],
    ["https://agy-docker.wangxy.host:8443", "agy-docker.wangxy.host:8443"],
  ]) {
    const req = request(origin, host, { "sec-fetch-site": "same-origin" });
    assert.doesNotThrow(() => auth.sameOrigin(req));
    assert.equal(
      auth.cookie("sample", req).includes("; Secure"),
      origin.startsWith("https:"),
    );
  }
  for (const req of [
    request("https://evil.test", "sa6400:18861"),
    request("null", "sa6400:18861"),
    request("http://sa6400:18861", "sa6400:18861", {
      "sec-fetch-site": "cross-site",
    }),
    request("https://evil.test", "sa6400:18861", {
      "x-forwarded-host": "evil.test",
    }),
  ])
    assert.throws(() => auth.sameOrigin(req));
});
test("provider authentication failures preserve the independent administrator session", () =>
  appTest(async ({ app, call, login }) => {
    const unauth = await call("/api/status", { session: false });
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).error.code, "admin_session_required");
    await login();
    const created = await call("/api/accounts", {
        method: "POST",
        data: { name: "auth boundary" },
      }),
      a = await created.json();
    app.runner.execute = async (id, { probe }) => {
      if (probe) return { models: [{ id: "gemini-test-flash" }] };
      throw new AppError(
        401,
        "upstream authentication required",
        "login_required",
      );
    };
    const rejected = await call("/api/accounts/" + a.id + "/verify", {
      method: "POST",
      data: {},
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "login_required");
    assert.equal((await call("/auth/session")).status, 200);
    assert.equal((await call("/api/status")).status, 200);
  }));


test("client tool calls survive CLI structure, HTTP/SSE and a matching tool-result round trip", () =>
  appTest(async ({call, login}) => {
    await login();
    const a = await (await call("/api/accounts", {method: "POST", data: {name: "tools"}})).json();
    await call("/api/accounts/" + a.id + "/verify", {method: "POST", data: {}});
    await call("/api/accounts/" + a.id, {method: "PATCH", data: {enabled: true}});
    const headers = {authorization: "Bearer " + key};
    const tools = [{type: "function", function: {name: "sum", description: "Add two integers", parameters: {
      type: "object", properties: {a: {type: "integer"}, b: {type: "integer"}}, required: ["a", "b"], additionalProperties: false,
    }}}];
    const request = (data) => call("/v1/chat/completions", {method: "POST", headers, data});
    const messages = [{role: "user", content: "TOOL_TEST: sum 2 and 3."}];
    const first = await request({tools, messages, tool_choice: "required", reasoning_effort: "low"});
    assert.equal(first.status, 200);
    const reply = (await first.json()).choices[0];
    assert.equal(reply.finish_reason, "tool_calls");
    assert.equal(reply.message.content, null);
    const tool = reply.message.tool_calls[0];
    assert.equal(tool.function.name, "sum");
    assert.deepEqual(JSON.parse(tool.function.arguments), {a: 2, b: 3});
    assert.match(tool.id, /^call_/);
    const second = await request({tools, messages: [...messages, reply.message, {role: "tool", tool_call_id: tool.id, content: "5"}]});
    assert.equal(second.status, 200);
    const answer = (await second.json()).choices[0];
    assert.equal(answer.finish_reason, "stop");
    assert.equal(answer.message.content, "5");
    const stream = await request({tools, messages, stream: true, stream_options: {include_usage: true}});
    const events = (await stream.text()).split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(6)));
    const streamed = events.flatMap((event) => event.choices || []);
    const streamedCall = streamed.find((choice) => choice.delta.tool_calls)?.delta.tool_calls[0];
    assert.equal(streamedCall.index, 0);
    assert.deepEqual(JSON.parse(streamedCall.function.arguments), {a: 2, b: 3});
    assert.ok(streamed.some((choice) => choice.finish_reason === "tool_calls"));
    assert.equal(events.at(-1).usage.total_tokens, 13);
    const compatible = await request({tools, messages, temperature: 0.2, max_tokens: 4096});
    assert.equal(compatible.status, 200);
    assert.equal(compatible.headers.get("x-agy-ignored-parameters"), "temperature,max_tokens");
    assert.deepEqual((await compatible.json()).agy.ignored_parameters, ["temperature", "max_tokens"]);
    const none = await request({tools, messages, tool_choice: "none"});
    assert.equal((await none.json()).choices[0].finish_reason, "stop");
    for (const content of ["TOOL_BAD_ARGUMENTS", "TOOL_UNKNOWN", "TOOL_PARTIAL"]) {
      const invalid = await request({tools, messages: [{role: "user", content}]});
      assert.equal(invalid.status, 502, content);
      assert.ok(["invalid_tool_output", "incomplete_result"].includes((await invalid.json()).error.code));
    }
    for (const data of [
      {tools, messages: [...messages, {role: "tool", tool_call_id: "missing", content: "5"}]},
      {tools, messages: [...messages, reply.message]},
      {tools, messages, tool_choice: {type: "function", function: {name: "unknown"}}},
    ]) assert.equal((await request(data)).status, 400);
  }));
