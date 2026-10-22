// The Large layout body and the 289 × 32 pill (NOTCH-DESIGN sections 1–2, 6).

import SwiftUI

/// Values the views need that don't belong in the model.
@MainActor
final class NotchEnvironment {
    var notchSize = CGSize(width: 185, height: 32)
    /// Height of the expanded body as laid out, so the controller knows the
    /// visible shape (everything outside it lets clicks through).
    var expandedBodyHeight: CGFloat = 0
    let level: AudioLevel
    var hotkeyLabel = "⌥ Space"
    var snooze: (String, Int) -> Void = { _, _ in }
    init(level: AudioLevel) { self.level = level }
}

struct ExpandedView: View {
    let model: AppModel
    let env: NotchEnvironment
    @Namespace private var ns
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var stableHeight: CGFloat?

    private var panel: Panel { model.panel == .idle ? model.lastPanel : model.panel }
    private var visible: Bool { model.size == .expanded }
    private var secondary: Double { contrast == .increased ? 0.75 : 0.6 }
    private var dimWords: Double { contrast == .increased ? 0.6 : 0.45 }

    var body: some View {
        let notchH = env.notchSize.height
        content
            .padding(Theme.bodyPadding)
            .frame(width: Theme.contentWidth, alignment: .topLeading)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { h in
                // Section 3: the height animates only for changes of 4 pt or more.
                if let s = stableHeight, abs(s - h) < 4 { return }
                stableHeight = h
            }
            .frame(height: stableHeight.map { min($0, Theme.maxHeight - notchH - Theme.dnkInset) }, alignment: .top)
            .clipped()
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { env.expandedBodyHeight = $0 }
            .overlay(alignment: .top) { strip.frame(height: notchH).offset(y: -notchH) }
            .background {
                AuroraRim(kind: panel.kind, topRadius: Theme.topRadius, bottomRadius: Theme.bottomRadius, visible: visible)
                    .padding(EdgeInsets(top: -notchH, leading: -(Theme.dnkInset + Theme.topRadius), bottom: -Theme.dnkInset,
                                        trailing: -(Theme.dnkInset + Theme.topRadius)))
            }
            .animation(MotionToken.spring(model.motion, reduceMotion: reduceMotion), value: model.layoutRevision)
            .onContinuousHover { phase in
                if case .active = phase { model.userActivity() }
            }
    }

    // MARK: - Strip beside the hardware notch

    private var strip: some View {
        HStack(spacing: 0) {
            Text(Theme.stateName(panel.kind, saved: panel == .done && model.run?.savedLabel != nil))
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(panel.kind == .notice ? .white.opacity(0.7) : Theme.rim(panel.kind).colors[0])
                .id(panel.kind)
                .transition(.content(reduceMotion: reduceMotion))
            Spacer(minLength: env.notchSize.width + 16)
            trailing
                .id(trailingKey)
                .transition(.content(reduceMotion: reduceMotion))
        }
        .padding(.horizontal, 1)
    }

    private var trailingKey: String {
        switch panel {
        case .question: "q"
        case .access: "a"
        case .blocked: "b"
        default: "\(panel.kind)"
        }
    }

    @ViewBuilder private var trailing: some View {
        switch panel {
        case .listening:
            HStack(spacing: 5) {
                Circle().fill(Theme.recording).frame(width: 5, height: 5)
                ElapsedText(model: model, style: .clock, visible: visible)
            }
        case .working:
            ElapsedText(model: model, style: .tenths, visible: visible)
        case .done where model.awaitingReply:
            HStack(spacing: 5) {
                ReplyCue()
                Text("Reply").font(.system(size: 11.5, weight: .medium)).foregroundStyle(.white.opacity(0.6))
            }
        case .done:
            LevelBars(style: .speaking, count: 3, barWidth: 2.5, gap: 2.2, height: 14, colors: Theme.rim(.done).colors,
                      level: nil, active: model.speaking, visible: visible)
        case .question: tag("Question")
        case .access: tag("Access")
        case .blocked: tag("Blocked")
        case let .reminder(r):
            HStack(spacing: 6) {
                BellIcon(ringing: visible).frame(width: 13, height: 13)
                Text(r.firedAt, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute())
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(Theme.reminder)
            }
        case let .recent(items):
            let today = items.filter { Calendar.current.isDateInToday($0.date) }.count
            Text("\(today) today").font(.system(size: 11.5, weight: .medium)).foregroundStyle(.white.opacity(0.6))
        case let .details(_, d):
            Text(secondsText(d.totalMs)).font(.system(size: 12, weight: .medium).monospacedDigit()).foregroundStyle(.white.opacity(0.6))
        default: EmptyView()
        }
    }

