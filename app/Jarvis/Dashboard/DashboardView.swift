// The dashboard window (Leo, 2026-11-08, phase 1): the Nebula orb in the
// middle with a card per running agent under it, Today on the left, Needs you
// and Recent on the right, a talk bar at the bottom. Ambient mode is the same
// window full screen: the orb fills it and only Needs you stays bright.
// It never speaks; stages stay on screen.

import AppKit
import SwiftUI

enum Dash {
    static let bg = Color(hex: 0x06080B)
    static let panel = Color(hex: 0x12151B)
    static let card = Color(hex: 0x171B22)
    static let line = Color(hex: 0x222833)
    static let text = Color(hex: 0xE8ECF2)
    static let muted = Color(hex: 0x9AA4B2)
    static let amber = Color(hex: 0xF5B547)
    static let amberBg = Color(hex: 0x1A160D)
    static let amberLine = Color(hex: 0x5C4718)
    static let title = Font.system(size: 12, weight: .semibold)

    @MainActor static func color(_ s: AgentStatus) -> Color {
        switch s {
        case .working: Color(hex: Appearance.shared.palette.working[0])
        case .waiting: amber
        case .queued: muted
        }
    }

    static func time(_ d: Date) -> String { d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }

    /// "Fri" within the week, else "Mon 16".
    static func day(_ d: Date, now: Date) -> String {
        if Calendar.current.isDate(d, inSameDayAs: now) { return "Today \(time(d))" }
        return d.formatted(.dateTime.weekday(.abbreviated).day()) + " " + time(d)
    }
}

private struct OrbSlot: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

struct DashboardView: View {
    let store: DashboardStore
    var hotkeyLabel: String
    var toggleAmbient: () -> Void
    @AppStorage("DashboardShowRecent") private var showRecent = true
    @State private var filter: AgentFilter = .all
    @State private var selected: String?
    @State private var details: DetailsSheet?

    private var model: AppModel { store.model }

