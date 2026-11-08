// Plays Jarvis's rendered speech through one AVAudioEngine player node, so
// sentences follow each other with no afplay start-up gap (Leo, 2026-10-15).

import AVFoundation

@MainActor
final class SpeechPlayer {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?

    /// Only the bridge's own temp renders (jarvis-say-*.wav) are played.
    nonisolated static func allowed(_ path: String) -> Bool {
        let url = URL(fileURLWithPath: path)
        return url.pathExtension == "wav" && url.lastPathComponent.hasPrefix("jarvis-say-") && !path.contains("..")
    }

    /// Queues the file; `done` runs once it has played, or failed, or was stopped.
    func play(_ path: String, done: @escaping @MainActor () -> Void) {
        guard Self.allowed(path), let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return done() }
        do {
            if format != file.processingFormat {
                // A new format (first use, or a voice change): rewire once.
                if engine.isRunning { engine.stop() }
                if node.engine == nil { engine.attach(node) }
                engine.connect(node, to: engine.mainMixerNode, format: file.processingFormat)
                format = file.processingFormat
            }
            if !engine.isRunning { try engine.start() }
        } catch {
            AppLog.write("speech player couldn't start: \(error.localizedDescription)")
            return done()
        }
        node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in
            Task { @MainActor in done() }
        }
        if !node.isPlaying { node.play() }
    }

    /// Leo interrupted: stop now. Every queued file's `done` still runs.
    func stop() {
        node.stop()
    }
}