    private func tag(_ s: String) -> some View {
        Text(s).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.attentionText)
    }

    // MARK: - Body

    @ViewBuilder private var content: some View {
        HStack(alignment: .top, spacing: Theme.columnGap) {
            PixelCharacter(mood: Mood(panel.kind), scale: 4, since: model.moodSince, level: env.level,
                           speaking: model.speaking, visible: visible)
                .frame(width: Theme.characterColumn)
            column
                .id(columnKey)
                .transition(.content(reduceMotion: reduceMotion))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
        }
    }

    private var columnKey: String {
        switch panel {
        case let .question(a): "q-\(a.id)"
        case let .reminder(r): "r-\(r.firedAt.timeIntervalSince1970)"
        case let .notice(t, _): "n-\(t)"
        case .recent: "recent"
        case let .details(item, _): "details-\(item.id)"
        default: "\(panel.kind)"
        }
    }

    @ViewBuilder private var column: some View {
        switch panel {
        case .idle, .listening: listening
        case .working: working
        case .done: done
        case let .question(a): question(a)
        case let .access(a): access(a)
        case let .blocked(b): blocked(b)
        case let .reminder(r): reminder(r)
        case let .notice(title, body): notice(title, body)
        case let .recent(items): recent(items)
        case let .details(item, d): RunDetailsView(item: item, details: d, back: { model.backToRecent() }, openRun: { model.openDetailsRun(item) })
        }
    }

    private var listening: some View {
        VStack(alignment: .leading, spacing: 0) {
            let t = model.transcript
            let confirmed = t.confirmed.split(separator: " ").map(String.init)
            let hyp = t.hypothesis.split(separator: " ").map(String.init)
            if let problem = model.listenProblem {
                Text(problem).font(Theme.body).foregroundStyle(Theme.attentionText)
                    .fixedSize(horizontal: false, vertical: true)
            } else if confirmed.isEmpty, hyp.isEmpty {
                HStack(spacing: 6) {
                    Text(listeningHint).font(Theme.body).foregroundStyle(.white.opacity(dimWords))
                    Caret(visible: visible)
                }
                .frame(minHeight: 50, alignment: .topLeading)
            } else {
                FlowLayout(spacing: 5, lineHeight: 25) {
                    ForEach(Array(confirmed.enumerated()), id: \.offset) { i, w in
                        TranscriptWord(word: w, confirmed: true, font: Theme.body, dim: dimWords)
                            .id("w\(i)")
                            .transition(.modifier(active: BlurFade(progress: 1, dy: 0), identity: BlurFade(progress: 0, dy: 0)).animation(MotionToken.wordIn))
                    }
                    ForEach(Array(hyp.enumerated()), id: \.offset) { i, w in
                        TranscriptWord(word: w, confirmed: false, font: Theme.body, dim: dimWords)
                            .id("w\(confirmed.count + i)")
                            .transition(.modifier(active: BlurFade(progress: 1, dy: 0), identity: BlurFade(progress: 0, dy: 0)).animation(MotionToken.wordIn))
                    }
                }
                .frame(minHeight: 50, alignment: .topLeading)
                .matchedGeometryEffect(id: "request", in: ns, properties: .position)
            }
            LevelBars(style: .mic, count: 20, barWidth: 3, gap: 4.5, height: 22, colors: Theme.rim(.listening).colors,
                      level: env.level, active: !model.isTranscribing, visible: visible)
                .padding(.top, 10)
        }
    }

    private var listeningHint: String {
        if model.isTranscribing { return "…" }
        if case let .loading(text) = model.speechModel { return "\(text)…" }
        return "Listening"
    }

    private var working: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.run?.request ?? "")
                .font(Theme.request)
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
                .truncationMode(.tail)
                .matchedGeometryEffect(id: "request", in: ns, properties: .position)
            ShimmerText(text: model.run?.status ?? "Thinking", font: Theme.body, visible: visible)
                .id(model.run?.status ?? "")
                .transition(.content(reduceMotion: reduceMotion))
                .padding(.top, 4)
            let steps = Array((model.run?.steps ?? []).suffix(4))
            if !steps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps) { s in
                        StepRow(step: s, last: s.id == steps.last?.id, accent: Theme.rim(.working).colors[1])
                            .transition(.content(reduceMotion: reduceMotion))
                    }
                }
                .padding(.top, 12)
            }
        }
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            let caps = model.run?.captions ?? []
            FlowLayout(spacing: 5, lineHeight: 25) {
                ForEach(caps) { c in
                    let words = c.text.split(separator: " ").map(String.init)
                    let per = words.isEmpty ? 0 : c.estimatedDuration / Double(words.count)
                    ForEach(Array(words.enumerated()), id: \.offset) { i, w in
                        SpokenWord(word: w, revealAt: c.startedAt + Double(i) * per, now: { model.scheduler.now }, font: Theme.body)
                            .id("\(c.id)-\(i)")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let run = model.run {
                let first = run.firstWordAt.map { $0 - run.startedAt }
                if !run.hosts.isEmpty || (first != nil && !run.request.isEmpty) {
                    HStack(spacing: 6) {
                        ForEach(run.hosts.prefix(4), id: \.self) { h in Chip(text: h) }
                        if let first, !run.request.isEmpty {
                            Text("first word \(first, format: .number.precision(.fractionLength(1)))s")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.4))
                                .padding(.horizontal, 4)
                        }
                    }
                    .padding(.top, 12)
                    .transition(.content(reduceMotion: reduceMotion))
                }
                if let saved = run.savedLabel {
                    Button { model.openSavedRun() } label: {
                        Text("Saved · \(saved) ↗").lineLimit(1)
                    }
                    .buttonStyle(SavedChipStyle())
                    .padding(.top, 12)
                    .transition(.content(reduceMotion: reduceMotion))
                }
            }
        }
    }

    private func label(_ s: String, color: Color = Theme.attentionText) -> some View {
        Text(s.uppercased())
            .font(Theme.label)
            .tracking(0.46)
            .foregroundStyle(color)
    }

    private func headline(_ s: String) -> some View {
        Text(s).font(Theme.body).foregroundStyle(.white).lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }

    private func sub(_ s: String) -> some View {
        Text(s).font(Theme.sub).foregroundStyle(.white.opacity(secondary))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }

    private func question(_ a: AskInfo) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            label("Jarvis needs you")
            headline(a.question)
            HStack(spacing: 8) {
                ForEach(Array(a.options.enumerated()), id: \.offset) { i, o in
                    Button(o) { model.answerButton(o) }.buttonStyle(NotchButtonStyle(primary: i == 0))
                }
                if a.options.isEmpty {
                    Button("Dismiss") { model.dismiss() }.buttonStyle(NotchButtonStyle())
                }
                Text("or hold \(env.hotkeyLabel)")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.leading, 4)
                    .fixedSize()
            }
            .padding(.top, 14)
        }
    }

    private func access(_ a: AccessInfo) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            label("Needs access")
            headline(a.what)
            if let fix = a.fix { sub(fix) }
            HStack(spacing: 8) {
                Button("Got it") { model.dismiss() }.buttonStyle(NotchButtonStyle())
            }
            .padding(.top, 14)
        }
    }

    private func blocked(_ b: BlockedInfo) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            label("Blocked · \(b.rule)")
            headline(b.sentence)
            if let d = b.detail { sub(d) }
            HStack(spacing: 8) {
                if b.safeVersion != nil {
                    Button("Do the safe version") { model.doSafeVersion() }.buttonStyle(NotchButtonStyle(primary: true))
                }
                Button("Dismiss") { model.dismiss() }.buttonStyle(NotchButtonStyle())
            }
            .padding(.top, 14)
        }
    }

    private func reminder(_ r: ReminderInfo) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            label("Reminder", color: Theme.reminder)
            headline(r.text)
            HStack(spacing: 8) {
                Button("Done") { model.dismiss() }.buttonStyle(NotchButtonStyle())
                Button("In 10 minutes") {
                    env.snooze(r.text, 10)
                    model.dismiss()
                }
                .buttonStyle(NotchButtonStyle())
            }
            .padding(.top, 14)
        }
    }

    private func recent(_ items: [ActionItem]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("WHAT JARVIS DID").font(.system(size: 11.5, weight: .medium)).tracking(0.46)
                Spacer()
                Text("Hold \(env.hotkeyLabel) to talk · ⌥⇧ Space to type").font(.system(size: 11.5))
            }
            .foregroundStyle(.white.opacity(0.4))
            .padding(.bottom, 6)
            if items.isEmpty {
                Text("Nothing yet. Hold \(env.hotkeyLabel) and ask for something.")
                    .font(Theme.sub).foregroundStyle(.white.opacity(secondary))
            }
            ForEach(items) { item in
                RecentRow(item: item) { model.openRecent(item) }
            }
        }
    }

    private func notice(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(Theme.body).foregroundStyle(.white)
            if !body.isEmpty { sub(body) }
        }
    }
}