    var body: some View {
        ZStack {
            if store.ambient { ambient } else { normal }
        }
        .foregroundStyle(Dash.text)
        // One web view for both layouts, so switching doesn't reload the orb.
        .backgroundPreferenceValue(OrbSlot.self) { slot in
            GeometryReader { g in
                Dash.bg
                let r = store.ambient || slot == nil ? CGRect(origin: .zero, size: g.size) : g[slot!]
                OrbView(store: store)
                    .frame(width: r.width, height: r.height)
                    .position(x: r.midX, y: r.midY)
                    .animation(.easeInOut(duration: 0.35), value: store.ambient)
            }
            .ignoresSafeArea()
        }
        // An overlay, not a sheet, so a click outside it closes it (Esc does too).
        .overlay {
            if let d = details {
                ZStack {
                    Color.black.opacity(0.6).ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { details = nil }
                        .accessibilityLabel("Close the details")
                        .accessibilityAddTraits(.isButton)
                    DetailsSheetView(sheet: d, store: store) { details = nil }
                        .padding(EdgeInsets(top: 44, leading: 40, bottom: 32, trailing: 40))
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: details?.id)
        .environment(\.colorScheme, .dark)
    }

    // MARK: - Normal

    private var normal: some View {
        VStack(spacing: 14) {
            header
            HStack(alignment: .top, spacing: 14) {
                TodayPanel(store: store).frame(width: 250)
                center
                VStack(spacing: 14) {
                    NeedsYouPanel(model: model, large: false)
                    if showRecent { recentPanel }
                    Spacer(minLength: 0)
                }
                .frame(width: 300)
            }
            TalkBar(model: model, hotkeyLabel: hotkeyLabel, large: false)
        }
        .padding(EdgeInsets(top: 34, leading: 18, bottom: 16, trailing: 18))
        .overlay(alignment: .top) { TitleBarArea().frame(height: 34) }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Jarvis").font(.system(size: 20, weight: .semibold))
            Text(store.now.formatted(.dateTime.weekday(.wide).day().month(.wide)) + " · " + Dash.time(store.now))
                .font(.system(size: 13)).foregroundStyle(Dash.muted)
            Spacer()
            if !showRecent {
                Button("Show recent") { showRecent = true }.buttonStyle(DashButtonStyle())
            }
            Button(action: toggleAmbient) { Text("Ambient ⤢") }
                .buttonStyle(DashButtonStyle())
                .help("Full screen, readable from across the room (Esc to leave)")
        }
        .background(TitleBarArea()) // the header's empty space acts as title bar too
    }

    private var center: some View {
        VStack(spacing: 12) {
            Color.clear
                .frame(maxWidth: .infinity, minHeight: 240, maxHeight: .infinity)
                .layoutPriority(1)
                .anchorPreference(key: OrbSlot.self, value: .bounds) { $0 }
                .overlay(alignment: .bottom) {
                    VStack(spacing: 6) {
                        LiveLine(model: model, large: false)
                        Text(Agents.summary(store.cards)).font(.system(size: 14, weight: .medium)).foregroundStyle(Dash.muted)
                    }
                }
                .accessibilityElement()
                .accessibilityLabel("Jarvis orb, \(Agents.summary(store.cards))")
            HStack(spacing: 6) {
                Text("Running now").font(Dash.title).foregroundStyle(Dash.muted)
                Spacer()
                ForEach(AgentFilter.allCases) { f in
                    Button(f.label) { filter = f }
                        .buttonStyle(DashButtonStyle(selected: filter == f, small: true))
                }
            }
            cards
            if let id = selected, let card = store.cards.first(where: { $0.id == id }) {
                PipelineStrip(card: card, stages: store.stages(for: card), now: store.now) {
                    details = DetailsSheet(card: card)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var cards: some View {
        let shown = store.cards.filter(filter.matches)
        return VStack(spacing: 8) {
            if shown.isEmpty {
                Text(store.cards.isEmpty ? "Nothing running. Ask for something below." : "None \(filter.label.lowercased()).")
                    .font(.system(size: 13)).foregroundStyle(Dash.muted)
                    .frame(maxWidth: .infinity, minHeight: 60)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 10)], spacing: 10) {
                // shortcut: shows the six newest; add scrolling if Leo runs more at once.
                ForEach(shown.prefix(6)) { c in
                    AgentCardView(card: c, now: store.now, selected: selected == c.id) {
                        selected = selected == c.id ? nil : c.id
                    }
                }
            }
            if shown.count > 6 {
                Text("+\(shown.count - 6) more").font(.system(size: 12)).foregroundStyle(Dash.muted)
            }
        }
    }

    private var recentPanel: some View {
        DashPanel {
            HStack {
                Text("Recent").font(Dash.title).foregroundStyle(Dash.muted)
                Spacer()
                Button("Hide") { showRecent = false }.buttonStyle(.plain)
                    .font(.system(size: 11.5)).foregroundStyle(Dash.muted)
            }
            if store.recent.isEmpty {
                Text("Nothing yet today.").font(.system(size: 13)).foregroundStyle(Dash.muted)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(store.recent, id: \.last!.id) { group in
                        RecentRow(item: group[0], count: group.count) { open(group) }
                    }
                }
            }
        }
    }

    private func open(_ group: [ActionItem]) {
        if group.contains(where: { $0.details != nil }) {
            details = DetailsSheet(items: group.filter { $0.details != nil })
        } else if let saved = group.first(where: { $0.saved }), let id = saved.sessionId {
            model.launcher?.open(sessionId: id)
        }
    }

    // MARK: - Ambient

    private var ambient: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Dash.time(store.now)).font(.system(size: 72, weight: .medium).monospacedDigit())
                    Text(store.now.formatted(.dateTime.weekday(.wide).day().month(.wide))).font(.system(size: 22)).foregroundStyle(Dash.muted)
                }
                Spacer()
                TodayPanel(store: store, large: true).frame(width: 380).opacity(0.45)
            }
            Spacer()
            LiveLine(model: model, large: true).padding(.bottom, 18)
            Text(Agents.summary(store.cards)).font(.system(size: 30, weight: .semibold))
            HStack(spacing: 40) {
                ForEach(store.cards.prefix(4)) { c in
                    VStack(spacing: 6) {
                        Circle().fill(Dash.color(c.status)).frame(width: 14, height: 14)
                        Text(c.request).font(.system(size: 20, weight: .semibold)).lineLimit(1)
                        Text(c.status == .waiting ? "Waiting on you" : c.stage).font(.system(size: 17))
                            .foregroundStyle(c.status == .waiting ? Dash.amber : Dash.muted).lineLimit(1)
                    }
                    .frame(maxWidth: 320)
                }
            }
            .opacity(0.6)
            .padding(.top, 16)
            NeedsYouPanel(model: model, large: true)
                .frame(maxWidth: 760)
                .padding(.top, 28)
            TalkBar(model: model, hotkeyLabel: hotkeyLabel, large: true)
                .frame(maxWidth: 760)
                .opacity(0.45)
                .padding(.top, 20)
        }
        .padding(48)
    }
}

