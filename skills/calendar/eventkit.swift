// Apple Calendar through EventKit: the fast path for apple.ts. AppleScript
// answers at about 12 ms per event per field, so a calendar with a few
// thousand events took minutes; EventKit answers a day in milliseconds and
// expands repeating events itself. Read only: it never saves or removes.
//
//   jarvis-calendar <from ISO> <to ISO>   → JSON array of events on stdout
//   exit 4: Calendars access denied or not yet granted (macOS asks once)
//
// apple.ts compiles this into ~/Jarvis/bin/jarvis-calendar with an embedded
// Info.plist (NSCalendarsFullAccessUsageDescription) the first time it runs.

import EventKit
import Foundation

struct Out: Encodable {
    var calendar: String
    var title: String
    var start: String
    var end: String
    var allDay: Bool
    var location: String?
    var recurrence: String? // always nil: EventKit returns each occurrence
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let plain = ISO8601DateFormatter()

func date(_ s: String) -> Date? { iso.date(from: s) ?? plain.date(from: s) }

let args = CommandLine.arguments
guard args.count == 3, let from = date(args[1]), let to = date(args[2]) else {
    FileHandle.standardError.write(Data("usage: jarvis-calendar <from ISO> <to ISO>\n".utf8))
    exit(64)
}

let store = EKEventStore()

func granted() -> Bool {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return true
    case .notDetermined:
        // First run: macOS shows its Calendars prompt once.
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        store.requestFullAccessToEvents { g, _ in
            ok = g
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 120)
        return ok
    default: return false
    }
}

guard granted() else {
    FileHandle.standardError.write(Data("Calendars access is off for Jarvis.\n".utf8))
    exit(4)
}

let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
let events = store.events(matching: predicate)
    .sorted { $0.startDate < $1.startDate }
    .map { e in
        Out(calendar: e.calendar?.title ?? "", title: e.title ?? "", start: iso.string(from: e.startDate),
            end: iso.string(from: e.endDate), allDay: e.isAllDay,
            location: (e.location?.isEmpty ?? true) ? nil : e.location, recurrence: nil)
    }
let data = try JSONEncoder().encode(events)
FileHandle.standardOutput.write(data)