// MARK: - Pieces

/// One hover-log row: time, summary, badge (NOTCH-DESIGN Large layout, 26 pt).
struct RecentRow: View {
    var item: ActionItem
    var open: () -> Void
    @State private var hover = false

    private var badge: (String, Color, Color)? {
        if item.saved { return ("Saved ↗", Theme.savedText, Color(hex: 0x5AC8FA, opacity: 0.14)) }
        switch item.kind {
        case "guard": return ("Guard", Theme.attentionText, Theme.attention.opacity(0.14))
        case "reminder": return ("Reminder", Theme.reminder, Theme.reminder.opacity(0.12))
        default: return nil
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(item.date, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute())
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.white.opacity(0.4))
                .frame(width: 44, alignment: .leading)
            Text(item.summary)
                .font(.system(size: 13.5))
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let b = badge {
                Text(b.0).font(.system(size: 11)).foregroundStyle(b.1)
                    .padding(.horizontal, 7).frame(height: 18)
                    .background(Capsule().fill(b.2))
            }
            if item.details != nil {
                Text("›").font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(hover ? 0.7 : 0.3))
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 7).fill(.white.opacity(openable && hover ? 0.08 : 0)))
        .padding(.horizontal, -8)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { if openable { open() } }
        .accessibilityAddTraits(openable ? .isButton : [])
    }

    private var openable: Bool { item.saved || item.details != nil }
}