// MARK: - Pieces

/// The title bar is drawn over by the content, so this stands in for it:
/// drag to move the window, double-click to do what macOS is set to do
/// (Fill/zoom by default, or minimise).
struct TitleBarArea: View {
    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(WindowDragGesture())
            .onTapGesture(count: 2) { Self.doubleClick(NSApp.keyWindow) }
            .accessibilityHidden(true)
    }

    static func doubleClick(_ window: NSWindow?) {
        // The user's choice in System Settings › Desktop & Dock › "Double-click a window's title bar to".
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window?.miniaturize(nil)
        case "None": break
        default: window?.zoom(nil)
        }
    }
}

/// The conversation as it happens, under the orb: what Leo is saying, what
/// Jarvis is doing, then what it says. While the dashboard is on screen, this
/// replaces the notch.
struct LiveLine: View {
    let model: AppModel
    var large: Bool

    var body: some View {
        Group {
            if let line = model.liveLine {
                VStack(spacing: 4) {
                    Text(line.who).font(.system(size: large ? 15 : 11.5, weight: .semibold)).foregroundStyle(Dash.muted)
                    Text(line.text)
                        .font(.system(size: large ? 30 : 19, weight: .medium))
                        .multilineTextAlignment(.center)
                        .lineLimit(large ? 4 : 3)
                        .frame(maxWidth: large ? 900 : 560)
                }
                .padding(.horizontal, 16)
                .transition(.opacity)
                .accessibilityElement(children: .combine)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.liveLine?.text)
    }
}

struct DashPanel<Content: View>: View {
    var highlighted = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(highlighted ? Dash.amberBg : Dash.panel.opacity(0.92)))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(highlighted ? Dash.amberLine : Dash.line))
    }
}

struct DashButtonStyle: ButtonStyle {
    var selected = false
    var small = false
    var primary = false
    @State private var hover = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: small ? 12 : 13, weight: .medium))
            .foregroundStyle(primary ? Dash.amberBg : selected ? Dash.text : Dash.muted)
            .padding(.horizontal, small ? 10 : 14)
            .frame(height: small ? 26 : 32)
            .background(Capsule().fill(primary ? Dash.amber.opacity(configuration.isPressed ? 0.8 : 1)
                                       : Color.white.opacity(selected || hover || configuration.isPressed ? 0.12 : 0.05)))
            .overlay(Capsule().stroke(selected ? Dash.text.opacity(0.35) : .clear))
            .contentShape(Capsule())
            .onHover { hover = $0 }
    }
}

struct AgentCardView: View {
    var card: AgentCard
    var now: Date
    var selected: Bool
    var pick: () -> Void

    var body: some View {
        Button(action: pick) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    Circle().fill(Dash.color(card.status)).frame(width: 8, height: 8)
                    Text(card.status == .waiting ? "Waiting on you" : card.status.rawValue.capitalized)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(card.status == .waiting ? Dash.amber : Dash.muted)
                    Spacer()
                    Text(Agents.elapsed(now.timeIntervalSince(card.startedAt)))
                        .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(Dash.muted)
                }
                Text(card.request).font(.system(size: 14, weight: .medium)).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(card.stage).font(.system(size: 12.5)).foregroundStyle(Dash.muted).lineLimit(1)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Dash.card))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Dash.text.opacity(0.4) : card.status == .waiting ? Dash.amberLine : Dash.line))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(card.request). \(card.status == .waiting ? "Waiting on you" : card.stage)")
    }
}

/// A card's run as plain stages, oldest first.
struct PipelineStrip: View {
    var card: AgentCard
    var stages: [Stage]
    var now: Date
    var showLog: () -> Void

