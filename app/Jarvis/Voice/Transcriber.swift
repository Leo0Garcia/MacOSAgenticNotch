// On-device transcription with WhisperKit. Models live in ~/Jarvis/models
// (self-contained, DESIGN section 2); the first launch downloads one.

import Foundation
@preconcurrency import WhisperKit

protocol SpeechTranscribing: Sendable {
    /// Loads (downloading if needed) the model. Progress text goes to `status`.
    func prepare(status: @escaping @Sendable (String) -> Void) async throws
    /// Transcribes 16 kHz mono samples.
    func transcribe(_ samples: [Float]) async throws -> String
}

actor WhisperTranscriber: SpeechTranscribing {
    /// small.en: accurate enough for place names ("Southampton") and fast on an M4.
    static let defaultModel = "openai_whisper-small.en"

    private let modelName: String
    private let downloadBase: URL
    private var whisper: WhisperBox?
    private var loading: Task<WhisperBox, Error>?

    init(model: String? = nil, downloadBase: URL) {
        self.modelName = model ?? UserDefaults.standard.string(forKey: "WhisperModel") ?? Self.defaultModel
        self.downloadBase = downloadBase
    }

    func prepare(status: @escaping @Sendable (String) -> Void) async throws {
        _ = try await load(status: status)
    }

    private func load(status: @escaping @Sendable (String) -> Void) async throws -> WhisperBox {
        if let whisper { return whisper }
        if let loading { return try await loading.value }
        let name = modelName
        let base = downloadBase
        let task = Task { () throws -> WhisperBox in
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            let local = Self.localModelFolder(base: base, model: name)
            status(local == nil ? "Downloading the speech model" : "Loading the speech model")
            let config = WhisperKitConfig(
                model: name,
                downloadBase: base,
                modelFolder: local?.path,
                verbose: false,
                logLevel: .error,
                prewarm: true,
                load: true,
                download: local == nil)
            return WhisperBox(try await WhisperKit(config))
        }
        loading = task
        do {
            let w = try await task.value
            whisper = w
            loading = nil
            return w
        } catch {
            loading = nil
            throw error
        }
    }

    /// A model already downloaded under ~/Jarvis/models, so launch works offline.
    static func localModelFolder(base: URL, model: String) -> URL? {
        let fm = FileManager.default
        guard let e = fm.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return nil }
        for case let url as URL in e where url.lastPathComponent == model {
            if fm.fileExists(atPath: url.appendingPathComponent("AudioEncoder.mlmodelc").path) { return url }
        }
        return nil
    }

    func transcribe(_ samples: [Float]) async throws -> String {
        let w = try await load(status: { _ in })
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: "en",
            temperature: 0,
            temperatureFallbackCount: 2,
            usePrefillPrompt: true,
            skipSpecialTokens: true,
            withoutTimestamps: true,
            suppressBlank: true,
            noSpeechThreshold: 0.6)
        let results = try await w.kit.transcribe(audioArray: samples, decodeOptions: options)
        return Self.clean(results.map(\.text).joined(separator: " "))
    }

    /// Drops Whisper's non-speech markers and stock hallucinations on silence.
    static func clean(_ text: String) -> String {
        var t = text.replacingOccurrences(of: #"\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>"#, with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        let stock: Set<String> = ["thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.", "."]
        if stock.contains(t.lowercased()) { return "" }
        return t
    }
}

/// WhisperKit isn't Sendable; it is only ever used from inside the actor.
final class WhisperBox: @unchecked Sendable {
    let kit: WhisperKit
    init(_ kit: WhisperKit) { self.kit = kit }
}
