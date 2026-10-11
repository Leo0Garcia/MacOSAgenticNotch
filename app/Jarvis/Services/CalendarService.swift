// Calendar reads for the calendar skill, answered by the app over the notch
// socket (`calendar_events`). The app is the one process macOS can grant
// Calendars access to under a clear name ("Jarvis"); a helper started from a
// Claude Code run has no app of its own to ask on behalf of, and macOS
// refused it. Read only: never saves or removes events.

import EventKit
import Foundation

@MainActor
final class CalendarService {
    private let store = EKEventStore()

    enum Failure: Error {
        case denied
        case badRange
    }

    func events(fromISO: String, toISO: String) async -> Result<[NotchProtocol.CalendarEvent], Failure> {
        guard let from = Self.date(fromISO), let to = Self.date(toISO), from < to else { return .failure(.badRange) }
        guard await authorized() else { return .failure(.denied) }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let list = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .map { e in
                NotchProtocol.CalendarEvent(
                    calendar: e.calendar?.title ?? "", title: e.title ?? "", start: iso.string(from: e.startDate),
                    end: iso.string(from: e.endDate), allDay: e.isAllDay,
                    location: (e.location?.isEmpty ?? true) ? nil : e.location)
            }
        return .success(list)
    }

    private func authorized() async -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return true
        case .notDetermined:
            // macOS shows "Jarvis would like full access to your calendar" once.
            let ok = (try? await store.requestFullAccessToEvents()) ?? false
            AppLog.write("calendar access \(ok ? "granted" : "not granted")")
            return ok
        default: return false
        }
    }

    nonisolated static func date(_ s: String) -> Date? {
        let a = ISO8601DateFormatter()
        a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return a.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}
