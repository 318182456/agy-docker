const priorities = {debug: 10, info: 20, warn: 30, error: 40, silent: 100};
const allowed = new Set(["request_id","session_id","method","path","status","code","stage","account_id","account_name","model","api_key_id","api_key_name","duration_ms","queue_ms","tokens","version","port","count","level","exit_code","message"]);
function safe(value) {
  return typeof value === "string" ? value.slice(0, 500).replace(/\b(?:sk-|ya29\.|gh[pousr]_)[A-Za-z0-9_.-]{10,}/g,"[credential]") : value;
}
export class Logger {
  constructor({level = "info", sink = (value) => console.log(value)} = {}) { this.level = level; this.sink = sink; }
  write(level,event,fields={}) {
    if ((priorities[level] || 20) < (priorities[this.level] || 20)) return;
    const data = Object.fromEntries(Object.entries(fields).filter(([k,v])=>allowed.has(k) && ["string","number","boolean"].includes(typeof v)).map(([k,v])=>[k,safe(v)]));
    this.sink(JSON.stringify({time:new Date().toISOString(),level,event,...data}));
  }
  debug(event,data){this.write("debug",event,data);}
  info(event,data){this.write("info",event,data);}
  warn(event,data){this.write("warn",event,data);}
  error(event,data){this.write("error",event,data);}
}
