// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with
// initialize, ping, tools/list, tools/call and notifications/cancelled.
// No SDK dependency, so a run never waits on `bun install`.

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

type Json = Record<string, unknown>;

export class ToolInputError extends Error {}

export class McpServer {
  private inflight = new Map<string | number, AbortController>();
  private pending = new Set<Promise<void>>();

  constructor(
    private info: ServerInfo,
    private tools: Tool[],
    private write: (line: string) => void,
    private log: (msg: string) => void = (m) => process.stderr.write(`[jarvis-bridge] ${m}\n`),
  ) {}

  /** Feed one line from stdin. Returns when the reply (if any) has been written. */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Json;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const p = this.dispatch(msg);
    this.pending.add(p);
    try {
      await p;
    } finally {
      this.pending.delete(p);
    }
  }

  /** Waits for every in-flight request to finish. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private send(obj: Json) {
    this.write(JSON.stringify(obj) + "\n");
  }

  private reply(id: unknown, result: Json) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: unknown, code: number, message: string) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private async dispatch(msg: Json): Promise<void> {
    const { id, method } = msg;
    const params = (msg.params ?? {}) as Json;
    const isRequest = id !== undefined && id !== null;
    if (typeof method !== "string") {
      if (isRequest) this.fail(id, -32600, "Invalid request");
      return; // a response to something we never send
    }

    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion =
          typeof asked === "string" && SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL;
        const result: Json = {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
        };
        if (this.info.instructions) result.instructions = this.info.instructions;
        return this.reply(id, result);
      }
      case "ping":
        return isRequest ? this.reply(id, {}) : undefined;
      case "tools/list":
        return this.reply(id, {
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call":
        return this.callTool(id as string | number, params);
      case "notifications/cancelled": {
        const target = params.requestId as string | number | undefined;
        if (target !== undefined) this.inflight.get(target)?.abort();
        return;
      }
      default:
        if (method.startsWith("notifications/")) return;
        if (isRequest) this.fail(id, -32601, `Method not found: ${method}`);
    }
  }

  private async callTool(id: string | number, params: Json) {
    const tool = this.tools.find((t) => t.name === params.name);
    if (!tool) return this.fail(id, -32602, `Unknown tool: ${String(params.name)}`);
    const args = (params.arguments ?? {}) as Json;
    const ctl = new AbortController();
    this.inflight.set(id, ctl);
    try {
      const r = await tool.handler(args, ctl.signal);
      if (ctl.signal.aborted) return; // cancelled requests get no response
      this.reply(id, { content: [{ type: "text", text: r.text }], isError: r.isError ?? false });
    } catch (err) {
      if (ctl.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ToolInputError)) this.log(`${tool.name} failed: ${message}`);
      this.reply(id, { content: [{ type: "text", text: message }], isError: true });
    } finally {
      this.inflight.delete(id);
    }
  }
}

/** Reads newline-delimited messages until the stream (stdin by default) closes. */
export async function serveStdio(server: McpServer, input: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<void> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handling: Promise<void>[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      // Requests run concurrently: an ask() must not block ping or speak.
      handling.push(server.handleLine(line));
    }
  }
  if (buf.trim()) handling.push(server.handleLine(buf));
  await Promise.allSettled(handling);
}

export function str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new ToolInputError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
  const t = v.trim();
  if (opts.required && !t) throw new ToolInputError(`${key} is required`);
  if (opts.max && t.length > opts.max) throw new ToolInputError(`${key} is longer than ${opts.max} characters`);
  return t;
}