/// "0.4 s", "12 s", "2 min 5 s"
func secondsText(_ ms: Double) -> String {
    let s = ms / 1000
    if s < 10 { return String(format: "%.1f s", s) }
    if s < 60 { return "\(Int(s.rounded())) s" }
    return "\(Int(s) / 60) min \(Int(s) % 60) s"
}

/// One request from Recent: what was asked and said, a bar of where the time
/// went, and the steps (Leo, 2026-10-22: "click into a request and see all the details").
struct RunDetailsView: View {
    var item: ActionItem
    var details: RunDetails
    var back: () -> Void
    var openRun: () -> Void

    static let sliceColors: [String: Color] = [
        "Starting Claude": Color(hex: 0x9AA4B2), "Thinking": Color(hex: 0x7D7AFF), "Tools": Color(hex: 0x5AC8FA),
        "Speaking": Color(hex: 0x30D158), "Working": Color(hex: 0x63E6BE),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button(action: back) { Text("‹ Recent") }.buttonStyle(.plain)
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(.white.opacity(0.55))
                    .accessibilityLabel("Back to recent requests")
                Spacer()
                Text(meta).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.white.opacity(0.4)).lineLimit(1)
            }
            .padding(.bottom, 6)
            Text(details.request).font(.system(size: 15, weight: .medium)).foregroundStyle(.white).lineLimit(2)
            if !details.reply.isEmpty {
                Text(details.reply).font(.system(size: 13)).foregroundStyle(.white.opacity(0.65)).lineLimit(3).fixedSize(horizontal: false, vertical: true).padding(.top, 3)
            }
            if let p = details.problem, details.outcome == "error" {
                Text(p).font(.system(size: 12)).foregroundStyle(Theme.attentionText).lineLimit(2).padding(.top, 3)
            }
            bar.padding(.top, 10)
            ForEach(Array(details.steps.prefix(4).enumerated()), id: \.offset) { _, s in
                HStack(spacing: 6) {
                    Text(s.error == true ? "✕" : "✓").font(.system(size: 10)).foregroundStyle(s.error == true ? Theme.recording : Theme.success)
                    Text(s.detail.map { "\(s.label) · \($0)" } ?? s.label).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                    Spacer()
                    if let ms = s.ms { Text(secondsText(ms)).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.white.opacity(0.45)) }
                }
                .frame(height: 19)
            }
            .padding(.top, 2)
            if details.steps.count > 4 {
                Text("and \(details.steps.count - 4) more steps").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.4))
            }
            if item.saved, item.sessionId != nil {
                Button("Open the conversation ↗", action: openRun).buttonStyle(SavedChipStyle()).padding(.top, 8)
            }
        }
    }

    private var meta: String {
        var parts = [details.route == "claude" || details.route == "warm" ? (details.model ?? "Claude") : "No Claude run"]
        if let t = details.turns { parts.append("\(t) turn\(t == 1 ? "" : "s")") }
        if let c = details.costUsd, c > 0 { parts.append(String(format: "$%.3f", c)) }
        return parts.joined(separator: " · ")
    }

    /// Where the time went: one bar, a slice per phase, with a legend.
    private var bar: some View {
        let slices = details.breakdown.filter { $0.ms > 0 }
        let total = max(slices.reduce(0) { $0 + $1.ms }, 1)
        return VStack(alignment: .leading, spacing: 5) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    ForEach(Array(slices.enumerated()), id: \.offset) { _, s in
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Self.sliceColors[s.label] ?? .gray)
                            .frame(width: max(3, (geo.size.width - CGFloat(slices.count - 1) * 2) * s.ms / total))
                    }
                }
            }
            .frame(height: 8)
            HStack(spacing: 10) {
                ForEach(Array(slices.enumerated()), id: \.offset) { _, s in
                    HStack(spacing: 4) {
                        Circle().fill(Self.sliceColors[s.label] ?? .gray).frame(width: 6, height: 6)
                        Text("\(s.label) \(secondsText(s.ms))").font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Took \(secondsText(details.totalMs)): " + slices.map { "\($0.label) \(secondsText($0.ms))" }.joined(separator: ", "))
    }
}

struct StepRow: View {
    var step: RunStep
    var last: Bool
    var accent: Color

    var body: some View {
        HStack(spacing: 6) {
            Text(last ? "●" : "✓")
                .font(.system(size: 11))
                .foregroundStyle(last ? accent : Theme.success)
                .frame(width: 16, alignment: .leading)
            Text(step.text)
                .font(Theme.step)
                .foregroundStyle(last ? .white : .white.opacity(0.5))
                .lineLimit(1)
                .frame(width: 150, alignment: .leading)
            Text(step.detail ?? "")
                .font(Theme.step)
                .foregroundStyle(.white.opacity(0.4))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(step.duration.map { String(format: "%.1fs", $0) } ?? "")
                .font(Theme.step.monospacedDigit())
                .foregroundStyle(.white.opacity(0.5))
                .frame(width: 40, alignment: .trailing)
        }
        .frame(height: 22)
    }
}

struct Chip: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white.opacity(0.75))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(Capsule().fill(.white.opacity(0.08)))
    }
}

