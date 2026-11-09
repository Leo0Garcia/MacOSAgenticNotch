// The dashboard's Kanban tab (Leo, 2026-11-09): Leo's Obsidian Kanban board,
// read only, re-read within a moment of every save in Obsidian. The file is
// watched only while the tab is on screen. Format: DESIGN section 9.

import AppKit
import SwiftUI

struct KanbanBoard: Equatable {
    var lanes: [KanbanLane] = []
}

struct KanbanLane: Equatable {
    var title: String
    /// The lane starts with `**Complete**`: its cards are done.
    var complete = false
    var cards: [KanbanCard] = []
}

struct KanbanCard: Equatable {
    /// What's shown: links as their labels, without tags, dates or `%%` notes.
    var text: String
    var done: Bool
    var tags: [String] = []
    var due: Date?
    /// The first `[[link]]`'s note, which a click opens.
    var note: String?
}

enum Kanban {
    enum Due { case overdue, today, later }

    /// Never fails: anything it doesn't recognise is skipped.
    static func parse(_ markdown: String) -> KanbanBoard {
        var lines = markdown.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            lines.removeSubrange(...end)
        }
        var board = KanbanBoard()
        var card: (done: Bool, lines: [String])?
        func flush() {
            if let c = card, !board.lanes.isEmpty { board.lanes[board.lanes.count - 1].cards.append(make(c.lines.joined(separator: "\n"), done: c.done)) }
            card = nil
        }
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            // The archive (after ***) and the settings block aren't lanes.
            if t == "***" || t.hasPrefix("%% kanban:settings") { break }
            if line.hasPrefix("## ") {
                flush()
                board.lanes.append(KanbanLane(title: t.dropFirst(3).trimmingCharacters(in: .whitespaces)))
            } else if board.lanes.isEmpty || t.isEmpty {
                continue
            } else if t == "**Complete**" {
                board.lanes[board.lanes.count - 1].complete = true
            } else if line.hasPrefix("- ") {
                flush()
                card = checkbox(String(line.dropFirst(2)))
            } else {
                card?.lines.append(t)
            }
        }
        flush()
        return board
    }

    /// "[x] text" → (true, ["text"]); no checkbox is an open card.
    private static func checkbox(_ s: String) -> (done: Bool, lines: [String]) {
        let c = Array(s)
        guard c.count >= 3, c[0] == "[", c[2] == "]" else { return (false, [s]) }
        return (c[1] != " ", [String(c.dropFirst(3)).trimmingCharacters(in: .whitespaces)])
    }

    static func make(_ raw: String, done: Bool) -> KanbanCard {
        var note: String?
        var s = raw.replacing(/%%[\s\S]*?(%%|$)/, with: "")
        s = s.replacing(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/) { m in
            let target = String(m.1)
            if note == nil { note = target.split(separator: "#").first.map(String.init) }
            return m.2.map(String.init) ?? target
        }
        let due = s.firstMatch(of: /@\{(\d{4})-(\d{2})-(\d{2})\}/).flatMap { date(Int($0.1), Int($0.2), Int($0.3)) }
        s = s.replacing(/@@?\{[^}]*\}/, with: "")
        let tags = s.matches(of: /(?:^|\s)#([\p{L}\p{N}_\/-]+)/).map { String($0.1) }
        s = s.replacing(/(^|\s)#[\p{L}\p{N}_\/-]+/) { $0.1 }
        s = s.replacing(/\s\^[\w-]+$/, with: "") // block id
        let text = s.split(separator: "\n").map { $0.split(separator: " ").joined(separator: " ") }.filter { !$0.isEmpty }.joined(separator: "\n")
        return KanbanCard(text: text, done: done, tags: tags, due: due, note: note)
    }

    private static func date(_ y: Int?, _ m: Int?, _ d: Int?) -> Date? {
        guard let y, let m, let d, (1...12).contains(m), (1...31).contains(d) else { return nil }
        return Calendar.current.date(from: DateComponents(year: y, month: m, day: d))
    }

    static func due(_ date: Date, now: Date) -> Due {
        if Calendar.current.isDate(date, inSameDayAs: now) { return .today }
        return date < now ? .overdue : .later
    }

    static func obsidianURL(vault: URL, note: String) -> URL? {
        func q(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }
        return URL(string: "obsidian://open?vault=\(q(vault.lastPathComponent))&file=\(q(note))")
    }
}

/// Kanban.md, re-read about 150 ms after it changes. Obsidian may replace the
/// file on save, so a delete or rename re-opens the watcher on the new file.
@MainActor
@Observable
final class KanbanFeed {
    private(set) var board = KanbanBoard()
    private(set) var updated: Date?
    private(set) var missing = false
    let url: URL
    @ObservationIgnored private var source: DispatchSourceFileSystemObject?
    @ObservationIgnored private var watchingFolder = false
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private(set) var watching = false

    init(url: URL) { self.url = url }

    func start() {
        guard !watching else { return }
        watching = true
        watch()
        load()
    }

    func stop() {
        watching = false
        pending?.cancel()
        source?.cancel()
        source = nil
    }

