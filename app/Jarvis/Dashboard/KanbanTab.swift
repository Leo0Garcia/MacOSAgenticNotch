// The dashboard's Kanban tab (Leo, 2026-11-09): Leo's Obsidian Kanban board,
// read only, re-read within a moment of every save in Obsidian. The file is
// watched only while the tab is on screen. Format: DESIGN section 9.
// Groups, module colours, the toolbar and card metadata are ported from Leo's
// own Obsidian plugin (kanban-module-colours/main.js), display only: nothing here writes.

import AppKit
import SwiftUI

struct KanbanBoard: Equatable {
    var lanes: [KanbanLane] = []
    /// Frontmatter `last-sync` and `last-sync-note`, written by the board's sync.
    var lastSync: String?
    var lastSyncNote: String?
}

struct KanbanLane: Equatable {
    var title: String
    /// The lane starts with `**Complete**`: its cards are done.
    var complete = false
    var cards: [KanbanCard] = []
    var kind: Kanban.LaneKind { Kanban.laneKind(title) }
}

struct KanbanCard: Equatable {
    /// What's shown: links as their labels, without tags, dates or `%%` notes.
    var text: String
    var done: Bool
    var tags: [String] = []
    var due: Date?
    /// The first `[[link]]`'s note, which a click opens.
    var note: String?
    /// "COMP2311", "Amra", "Careers" or "Life" (the plugin's groupOf).
    var group = "Life"
    /// `%%src:kind:id|url%%`: where the card came from.
    var src: String?
    var srcURL: URL?
    /// `%%likely:reason%%` (unless `%%nolikely%%`): proof it's done, waiting for Leo.
    var likely: String?
}

/// Lecture notes written / lecture notes there are, for one module.
struct NotesProgress: Equatable, Sendable {
    var done = 0
    var total = 0
}

enum Kanban {
    /// Never fails: anything it doesn't recognise is skipped.
    static func parse(_ markdown: String) -> KanbanBoard {
        var lines = markdown.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        var board = KanbanBoard()
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            board.lastSync = frontmatterValue(lines[..<end], "last-sync")
            board.lastSyncNote = frontmatterValue(lines[..<end], "last-sync-note")
            lines.removeSubrange(...end)
        }
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