struct SavedChipStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Capsule().fill(.white.opacity(hover ? 0.16 : 0.1)))
            .contentShape(Capsule())
            .onHover { hover = $0 }
    }
}

struct Caret: View {
    var visible: Bool
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
            let on = !visible || Int(ctx.date.timeIntervalSinceReferenceDate * 2) % 2 == 0
            RoundedRectangle(cornerRadius: 1)
                .fill(.white.opacity(0.7))
                .frame(width: 2, height: 19)
                .opacity(on ? 1 : 0)
        }
    }
}

struct BellIcon: View {
    var ringing: Bool
    @State private var start = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: !ringing || reduceMotion)) { ctx in
            // Rings twice (1.4 s each), then rests.
            let t = ctx.date.timeIntervalSince(start)
            let phase = t.truncatingRemainder(dividingBy: 1.4) / 1.4
            let swing: Double = t > 2.8 || reduceMotion ? 0 : (phase < 0.5 ? sin(phase * 8 * .pi) * 14 * (1 - phase * 2) : 0)
            BellShape()
                .fill(Theme.reminder)
                .rotationEffect(.degrees(swing), anchor: UnitPoint(x: 0.5, y: 0.1))
        }
    }
}

struct ElapsedText: View {
    enum Style { case clock, seconds, tenths }
    let model: AppModel
    var style: Style
    var visible: Bool

