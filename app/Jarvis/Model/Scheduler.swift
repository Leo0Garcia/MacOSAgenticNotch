// Timers for the state model, behind a protocol so tests can drive time.

import Foundation

@MainActor
final class Scheduled {
    private let onCancel: () -> Void
    private(set) var cancelled = false
    init(onCancel: @escaping () -> Void) { self.onCancel = onCancel }
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        onCancel()
    }
}

@MainActor
protocol Scheduling: AnyObject {
    /// Seconds on a monotonic clock.
    var now: Double { get }
    @discardableResult
    func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> Scheduled
}

@MainActor
final class LiveScheduler: Scheduling {
    var now: Double { ProcessInfo.processInfo.systemUptime }

    func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> Scheduled {
        let task = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            action()
        }
        return Scheduled { task.cancel() }
    }
}
