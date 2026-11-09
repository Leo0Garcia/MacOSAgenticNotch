// A finished request in the dashboard (Leo, 2026-11-09: "a main chat log in
// the middle … and then all of the tool calls on the right side"): the request,
// its meta and timing bar on top, the conversation as bubbles in the middle,
// every tool call on the right, each opening to its input and output.
// The notch keeps its own small RunDetailsView.

import SwiftUI

struct RunLogView: View {
    /// One request, or a conversation's requests oldest first.
    var items: [ActionItem]
    var close: () -> Void
    var openRun: (ActionItem) -> Void

    private var runs: [(item: ActionItem, details: RunDetails)] { items.compactMap { i in i.details.map { (i, $0) } } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(EdgeInsets(top: 20, leading: 24, bottom: 18, trailing: 20))
            Divider().overlay(Dash.line)
            HStack(spacing: 0) {
                chat
                Divider().overlay(Dash.line)
                tools.frame(width: 380)
            }
        }
    }

    // MARK: - Top

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(runs.count == 1 ? runs[0].details.request : "Conversation · \(runs.count) requests")
                    .font(.system(size: 18, weight: .semibold)).lineLimit(2)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if let saved = items.last(where: { $0.saved && $0.sessionId != nil }) {
                    Button("Open the conversation ↗") { openRun(saved) }.buttonStyle(DashButtonStyle(small: true))
                }
                CloseButton(close: close)
            }
            Text(meta).font(.system(size: 12.5).monospacedDigit()).foregroundStyle(Dash.muted)
            if let d = runs.first?.details, runs.count == 1 {
                if let p = d.problem, d.outcome == "error" {
                    Text(p).font(.system(size: 12.5)).foregroundStyle(Theme.attentionText).lineLimit(2)
                }
                RunDetailsView.bar(d, legend: true).frame(maxWidth: 560).padding(.top, 2)
            }
        }
    }

    private var meta: String {
        let all = runs.map(\.details)
        guard let d = all.first else { return "" }
        var parts: [String] = []
        if all.count == 1 {
            parts.append(d.route == "claude" || d.route == "warm" ? (d.model ?? "Claude") : "No Claude run")
            if let t = d.turns { parts.append("\(t) turn\(t == 1 ? "" : "s")") }
        }
        let cost = all.compactMap(\.costUsd).reduce(0, +)
        if cost > 0 { parts.append(String(format: "$%.3f", cost)) }
        parts.append(secondsText(all.reduce(0) { $0 + $1.totalMs }))
        if let start = d.started { parts.append(Dash.day(start, now: Date())) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Middle: the conversation

    private var chat: some View {
        Scrolling {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(Array(runs.enumerated()), id: \.offset) { i, run in
                    if runs.count > 1 { RequestHeader(index: i + 1, details: run.details).padding(.top, i == 0 ? 0 : 10) }
                    ForEach(Array(run.details.lines.enumerated()), id: \.offset) { _, line in
                        ChatBubble(line: line)
                    }
                }
            }
            .padding(24)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Right: the tool calls

    private var tools: some View {
        let count = runs.reduce(0) { $0 + $1.details.steps.count }
        return Scrolling {
            LazyVStack(alignment: .leading, spacing: 6) {
                Text(count == 1 ? "1 tool call" : "\(count) tool calls").font(Dash.title).foregroundStyle(Dash.muted)
                    .padding(.bottom, 4)
                if count == 0 {
                    Text("No tool calls.").font(.system(size: 13)).foregroundStyle(Dash.muted)
                }
                ForEach(Array(runs.enumerated()), id: \.offset) { i, run in
                    if runs.count > 1, !run.details.steps.isEmpty {
                        Text(run.details.request).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Dash.muted)
                            .lineLimit(1).padding(.top, i == 0 ? 0 : 10)
                    }
                    ForEach(Array(run.details.steps.enumerated()), id: \.offset) { _, s in ToolCallRow(step: s) }
                }
            }
            .padding(EdgeInsets(top: 22, leading: 18, bottom: 22, trailing: 18))
        }
        .background(Color.black.opacity(0.18))
    }
}

/// "+4.2 s" from the start of the request.
private func offsetText(_ ms: Double) -> String { "+" + secondsText(ms) }

private struct RequestHeader: View {
    var index: Int
    var details: RunDetails

    var body: some View {
        HStack(spacing: 8) {
            Text("Request \(index)").font(.system(size: 11.5, weight: .semibold))
            Text(details.started.map(Dash.time) ?? "")
            Text(secondsText(details.totalMs))
            Rectangle().fill(Dash.line).frame(height: 1)
        }
        .font(.system(size: 11.5).monospacedDigit())
        .foregroundStyle(Dash.muted)
        .accessibilityElement(children: .combine)
    }
}

private struct ChatBubble: View {
    var line: RunDetails.ChatLine

    var body: some View {
        switch line.who {
        case "checker": checker
        case "leo": bubble(leading: false)
        default: bubble(leading: true)
        }
    }

    private func bubble(leading: Bool) -> some View {
        VStack(alignment: leading ? .leading : .trailing, spacing: 4) {
            Text(leading ? "Jarvis" : "Leo").font(.system(size: 11, weight: .semibold)).foregroundStyle(Dash.muted)
            Text(line.text)
                .font(.system(size: 14))
                .lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 14).fill(leading ? Dash.inset : Color.white.opacity(0.11)))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(leading ? Dash.line : .clear))
            Text(offsetText(line.atMs)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Dash.muted.opacity(0.8))
        }
        .frame(maxWidth: 560, alignment: leading ? .leading : .trailing)
        .frame(maxWidth: .infinity, alignment: leading ? .leading : .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(leading ? "Jarvis" : "Leo"), \(offsetText(line.atMs)): \(line.text)")
    }

    private var checker: some View {
        let ok = line.text.hasPrefix("Checked:")
        return HStack(spacing: 6) {
            Text(ok ? "✓" : "!").foregroundStyle(ok ? Theme.success : Dash.amber)
            Text(line.text).foregroundStyle(ok ? Dash.muted : Dash.amber).textSelection(.enabled)
            Text(offsetText(line.atMs)).foregroundStyle(Dash.muted.opacity(0.8)).monospacedDigit()
        }
        .font(.system(size: 12))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Checker: \(line.text)")
    }
}

