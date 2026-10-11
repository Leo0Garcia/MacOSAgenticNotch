// `--demo`: cycles the notch through every state with canned content, using
// the same model calls the real pieces make. Used to check transitions and
// measure hitches (Instruments' Animation Hitches) without a mic or a run.

import Foundation

@MainActor
final class DemoDriver {
    private let model: AppModel
    private let launcher = DemoLauncher()
    private var task: Task<Void, Never>?

    init(model: AppModel) {
        self.model = model
        model.launcher = launcher
        model.voice = nil // no mic in the demo
        model.postNotification = nil // and no notification prompts
        model.speechModel = .ready
    }

    /// `--demo-working`: a run that stays in Working (for CPU measurement):
    /// expanded for the first 3 s, then the pill, with a new step every 2 s.
    func startWorking() {
        task = Task { [weak self] in
            guard let self else { return }
            self.model.submit("Start a research session on Southampton rents")
            var n = 0
            while !Task.isCancelled {
                n += 1
                await self.launcher.play(model: self.model, [(2, .status(text: "Reading source \(n)", detail: "example.com/\(n)"))])
            }
        }
    }

    func start() {
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.cycle()
            }
        }
    }

    private func wait(_ s: Double) async { try? await Task.sleep(for: .seconds(s)) }

    private func cycle() async {
        // Listening → Working → Done (weather).
        model.hotkeyDown()
        let words = "What's the weather in Southampton".split(separator: " ").map(String.init)
        for i in 1...words.count {
            await wait(0.3)
            model.updateTranscript(Transcript(confirmed: words.prefix(max(0, i - 1)).joined(separator: " "), hypothesis: words[i - 1]))
        }
        await wait(0.4)
        model.updateTranscript(Transcript(confirmed: words.joined(separator: " "), hypothesis: ""))
        model.listeningFinished(words.joined(separator: " "))
        await launcher.play(model: model, [
            (0.4, .state("working", sessionId: "11111111-2222-3333-4444-555555555555")),
            (0.5, .status(text: "Searching the web", detail: "southampton weather today")),
            (0.9, .status(text: "Reading BBC Weather", detail: "bbc.co.uk/weather/2637487")),
        ])
        speak("It's 14 degrees and cloudy in Southampton, with light rain from about 4pm.", id: "d1")
        await wait(3.6)
        model.speechEnded(id: "d1")
        await launcher.play(model: model, [
            (0.1, .done(sessionId: "11111111-2222-3333-4444-555555555555", keep: false, summary: "Weather in Southampton", reply: "", name: nil)),
            (0.1, .state("done", sessionId: nil)),
        ])
        launcher.exit(model: model, 0)
        await wait(4)

        // Long run: Working collapses to the pill, then Done saved.
        model.submit("Start a research session on Southampton rents")
        await launcher.play(model: model, [
            (0.3, .state("working", sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
            (0.6, .status(text: "Searching the web", detail: "southampton average rent 2026")),
            (1.2, .status(text: "Reading Zoopla", detail: "zoopla.co.uk/market/southampton")),
            (1.4, .status(text: "Reading Rightmove", detail: "rightmove.co.uk/house-prices/southampton")),
            (1.2, .status(text: "Writing the notes", detail: "Jarvis-Memory/Research/Southampton rents.md")),
        ])
        model.hoverChanged(true)
        await wait(1.5)
        model.hoverChanged(false)
        await wait(1)
        speak("I've started that. The first pass is in your vault under Southampton rents.", id: "d2")
        await launcher.play(model: model, [
            (0.2, .done(sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", keep: true, summary: "Research: Southampton rents", reply: "", name: "Jarvis: Research: Southampton rents")),
        ])
        launcher.exit(model: model, 0)
        await wait(3.6)
        model.speechEnded(id: "d2")
        await wait(7)

        // Needs you: a question, answered with a button.
        model.received(.ask(id: "q1", question: "Put “COMP2211 lab 4” in In-progress or Not Started?", options: ["In-progress", "Not Started"], timeoutMs: 60_000, sessionId: nil), from: -1)
        await wait(3)
        model.answerButton("In-progress")
        await wait(1.5)

        // Blocked by guard.
        model.submit("Pay my tuition fee")
        await launcher.play(model: model, [
            (0.8, .status(text: "Opening the fees portal", detail: "southampton.ac.uk/fees")),
            (0.6, .denied(tool: "mcp__claude-in-chrome__navigate", rule: "no-real-consequences", reason: "guard:no-real-consequences: tuition fee payment is for Leo to do himself. Safe alternative: a reminder to pay it at 6pm")),
        ])
        speak("I can't pay your tuition fee. That one's for you to do.", id: "d3")
        await wait(2.6)
        model.speechEnded(id: "d3")
        launcher.exit(model: model, 0)
        await wait(3)
        model.dismiss()
        await wait(1.5)

        // Reminder.
        model.received(.reminder(id: "r1", text: "Call Sue about the Amra brief"), from: -1)
        await wait(7)
        model.dismiss()
        await wait(2)
    }

    private func speak(_ text: String, id: String) {
        model.speechStarted(id: id, text: text)
    }
}

/// Stands in for the launcher in --demo: events are pushed by the script.
@MainActor
final class DemoLauncher: LauncherRunning {
    private var onEvent: ((LauncherEvent) -> Void)?
    private var exited: ((Int32) -> Void)?

    func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {
        self.onEvent = onEvent
        self.exited = exited
    }

    func play(model: AppModel, _ events: [(Double, LauncherEvent)]) async {
        for (delay, e) in events {
            try? await Task.sleep(for: .seconds(delay))
            onEvent?(e)
        }
    }

    func exit(model: AppModel, _ code: Int32) { exited?(code) }
    func open(sessionId: String) {}
    func cancelAll() {}
}
