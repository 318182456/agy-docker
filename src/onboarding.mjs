import xterm from "@xterm/headless";
const { Terminal } = xterm;

// Only pinned official CLI setup pages may cause automatic keystrokes.
export class Onboarding {
  constructor({ send, changed = () => {}, completed = () => {}, workspace = null }) {
    Object.assign(this, { send, changed, completed, workspace });
    this.done = new Set();
    this.terminal = new Terminal({
      cols: 180, rows: 60, scrollback: 0,
      allowProposedApi: true, logLevel: "off",
    });
    this.reply = this.terminal.onData((data) => this.send(data));
  }
  write(data) {
    if (this.closed) return;
    this.terminal.write(data, () => {
      if (this.closed) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.advance(), 180);
      this.timer.unref();
    });
  }
  get screen() {
    if (this.closed) return this.lastScreen || "";
    const b = this.terminal.buffer.active;
    return Array.from({ length: 60 }, (_, i) =>
      b.getLine(b.viewportY + i)?.translateToString(true) || "",
    ).join("\n").trim();
  }
  once(step, keys, message) {
    if (this.done.has(step)) return;
    this.done.add(step);
    this.changed(message);
    this.send(keys);
  }
  advance() {
    const s = this.screen;
    // A saved profile can skip every setup screen. Require both the configured workspace and native input chrome.
    const ready = this.workspace && s.includes(this.workspace) && /\? for shortcuts/i.test(s) && /(?:^|\n)\s*[>❯]\s*(?:\n|$)/.test(s);
    if (/Select login method:/i.test(s) && /1\. Google OAuth/.test(s))
      this.once("oauth", "\r", "已选择 Google OAuth，等待官方授权链接。");
    else if (
      this.workspace && /Accessing workspace:/.test(s) &&
      s.split("\n").some((line) => line.trim() === this.workspace) &&
      /Do you trust the contents of this project\?/.test(s) &&
      /[>❯]\s*Yes, I trust this folder/.test(s)
    )
      this.once("workspace-trust", "\r", "已确认本账号的独立空工作目录。");
    else if (/Choose your color scheme:/i.test(s) && /\[Next\]/.test(s))
      this.once("theme", "\t\r", "已自动选择默认终端主题。");
    else if (/help improve Antigravity CLI/i.test(s) && /\[Done\]/.test(s)) {
      if (/\[[xX✓]\]\s*Yes/.test(s))
        this.once("telemetry-off", " ", "已取消可选的互动数据收集。");
      else
        this.once("setup-done", "\t\t\r", "正在保存官方首次设置。");
    } else if ((ready || ((this.done.has("setup-done") || this.done.has("workspace-trust")) && /Ready for your message/i.test(s))) && !this.done.has("complete")) {
      this.done.add("complete");
      this.changed("已进入官方 agy 主界面，正在准备校验登录…");
      this.completed();
    }
  }
  close() {
    this.lastScreen = this.screen;
    this.closed = true;
    clearTimeout(this.timer);
    this.reply.dispose();
    this.terminal.dispose();
  }
}
