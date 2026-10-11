import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ClientMessage, NotchFile } from "../src/protocol";
import type { RunResult, Runner } from "../src/system";

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "jarvis-bridge-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export interface StubRunner extends Runner {
  calls: { cmd: string[]; stdin?: string }[];
}

export function stubRunner(respond: (cmd: string[], stdin?: string) => Partial<RunResult> | Promise<Partial<RunResult>> = () => ({})): StubRunner {
  const calls: StubRunner["calls"] = [];
  const fn = (async (cmd, opts = {}) => {
    calls.push({ cmd, stdin: opts.stdin });
    const r = await respond(cmd, opts.stdin);
    return { code: 0, stdout: "", stderr: "", ...r };
  }) as StubRunner;
  fn.calls = calls;
  return fn;
}

/** Stands in for the Swift app: hosts the socket and writes notch.json. */
export class FakeApp {
  received: ClientMessage[] = [];
  clients = new Set<ServerWebSocket<{ authed: boolean }>>();
  server: Server;
  token = "test-token-" + Math.random().toString(36).slice(2);
  onAsk: ((m: Extract<ClientMessage, { type: "ask" }>, ws: ServerWebSocket<{ authed: boolean }>) => void) | null = null;
  private listeners: ((m: ClientMessage) => void)[] = [];

  constructor(public home: string, opts: { writeFile?: boolean; pid?: number } = {}) {
    const app = this;
    this.server = Bun.serve<{ authed: boolean }, {}>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req, { data: { authed: false } })) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(ws) {
          app.clients.add(ws);
        },
        close(ws) {
          app.clients.delete(ws);
        },
        message(ws, raw) {
          const m = JSON.parse(String(raw)) as ClientMessage;
          if (!ws.data.authed) {
            if (m.type !== "hello" || m.token !== app.token) {
              ws.send(JSON.stringify({ type: "error", message: "bad token" }));
              ws.close(4001, "bad token");
              return;
            }
            ws.data.authed = true;
            app.received.push(m);
            ws.send(JSON.stringify({ type: "welcome", protocol: 1 }));
            return;
          }
          app.received.push(m);
          for (const l of app.listeners) l(m);
          if (m.type === "ask") app.onAsk?.(m, ws);
        },
      },
    });
    if (opts.writeFile !== false) this.writeNotchFile(opts.pid);
  }

  writeNotchFile(pid = process.pid, token = this.token) {
    const f: NotchFile = { port: this.server.port!, token, pid, protocol: 1 };
    writeFileSync(join(this.home, "notch.json"), JSON.stringify(f), { mode: 0o600 });
  }

  /** Resolves with the first message of the given type (already received or future). */
  next<T extends ClientMessage["type"]>(type: T, timeoutMs = 2000): Promise<Extract<ClientMessage, { type: T }>> {
    const seen = this.received.find((m) => m.type === type);
    if (seen) return Promise.resolve(seen as Extract<ClientMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs}ms`)), timeoutMs);
      this.listeners.push((m) => {
        if (m.type === type) {
          clearTimeout(t);
          resolve(m as Extract<ClientMessage, { type: T }>);
        }
      });
    });
  }

  types(): string[] {
    return this.received.map((m) => m.type);
  }

  stop() {
    this.server.stop(true);
  }
}
