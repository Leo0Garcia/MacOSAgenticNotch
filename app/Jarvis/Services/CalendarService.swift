// Calendar reads for the calendar skill, answered by the app over the notch
// socket (`calendar_events`). The app is the one process macOS can grant
// Calendars access to under a clear name ("Jarvis"); a helper started from a
// Claude Code run has no app of its own to ask on behalf of, and macOS
// refused it. Writes are add only (`calendar_add`): it never edits or removes events.

import EventKit
import Foundation

@MainActor
final class CalendarService {
    private let store = EKEventStore()

    enum Failure: Error, Equatable {
        case denied
        case badRange
        case noCalendar(String)
        case badRepeat
        case saveFailed(String)

        var code: String {
            switch self {
            case .denied: "denied"
            case .badRange: "bad_range"
            case .noCalendar: "no_calendar"
            case .badRepeat: "bad_repeat"
            case .saveFailed: "save_failed"
            }
        }

        var message: String {
            switch self {
            case .denied: "Calendars access is off for Jarvis."
            case .badRange: "start and end must be ISO 8601, start before end."
            case let .noCalendar(name): "There's no writable calendar called \(name)."
            case .badRepeat: "repeat must be daily, weekly, monthly or yearly, and until ISO 8601."
            case let .saveFailed(why): "Calendar didn't save the event: \(why)"
            }
        }
    }

    func add(_ new: NotchProtocol.NewCalendarEvent) async -> Result<String, Failure> {
        guard let start = Self.date(new.start), let end = Self.date(new.end), start < end else { return .failure(.badRange) }
        let rule: EKRecurrenceRule?
        switch Self.recurrence(new.repeat, until: new.until) {
        case let .success(r): rule = r
        case let .failure(f): return .failure(f)
        }
        guard await authorized() else { return .failure(.denied) }
        let target: EKCalendar?
        if let name = new.calendar {
            target = store.calendars(for: .event).first { $0.title.caseInsensitiveCompare(name) == .orderedSame && $0.allowsContentModifications }
            if target == nil { return .failure(.noCalendar(name)) }
        } else {
            target = store.defaultCalendarForNewEvents
            if target == nil { return .failure(.noCalendar("(default)")) }
        }
        let e = EKEvent(eventStore: store)
        e.title = new.title
        e.startDate = start
        e.endDate = end
        e.isAllDay = new.allDay
        e.location = new.location
        e.calendar = target
        if let rule { e.addRecurrenceRule(rule) }
        do {
            try store.save(e, span: .futureEvents, commit: true)
        } catch {
            return .failure(.saveFailed(error.localizedDescription))
        }
        AppLog.write("calendar added \"\(new.title)\" to \(target!.title)")
        return .success(target!.title)
    }

    /// nil repeat → no rule. The rule repeats on the start's weekday / day of month.
    nonisolated static func recurrence(_ frequency: String?, until: String?) -> Result<EKRecurrenceRule?, Failure> {
        guard let frequency else { return until == nil ? .success(nil) : .failure(.badRepeat) }
        let freq: EKRecurrenceFrequency
        switch frequency.lowercased() {
        case "daily": freq = .daily
        case "weekly": freq = .weekly
        case "monthly": freq = .monthly
        case "yearly": freq = .yearly
        default: return .failure(.badRepeat)
        }
        var end: EKRecurrenceEnd?
        if let until {
            guard let d = date(until) else { return .failure(.badRepeat) }
            end = EKRecurrenceEnd(end: d)
        }
        return .success(EKRecurrenceRule(recurrenceWith: freq, interval: 1, end: end))
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