    var body: some View {
        DashPanel {
            HStack(spacing: 10) {
                Text(card.request).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text("started \(Dash.time(card.startedAt))").font(.system(size: 12)).foregroundStyle(Dash.muted)
                Spacer()
                Button("Show the log", action: showLog).buttonStyle(DashButtonStyle(small: true))
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(stages.enumerated()), id: \.offset) { i, s in
                        let current = i == stages.count - 1
                        Text(s.text)
                            .font(.system(size: 12.5, weight: current ? .semibold : .regular))
                            .foregroundStyle(current ? Dash.text : Dash.muted)
                            .padding(.horizontal, 10).frame(height: 26)
                            .background(Capsule().fill(Color.white.opacity(current ? 0.1 : 0.04)))
                        if !current { Text("→").foregroundStyle(Dash.muted).accessibilityHidden(true) }
                    }
                }
            }
        }
    }
}

struct NeedsYouPanel: View {
    let model: AppModel
    var large: Bool

    var body: some View {
        let active = model.panel.isNeedsYou
        DashPanel(highlighted: active) {
            HStack(spacing: 8) {
                Circle().fill(active ? Dash.amber : Dash.muted.opacity(0.5)).frame(width: large ? 12 : 8, height: large ? 12 : 8)
                Text("Needs you").font(large ? .system(size: 18, weight: .semibold) : Dash.title)
                    .foregroundStyle(active ? Dash.amber : Dash.muted)
            }
            switch model.panel {
            case let .question(ask):
                Text(ask.question).font(.system(size: large ? 28 : 15, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                FlowButtons(options: ask.options, large: large) { model.answerButton($0) }
                Button("Dismiss") { model.dismiss() }.buttonStyle(.plain).font(.system(size: large ? 16 : 12)).foregroundStyle(Dash.muted)
            case let .access(a):
                Text(a.what).font(.system(size: large ? 28 : 15, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                if let fix = a.fix { Text(fix).font(.system(size: large ? 18 : 12.5)).foregroundStyle(Dash.muted) }
                Button("OK") { model.dismiss() }.buttonStyle(DashButtonStyle(primary: true))
            case let .blocked(b):
                Text(b.sentence).font(.system(size: large ? 28 : 15, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                if let d = b.detail { Text(d).font(.system(size: large ? 18 : 12.5)).foregroundStyle(Dash.muted) }
                HStack {
                    if let safe = b.safeVersion {
                        Button("Do this instead: \(safe)") { model.doSafeVersion() }.buttonStyle(DashButtonStyle(primary: true))
                    }
                    Button("Dismiss") { model.dismiss() }.buttonStyle(DashButtonStyle())
                }
            default:
                Text("Nothing needs you.").font(.system(size: large ? 18 : 13)).foregroundStyle(Dash.muted)
            }
        }
    }
}

private struct FlowButtons: View {
    var options: [String]
    var large: Bool
    var pick: (String) -> Void

    var body: some View {
        // Wraps when the options don't fit on one line.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttons }
            VStack(alignment: .leading, spacing: 8) { buttons }
        }
    }

    @ViewBuilder private var buttons: some View {
        ForEach(Array(options.enumerated()), id: \.offset) { i, o in
            Button(o) { pick(o) }
                .buttonStyle(DashButtonStyle(primary: i == 0))
                .scaleEffect(large ? 1.35 : 1, anchor: .leading)
                .padding(.trailing, large ? 20 : 0)
        }
    }
}

struct TodayPanel: View {
    let store: DashboardStore
    var large = false

    var body: some View {
        let body = Font.system(size: large ? 17 : 13)
        DashPanel {
            Text("Today").font(Dash.title).foregroundStyle(Dash.muted)
            if store.events.isEmpty {
                Text("Nothing in the timetable or calendar.").font(body).foregroundStyle(Dash.muted)
            }
            ForEach(store.events.filter { $0.allDay || $0.end > store.now }.prefix(large ? 4 : 8)) { e in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(e.allDay ? "All day" : Dash.time(e.start)).font(body.monospacedDigit()).foregroundStyle(Dash.muted)
                        .frame(width: large ? 64 : 48, alignment: .leading)
                    Text([e.title, e.location].compactMap { $0 }.joined(separator: " · ")).font(body).lineLimit(2)
                }
            }
            if !large {
                Divider().overlay(Dash.line)
                Text("DUE IN 7 DAYS").font(.system(size: 11, weight: .semibold)).foregroundStyle(Dash.muted)
                if store.deadlines.isEmpty { Text("No Moodle deadlines.").font(body).foregroundStyle(Dash.muted) }
                ForEach(store.deadlines) { d in
                    HStack(alignment: .firstTextBaseline) {
                        Text([d.course, d.title].compactMap { $0 }.joined(separator: " ")).font(body).lineLimit(2)
                        Spacer()
                        Text(d.dueDate.map { Dash.day($0, now: store.now) } ?? d.due).font(.system(size: 12).monospacedDigit()).foregroundStyle(Dash.amber)
                    }
                }
                Divider().overlay(Dash.line)
                Text("REMINDERS").font(.system(size: 11, weight: .semibold)).foregroundStyle(Dash.muted)
                if store.reminders.isEmpty { Text("None set.").font(body).foregroundStyle(Dash.muted) }
                ForEach(store.reminders.prefix(6)) { r in
                    HStack(alignment: .firstTextBaseline) {
                        Text(r.text).font(body).lineLimit(2)
                        Spacer()
                        Text(r.date.map { Dash.day($0, now: store.now) } ?? "").font(.system(size: 12).monospacedDigit()).foregroundStyle(Dash.muted)
                    }
                }
            }
        }
    }
}

struct TalkBar: View {
    let model: AppModel
    var hotkeyLabel: String
    var large: Bool
    @State private var text = ""

    var body: some View {
        HStack(spacing: 12) {
            TextField("Ask Jarvis something…", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: large ? 20 : 15))
                .onSubmit(send)
            Text("or hold \(hotkeyLabel) and talk").font(.system(size: large ? 15 : 12)).foregroundStyle(Dash.muted)
            Button("Send", action: send).buttonStyle(DashButtonStyle(primary: !text.isEmpty))
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 18)
        .frame(height: large ? 60 : 48)
        .background(Capsule().fill(Dash.panel))
        .overlay(Capsule().stroke(Dash.line))
    }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        model.submit(t)
        text = ""
    }
}

// MARK: - Details

struct DetailsSheet: Identifiable {
    var card: AgentCard?
    var items: [ActionItem] = []
    var id: String { card?.id ?? items.map { String($0.id) }.joined(separator: ",") }
}

/// "Show the log" and Recent: RunLogView for finished requests; for one
/// still running, the stages seen so far with their times.
struct DetailsSheetView: View {
    var sheet: DetailsSheet
    let store: DashboardStore
    var close: () -> Void

    var body: some View {
        let items = sheet.items.isEmpty ? (store.finished(sessionId: sheet.card?.sessionId) ?? []) : sheet.items
        Group {
            if !items.isEmpty {
                RunLogView(items: items, close: close) { item in
                    if let id = item.sessionId { store.model.launcher?.open(sessionId: id) }
                }
                .frame(maxWidth: 1240, maxHeight: 820)
            } else if let card = sheet.card {
                running(card).frame(width: 560)
            }
        }
        .background(RoundedRectangle(cornerRadius: 16).fill(Dash.panel))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Dash.line))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.5), radius: 30, y: 10)
        .foregroundStyle(Dash.text)
        .environment(\.colorScheme, .dark)
    }

    private func running(_ card: AgentCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Running for \(Agents.elapsed(store.now.timeIntervalSince(card.startedAt)))")
                    .font(.system(size: 12).monospacedDigit()).foregroundStyle(Dash.muted)
                Spacer()
                CloseButton(close: close)
            }
            Text(card.request).font(.system(size: 16, weight: .medium))
            ForEach(Array(store.stages(for: card).enumerated()), id: \.offset) { _, s in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(s.at.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)))
                        .font(.system(size: 12).monospacedDigit()).foregroundStyle(Dash.muted)
                    Text(s.text).font(.system(size: 13))
                }
            }
            Text("The full details, with the conversation and every tool call, show here once it finishes.")
                .font(.system(size: 12)).foregroundStyle(Dash.muted)
        }
        .padding(22)
    }
}
