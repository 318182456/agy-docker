import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { AppError } from "./common.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export class Keyrings {
  constructor() {
    this.entries = new Map();
  }
  async acquire(id, profile) {
    let e = this.entries.get(id);
    if (e?.closing) {
      await e.closing;
      return this.acquire(id, profile);
    }
    if (!e) {
      e = { refs: 0, children: [], runtime: null };
      this.entries.set(id, e);
      e.ready = this.start(e, profile).catch(async (error) => {
        await this.dispose(e);
        if (this.entries.get(id) === e) this.entries.delete(id);
        throw error;
      });
    }
    e.refs++;
    const env = await e.ready;
    let released = false;
    return {
      env,
      release: async () => {
        if (released) return;
        released = true;
        if (--e.refs === 0) {
          e.closing = this.dispose(e).finally(() => {
            if (this.entries.get(id) === e) this.entries.delete(id);
          });
          await e.closing;
        }
      },
    };
  }
  async start(e, profile) {
    e.runtime = await mkdtemp(join(tmpdir(), "agy-keyring-"));
    const address = "unix:path=" + join(e.runtime, "bus");
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      ...profile.env,
      DBUS_SESSION_BUS_ADDRESS: address,
      XDG_RUNTIME_DIR: e.runtime,
    };
    const directory = join(
      profile.home,
      ".local",
      "share",
      "agy-docker-keyring",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "unlock");
    try {
      await writeFile(path, randomBytes(32).toString("base64url"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const password = await readFile(path);
    const launch = (command, args) => {
      const c = spawn(command, args, {
        env,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      c.diagnostic = "";
      c.stderr.on("data", (b) => {
        c.diagnostic += b.toString();
      });
      c.on("error", (error) => {
        c.launchError = error;
      });
      e.children.push(c);
      return c;
    };
    // Private bus deliberately has no activation service directories: probing
    // before our daemon owns its name must not auto-start a competing daemon.
    const config = join(e.runtime, "session.conf");
    await writeFile(
      config,
      `<busconfig><type>session</type><listen>${address}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
      { mode: 0o600 },
    );
    const bus = launch("dbus-daemon", [
      "--nofork",
      "--nopidfile",
      "--config-file=" + config,
    ]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (bus.launchError || bus.exitCode !== null) break;
      try {
        ready = (await stat(join(e.runtime, "bus"))).isSocket();
      } catch {}
      if (ready) break;
      await delay(50);
    }
    if (!ready)
      throw new AppError(
        503,
        "D-Bus 启动失败：" + (bus.launchError?.message || bus.diagnostic),
        "keyring_unavailable",
      );
    const daemon = launch("gnome-keyring-daemon", [
      "--foreground",
      "--unlock",
      "--components=secrets",
      "--control-directory=" + join(e.runtime, "keyring"),
    ]);
    daemon.stdin.on("error", () => {});
    daemon.stdin.end(password, () => password.fill(0));
    for (let i = 0; i < 50; i++) {
      if (daemon.launchError || daemon.exitCode !== null) break;
      const call = async (args) =>
        new Promise((resolve) => {
          const child = spawn(
            "dbus-send",
            [
              "--session",
              "--print-reply",
              "--reply-timeout=500",
              "--dest=org.freedesktop.secrets",
              ...args,
            ],
            { env, stdio: ["ignore", "pipe", "ignore"] },
          );
          let output = "";
          child.stdout.on("data", (b) => (output += b));
          child.once("error", () => resolve({ code: 1, output: "" }));
          child.once("close", (code) => resolve({ code, output }));
        });
      // Secret Service can answer Ping before the login collection is unlocked.
      const unlocked = await call([
        "/org/freedesktop/secrets/collection/login",
        "org.freedesktop.DBus.Properties.Get",
        "string:org.freedesktop.Secret.Collection",
        "string:Locked",
      ]);
      if (unlocked.code === 0 && /boolean false/.test(unlocked.output)) {
        const alias = await call([
          "/org/freedesktop/secrets",
          "org.freedesktop.Secret.Service.SetAlias",
          "string:default",
          "objpath:/org/freedesktop/secrets/collection/login",
        ]);
        if (alias.code === 0)
          return {
            DBUS_SESSION_BUS_ADDRESS: address,
            XDG_RUNTIME_DIR: e.runtime,
          };
      }
      await delay(100);
    }
    throw new AppError(
      503,
      "Linux 密钥环启动失败：" +
        (daemon.launchError?.message || daemon.diagnostic),
      "keyring_unavailable",
    );
  }
  async dispose(e) {
    for (const c of [...e.children].reverse()) {
      if (c.exitCode !== null || c.signalCode) continue;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            c.kill("SIGKILL");
          } catch {}
          resolve();
        }, 1500);
        c.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          c.kill("SIGTERM");
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    if (e.runtime) await rm(e.runtime, { recursive: true, force: true });
  }
  async close() {
    await Promise.all([...this.entries.values()].map((e) => this.dispose(e)));
    this.entries.clear();
  }
}