    var body: some View {
        let now = model.scheduler.now
        // Rounded so re-evaluating the body yields the same schedule.
        let raw = Date().addingTimeInterval(-model.elapsed(at: now)).timeIntervalSinceReferenceDate
        let start = Date(timeIntervalSinceReferenceDate: (raw * 20).rounded() / 20)
        TimelineView(ElapsedSchedule(start: start, style: style, paused: !visible)) { ctx in
            Text(Self.format(max(0, ctx.date.timeIntervalSince(start)), style))
                .font(Theme.wingFont)
                .foregroundStyle(.white.opacity(0.72))
        }
    }

    static func format(_ e: Double, _ style: Style) -> String {
        switch style {
        case .clock: return String(format: "%d:%02d", Int(e) / 60, Int(e) % 60)
        case .tenths where e < 10:
            return String(format: "%.1fs", e)
        case .seconds, .tenths:
            if e < 60 { return "\(Int(e))s" }
            return String(format: "%d:%02d", Int(e) / 60, Int(e) % 60)
        }
    }
}

/// Ticks only as often as the text changes (each tick re-lays out the notch):
/// tenths only in the expanded strip's first 10 s, else whole seconds.
struct ElapsedSchedule: TimelineSchedule {
    var start: Date
    var style: ElapsedText.Style
    var paused: Bool

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next = startDate
        let paused = self.paused
        return AnyIterator {
            if paused { return nil }
            let current = next
            let e = current.timeIntervalSince(start)
            let step: Double = (style == .tenths && e < 10) ? 0.1 : 1
            // Align to the step boundary so the digit changes on time.
            let k = ((e + 0.001) / step).rounded(.down) + 1
            next = max(start.addingTimeInterval(k * step), current.addingTimeInterval(step / 2))
            return current
        }
    }
}

// MARK: - Pill (compact)

struct PillLeading: View {
    let model: AppModel
    let env: NotchEnvironment
    static let wingWidth: CGFloat = Theme.wing - 14 // DNK adds 6 (ear) + 8 (inset)

    private var panel: Panel { model.panel == .idle ? model.lastPanel : model.panel }

    var body: some View {
        if model.panel == .idle {
            // Idle: no wings, so the hidden state is exactly the hardware outline.
            Color.clear.frame(width: 0, height: max(20, env.notchSize.height - 12))
        } else {
            PixelCharacter(mood: Mood(panel.kind), scale: 2, since: model.moodSince, level: env.level,
                           speaking: model.speaking, visible: model.size == .compact)
                .frame(width: Self.wingWidth, height: max(20, env.notchSize.height - 12), alignment: .leading)
                .background(alignment: .topLeading) {
                    // The rim round the whole pill, drawn from the leading wing.
                    let w = env.notchSize.width + 2 * Theme.wing
                    AuroraRim(kind: panel.kind, topRadius: 6, bottomRadius: 14, visible: model.size == .compact, showGlow: false)
                        .frame(width: w, height: env.notchSize.height)
                        .offset(x: -14, y: -4)
                        .opacity(panel.kind == .needs ? 1 : 0.55)
                }
        }
    }
}

/// The mic is open for a reply: a small mic that breathes, in the listening colour.
struct ReplyCue: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.rim(.listening).colors[0])
            .opacity(on || reduceMotion ? 1 : 0.45)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(), value: on)
            .onAppear { on = true }
            .accessibilityLabel("Listening for a reply")
    }
}

