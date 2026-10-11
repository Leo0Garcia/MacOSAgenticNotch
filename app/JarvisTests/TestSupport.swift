import Foundation
@testable import Jarvis

/// Time only moves when a test says so.
@MainActor
final class TestScheduler: Scheduling {
    var now: Double = 1000
    private var pending: [(at: Double, id: Int, action: @MainActor () -> Void, handle: Scheduled)] = []
    private var nextID = 0

    func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> Scheduled {
        nextID += 1
        let id = nextID
        let handle = Scheduled { [weak self] in self?.pending.removeAll { $0.id == id } }
        pending.append((now + seconds, id, action, handle))
        return handle
    }

    /// Advances the clock, firing due timers in order (including ones they schedule).
    func advance(_ seconds: Double) {
        let end = now + seconds
        while let next = pending.filter({ $0.at <= end }).min(by: { ($0.at, $0.id) < ($1.at, $1.id) }) {
            pending.removeAll { $0.id == next.id }
            now = next.at
            next.action()
        }
        now = end
    }
}

@MainActor
final class FakeLauncher: LauncherRunning {
    var requests: [String] = []
    var opened: [String] = []
    private var handlers: [(event: @MainActor (LauncherEvent) -> Void, exited: @MainActor (Int32) -> Void)] = []

    func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {
        requests.append(request)
        handlers.append((onEvent, exited))
    }
    func emit(_ e: LauncherEvent, run: Int? = nil) { handlers[run ?? handlers.count - 1].event(e) }
    func exit(_ code: Int32 = 0, run: Int? = nil) { handlers[run ?? handlers.count - 1].exited(code) }
    func open(sessionId: String) { opened.append(sessionId) }
    func cancelAll() {}
}

@MainActor
final class FakeVoice: VoiceInput {
    var result = ""
    var started = 0
    var failWith: Error?
    func start() throws {
        if let failWith { throw failWith }
        started += 1
    }
    func finish() async -> String { result }
    func cancel() {}
}

@MainActor
func makeModel() -> (AppModel, TestScheduler, FakeLauncher, FakeVoice) {
    let s = TestScheduler()
    let m = AppModel(scheduler: s)
    let l = FakeLauncher()
    let v = FakeVoice()
    m.launcher = l
    m.voice = v
    m.speechModel = .ready
    return (m, s, l, v)
}
