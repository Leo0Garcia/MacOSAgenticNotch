// Reads the newest rows of ~/Jarvis/actions.sqlite (owned by the bridge,
// DESIGN 8.4) for the hover log. Read only, through the system SQLite.

import Foundation
import SQLite3

struct ActionItem: Equatable, Identifiable, Sendable {
    var id: Int
    var date: Date
    var sessionId: String?
    var kind: String
    var summary: String
    var saved: Bool
    /// What happened and where the time went, for requests (launcher/src/details.ts).
    var details: RunDetails? = nil
}

/// RunDetails v1, written by the launcher into the action row's `detail`.
struct RunDetails: Decodable, Equatable, Sendable {
    struct Step: Decodable, Equatable, Sendable {
        var label: String
        var detail: String?
        var atMs: Double
        var ms: Double?
        var error: Bool?
    }
    struct Slice: Decodable, Equatable, Sendable {
        var label: String
        var ms: Double
    }
    var v: Int
    var request: String
    var reply: String
    var route: String
    var model: String?
    var outcome: String
    var saved: Bool
    var totalMs: Double
    var breakdown: [Slice]
    var steps: [Step]
    var turns: Int?
    var costUsd: Double?
    var problem: String?

    /// Nil unless it's v1 JSON (older rows hold a plain-text detail).
    static func parse(_ text: String?) -> RunDetails? {
        guard let text, text.hasPrefix("{"), let d = try? JSONDecoder().decode(RunDetails.self, from: Data(text.utf8)), d.v == 1 else { return nil }
        return d
    }
}

enum ActionsStore {
    static func newest(_ limit: Int = 8, file: URL) -> [ActionItem] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        var db: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return []
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 500)
        var stmt: OpaquePointer?
        let sql = "SELECT id, ts, session_id, kind, summary, saved, detail FROM actions ORDER BY id DESC LIMIT ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        func text(_ i: Int32) -> String? {
            guard let c = sqlite3_column_text(stmt, i) else { return nil }
            return String(cString: c)
        }
        var out: [ActionItem] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let ts = text(1) ?? ""
            out.append(ActionItem(
                id: Int(sqlite3_column_int64(stmt, 0)),
                date: iso.date(from: ts) ?? plain.date(from: ts) ?? Date(),
                sessionId: text(2),
                kind: text(3) ?? "",
                summary: text(4) ?? "",
                saved: sqlite3_column_int(stmt, 5) != 0,
                details: RunDetails.parse(text(6))))
        }
        return out
    }
}
