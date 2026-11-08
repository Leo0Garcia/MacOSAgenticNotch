// Small talk and simple, timeless questions answered by Apple's on-device
// model (macOS 26+), without starting Claude (Leo, 2026-11-08). The launcher
// asks through the notch socket (`quick_answer`); nil means "send it to Claude".

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum QuickReplies {
    static let instructions = """
    You are Jarvis, Leo's assistant on his Mac, speaking out loud. Set canAnswer to true only for small talk \
    (greetings, how are you, thanks, jokes) and simple general knowledge that never changes (definitions, \
    capitals, basic maths, well-known facts). Set it to false for anything about the time, date, weather, \
    news, prices or anything recent; anything about Leo's files, notes, calendar, tasks, email, messages or \
    accounts; anything that needs a tool, the web or an action on his Mac; and anything you're not sure of. \
    The answer is one or two short spoken sentences, British English, warm and a little dry. No lists or markdown.
    """

    static func answer(_ text: String) async -> String? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard SystemLanguageModel.default.availability == .available else { return nil }
            do {
                let session = LanguageModelSession(instructions: instructions)
                let r = try await session.respond(to: text, generating: QuickReply.self)
                let a = r.content.answer.trimmingCharacters(in: .whitespacesAndNewlines)
                return r.content.canAnswer && !a.isEmpty ? a : nil
            } catch {
                AppLog.write("quick reply failed: \(error.localizedDescription)")
                return nil
            }
        }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
@Generable
struct QuickReply {
    @Guide(description: "true only if you can answer fully and correctly right now, without tools, current information or Leo's data")
    var canAnswer: Bool
    @Guide(description: "the spoken answer, one or two short sentences; empty when canAnswer is false")
    var answer: String
}
#endif