    func load() {
        guard let data = try? Data(contentsOf: url) else { missing = true; return }
        missing = false
        let b = Kanban.parse(String(decoding: data, as: UTF8.self))
        if b != board { board = b }
        updated = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    private func watch() {
        var fd = open(url.path, O_EVTONLY)
        // Not there (mid-save, or not made yet): watch its folder until it appears.
        watchingFolder = fd < 0
        if fd < 0 { fd = open(url.deletingLastPathComponent().path, O_EVTONLY) }
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename, .revoke], queue: .main)
        s.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.changed() } }
        s.setCancelHandler { close(fd) }
        s.resume()
        source = s
    }

    private func changed() {
        guard let s = source else { return }
        if watchingFolder || !s.data.isDisjoint(with: [.delete, .rename, .revoke]) {
            s.cancel()
            source = nil
        }
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled, let self, self.watching else { return }
            if self.source == nil { self.watch() }
            self.load()
        }
    }
}

struct KanbanTab: View {
    let feed: KanbanFeed
    let vault: URL
    var active: Bool
    var now: Date
    /// Lanes Leo opened or closed, against their default (done lanes start closed).
    @State private var flipped: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(feed.missing ? "No Kanban.md in \(vault.path)" : "\(feed.board.lanes.reduce(0) { $0 + $1.cards.count }) cards")
                    .font(Dash.title).foregroundStyle(Dash.muted)
                Spacer()
                if let d = feed.updated {
                    Text("Updated " + Dash.day(d, now: now).lowercased()).font(.system(size: 12)).foregroundStyle(Dash.muted)
                }
            }
            lanes
        }
        .onChange(of: active, initial: true) { _, on in on ? feed.start() : feed.stop() }
        .onDisappear { feed.stop() }
    }

    @ViewBuilder private var lanes: some View {
        let row = HStack(alignment: .top, spacing: 12) {
            ForEach(Array(feed.board.lanes.enumerated()), id: \.offset) { _, lane in
                LaneView(lane: lane, open: lane.complete == flipped.contains(lane.title), now: now, vault: vault) {
                    flipped.formSymmetricDifference([lane.title])
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        if OffscreenRender.active { row.frame(maxWidth: .infinity, alignment: .leading).clipped() } else { ScrollView(.horizontal) { row } }
    }
}

private struct LaneView: View {
    var lane: KanbanLane
    var open: Bool
    var now: Date
    var vault: URL
    var toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    Text(lane.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text("\(lane.cards.count)").font(.system(size: 11, weight: .medium)).foregroundStyle(Dash.muted)
                        .padding(.horizontal, 6).frame(height: 18).background(Capsule().fill(Color.white.opacity(0.06)))
                    Spacer(minLength: 0)
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Dash.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(lane.title), \(lane.cards.count) cards, \(open ? "open" : "closed")")
            if open {
                Scrolling {
                    VStack(spacing: 8) {
                        ForEach(Array(lane.cards.enumerated()), id: \.offset) { _, c in
                            CardView(card: c, now: now, link: c.note.flatMap { Kanban.obsidianURL(vault: vault, note: $0) })
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(width: open ? 264 : 180, alignment: .topLeading)
        .frame(maxHeight: open ? .infinity : nil, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 14).fill(Dash.panel.opacity(0.92)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Dash.line))
    }
}

private struct CardView: View {
    var card: KanbanCard
    var now: Date
    var link: URL?
    @State private var hover = false

    static let red = Color(hex: 0xF0646A)

    var body: some View {
        Button { if let link { NSWorkspace.shared.open(link) } } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if card.done { Text("✓").font(.system(size: 12, weight: .bold)).foregroundStyle(Color(hex: Appearance.shared.palette.done[0])) }
                    Text(card.text).font(.system(size: 13)).foregroundStyle(card.done ? Dash.muted : Dash.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if card.due != nil || !card.tags.isEmpty {
                    HStack(spacing: 4) {
                        if let d = card.due { chip(dueLabel(d), color: dueColor(d)) }
                        ForEach(card.tags, id: \.self) { chip("#" + $0, color: Dash.muted) }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(hover && link != nil ? Dash.line : Dash.card))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(link != nil) // not .disabled, which would dim the card
        .onHover { hover = $0 }
        .help(link == nil ? "" : "Open in Obsidian")
    }

    private func dueLabel(_ d: Date) -> String {
        Kanban.due(d, now: now) == .today ? "Today" : d.formatted(.dateTime.day().month(.abbreviated))
    }

    private func dueColor(_ d: Date) -> Color {
        if card.done { return Dash.muted }
        switch Kanban.due(d, now: now) {
        case .overdue: return Self.red
        case .today: return Dash.amber
        case .later: return Dash.muted
        }
    }

    private func chip(_ s: String, color: Color) -> some View {
        Text(s).font(.system(size: 11, weight: .medium)).foregroundStyle(color)
            .padding(.horizontal, 7).frame(height: 19)
            .background(Capsule().fill(color.opacity(0.12)))
    }
}

enum DashTab: String { case dashboard, kanban }

/// Dashboard | Kanban in the header, ⌘1 and ⌘2.
struct DashTabSwitch: View {
    @Binding var tab: DashTab

    var body: some View {
        HStack(spacing: 2) {
            button("Dashboard", .dashboard, key: "1")
            button("Kanban", .kanban, key: "2")
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.04)))
    }

    private func button(_ label: String, _ t: DashTab, key: KeyEquivalent) -> some View {
        Button(label) { tab = t }
            .buttonStyle(DashButtonStyle(selected: tab == t, small: true))
            .keyboardShortcut(key, modifiers: .command)
            .help("\(label) (⌘\(key.character))")
    }
}
