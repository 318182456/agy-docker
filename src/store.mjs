import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AppError, accountId, object } from "./common.mjs";
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, "state.json");
    this.state = { accounts: [], cursor: 0, events: [] };
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      !Array.isArray(this.state.accounts) ||
      !Array.isArray(this.state.events)
    )
      throw Error("Invalid state file");
    return this;
  }
  async save() {
    const data = JSON.stringify(this.state);
    this.pending = this.pending.then(async () => {
      const temp = this.path + ".tmp";
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.pending;
  }
  list() {
    return this.state.accounts.map((a) => ({ ...a }));
  }
  get(id) {
    const a = this.state.accounts.find((a) => a.id === accountId(id));
    if (!a) throw new AppError(404, "账号不存在");
    return a;
  }
  async create(input) {
    object(input);
    if (this.state.accounts.length >= 100)
      throw new AppError(409, "最多支持 100 个账号");
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100
    )
      throw new AppError(400, "请输入不超过 100 字符的账号名称");
    const a = {
      id: "a_" + randomBytes(8).toString("hex"),
      name: input.name.trim(),
      enabled: false,
      status: "not_logged_in",
      models: [],
      requests: 0,
      successes: 0,
      failures: 0,
      total_tokens: 0,
      token_reports: 0,
      created_at: new Date().toISOString(),
    };
    this.state.accounts.push(a);
    await this.save();
    return { ...a };
  }
  async patch(id, input) {
    object(input);
    const a = this.get(id);
    if (Object.keys(input).some((k) => !["name", "enabled"].includes(k)))
      throw new AppError(400, "仅可修改名称和启用状态");
    if (input.name !== undefined) {
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 100
      )
        throw new AppError(400, "名称无效");
      a.name = input.name.trim();
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean")
        throw new AppError(400, "启用状态必须为布尔值");
      if (input.enabled && (!a.models.length || !a.checked_at))
        throw new AppError(409, "请先完成校验并测试");
      a.enabled = input.enabled;
      if (a.enabled) a.status = "ready";
    }
    await this.save();
    return { ...a };
  }
  pick(id, model) {
    if (id) {
      const a = this.get(id);
      if (!a.enabled) throw new AppError(409, "指定账号未启用");
      if (model && !a.models.some((m) => m.id === model))
        throw new AppError(
          400,
          "指定账号的模型目录没有此模型，请检查或刷新目录",
        );
      return a;
    }
    const pool = this.state.accounts.filter(
      (a) => a.enabled && (!model || a.models.some((m) => m.id === model)),
    );
    if (!pool.length)
      throw new AppError(
        503,
        "没有已启用的账号，请先登录、检查模型并启用账号",
        "no_account",
      );
    const a = pool[this.state.cursor % pool.length];
    this.state.cursor++;
    return a;
  }
  async remove(id) {
    this.get(id);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    await this.save();
  }
  async event(row) {
    this.state.events.unshift({ ...row, at: new Date().toISOString() });
    this.state.events = this.state.events.slice(0, 100);
    await this.save();
  }
}
