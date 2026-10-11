// Tool calls as plain status lines for the notch's Working panel
// (NOTCH-DESIGN section 2: tool names map to status lines in the launcher,
// not the app). Unknown tools show "Working".

export interface ToolStatus {
  text: string;
  detail?: string;
}

/** Tools that aren't steps Leo cares about: Jarvis's own plumbing. */
const QUIET = new Set(["StructuredOutput", "mcp__jarvis__speak", "mcp__jarvis__log", "mcp__jarvis__ask", "TodoWrite", "ToolSearch"]);

function host(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function urlDetail(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** "bbc.co.uk" → "BBC", "zoopla.co.uk" → "Zoopla": a readable site name. */
export function siteName(h: string): string {
  const parts = h.split(".");
  const label = parts.length > 2 && ["co", "com", "org", "ac", "gov", "net"].includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? h;
  if (!label) return h;
  return label.length <= 3 ? label.toUpperCase() : label[0].toUpperCase() + label.slice(1);
}

const base = (p: unknown) => (typeof p === "string" ? p.split("/").filter(Boolean).pop() ?? p : undefined);

export function toolStatus(name: string, input: Record<string, unknown> = {}): ToolStatus | null {
  if (QUIET.has(name)) return null;
  switch (name) {
    case "WebSearch":
      return { text: "Searching the web", detail: typeof input.query === "string" ? input.query : undefined };
    case "WebFetch": {
      const h = host(input.url);
      return { text: h ? `Reading ${siteName(h)}` : "Reading a page", detail: urlDetail(input.url) };
    }
    case "Bash":
      return { text: "Running a command", detail: typeof input.description === "string" ? input.description : undefined };
    case "Read":
      return { text: "Reading a file", detail: base(input.file_path) };
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { text: "Writing a file", detail: base(input.file_path) };
    case "Glob":
    case "Grep":
      return { text: "Searching files", detail: typeof input.pattern === "string" ? input.pattern : undefined };
    case "Skill":
      return { text: typeof input.skill === "string" ? `Using the ${input.skill} skill` : "Using a skill" };
    case "Task":
    case "Agent":
      return { text: "Starting a helper", detail: typeof input.description === "string" ? input.description : undefined };
    case "mcp__jarvis__remind":
      return { text: "Setting a reminder", detail: typeof input.when === "string" ? input.when : undefined };
    case "mcp__jarvis__notify":
      return { text: "Sending you a notification" };
  }
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (m) {
    const [, server, tool] = m;
    if (server === "claude-in-chrome") {
      if (tool === "navigate" || tool === "tabs_create_mcp") {
        const h = host(input.url);
        return { text: h ? `Opening ${siteName(h)}` : "Opening Chrome", detail: urlDetail(input.url) };
      }
      return { text: "Reading the page in Chrome" };
    }
    const pretty = server.replace(/^claude_ai_/, "").replace(/[-_]/g, " ");
    return { text: `Using ${pretty}`, detail: tool.replace(/_/g, " ") };
  }
  return { text: "Working" };
}