private struct ToolCallRow: View {
    var step: RunDetails.Step
    @State private var open: Bool
    @State private var hover = false

    /// A failed call starts open: its error is usually what Leo came to see.
    init(step: RunDetails.Step) {
        self.step = step
        _open = State(initialValue: step.error == true && (step.input != nil || step.output != nil))
    }

    private var failed: Bool { step.error == true }
    private var openable: Bool { step.input != nil || step.output != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { if openable { open.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(failed ? "✕" : "✓").font(.system(size: 11, weight: .bold))
                        .foregroundStyle(failed ? Theme.recording : Theme.success)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        if let d = step.detail ?? step.tool {
                            Text(d).font(.system(size: 11.5)).foregroundStyle(Dash.muted).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 6)
                    Text(step.ms.map(secondsText) ?? "").font(.system(size: 11.5).monospacedDigit()).foregroundStyle(Dash.muted)
                    if openable {
                        Text("›").font(.system(size: 13, weight: .semibold)).foregroundStyle(Dash.muted)
                            .rotationEffect(.degrees(open ? 90 : 0))
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(step.label), \(failed ? "failed" : "done")\(step.ms.map { ", took \(secondsText($0))" } ?? "")")
            .accessibilityHint(openable ? (open ? "Hides the input and output" : "Shows the input and output") : "")
            if open {
                if let i = step.input { MonoBox(title: "Input", text: i) }
                if let o = step.output { MonoBox(title: failed ? "Error" : "Output", text: o) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(open || hover ? 0.07 : 0.035)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(open ? Dash.line : .clear))
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: open)
    }
}

private struct MonoBox: View {
    var title: String
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(Dash.muted)
            Scrolling {
                Text(text)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Dash.text.opacity(0.85))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 150, alignment: .top)
            .clipped()
            .fixedSize(horizontal: false, vertical: true)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.45)))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(text)")
    }
}

/// ImageRenderer draws nothing inside a ScrollView, so snapshots get the content laid out plainly.
struct Scrolling<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        if OffscreenRender.active { content.frame(maxHeight: .infinity, alignment: .top).clipped() } else { ScrollView { content } }
    }
}

struct CloseButton: View {
    var close: () -> Void

    var body: some View {
        Button(action: close) { Text("✕").font(.system(size: 12, weight: .semibold)).frame(width: 14) }
            .buttonStyle(DashButtonStyle(small: true))
            .keyboardShortcut(.cancelAction)
            .help("Close (Esc)")
            .accessibilityLabel("Close")
    }
}