struct PillTrailing: View {
    let model: AppModel
    let env: NotchEnvironment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var panel: Panel { model.panel == .idle ? model.lastPanel : model.panel }

    var body: some View {
        Group {
            switch panel {
            case .working:
                ElapsedText(model: model, style: .seconds, visible: model.size == .compact)
            case .done where model.awaitingReply:
                ReplyCue()
            case .done:
                LevelBars(style: .speaking, count: 3, barWidth: 2.5, gap: 2.2, height: 14, colors: Theme.rim(.done).colors,
                          level: nil, active: model.speaking, visible: model.size == .compact)
            case .question, .access, .blocked:
                AttentionDot(visible: model.size == .compact)
            case .reminder:
                BellIcon(ringing: model.size == .compact).frame(width: 13, height: 13)
            default:
                EmptyView()
            }
        }
        .frame(width: model.panel == .idle ? 0 : PillLeading.wingWidth, height: max(20, env.notchSize.height - 12), alignment: .trailing)
        .opacity(model.panel == .idle ? 0 : 1)
    }
}

struct AttentionDot: View {
    var visible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        PulseDot(animating: visible && !reduceMotion).frame(width: 18, height: 18)
    }
}

/// The needs-you dot: an amber dot with a ring pulsing on `attention` (1.2 s),
/// run by Core Animation so a long unanswered question costs no CPU.
struct PulseDot: NSViewRepresentable {
    var animating: Bool

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        v.wantsLayer = true
        let ring = CALayer()
        ring.name = "ring"
        ring.borderColor = NSColor(Theme.attention).withAlphaComponent(0.6).cgColor
        ring.borderWidth = 2.5
        let dot = CALayer()
        dot.name = "dot"
        dot.backgroundColor = NSColor(Theme.attention).cgColor
        v.layer?.addSublayer(ring)
        v.layer?.addSublayer(dot)
        return v
    }

    func updateNSView(_ v: NSView, context: Context) {
        guard let layers = v.layer?.sublayers, let ring = layers.first(where: { $0.name == "ring" }),
              let dot = layers.first(where: { $0.name == "dot" }) else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let c = CGPoint(x: 9, y: 9)
        dot.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
        dot.cornerRadius = 4
        dot.position = c
        ring.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
        ring.cornerRadius = 4
        ring.position = c
        CATransaction.commit()
        ring.removeAllAnimations()
        dot.removeAllAnimations()
        ring.opacity = 0
        guard animating else { return }
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = 2.2
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let g = CAAnimationGroup()
        g.animations = [grow, fade]
        g.duration = 1.2
        g.repeatCount = .infinity
        g.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        ring.add(g, forKey: "pulse")
        let dim = CABasicAnimation(keyPath: "opacity")
        dim.fromValue = 1
        dim.toValue = 0.65
        dim.duration = 0.6
        dim.autoreverses = true
        dim.repeatCount = .infinity
        dot.add(dim, forKey: "dim")
    }
}

/// The mockup's bell, as a path (no symbol image to load on first show).
struct BellShape: Shape {
    func path(in r: CGRect) -> Path {
        let sx = r.width / 16, sy = r.height / 16
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * sx, y: r.minY + y * sy) }
        var path = Path()
        path.move(to: p(8, 1.5))
        path.addCurve(to: p(3.7, 6), control1: p(5.5, 1.5), control2: p(3.7, 3.5))
        path.addLine(to: p(3.7, 8.6))
        path.addLine(to: p(2.4, 11))
        path.addCurve(to: p(3, 12.1), control1: p(2.1, 11.5), control2: p(2.4, 12.1))
        path.addLine(to: p(13, 12.1))
        path.addCurve(to: p(13.6, 11), control1: p(13.6, 12.1), control2: p(13.9, 11.5))
        path.addLine(to: p(12.3, 8.6))
        path.addLine(to: p(12.3, 6))
        path.addCurve(to: p(8, 1.5), control1: p(12.3, 3.5), control2: p(10.5, 1.5))
        path.closeSubpath()
        path.move(to: p(6.2, 13.2))
        path.addCurve(to: p(9.8, 13.2), control1: p(6.6, 14.6), control2: p(9.4, 14.6))
        path.closeSubpath()
        return path
    }
}
