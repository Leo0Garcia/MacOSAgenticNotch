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
        let sql = "SELECT id, ts, session_id, kind, summary, saved FROM actions ORDER BY id DESC LIMIT ?"
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
                saved: sqlite3_column_int(stmt, 5) != 0))
        }
        return out
    }
}
