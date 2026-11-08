// Client side of the notch socket, plus the macOS fallbacks used when the app
// isn't running. Every send reports whether the app got it, so callers can
// fall back instead of failing silently.

import { readFileSync } from "node:fs";
import { notchFile } from "./config";
import { PROTOCOL_VERSION, type AppMessage, type Answer, type ClientKind, type ClientMessage, type NotchFile } from "./protocol";
import type { Runner } from "./system";

export interface NotchLinkOptions {
  home: string;
  client: ClientKind;
  sessionId: string | null;
  connectTimeoutMs?: number;
}

export function readNotchFile(home: string): NotchFile | null {
  try {
    const f = JSON.parse(readFileSync(notchFile(home), "utf8")) as NotchFile;
    if (typeof f.port !== "number" || typeof f.token !== "string" || typeof f.pid !== "number") return null;
    if (f.protocol !== undefined && f.protocol !== PROTOCOL_VERSION) return null;
    return f;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class NotchLink {
  private ws: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private waiters = new Map<string, (a: Answer | null) => void>();
  private played = new Map<string, () => void>();
  private canPlay = false;
  private closed = false;

  constructor(private opts: NotchLinkOptions) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connects if needed. Resolves false when the app isn't running or rejects us. */
  connect(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private open(): Promise<boolean> {
    const f = readNotchFile(this.opts.home);
    if (!f || !pidAlive(f.pid)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          try {
            ws.close();
          } catch {}
        }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), this.opts.connectTimeoutMs ?? 1000);
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${f.port}/`);
      } catch {
        clearTimeout(timer);
        return resolve(false);
      }
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            token: f.token,
            client: this.opts.client,
            pid: process.pid,
            session_id: this.opts.sessionId,
          } satisfies ClientMessage),
        );
      };
      ws.onmessage = (ev) => {
        let msg: AppMessage;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          this.canPlay = msg.play === true;
          this.ws = ws;
          done(true);
        } else if (msg.type === "answer") {
          const w = this.waiters.get(msg.id);
          if (w) {
            this.waiters.delete(msg.id);
            w(msg);
          }
        } else if (msg.type === "played") {
          this.played.get(msg.id)?.();
        } else if (msg.type === "error" && !settled) {
          done(false);
        }
      };
      ws.onerror = () => done(false);
      ws.onclose = () => {
        done(false);
        if (this.ws === ws) this.ws = null;
        for (const done of this.played.values()) done();
        // Anyone waiting on an answer gets "no answer" rather than hanging.
        for (const [id, w] of this.waiters) {
          this.waiters.delete(id);
          w(null);
        }
      };
    });
  }

  /** Sends if connected (connecting first). Returns whether the app received it. */
  async send(msg: ClientMessage): Promise<boolean> {
    if (!(await this.connect())) return false;
    try {
      this.ws!.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Has the app play a WAV and waits until it has (or was stopped, or the app
   * went away). False when the app can't play it, so the caller plays it itself.
   */
  async play(id: string, file: string, timeoutMs = 120_000): Promise<boolean> {
    if (!(await this.connect()) || !this.canPlay) return false;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.played.delete(id);
        resolve(true);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.played.set(id, finish);
      if (!this.ws) return finish();
      try {
        this.ws.send(JSON.stringify({ type: "play", id, file } satisfies ClientMessage));
      } catch {
        this.played.delete(id);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /** Sends an ask and waits for its answer. Null on timeout, abort or disconnect. */
  async ask(msg: Extract<ClientMessage, { type: "ask" }>, signal?: AbortSignal): Promise<Answer | "timeout" | null> {
    if (!(await this.send(msg))) return null;
    return new Promise((resolve) => {
      const finish = (r: Answer | "timeout" | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(msg.id);
        resolve(r);
      };
      const timer = setTimeout(() => {
        void this.send({ type: "ask_cancel", id: msg.id, reason: "timeout" });
        finish("timeout");
      }, msg.timeout_ms);
      const onAbort = () => {
        void this.send({ type: "ask_cancel", id: msg.id, reason: "cancelled" });
        finish(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(msg.id, (a) => finish(a));
    });
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

/** macOS notification without the app. Text goes through argv, never into the script. */
export async function osNotify(run: Runner, title: string, body: string): Promise<void> {
  const r = await run([
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e",
    "end run",
    title,
    body,
  ]);
  if (r.code !== 0) throw new Error(`osascript failed (exit ${r.code}): ${r.stderr.trim() || "no output"}`);
}

/**
 * A reminder firing, for the launcher's launchd job. Shows it in the notch; with
 * the app closed, posts a macOS notification and says it aloud instead.
 * Returns where it was shown.
 */
export async function fireReminder(opts: {
  home: string;
  text: string;
  run?: Runner;
  connectTimeoutMs?: number;
}): Promise<"notch" | "macos"> {
  const { appendAction } = await import("./actions");
  const { Speaker } = await import("./speech");
  const { runCommand } = await import("./system");
  const run = opts.run ?? runCommand;
  const link = new NotchLink({ home: opts.home, client: "reminder", sessionId: null, connectTimeoutMs: opts.connectTimeoutMs });
  try {
    appendAction(opts.home, { kind: "reminder", summary: opts.text });
    const id = `r-${process.pid}-${Date.now()}`;
    if (await link.send({ type: "reminder", id, text: opts.text })) return "notch";
    await osNotify(run, "Reminder", opts.text);
    const speaker = new Speaker({ home: opts.home, run });
    await speaker.say(`Reminder: ${opts.text}`);
    await speaker.idle(); // give the voice back before exiting
    return "macos";
  } finally {
    link.close();
  }
}
