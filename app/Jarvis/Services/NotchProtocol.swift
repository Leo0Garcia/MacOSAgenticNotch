// The notch WebSocket protocol, version 1: the Swift side of
// bridge/src/protocol.ts. docs/DESIGN.md section 8.2 is the written spec;
// keep all three in step. The app hosts the socket; the bridge, launcher and
// reminder firings are clients.

import Foundation

enum NotchProtocol {
    static let version = 1

    /// ~/Jarvis/notch.json, written (mode 0600) once the socket is listening.
    struct File: Codable, Equatable {
        var port: Int
        var token: String
        var pid: Int32
        var `protocol`: Int
    }

    enum ClientKind: String, Codable {
        case bridge, launcher, reminder, cli
    }

    struct ActionRow: Codable, Equatable, Sendable {
        var id: Int
        var ts: String
        var session_id: String?
        var kind: String
        var summary: String
        var detail: String?
        var saved: Bool
    }

    /// Client to app. Unknown types decode as `.unknown` and are ignored.
    enum ClientMessage: Equatable, Sendable {
        case hello(protocol: Int, token: String, client: ClientKind, pid: Int32?, sessionId: String?)
        case speakStart(id: String, text: String, sessionId: String?, opener: Bool = false)
        case speakEnd(id: String)
        case notify(id: String, title: String, body: String, sessionId: String?)
        case ask(id: String, question: String, options: [String], timeoutMs: Int, sessionId: String?)
        case askCancel(id: String, reason: String)
        case reminder(id: String, text: String)
        case log(ActionRow)
        case runEvent(sessionId: String?, event: String, text: String?, keep: Bool?, summary: String?, rule: String?)
        /// The calendar skill asks the app (which holds the Calendars permission) for events.
        case calendarEvents(id: String, from: String, to: String)
        case unknown(type: String)
    }

    /// App to client.
    enum AppMessage: Equatable, Sendable {
        case welcome
        case answer(id: String, text: String, via: AnswerVia)
        case error(id: String?, message: String)
        case calendarEventsResult(id: String, events: [CalendarEvent])
        case calendarEventsError(id: String, code: String, message: String)
    }

    /// One calendar occurrence, in the shape the calendar skill's apple.ts reads.
    struct CalendarEvent: Equatable, Sendable {
        var calendar: String
        var title: String
        var start: String
        var end: String
        var allDay: Bool
        var location: String?
    }

    enum AnswerVia: String, Codable, Sendable {
        case button, voice, dismissed
    }

    enum DecodeError: Error, Equatable {
        case notJSON
        case missingType
        case missingField(String)
    }

    static func decode(_ text: String) throws -> ClientMessage {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw DecodeError.notJSON }
        guard let type = obj["type"] as? String else { throw DecodeError.missingType }

        func str(_ k: String) throws -> String {
            guard let v = obj[k] as? String else { throw DecodeError.missingField(k) }
            return v
        }
        func optStr(_ k: String) -> String? { obj[k] as? String }
        func int(_ k: String) throws -> Int {
            guard let v = obj[k] as? NSNumber else { throw DecodeError.missingField(k) }
            return v.intValue
        }

        switch type {
        case "hello":
            guard let client = ClientKind(rawValue: try str("client")) else { throw DecodeError.missingField("client") }
            return .hello(
                protocol: try int("protocol"), token: try str("token"), client: client,
                pid: (obj["pid"] as? NSNumber)?.int32Value, sessionId: optStr("session_id"))
        case "speak_start":
            return .speakStart(id: try str("id"), text: try str("text"), sessionId: optStr("session_id"), opener: obj["opener"] as? Bool ?? false)
        case "speak_end":
            return .speakEnd(id: try str("id"))
        case "notify":
            return .notify(id: try str("id"), title: try str("title"), body: try str("body"), sessionId: optStr("session_id"))
        case "ask":
            let options = (obj["options"] as? [String]) ?? []
            return .ask(
                id: try str("id"), question: try str("question"), options: Array(options.prefix(2)),
                timeoutMs: (obj["timeout_ms"] as? NSNumber)?.intValue ?? 120_000, sessionId: optStr("session_id"))
        case "ask_cancel":
            return .askCancel(id: try str("id"), reason: optStr("reason") ?? "cancelled")
        case "reminder":
            return .reminder(id: try str("id"), text: try str("text"))
        case "log":
            guard let row = obj["row"],
                  let rowData = try? JSONSerialization.data(withJSONObject: row),
                  let decoded = try? JSONDecoder().decode(ActionRow.self, from: rowData)
            else { throw DecodeError.missingField("row") }
            return .log(decoded)
        case "run_event":
            return .runEvent(
                sessionId: optStr("session_id"), event: try str("event"), text: optStr("text"),
                keep: obj["keep"] as? Bool, summary: optStr("summary"), rule: optStr("rule"))
        case "calendar_events":
            return .calendarEvents(id: try str("id"), from: try str("from"), to: try str("to"))
        default:
            return .unknown(type: type)
        }
    }

    static func encode(_ msg: AppMessage) -> String {
        var obj: [String: Any]
        switch msg {
        case .welcome:
            obj = ["type": "welcome", "protocol": version]
        case let .answer(id, text, via):
            obj = ["type": "answer", "id": id, "text": text, "via": via.rawValue]
        case let .error(id, message):
            obj = ["type": "error", "message": message]
            if let id { obj["id"] = id }
        case let .calendarEventsResult(id, events):
            obj = ["type": "calendar_events_result", "id": id, "events": events.map { e -> [String: Any] in
                ["calendar": e.calendar, "title": e.title, "start": e.start, "end": e.end, "allDay": e.allDay,
                 "location": e.location ?? NSNull(), "recurrence": NSNull()]
            }]
        case let .calendarEventsError(id, code, message):
            obj = ["type": "calendar_events_result", "id": id, "error": ["code": code, "message": message]]
        }
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
