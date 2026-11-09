// Approval queue (Leo, 2026-11-09: "Jarvis finds tasks it can do, I approve the
// task and it keeps it in the queue, I can click on it to see progress, and
// once finished it shows as complete, at which point I can dismiss it").
// state/queue.json holds the items. The scout and the daily finder propose,
// Leo approves (notch or dashboard), and the worker runs approved items one at
// a time as quiet background runs. The app changes it only through `run.sh
// queue …`, and every write holds a lock file, so concurrent writers can't lose
// each other's changes.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { NotchLink } from "../../bridge/src/notch";
import { type Config, paths } from "./config";
import { dailyPlist, installDaily } from "./daily";
import { type Exec, realExec } from "./reminders/scheduler";
import { run as realRun, type RunOptions, type RunOutcome } from "./run";
import { log, writeFileAtomic } from "./store";

export type QueueStatus = "proposed" | "approved" | "running" | "done" | "failed";

export interface QueueItem {
  id: string;
  /** kanban, university, freelance, email, other. */
  source: string;
  /** What Jarvis will do, short: "Write the COMP2311 Lecture 17 notes". */
  title: string;
  /** The request the run gets, self-contained. */
  request: string;
  /** One line: why this is worth doing now. */
  why: string;
  status: QueueStatus;
  sessionId?: string;
  summary?: string;
  /** A finished run that ended waiting on Leo (tasks.ts `resolved: false`, or a guard block). */
  needsYou?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Closed {
  title: string;
  request: string;
  /** declined or dismissed */
  how: string;
  at: string;
}

export interface Queue {
  items: QueueItem[];
  /** Declined and dismissed items, so the same thing isn't proposed again for a while. */
  closed: Closed[];
}

export const WORKER_LABEL = "com.jarvis.queue-worker";
export const FINDER_LABEL = "com.jarvis.task-finder";
const CLOSED_DAYS = 30;
/** At most this many notch questions per batch of proposals. */
const MAX_ASKS = 2;

export const queueFile = (c: Config) => join(paths(c).state, "queue.json");

export function readQueue(c: Config): Queue {
  try {
    const q = JSON.parse(readFileSync(queueFile(c), "utf8"));
    return { items: Array.isArray(q.items) ? q.items : [], closed: Array.isArray(q.closed) ? q.closed : [] };
  } catch {
    return { items: [], closed: [] };
  }
}

/** Read, change and write the queue under a lock file. */
export function updateQueue<T>(c: Config, change: (q: Queue) => T, now = Date.now()): T {
  const lock = `${queueFile(c)}.lock`;
  mkdirSync(paths(c).state, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      // A writer that died mid-write leaves its lock; nobody holds one for seconds.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {}
      if (i > 500) throw new Error("the queue is locked");
      Bun.sleepSync(10);
    }
  }
  try {
    const q = readQueue(c);
    q.closed = q.closed.filter((x) => now - Date.parse(x.at) < CLOSED_DAYS * 86400_000);
    const out = change(q);
    writeFileAtomic(queueFile(c), JSON.stringify(q, null, 2));
    return out;
  } finally {
    rmSync(lock, { force: true });
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const same = (a: { title: string; request: string }, b: { title: string; request: string }) =>
  norm(a.title) === norm(b.title) || norm(a.request) === norm(b.request);

/** Adds proposals that aren't already queued or recently declined/dismissed. Returns the ones added. */
export function propose(c: Config, input: unknown, now = Date.now()): QueueItem[] {
  if (!Array.isArray(input)) throw new Error("expected a JSON array of {source, title, request, why}");
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const at = new Date(now).toISOString();
  return updateQueue(c, (q) => {
    const added: QueueItem[] = [];
    for (const p of input.slice(0, 10)) {
      const item: QueueItem = {
        id: `q${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        source: str(p?.source, 20) || "other",
        title: str(p?.title, 120),
        request: str(p?.request, 1000),
        why: str(p?.why, 200),
        status: "proposed",
        createdAt: at,
        updatedAt: at,
      };
      if (!item.title || !item.request) continue;
      if ([...q.items, ...q.closed].some((x) => same(x, item))) continue;
      q.items.push(item);
      added.push(item);
    }
    return added;
  }, now);
}

const ALLOWED: Record<string, QueueStatus[]> = {
  approve: ["proposed"],
  decline: ["proposed"],
  dismiss: ["proposed", "done", "failed"],
  retry: ["failed"],
};

/** Leo's actions from the notch or the dashboard. Returns the item, or null when it can't (gone, or the wrong state). */
export function act(c: Config, action: keyof typeof ALLOWED, id: string, now = Date.now()): QueueItem | null {
  return updateQueue(c, (q) => {
    const item = q.items.find((x) => x.id === id);
    if (!item || !ALLOWED[action]!.includes(item.status)) return null;
    const at = new Date(now).toISOString();
    if (action === "decline" || action === "dismiss") {
      q.items = q.items.filter((x) => x !== item);
      q.closed.push({ title: item.title, request: item.request, how: action === "decline" ? "declined" : "dismissed", at });
      return item;
    }
    item.status = "approved";
    item.updatedAt = at;
    delete item.sessionId;
    delete item.summary;
    delete item.needsYou;
    return item;
  }, now);
}

function set(c: Config, id: string, fields: Partial<QueueItem>, now = Date.now()): void {
  updateQueue(c, (q) => {
    const item = q.items.find((x) => x.id === id);
    if (item) Object.assign(item, fields, { updatedAt: new Date(now).toISOString() });
  }, now);
}

/** How every queued run starts: Leo isn't watching, and the hard limits in plain words. */
export const workRequest = (item: QueueItem) =>
  [
    "A task Leo approved from his Jarvis queue. He isn't watching: don't speak, ask or notify, just do it.",
    "If you need something only Leo can give (a decision, a login, access), stop there, say exactly what you need in your reply and set resolved to false.",
    "Hard limits: no money, nothing with real-life consequences (never submit or sign anything), and never contact anyone as Leo: emails and messages are drafts only, written for him to send himself.",
    "",
    item.request,
  ].join("\n");

type Runner = (c: Config, request: string, opts: RunOptions) => Promise<RunOutcome>;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Runs approved items one at a time until none are left. Returns a log line. */
export async function work(c: Config, opts: { run?: Runner } = {}): Promise<string> {
  const pidFile = join(paths(c).state, "queue-worker.pid");
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) return `the worker is already running (pid ${pid})`;
  } catch {}
  writeFileAtomic(pidFile, String(process.pid));
  const done: string[] = [];
  try {
    // Only one worker runs, so an item still "running" was cut off (a restart).
    updateQueue(c, (q) => {
      for (const x of q.items.filter((i) => i.status === "running"))
        Object.assign(x, { status: "failed", summary: "Stopped before it finished (the Mac restarted or Jarvis quit).", updatedAt: new Date().toISOString() });
    });
    for (;;) {
      const item = updateQueue(c, (q) => {
        const next = q.items.find((x) => x.status === "approved");
        if (next) Object.assign(next, { status: "running", updatedAt: new Date().toISOString() });
        return next;
      });
      if (!item) break;
      log(c, "queue: running", { id: item.id, title: item.title });
      const r = await (opts.run ?? realRun)(c, workRequest(item), {
        background: true,
        check: true,
        emit: (e) => {
          if (e.event === "state" && e.state === "working" && e.sessionId) set(c, item.id, { sessionId: e.sessionId });
        },
      }).catch((e): RunOutcome => ({ exitCode: 1, error: String(e) }));
      const failed = r.exitCode !== 0;
      set(c, item.id, {
        status: failed ? "failed" : "done",
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        summary: (failed ? r.error ?? r.summary : r.summary || r.reply)?.slice(0, 300) ?? "",
        ...(!failed && (r.resolved === false || r.denials?.length) ? { needsYou: true } : {}),
      });
      done.push(`${failed ? "failed" : "done"}: ${item.title}`);
    }
  } finally {
    rmSync(pidFile, { force: true });
  }
  return done.join("; ") || "nothing approved";
}

/** Wakes the worker agent; without it (schedules not installed), works here. */
export async function startWorker(c: Config, exec: Exec = realExec): Promise<string> {
  const r = exec([c.launchctl, "kickstart", `gui/${process.getuid?.() ?? 501}/${WORKER_LABEL}`]);
  if (r.code === 0) return "worker started";
  log(c, "queue: worker agent not loaded, working inline", { stderr: r.stderr.trim() });
  return work(c);
}

type Ask = Pick<NotchLink, "ask" | "close">;

/** The notch's quick "Approve / Not now" for new proposals, at most two. "Not now" leaves them in the queue. */
export async function offer(c: Config, items: QueueItem[], opts: { link?: Ask; exec?: Exec; now?: Date } = {}): Promise<string[]> {
  const out: string[] = [];
  if (!items.length) return out;
  const link = opts.link ?? new NotchLink({ home: c.home, client: "launcher", sessionId: null, connectTimeoutMs: 1000 });
  let approved = false;
  try {
    for (const [i, item] of items.slice(0, MAX_ASKS).entries()) {
      const question = `${item.why ? `${item.why.replace(/[.\s]+$/, "")}. ` : ""}I could ${item.title.charAt(0).toLowerCase()}${item.title.slice(1).replace(/[.\s]+$/, "")}.`;
      const a = await link.ask({ type: "ask", id: `queue-${(opts.now ?? new Date()).getTime()}-${i}`, question, options: ["Approve", "Not now"], timeout_ms: 10 * 60 * 1000, session_id: null });
      if (a === null) {
        out.push("notch app not open");
        break;
      }
      if (a !== "timeout" && /^approve\b|^(?:y|yes|yeah|sure|ok|okay|go ahead|do it)\b/i.test(a.text.trim()) && act(c, "approve", item.id)) {
        approved = true;
        out.push(`approved: ${item.title}`);
      } else out.push(`${a === "timeout" ? "no answer" : "not now"}: ${item.title}`);
    }
  } finally {
    link.close();
  }
  if (approved) out.push(await startWorker(c, opts.exec));
  return out;
}

/** The worker agent: every 30 minutes, and kicked on each approval. */
export function workerPlist(c: Config): string {
  return dailyPlist(c, WORKER_LABEL, ["queue", "work"], 0, 0, "queue-worker.log").replace(
    /\t<key>StartCalendarInterval<\/key>[\s\S]*?<\/dict>\n/,
    "\t<key>StartInterval</key>\n\t<integer>1800</integer>\n",
  );
}

export const installWorker = (c: Config, exec?: Exec) => installDaily(c, WORKER_LABEL, workerPlist(c), exec);
