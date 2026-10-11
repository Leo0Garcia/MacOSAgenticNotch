// Wires the pieces together at launch: notch socket, launcher, hotkey, voice
// pipeline, notch controller.
//
// Launch arguments (for testing without the mic):
//   --request "<text>"     send a typed request as if spoken
//   --audio-file <path>    play an audio file through transcription as if spoken
//   --demo                 cycle through every state with canned content
//   --snapshots <dir>      render each state to PNG and quit

import AppKit
import AVFoundation
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let paths = Paths.current()
    lazy var model = AppModel(scheduler: LiveScheduler())
    private(set) var env: NotchEnvironment!
    private var controller: NotchController?
    private var server: NotchServer?
    private var launcher: Launcher?
    private var hotkeys: HotKeyCenter?
    private var escapeID: UInt32?
    private var voice: VoicePipeline?
    private let notifier = SystemNotifier()
    private let calendar = CalendarService()
    private var notificationsRequested = false
    private var demo: DemoDriver?
    private var signalSources: [DispatchSourceSignal] = []

    static var isUnitTesting: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !Self.isUnitTesting else { return }
        if let i = CommandLine.arguments.firstIndex(of: "--snapshots"), i + 1 < CommandLine.arguments.count {
            Snapshots.render(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
            exit(0)
        }
        AppLog.configure(paths)
        AppLog.write("Jarvis app starting (repo \(paths.repo.path))")

        let capture = AudioCapture()
        env = NotchEnvironment(level: capture.level)

        let launcher = Launcher(paths: paths)
        self.launcher = launcher
        model.launcher = launcher
        env.snooze = { text, minutes in launcher.snooze(text: text, minutes: minutes) }
        model.postNotification = { [weak self] title, body in self?.notify(title: title, body: body) }
        model.announce = { [weak self] text in self?.notifier.announce(text) }
        let actions = paths.home.appendingPathComponent("actions.sqlite")
        model.loadRecent = { ActionsStore.newest(8, file: actions) }

        let voice = VoicePipeline(capture: capture, transcriber: WhisperTranscriber(downloadBase: paths.models), model: model)
        self.voice = voice
        model.voice = voice

        // SIGTERM/SIGINT (launchd, kill) still go through terminate, so notch.json is removed.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
        controller = NotchController(model: model, env: env)
        Snapshots.warmUp(env: env)
        startServer()
        registerHotkeys()

        let args = CommandLine.arguments
        if args.contains("--demo") || args.contains("--demo-working") {
            demo = DemoDriver(model: model)
            if args.contains("--demo-working") { demo?.startWorking() } else { demo?.start() }
            return
        }
        voice.prepare()
        if let i = args.firstIndex(of: "--request"), i + 1 < args.count {
            let request = args[i + 1]
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                self.model.submit(request)
            }
        }
        if let i = args.firstIndex(of: "--audio-file"), i + 1 < args.count {
            let url = URL(fileURLWithPath: args[i + 1])
            Task { @MainActor in
                // Wait for the model so the simulated press behaves like a real one.
                while case .loading = self.model.speechModel { try? await Task.sleep(for: .milliseconds(200)) }
                try? await Task.sleep(for: .seconds(0.5))
                await voice.simulate(file: url)
            }
        }
        observeEscape()
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
        launcher?.cancelAll()
    }

    private func startServer() {
        let server = NotchServer(notchFile: paths.notchFile)
        server.delegate = self
        self.server = server
        model.sendToClient = { [weak server] id, msg in server?.send(msg, to: id) }
        Task {
            do {
                _ = try await server.start()
            } catch {
                AppLog.write("notch socket failed: \(error.localizedDescription)")
            }
        }
    }

    private func registerHotkeys() {
        let hk = HotKeyCenter()
        hotkeys = hk
        let ok = hk.register(.optionSpace, onPress: { [weak self] in self?.pushToTalkDown() }, onRelease: { [weak self] in self?.model.hotkeyUp() })
        env.hotkeyLabel = HotKeyCenter.Combo.optionSpace.label
        if ok == nil {
            AppLog.write("⌥ Space is taken by another app")
            model.postNotification?("Jarvis", "⌥ Space is already used by another app, so push-to-talk is off.")
        }
    }

    private func pushToTalkDown() {
        // First press: macOS asks for the mic. Leo triggers this himself.
        if AudioCapture.permission == .notDetermined {
            Task {
                let granted = await AudioCapture.requestPermission()
                AppLog.write("microphone \(granted ? "allowed" : "denied")")
            }
            model.hotkeyDown() // shows the listening panel with the problem text
            return
        }
        model.hotkeyDown()
    }

    /// Esc is registered only while a dismissable panel is expanded.
    private func observeEscape() {
        withObservationTracking {
            _ = model.size
            _ = model.panel
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateEscape()
                self.observeEscape()
            }
        }
    }

    private func updateEscape() {
        let want = model.size == .expanded && model.panel != .listening && model.panel != .idle
        if want, escapeID == nil {
            escapeID = hotkeys?.register(.escape, onPress: { [weak self] in
                guard let self else { return }
                switch self.model.panel {
                case .access, .blocked, .reminder, .notice: self.model.dismiss()
                default: self.model.collapseOrHide()
                }
            })
        } else if !want, let id = escapeID {
            hotkeys?.unregister(id)
            escapeID = nil
        }
    }

    private func notify(title: String, body: String) {
        if !notificationsRequested {
            notificationsRequested = true
            notifier.requestAuthorization()
        }
        notifier.post(title: title, body: body)
    }
}

extension AppDelegate: NotchServerDelegate {
    func notchServer(_ server: NotchServer, received message: NotchProtocol.ClientMessage, from client: NotchServer.ClientID) {
        if case let .calendarEvents(id, from, to) = message {
            Task {
                switch await calendar.events(fromISO: from, toISO: to) {
                case let .success(events): server.send(.calendarEventsResult(id: id, events: events), to: client)
                case .failure(.denied): server.send(.calendarEventsError(id: id, code: "denied", message: "Calendars access is off for Jarvis."), to: client)
                case .failure(.badRange): server.send(.calendarEventsError(id: id, code: "bad_range", message: "from and to must be ISO 8601, from before to."), to: client)
                }
            }
            return
        }
        model.received(message, from: client)
    }

    func notchServer(_ server: NotchServer, disconnected client: NotchServer.ClientID) {
        model.clientDisconnected(client)
    }
}
