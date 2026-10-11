// Microphone capture for push-to-talk: AVAudioEngine input tap, resampled to
// 16 kHz mono Float for Whisper, plus a smoothed RMS level for the mic bars.
// Runs only between hotkey down and up, so the mic indicator is never on idle.

import AVFoundation
import Synchronization

/// The live mic level, read every frame by the bars' Canvas without going
/// through SwiftUI observation (section 3: no per-frame view rebuilds).
final class AudioLevel: Sendable {
    private let value = Mutex<Float>(0)
    func set(_ v: Float) { value.withLock { $0 = v } }
    var current: Float { value.withLock { $0 } }
}

/// Samples captured so far, appended on the audio thread.
final class SampleBuffer: Sendable {
    private let samples = Mutex<[Float]>([])
    func append(_ s: [Float]) { samples.withLock { $0.append(contentsOf: s) } }
    func snapshot() -> [Float] { samples.withLock { $0 } }
    func reset() { samples.withLock { $0.removeAll(keepingCapacity: true) } }
    var count: Int { samples.withLock { $0.count } }
}

enum AudioCaptureError: LocalizedError {
    case micDenied
    case noInput
    case converter

    var errorDescription: String? {
        switch self {
        case .micDenied: "Jarvis can't hear you: microphone access is off. Turn it on in System Settings → Privacy & Security → Microphone."
        case .noInput: "No microphone is available."
        case .converter: "Couldn't set up audio conversion for the microphone."
        }
    }
}

@MainActor
final class AudioCapture {
    static let sampleRate: Double = 16_000

    let level = AudioLevel()
    let buffer = SampleBuffer()
    private let engine = AVAudioEngine()
    private var running = false

    var isRunning: Bool { running }

    static var permission: AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .audio) }

    /// Asks for mic access (shows the macOS prompt the first time).
    static func requestPermission() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    func start() throws {
        guard !running else { return }
        switch Self.permission {
        case .denied, .restricted: throw AudioCaptureError.micDenied
        default: break
        }
        buffer.reset()
        level.set(0)
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { throw AudioCaptureError.noInput }
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inFormat, to: outFormat)
        else { throw AudioCaptureError.converter }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat, block: Self.makeTap(converter: converter, outFormat: outFormat, buffer: buffer, level: level))
        engine.prepare()
        try engine.start()
        running = true
    }

    /// Stops capture and returns everything captured.
    func stop() -> [Float] {
        guard running else { return buffer.snapshot() }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        level.set(0)
        return buffer.snapshot()
    }

    /// Built outside the main actor so the tap closure isn't main-actor isolated.
    nonisolated private static func makeTap(converter: AVAudioConverter, outFormat: AVAudioFormat, buffer: SampleBuffer, level: AudioLevel) -> AVAudioNodeTapBlock {
        let conv = UncheckedBox(converter)
        let smoothed = Mutex<Float>(0)
        return { pcm, _ in
            // RMS of the first channel for the bars, smoothed 0.25 per buffer.
            if let ch = pcm.floatChannelData?[0] {
                let n = Int(pcm.frameLength)
                var sum: Float = 0
                for i in 0..<n { sum += ch[i] * ch[i] }
                let rms = n > 0 ? (sum / Float(n)).squareRoot() : 0
                // Speech RMS is roughly 0.01–0.2; map to 0…1 on a log-ish curve.
                let target = min(1, max(0, (20 * log10(max(rms, 1e-5)) + 55) / 40))
                let v = smoothed.withLock { s -> Float in
                    s += (target - s) * 0.25
                    return s
                }
                level.set(v)
            }
            let ratio = outFormat.sampleRate / pcm.format.sampleRate
            let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio + 32)
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
            let fed = FlagBox()
            var err: NSError?
            conv.value.convert(to: out, error: &err) { _, status in
                if fed.set {
                    status.pointee = .noDataNow
                    return nil
                }
                fed.set = true
                status.pointee = .haveData
                return pcm
            }
            if err == nil, let ch = out.floatChannelData?[0], out.frameLength > 0 {
                buffer.append(Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength))))
            }
        }
    }
}

/// The converter is only touched from the audio tap's serial thread.
final class UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ v: T) { value = v }
}
