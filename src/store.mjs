import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { defaultSettings } from "./admin/settings.mjs";
import { AppError, accountId, object, equalSecret } from "./common.mjs";
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, "state.json");
    this.state = { accounts: [], cursor: 0, events: [], keys: [], settings: {...defaultSettings}, master_usage: freshUsage() };
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await readFile(this.path, "utf8"));
      this.state = {...this.state,...loaded,settings:{...defaultSettings,...loaded.settings}};
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      !Array.isArray(this.state.accounts) ||
      !Array.isArray(this.state.events) || !Array.isArray(this.state.keys)
    )
      throw Error("Invalid state file");
    this.prune();
    return this;
  }
  async save() {
    this.prune();
    const data = JSON.stringify(this.state);
    this.pending = this.pending.catch(() => {}).then(async () => {
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
      if(input.enabled&&["login_required","account_suspended"].includes(a.status))throw new AppError(409,"请重新完成登录校验后再启用");
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
    this.prune();
    await this.save();
  }
  prune() {
    const since=Date.now()-this.state.settings.log_retention_days*86400000;
    this.state.events=this.state.events.filter(e=>Number.isFinite(Date.parse(e.at))&&Date.parse(e.at)>=since).slice(0,this.state.settings.log_max_entries);
  }
  getKey(id) {
    if(typeof id!=="string"||!/^k_[a-f0-9]{16}$/.test(id))throw new AppError(400,"密钥ID无效");
    const key=this.state.keys.find(k=>k.id===id);
    if(!key)throw new AppError(404,"密钥不存在");
    return key;
  }
  listKeys() {
    return this.state.keys.map(({value,...key})=>({...key,last4:value.slice(-4),expired:!!key.expires_at&&Date.parse(key.expires_at)<=Date.now()}));
  }
  async createKeys(rows,{reserved=[]}={}) {
    if(!Array.isArray(rows)||!rows.length||rows.length>500||this.state.keys.length+rows.length>1000)throw new AppError(400,"一次导入1–500项，总密钥数最多1000");
    const seen=new Set();
    const created=rows.map(row=>{
      object(row);
      const name=String(row.name||"").trim();
      if(!name||name.length>100)throw new AppError(400,"密钥名称需为1–100字符");
      const value=row.value??row.key??row.token??("sk-"+randomBytes(32).toString("base64url"));
      if(typeof value!=="string"||value.length<20||value.length>256||/\s/.test(value))throw new AppError(400,"密钥需为20–256字符且不能包含空白");
      if(seen.has(value)||this.state.keys.some(k=>equalSecret(k.value,value))||reserved.some(x=>equalSecret(x,value)))throw new AppError(409,"导入内容包含重复密钥或受保护的部署凭据");
      seen.add(value);
      if(row.enabled!=null&&typeof row.enabled!=="boolean")throw new AppError(400,"启用状态必须为布尔值");
      const expires_at=expiry(row.expires_at);
      return {id:"k_"+randomBytes(8).toString("hex"),name,value,enabled:row.enabled??true,expires_at,created_at:new Date().toISOString(),usage:freshUsage()};
    });
    this.state.keys.push(...created);await this.save();
    const ids=new Set(created.map(x=>x.id));return this.listKeys().filter(x=>ids.has(x.id));
  }
  async patchKey(id,input) {
    object(input);const key=this.getKey(id);
    if(Object.keys(input).some(k=>!["name","enabled","expires_at"].includes(k)))throw new AppError(400,"只可修改名称、启用状态和到期时间");
    const update={};
    if(input.name!==undefined){if(typeof input.name!=="string"||!input.name.trim()||input.name.length>100)throw new AppError(400,"密钥名称无效");update.name=input.name.trim();}
    if(input.enabled!==undefined){if(typeof input.enabled!=="boolean")throw new AppError(400,"启用状态无效");update.enabled=input.enabled;}
    if(input.expires_at!==undefined)update.expires_at=expiry(input.expires_at);
    Object.assign(key,update);await this.save();return this.listKeys().find(k=>k.id===id);
  }
  authorizeKey(value) {
    if(typeof value!=="string"||value.length>256)return null;
    const key=this.state.keys.find(k=>equalSecret(k.value,value));
    return key&&key.enabled&&(!key.expires_at||Date.parse(key.expires_at)>Date.now())?{kind:"api",key_id:key.id,key_name:key.name}:null;
  }
  assertKeyActive(id) {
    if(id==="master")return;
    const key=this.state.keys.find(k=>k.id===id);
    if(!key||!key.enabled||(key.expires_at&&Date.parse(key.expires_at)<=Date.now()))throw new AppError(401,"API 密钥已停用、删除或到期","invalid_api_key");
  }
  keyUsage(id) { return id==="master"?this.state.master_usage:this.state.keys.find(k=>k.id===id)?.usage; }
  beginKeyRequest(id) {const usage=this.keyUsage(id);if(usage){usage.requests++;usage.last_used=new Date().toISOString();}}
  endKeyRequest(id,success,tokens=null) {
    const usage=this.keyUsage(id);if(!usage)return;
    usage[success?"successes":"failures"]++;
    if(Number.isFinite(tokens)){usage.total_tokens+=tokens;usage.token_reports++;}
  }

}

function freshUsage(){return{requests:0,successes:0,failures:0,total_tokens:0,token_reports:0,last_used:null};}
function expiry(value){
  if(value==null||value==="")return null;
  if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new AppError(400,"到期时间无效");
  return new Date(value).toISOString();
}
