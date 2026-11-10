import {Logger} from "./runtime/logger.mjs";
import {Quotas} from "./services/quota.mjs";
import {registerAdmin} from "./admin/routes.mjs";
import {registerPages} from "./admin/pages.mjs";
import {Sessions, sessionSelector, sessionOwner, registerSessions} from "./sessions.mjs";
import { prepareChat, toolMessage } from "./chat.mjs";
import { LoginManager } from "./login.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "./store.mjs";
import { Runner } from "./runner.mjs";
import { SerialQueue } from "./queue.mjs";
import { Auth } from "./auth.mjs";
import { AppError, object, modelId } from "./common.mjs";
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
async function body(req) {
  if (
    !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
  )
    throw new AppError(415, "请使用 application/json");
  let bytes = 0;
  const parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new AppError(413, "请求不能超过 512 KiB");
    parts.push(chunk);
  }
  try {
    return object(JSON.parse(Buffer.concat(parts).toString("utf8")));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "JSON 格式无效");
  }
}
function promptInput(input) {
  object(input);
  const prompt = input.prompt;
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    Buffer.byteLength(prompt) > 256 * 1024
  )
    throw new AppError(400, "任务内容必须为非空文本，最多 256 KiB");
  // ASVS V2.2.1: this service accepts text, not CLI file-reference expansion.
  if (/@["']?(?:[\/]|~[\/]|\.\.?[\/]|[A-Za-z]:[\/])/.test(prompt))
    throw new AppError(
      400,
      "不接受 CLI 本地文件引用，请直接提交需要处理的文本",
      "unsupported_file_reference",
    );
  return { prompt, model: modelId(input.model), account: input.account_id, session_id: sessionSelector(input.session_id) };
}
export async function createApplication(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || "data");
  const store = options.store || (await new Store(dataDir).init());
  const logger=options.logger||new Logger({level:process.env.LOG_LEVEL||store.state.settings.log_level});
  const runner =
    options.runner ||
    new Runner({
      dataDir,
      command: process.env.AGY_BIN || "agy",
      timeout: Number(process.env.TASK_TIMEOUT_SECONDS || 180) * 1000,
    });
  const queue = new SerialQueue(
    Number(process.env.QUEUE_LIMIT || 32),
    Number(process.env.MAX_CONCURRENCY || 1),
  );
  const auth = new Auth({
    password: options.password || process.env.ADMIN_PASSWORD,
    key: options.key || process.env.API_KEY,
    keyLookup: value=>store.authorizeKey(value),
  });
  const sessions = new Sessions({runner, logger, limit: Number(process.env.SESSION_LIMIT || 2),
    idleMs: Number(process.env.SESSION_IDLE_SECONDS || 120) * 1000,
    maxTurns: Number(process.env.SESSION_MAX_TURNS || 50)});
  const loginManager = new LoginManager({
    dataDir,
    queue,
    store,
    keyrings: runner.keyrings,
    logger,
    verify: (id, log) => verifyAccount(id, undefined, log),
    beforeLogin: () => sessions.closeWhere(() => true),
  });
  const routes = [];
  function register(method, path, access, handler) {
    if (!["public", "read", "mutation", "api"].includes(access))
      throw Error("Unclassified endpoint");
    routes.push({ method, path, access, handler });
  }
  const send = (res, value, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const quotas=new Quotas({store,runner,queue,logger});
  async function perform(params, signal, context={}) {
    const existing = params.session_id && params.session_id !== "new" ? sessions.get(params.session_id, context.owner) : null;
    if (existing && params.account && params.account !== existing.account)
      throw new AppError(409, "会话已固定执行账号，请开始新会话", "session_mismatch");
    if (existing && params.model && params.model !== existing.model)
      throw new AppError(409, "会话已固定模型，请开始新会话", "session_mismatch");
    const model = existing?.model ?? params.model;
    const selected=store.pick(existing?.account || params.account,model).id;
    context.account_id=selected;context.account_name=store.get(selected).name;
    const queued=Date.now(),id=context.id||randomUUID();
    context.stage="queue";
    logger.info("request.queued",{request_id:id,account_id:selected,model:params.model||"默认模型",api_key_name:context.key_name||"管理台"});
    return queue.add(async()=>{
      context.assertActive?.();
      if(context.key_id)store.assertKeyActive(context.key_id);
      const a=store.pick(selected,model),started=Date.now();
      const turn = params.session_id ? sessions.begin(existing, context.owner, {
        account: selected, model, kind: params.messages ? "chat" : "task", schema: params.schema,
        effort: params.effort, config: params.sessionConfig, messages: params.messages, prompt: params.prompt,
      }) : null;
      context.stage="generation";
      logger.info("request.started",{request_id:id,account_id:a.id,account_name:a.name,model:params.model||"默认模型",api_key_name:context.key_name||"管理台",queue_ms:started-queued});
      a.requests++;
      try{
        await store.save();
        context.assertActive?.();
        if (turn?.session.closed) throw new AppError(410, "会话已关闭，请开始新会话", "session_closed");
        if (context.key_id) store.assertKeyActive(context.key_id);
        store.pick(selected, model);
        const result=await runner.execute(a.id,{prompt:turn?.prompt ?? params.prompt,model,schema:params.schema,effort:params.effort,signal,sessionId:turn?.session.id});
        result.assistant=toolMessage(result,params.tooling);
        if (turn) result.session = sessions.complete(turn.session, {messages: params.messages, assistant: result.assistant});
        a.successes++;a.total_tokens+=result.usage?.total_tokens||0;
        if(Number.isFinite(result.usage?.total_tokens))a.token_reports=(a.token_reports||0)+1;
        a.last_used=new Date().toISOString();a.last_error=null;
        if(context.key_id){store.endKeyRequest(context.key_id,true,result.usage?.total_tokens);context.outcome=true;}
        await store.event({id,account_id:a.id,account_name:a.name,api_key_id:context.key_id||"panel",api_key_name:context.key_name||"管理台",
          model:params.model||result.model||"默认模型",status:200,stage:"completed",duration_ms:Date.now()-started,queue_ms:started-queued,total_tokens:result.usage?.total_tokens??null});
        context.recorded=true;
        logger.info("request.completed",{request_id:id,account_id:a.id,model:params.model||result.model||"默认模型",status:200,duration_ms:Date.now()-started,tokens:result.usage?.total_tokens});
        return {...result,request_id:id,account:{id:a.id,name:a.name}};
      }catch(error){
        if (turn && !turn.session.closed) await sessions.close(turn.session.id, context.owner);
        a.failures++;a.last_error=error.code||"internal_error";
        if(["account_suspended","login_required"].includes(error.code)){
          a.enabled=false;a.status=error.code;
          await sessions.closeWhere(s => s.account === a.id);
        }
        if(context.key_id){store.endKeyRequest(context.key_id,false);context.outcome=true;}
        await store.event({id,account_id:a.id,account_name:a.name,api_key_id:context.key_id||"panel",api_key_name:context.key_name||"管理台",
          model:params.model||"默认模型",status:error.status||500,code:error.code||"internal_error",message:error instanceof AppError?error.message:"内部执行失败",stage:"generation",duration_ms:Date.now()-started});
        context.recorded=true;
        logger.warn("request.failed",{request_id:id,account_id:a.id,model:params.model||"默认模型",status:error.status||500,code:error.code||"internal_error",duration_ms:Date.now()-started});
        throw error;
      }
    },signal,{key:selected});
  }
  register("GET", "/health", "public", async ({ res }) =>
    send(res, { status: "ok", version }),
  );
  registerPages({register,publicDir});
  registerAdmin({register,send,body,store,auth,queue,runner,logger,dataDir,version,quotas,sessions});
  registerSessions({register,send,sessions});
  register("POST", "/auth/login", "public", async ({ req, res }) => {
    auth.sameOrigin(req);
    const input = await body(req);
    const session = auth.login(req, input.password);
    res.setHeader("set-cookie", auth.cookie(session.token, req));
    send(res, { csrf: session.csrf });
  });
  register("GET", "/auth/session", "read", async ({ res, principal }) =>
    send(res, { authenticated: true, csrf: principal.csrf }),
  );
  register(
    "POST",
    "/auth/logout",
    "mutation",
    async ({ req, res, principal }) => {
      if (loginManager.current?.owner === principal.token) loginManager.close();
      await sessions.closeWhere(s => s.owner === sessionOwner(principal));
      auth.sessions.delete(principal.token);
      res.setHeader(
        "set-cookie",
        "agy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" +
          (auth.sameOrigin(req).protocol === "https:" ? "; Secure" : ""),
      );
      send(res, { success: true });
    },
  );
  register("GET", "/api/status", "read", async ({ res }) => {
    store.prune();send(res, {
      version,
      queue: queue.status,
      memory: {
        gateway_rss: process.memoryUsage().rss,
        cli_rss: await runner.memory(),
      },
      accounts: store.list(),
      events: store.state.events,
      settings:store.state.settings,
    });
  });
  register("GET","/api/accounts","read",async({res})=>send(res,{accounts:store.list(),settings:store.state.settings,version,queue:queue.status,sessions:sessions.status}));
  register("GET","/api/runtime","read",async({res})=>send(res,{version,queue:queue.status,sessions:sessions.status,memory:{gateway_rss:process.memoryUsage().rss,cli_rss:await runner.memory()}}));
  register("POST", "/api/accounts", "mutation", async ({ req, res }) =>
    send(res, await store.create(await body(req)), 201),
  );
  register(
    "PATCH",
    /^\/api\/accounts\/(a_[a-f0-9]{16})$/,
    "mutation",
    async ({ req, res, match }) => {
      const account = await store.patch(match[1], await body(req));
      if (!account.enabled) await sessions.closeWhere(s => s.account === account.id);
      send(res, account);
    },
  );
  register(
    "DELETE",
    /^\/api\/accounts\/(a_[a-f0-9]{16})$/,
    "mutation",
    async ({ res, match }) => {
      if (queue.activeKeys.has(match[1]))
        throw new AppError(409, "账号正在执行任务，请完成后移除");
      await store.remove(match[1]);
      await sessions.closeWhere(s => s.account === match[1]);
      send(res, { success: true, profile_preserved: true });
    },
  );
  register(
    "POST",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/login$/,
    "mutation",
    async ({ req, res, match, principal }) => {
      const input = await body(req);
      if (input.restart != null && typeof input.restart !== "boolean")
        throw new AppError(400, "restart 必须为布尔值");
      const value = input.restart === true
        ? await loginManager.restart(principal.token, match[1])
        : loginManager.start(principal.token, match[1]);
      send(res, value);
    },
  );
  register(
    "GET",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/login$/,
    "read",
    async ({ res, match, principal }) =>
      send(res, loginManager.view(principal.token, match[1])),
  );
  register(
    "POST",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/login-input$/,
    "mutation",
    async ({ req, res, match, principal }) =>
      send(res, loginManager.input(principal.token, match[1], await body(req))),
  );
  register(
    "POST",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/login-stop$/,
    "mutation",
    async ({ res, match, principal }) =>
      send(res, loginManager.stop(principal.token, match[1])),
  );
  async function verifyAccount(id, signal, onOutput) {
    const a = store.get(id);
    await sessions.closeWhere(s => s.account === id);
    let testStarted = null,
      testModel = "";
    try {
      const result = await runner.execute(a.id, {
        probe: true,
        signal,
        onOutput,
      });
      a.models = result.models;
      const candidates = a.models.filter(
        (m) => !/image|tts|audio|video|embedding/i.test(m.id),
      );
      const selected =
        candidates.find(
          (m) =>
            /flash/i.test(m.id) &&
            /(?:^|[-_.])(?:low|lite)(?:$|[-_.])/i.test(m.id),
        ) ||
        candidates.find((m) => /flash/i.test(m.id)) ||
        candidates[0];
      if (!selected) throw new AppError(503, "没有可用于验证的文本模型");
      testStarted = Date.now();
      testModel = selected.id;
      a.requests++;
      const tested = await runner.execute(a.id, {
        prompt: "Reply with exactly OK. Do not use tools.",
        model: selected.id,
        signal,
        onOutput,
      });
      a.successes++;
      a.total_tokens += tested.usage.total_tokens || 0;
      if (Number.isFinite(tested.usage.total_tokens))
        a.token_reports = (a.token_reports || 0) + 1;
      a.last_used = new Date().toISOString();
      await store.event({
        id: randomUUID(),
        account_id: a.id,
        account_name: a.name,
        model: selected.id,
        status: 200,
        kind: "verification",
        duration_ms: Date.now() - testStarted,
        total_tokens: tested.usage.total_tokens ?? null,
      });
      a.status = "ready";
      a.last_error = null;
      a.checked_at = new Date().toISOString();
      await store.save();
    } catch (e) {
      a.last_error = e.code || "verification_failed";
      a.enabled = false;
      a.status = a.last_error;
      a.checked_at = null;
      if (testStarted) {
        a.failures++;
        await store.event({
          id: randomUUID(),
          account_id: a.id,
          account_name: a.name,
          model: testModel,
          status: e.status || 500,
          code: a.last_error,
          kind: "verification",
          duration_ms: Date.now() - testStarted,
        });
      } else await store.save();
      throw e;
    }
    return a;
  }
  register(
    "POST",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/verify$/,
    "mutation",
    async ({ res, match, signal }) => {
      const a = await queue.add(() => verifyAccount(match[1], signal), signal, {
        key: match[1],
      });
      send(res, {
        account: { ...a },
        note: "官方模型目录与实际生成均验证通过",
      });
    },
  );
  register(
    "POST",
    /^\/api\/accounts\/(a_[a-f0-9]{16})\/login-finish$/,
    "mutation",
    async ({ res, match, principal, signal }) => {
      const a = await loginManager.finish(
        principal.token,
        match[1],
        (onOutput) => verifyAccount(match[1], signal, onOutput),
      );
      send(res, { account: { ...a }, note: "登录与实际生成均验证通过" });
    },
  );
  register("POST", "/api/tasks", "mutation", async ({ req, res, signal, principal, requestId }) =>
    send(res, await perform(promptInput(await body(req)), signal, {id:requestId, owner:sessionOwner(principal), assertActive:()=>auth.session(req)})),
  );
  register("GET", "/v1/models", "api", async ({ res }) => {
    const models = new Set(
      store
        .list()
        .filter((a) => a.enabled)
        .flatMap((a) => a.models.map((m) => m.id)),
    );
    send(res, {
      object: "list",
      data: [...models]
        .sort()
        .map((id) => ({ id, object: "model", owned_by: "agy" })),
    });
  });
  register(
    "POST",
    "/v1/chat/completions",
    "api",
    async ({ req, res, signal, principal, requestId }) => {
      const context=req.trace={id:requestId,key_id:principal.key_id,key_name:principal.key_name,owner:sessionOwner(principal),stage:"request_prepare",started:Date.now()};
      store.beginKeyRequest(principal.key_id);
      logger.info("request.received",{request_id:requestId,api_key_id:principal.key_id,api_key_name:principal.key_name,stage:"request_prepare"});
      const input=await body(req);
      context.model=typeof input.model==="string"?input.model.slice(0,160):"默认模型";
      const params=prepareChat(input,promptInput);
      if (params.ignoredParameters.length)
        res.setHeader("x-agy-ignored-parameters", params.ignoredParameters.join(","));
      if (params.tooling) res.setHeader("x-agy-tool-mode", "structured-output");
      let heartbeat;
      if (input.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
          "x-stream-mode": "buffered",
        });
        res.write(": queued\n\n");
        heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": waiting for agy\n\n");
        }, 15000);
      }
      try {
        const result = await perform(params, signal, context);
        const id = "chatcmpl-" + result.request_id,
          created = Math.floor(Date.now() / 1000),
          model = result.model || params.model || "agy-default";
        if (input.stream) {
          const chunk = (delta, finish_reason = null) =>
            res.write(
              "data: " +
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta, finish_reason }],
                  ...(result.session ? {agy: {session: result.session}} : {}),
                }) +
                "\n\n",
            );
          const message = result.assistant;
          chunk({ role: "assistant", content: message.content });
          if (message.tool_calls)
            chunk({tool_calls: message.tool_calls.map((call, index) => ({index, ...call}))});
          chunk({}, message.tool_calls?.length ? "tool_calls" : "stop");
          if (input.stream_options?.include_usage)
            res.write("data: " + JSON.stringify({
              id, object: "chat.completion.chunk", created, model, choices: [],
              usage: {prompt_tokens: result.usage.input_tokens ?? 0, completion_tokens: result.usage.output_tokens ?? 0, total_tokens: result.usage.total_tokens ?? 0},
            }) + "\n\n");
          res.end("data: [DONE]\n\n");
        } else
          send(res, {
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: result.assistant,
                finish_reason: result.assistant.tool_calls?.length ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: result.usage.input_tokens ?? 0,
              completion_tokens: result.usage.output_tokens ?? 0,
              total_tokens: result.usage.total_tokens ?? 0,
            },
            agy: {
              account_id: result.account.id,
              request_id: result.request_id,
              ignored_parameters: params.ignoredParameters,
              ...(params.tooling ? {tool_mode: "structured_output"} : {}),
              ...(result.session ? {session: result.session} : {}),
            },
          });
      } finally {
        clearInterval(heartbeat);
      }
    },
  );
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const url = new URL(req.url, "http://internal");
      req.safePath=url.pathname;
      const candidates = routes
        .map((route) => ({
          route,
          match:
            route.path instanceof RegExp
              ? url.pathname.match(route.path)
              : route.path === url.pathname
                ? []
                : null,
        }))
        .filter((x) => x.match);
      const found = candidates.find((x) => x.route.method === req.method);
      if (!found) {
        if (candidates.length)
          res.setHeader(
            "allow",
            candidates.map((x) => x.route.method).join(", "),
          );
        throw new AppError(
          candidates.length ? 405 : 404,
          candidates.length ? "不支持此请求方法" : "接口不存在",
        );
      }
      const principal = auth.check(req, found.route.access);
      await found.route.handler({
        req,
        res,
        principal,
        match: found.match,
        signal: controller.signal,
        requestId,
      });
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if(req.trace&&!req.trace.recorded){
        const t=req.trace;
        if(!t.outcome)store.endKeyRequest(t.key_id,false);
        await store.event({id:requestId,api_key_id:t.key_id,api_key_name:t.key_name,account_id:t.account_id||null,account_name:t.account_name||null,
          model:t.model||"未提供模型",status,code:e.code||"internal_error",message:e instanceof AppError?e.message:"内部错误",stage:t.stage,duration_ms:Date.now()-t.started}).catch(()=>{});
      }
      logger.warn("http.failed",{request_id:requestId,path:req.safePath||"/",method:req.method,status,code:e.code||"internal_error",stage:req.trace?.stage||"request",message:e instanceof AppError?e.message:"内部错误"});
      if (res.destroyed) return;
      const value = {
        error: {
          message: e instanceof AppError ? e.message : "服务内部错误",
          code: e instanceof AppError ? e.code : "internal_error",
          request_id: requestId,
        },
      };
      if (res.headersSent)
        res.end("data: " + JSON.stringify(value) + "\n\ndata: [DONE]\n\n");
      else send(res, value, status === 499 ? 408 : status);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    runner,
    queue,
    auth,
    loginManager,
    quotas,
    sessions,
    logger,
    catalog: routes.map(({ method, path, access }) => ({
      method,
      path: String(path),
      access,
    })),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await createApplication();
  const port = Number(process.env.PORT || 18861);
  app.server.listen(port, process.env.HOST || "0.0.0.0", () =>
    app.logger.info("service.started",{version,port}),
  );
  const close = () => {
    app.loginManager.close();
    app.server.close();
    Promise.all([app.store.pending, app.runner.close()]).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