    private static func frontmatterValue(_ head: ArraySlice<String>, _ key: String) -> String? {
        for l in head where l.hasPrefix(key + ":") {
            return l.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces).replacing(/^["']|["']$/, with: "")
        }
        return nil
    }

    static func make(_ raw: String, done: Bool) -> KanbanCard {
        var note: String?
        var src: String?, srcURL: URL?, likely: String?, nolikely = false
        for m in raw.matches(of: /%%([\s\S]*?)%%/) {
            let body = m.1.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.lowercased().hasPrefix("src:") {
                let parts = body.dropFirst(4).split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                src = parts[0].trimmingCharacters(in: .whitespaces).split(separator: ":").first.map { $0.lowercased() } ?? ""
                if parts.count > 1 { srcURL = webURL(parts[1].trimmingCharacters(in: .whitespaces)) }
            } else if body.lowercased().hasPrefix("likely:") {
                let r = body.dropFirst(7).trimmingCharacters(in: .whitespaces)
                likely = r.isEmpty ? "Looks done" : r
            } else if body.lowercased() == "nolikely" {
                nolikely = true
            }
        }
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
        return KanbanCard(text: text, done: done, tags: tags, due: due, note: note, group: groupOf(raw),
                          src: src, srcURL: srcURL, likely: nolikely ? nil : likely)
    }

    /// Only http(s): a card's link must not open apps or local files.
    private static func webURL(_ s: String) -> URL? {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host != nil else { return nil }
        return u
    }

    // MARK: Ported from the plugin (same regexes, colours and order)

    static let colours: [String: UInt32] = ["2300": 0xD4537E, "2311": 0x8B5CF6, "2312": 0x378ADD, "2321": 0x14B8A6]
    static let palette: [UInt32] = [0xE0673A, 0x3B9C5A, 0x0891B2, 0xA855F7, 0xDB2777, 0x65A30D, 0x2563EB, 0xC2410C]
    static let groupColours: [String: UInt32] = ["Amra": 0xE0673A, "Careers": 0x2563EB, "Life": 0x65A30D]
    static let areaOrder = ["Amra", "Careers", "Life"]

    /// A module's colour: Leo's fixed ones, else a stable pick from the palette.
    static func colourFor(_ code: String) -> UInt32 {
        if let c = colours[code] { return c }
        var h: UInt32 = 0
        for u in code.utf16 { h = h &* 31 &+ UInt32(u) }
        return palette[Int(h % UInt32(palette.count))]
    }

    /// The plugin's CODE_RE: "COMP2311" or "comp 2311" → "2311". Simple word
    /// boundaries, as JavaScript's \b (Swift's default would join "x.COMP2311").
    static func moduleCode(_ text: String) -> String? {
        text.firstMatch(of: /\b(?i:COMP)\s?(\d{4})\b/.wordBoundaryKind(.simple)).map { String($0.1) }
    }

    static func groupOf(_ text: String) -> String {
        if let code = moduleCode(text) { return "COMP" + code }
        if text.contains(/(?i)(^|\s)#(amra|chrononight|work)\b/.wordBoundaryKind(.simple)) { return "Amra" }
        if text.contains(/(?i)(^|\s)#(careers?|internships?)\b/.wordBoundaryKind(.simple)) { return "Careers" }
        return "Life"
    }

    static func groupRank(_ g: String) -> String {
        if g.hasPrefix("COMP") { return "0" + g }
        return "1\(areaOrder.firstIndex(of: g) ?? 9)" + g
    }

    static func groupColour(_ g: String) -> UInt32 {
        g.hasPrefix("COMP") ? colourFor(String(g.dropFirst(4))) : groupColours[g] ?? 0x888888
    }

    static func groupName(_ g: String) -> String { g == "Amra" ? "Amra work" : g }

    enum LaneKind { case complete, overdue, week, later, progress, other }

    static func laneKind(_ title: String) -> LaneKind {
        let t = title.trimmingCharacters(in: .whitespaces)
        if t.contains(/^(?i)complete/) { return .complete }
        if t.contains(/^(?i)overdue/) { return .overdue }
        if t.contains(/^(?i)(this week|due this week)/) { return .week }
        if t.contains(/^(?i)(later|not started|to do|backlog)/) { return .later }
        if t.contains(/^(?i)in[\s-]?progress/) { return .progress }
        return .other
    }

    /// A lane's cards in runs of one group, groups by groupRank and cards by
    /// due date (undated last), as the plugin's tidyBoard orders them.
    static func sections(_ cards: [KanbanCard]) -> [(group: String, cards: [KanbanCard])] {
        let sorted = cards.enumerated().sorted { a, b in
            let (ga, gb) = (groupRank(a.element.group), groupRank(b.element.group))
            if ga != gb { return ga < gb }
            let (da, db) = (a.element.due ?? .distantFuture, b.element.due ?? .distantFuture)
            return da != db ? da < db : a.offset < b.offset
        }.map(\.element)
        var out: [(group: String, cards: [KanbanCard])] = []
        for c in sorted {
            if out.last?.group == c.group { out[out.count - 1].cards.append(c) } else { out.append((c.group, [c])) }
        }
        return out
    }

    /// Every group on the board, in groupRank order (the toolbar's chips).
    static func groups(_ board: KanbanBoard) -> [String] {
        Set(board.lanes.flatMap { $0.cards.map(\.group) }).sorted { groupRank($0) < groupRank($1) }
    }

    enum DueState { case late, soon, ok }

    /// "3d late", "today", "tomorrow", "5d".
    static func relDue(_ due: Date, now: Date) -> (label: String, state: DueState) {
        let c = Calendar.current
        let days = c.dateComponents([.day], from: c.startOfDay(for: now), to: c.startOfDay(for: due)).day ?? 0
        if days < 0 { return ("\(-days)d late", .late) }
        if days == 0 { return ("today", .soon) }
        if days == 1 { return ("tomorrow", .soon) }
        return ("\(days)d", days <= 2 ? .soon : .ok)
    }

    /// Lecture notes per module: files under a `Lectures` folder named
    /// "… - Lecture …" or "… - Week …" with a COMP code in the path; written once they reach 1300 bytes.
    nonisolated static func notesProgress(vault: URL) -> [String: NotesProgress] {
        var out: [String: NotesProgress] = [:]
        let keys: [URLResourceKey] = [.fileSizeKey, .isRegularFileKey]
        guard let e = FileManager.default.enumerator(at: vault, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return out }
        let base = vault.standardizedFileURL.path + "/"
        for case let f as URL in e where f.pathExtension == "md" {
            let path = String(f.standardizedFileURL.path.dropFirst(base.count))
            let name = f.deletingPathExtension().lastPathComponent
            guard path.contains("/Lectures/"), name.contains(#/(?i) - (Lecture|Week) /#), let code = moduleCode(path) else { continue }
            let v = try? f.resourceValues(forKeys: Set(keys))
            guard v?.isRegularFile == true else { continue }
            let g = "COMP" + code
            out[g, default: NotesProgress()].total += 1
            if (v?.fileSize ?? 0) >= 1300 { out[g, default: NotesProgress()].done += 1 }
        }
        return out
    }

    /// "today 07:17", "yesterday 22:05", else "2026-11-03 09:00"; anything unparsable as written.
    static func fmtSync(_ s: String, now: Date) -> String {
        let f = ISO8601DateFormatter()
        var d = f.date(from: s)
        if d == nil { f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; d = f.date(from: s) }
        guard let d else { return s }
        let c = Calendar.current
        let time = d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if c.isDate(d, inSameDayAs: now) { return "today " + time }
        if let y = c.date(byAdding: .day, value: -1, to: now), c.isDate(d, inSameDayAs: y) { return "yesterday " + time }
        let ymd = c.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d ", ymd.year ?? 0, ymd.month ?? 0, ymd.day ?? 0) + time
    }

    private static func date(_ y: Int?, _ m: Int?, _ d: Int?) -> Date? {
        guard let y, let m, let d, (1...12).contains(m), (1...31).contains(d) else { return nil }
        return Calendar.current.date(from: DateComponents(year: y, month: m, day: d))
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
    /// Lecture notes per module, refreshed with the board.
    private(set) var progress: [String: NotesProgress] = [:]
    let url: URL
    @ObservationIgnored private var progressTask: Task<Void, Never>?
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
        progressTask?.cancel()
        source?.cancel()
        source = nil
    }

    func load() {
        guard let data = try? Data(contentsOf: url) else { missing = true; return }
        missing = false
        let b = Kanban.parse(String(decoding: data, as: UTF8.self))
        if b != board { board = b }
        updated = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        refreshProgress()
    }

    /// Walks the vault off the main thread (it's big); snapshots need it at once.
    private func refreshProgress() {
        let vault = url.deletingLastPathComponent()
        if OffscreenRender.active { progress = Kanban.notesProgress(vault: vault); return }
        progressTask?.cancel()
        progressTask = Task { [weak self] in
            let p = await Task.detached(priority: .utility) { Kanban.notesProgress(vault: vault) }.value
            guard !Task.isCancelled, let self, p != self.progress else { return }
            self.progress = p
        }
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
    /// The toolbar chip: "All" or one group (the plugin's `filter`).
    @AppStorage("KanbanFilter") private var filter = "All"
    /// Folded groups as "lane|group" lines (the plugin's `collapsed`).
    @AppStorage("KanbanCollapsedGroups") private var collapsedRaw = ""

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
            if !feed.missing { toolbar }
            lanes
        }
        .onChange(of: active, initial: true) { _, on in on ? feed.start() : feed.stop() }
        .onDisappear { feed.stop() }
    }

    private var groups: [String] { Kanban.groups(feed.board) }
    /// A remembered chip whose group has left the board shows everything.
    private var shown: String { groups.contains(filter) ? filter : "All" }
    private var collapsed: Set<String> { Set(collapsedRaw.split(separator: "\n").map(String.init)) }

    private var toolbar: some View {
        HStack(alignment: .center, spacing: 16) {
            HStack(spacing: 6) {
                ForEach(["All"] + groups, id: \.self) { g in
                    let on = g == shown
                    let c = g == "All" ? Dash.muted : Color(hex: Kanban.groupColour(g))
                    Button { filter = on ? "All" : g } label: {
                        Text(Kanban.groupName(g)).font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(on ? Color.white : Dash.muted)
                            .padding(.horizontal, 10).frame(height: 22)
                            .background(Capsule().fill(on ? c : c.opacity(0.14)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            Spacer(minLength: 0)
            ForEach(feed.progress.sorted { $0.key < $1.key }, id: \.key) { g, p in
                let c = Color(hex: Kanban.groupColour(g))
                HStack(spacing: 6) {
                    Text(g.dropFirst(4))
                    Capsule().fill(c.opacity(0.18)).frame(width: 60, height: 5)
                        .overlay(alignment: .leading) { Capsule().fill(c).frame(width: p.total > 0 ? 60 * CGFloat(p.done) / CGFloat(p.total) : 0) }
                    Text("\(p.done)/\(p.total)").monospacedDigit()
                }
                .font(.system(size: 11)).foregroundStyle(Dash.muted)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(g) lecture notes written: \(p.done) of \(p.total)")
                .help("\(g) lecture notes written: \(p.done) of \(p.total)")
            }
            Text(feed.board.lastSync.map { "Synced " + Kanban.fmtSync($0, now: now) + (feed.board.lastSyncNote.map { " · " + $0 } ?? "") } ?? "Not synced yet")
                .font(.system(size: 11)).foregroundStyle(Dash.muted.opacity(0.7)).lineLimit(1)
        }
    }

    @ViewBuilder private var lanes: some View {
        let row = HStack(alignment: .top, spacing: 12) {
            ForEach(Array(feed.board.lanes.enumerated()), id: \.offset) { _, lane in
                let done = lane.complete || lane.kind == .complete
                LaneView(lane: lane, done: done, open: done == flipped.contains(lane.title), filter: shown, collapsed: collapsed, now: now, vault: vault,
                         toggle: { flipped.formSymmetricDifference([lane.title]) },
                         toggleGroup: { g in
                             var c = collapsed
                             c.formSymmetricDifference([lane.title + "|" + g])
                             collapsedRaw = c.sorted().joined(separator: "\n")
                         })
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        if OffscreenRender.active { row.frame(maxWidth: .infinity, alignment: .leading).clipped() } else { ScrollView(.horizontal) { row } }
    }
}

private struct LaneView: View {
    var lane: KanbanLane
    /// Completed lane: no group headers, cards in file order (as the plugin).
    var done: Bool
    var open: Bool
    var filter: String
    var collapsed: Set<String>
    var now: Date
    var vault: URL
    var toggle: () -> Void
    var toggleGroup: (String) -> Void

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
                    VStack(alignment: .leading, spacing: 8) {
                        if done {
                            ForEach(Array(lane.cards.filter { filter == "All" || $0.group == filter }.enumerated()), id: \.offset) { _, c in card(c) }
                        } else {
                            ForEach(Kanban.sections(lane.cards).filter { filter == "All" || $0.group == filter }, id: \.group) { s in
                                let folded = collapsed.contains(lane.title + "|" + s.group)
                                GroupHeader(group: s.group, count: s.cards.count, folded: folded) { toggleGroup(s.group) }
                                if !folded { ForEach(Array(s.cards.enumerated()), id: \.offset) { _, c in card(c) } }
                            }
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(width: open ? 264 : 180, alignment: .topLeading)
        .frame(maxHeight: open ? .infinity : nil, alignment: .top)
        .liquidGlass(in: .rect(cornerRadius: 14))
    }

    private func card(_ c: KanbanCard) -> some View {
        CardView(card: c, now: now, link: c.note.flatMap { Kanban.obsidianURL(vault: vault, note: $0) })
    }
}

/// A group's subsection header: chevron, name, count and a rule, in the group's colour.
private struct GroupHeader: View {
    var group: String
    var count: Int
    var folded: Bool
    var toggle: () -> Void

    var body: some View {
        let c = Color(hex: Kanban.groupColour(group))
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: folded ? "chevron.right" : "chevron.down").font(.system(size: 9, weight: .bold)).frame(width: 10)
                Text(Kanban.groupName(group).uppercased()).font(.system(size: 11, weight: .bold)).tracking(0.44).lineLimit(1)
                Text("\(count)").font(.system(size: 11, weight: .semibold)).padding(.horizontal, 6).background(Capsule().fill(c.opacity(0.16)))
                Rectangle().fill(c.opacity(0.3)).frame(height: 1)
            }
            .foregroundStyle(c)
            .padding(.top, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(Kanban.groupName(group)), \(count) cards, \(folded ? "folded" : "open")")
    }
}

private struct CardView: View {
    var card: KanbanCard
    var now: Date
    var link: URL?
    @State private var hover = false

    static let red = Color(hex: 0xE24B4A)
    static let green = Color(hex: 0x3FB950)
    static let srcIcons = ["moodle": "graduationcap", "handin": "arrow.up.doc", "slack": "message", "notes": "note.text", "tutorial": "pencil",
                           "calendar": "calendar", "trackr": "briefcase", "anki": "square.stack", "amra": "storefront"]

    private var likely: String? { card.done ? nil : card.likely }
    private var accent: Color? { card.group.hasPrefix("COMP") ? Color(hex: Kanban.groupColour(card.group)) : nil }

    var body: some View {
        Button { if let link { NSWorkspace.shared.open(link) } } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if card.done { Text("✓").font(.system(size: 12, weight: .bold)).foregroundStyle(Color(hex: Appearance.shared.palette.done[0])) }
                    Text(card.text).font(.system(size: 13)).foregroundStyle(card.done ? Dash.muted : Dash.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let due = card.done ? nil : card.due
                if due != nil || card.src != nil || !card.tags.isEmpty {
                    HStack(spacing: 4) {
                        if let s = card.src { source(s) }
                        if let d = due {
                            let r = Kanban.relDue(d, now: now)
                            chip(r.label, color: r.state == .late ? Self.red : r.state == .soon ? Dash.amber : Dash.muted)
                                .help("Due " + d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
                        }
                        ForEach(card.tags, id: \.self) { chip("#" + $0, color: Dash.muted) }
                    }
                }
                if let l = likely {
                    Label("Likely done", systemImage: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Self.green)
                        .padding(.horizontal, 7).frame(height: 19).background(Capsule().fill(Self.green.opacity(0.18)))
                        .help(l).accessibilityHint(l)
                }
            }
            .padding(10)
            .padding(.leading, accent == nil ? 0 : 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(hover && link != nil ? Color.white.opacity(0.1) : Dash.inset))
            .overlay(alignment: .leading) {
                if let accent { UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10).fill(accent).frame(width: 3) }
            }
            .overlay {
                if likely != nil { RoundedRectangle(cornerRadius: 10).strokeBorder(Self.green.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(link != nil || card.srcURL != nil) // not .disabled, which would dim the card
        .onHover { hover = $0 }
        .help(link == nil ? "" : "Open in Obsidian")
    }

    @ViewBuilder private func source(_ kind: String) -> some View {
        let icon = Image(systemName: Self.srcIcons[kind] ?? "circle.dotted").font(.system(size: 11)).foregroundStyle(Dash.muted)
            .frame(width: 16, height: 19)
        if let u = card.srcURL {
            Button { NSWorkspace.shared.open(u) } label: { icon.contentShape(Rectangle()) }
                .buttonStyle(.plain).help("From \(kind) (open)").accessibilityLabel("From \(kind), open")
        } else {
            icon.help("From \(kind)").accessibilityLabel("From \(kind)")
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
