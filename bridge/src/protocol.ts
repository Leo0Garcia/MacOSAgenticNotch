// The notch WebSocket protocol, version 1. docs/DESIGN.md section 8.2 is the
// written spec; keep the two in step. The app hosts the socket; the bridge,
// launcher and reminder firings are clients.

export const PROTOCOL_VERSION = 1;

/** ~/Jarvis/notch.json, written by the app (mode 0600) when its socket is listening. */
export interface NotchFile {
  port: number;
  token: string;
  pid: number;
  protocol: number;
}

export type ClientKind = "bridge" | "launcher" | "reminder" | "cli";

// Client -> app
export interface Hello {
  type: "hello";
  protocol: number;
  token: string;
  client: ClientKind;
  pid: number;
  session_id: string | null;
}
export interface SpeakStart {
  type: "speak_start";
  id: string;
  text: string;
  session_id: string | null;
}
export interface SpeakEnd {
  type: "speak_end";
  id: string;
}
export interface Notify {
  type: "notify";
  id: string;
  title: string;
  body: string;
  session_id: string | null;
}
export interface Ask {
  type: "ask";
  id: string;
  question: string;
  options: string[];
  timeout_ms: number;
  session_id: string | null;
}
export interface AskCancel {
  type: "ask_cancel";
  id: string;
  reason: "timeout" | "cancelled";
}
export interface Reminder {
  type: "reminder";
  id: string;
  text: string;
}
export interface LogRow {
  type: "log";
  row: ActionRow;
}
export interface RunEvent {
  type: "run_event";
  session_id: string | null;
  event: "started" | "tool" | "speaking" | "done" | "denied" | "failed";
  text?: string;
  keep?: boolean;
  summary?: string;
  rule?: string;
}
/** The calendar skill asks the app (which holds the Calendars permission) for events. */
export interface CalendarEvents {
  type: "calendar_events";
  id: string;
  from: string; // ISO 8601
  to: string;
}
export type ClientMessage = Hello | SpeakStart | SpeakEnd | Notify | Ask | AskCancel | Reminder | LogRow | RunEvent | CalendarEvents;

// App -> client
export interface Welcome {
  type: "welcome";
  protocol: number;
}
export interface Answer {
  type: "answer";
  id: string;
  text: string;
  via: "button" | "voice" | "dismissed";
}
export interface ErrorMsg {
  type: "error";
  id?: string;
  message: string;
}
export interface CalendarEventsResult {
  type: "calendar_events_result";
  id: string;
  events?: { calendar: string; title: string; start: string; end: string; allDay: boolean; location: string | null; recurrence: null }[];
  error?: { code: "denied" | "bad_range"; message: string };
}
export type AppMessage = Welcome | Answer | ErrorMsg | CalendarEventsResult;

/** One row of ~/Jarvis/actions.sqlite, as stored and as sent in `log`. */
export interface ActionRow {
  id: number;
  ts: string;
  session_id: string | null;
  kind: ActionKind;
  summary: string;
  detail: string | null;
  saved: boolean;
}
export const ACTION_KINDS = ["run", "action", "note", "guard", "reminder"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
