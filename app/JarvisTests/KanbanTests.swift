import Foundation
import Testing
@testable import Jarvis

/// The real board's structure (DESIGN section 9) with made-up cards.
private let fixture = """
---

kanban-plugin: board
last-sync: 2026-11-09T07:17:52+00:00
last-sync-note: "3 new cards"

---

## Overdue

- [ ] Do [[COMP9999 - Tutorial 5|COMP9999 Tutorial 5]] #comp9999 @{2026-11-01} %%src:tutorial:COMP9999 - Tutorial 5|%%
- [ ] Talk to Sam about the site #freelance @{2026-11-05} %%src:slack:D1|https://x.slack.com/a%% %%likely:held 5 Nov%%


## This week

- [ ] [[Lecture 17]] notes #comp9999 #uni/notes
\tsecond line of the card
  - [ ] a sub-step stays in the card
- [ ] Buy chalk ^abc123
- [x] Done but not in a done lane


## Later

- [ ] Multi-line %%hidden
across lines%% after
- plain bullet

## Completed

**Complete**
- [x] [[Folder/Note#Heading|Write notes]] #comp9999 @{2026-11-11}
- [X] Need to do washing




%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[false,false,false,false]}
```
%%
"""

@Suite struct KanbanParserTests {
    let board = Kanban.parse(fixture)

    @Test func lanesInOrder() {
        #expect(board.lanes.map(\.title) == ["Overdue", "This week", "Later", "Completed"])
        #expect(board.lanes.map(\.cards.count) == [2, 3, 2, 2])
    }

    @Test func completedLane() {
        #expect(board.lanes.map(\.complete) == [false, false, false, true])
        #expect(board.lanes[3].cards.allSatisfy { $0.done })
    }

    @Test func checkboxes() {
        #expect(!board.lanes[0].cards[0].done)
        #expect(board.lanes[1].cards[2].done)
        #expect(!board.lanes[2].cards[1].done) // a bullet without a checkbox
        #expect(board.lanes[2].cards[1].text == "plain bullet")
    }

    @Test func linksShowTheirLabelsAndOpenTheirNote() {
        let c = board.lanes[0].cards[0]
        #expect(c.text == "Do COMP9999 Tutorial 5")
        #expect(c.note == "COMP9999 - Tutorial 5")
        #expect(board.lanes[1].cards[0].note == "Lecture 17")
        #expect(board.lanes[3].cards[0].text == "Write notes")
        #expect(board.lanes[3].cards[0].note == "Folder/Note")
        #expect(board.lanes[0].cards[1].note == nil)
    }

    @Test func tagsBecomeChips() {
        #expect(board.lanes[0].cards[0].tags == ["comp9999"])
        #expect(board.lanes[1].cards[0].tags == ["comp9999", "uni/notes"])
        #expect(board.lanes[1].cards[1].tags.isEmpty)
    }

    @Test func dates() {
        let c = Calendar.current
        #expect(board.lanes[0].cards[0].due == c.date(from: DateComponents(year: 2026, month: 11, day: 1)))
        #expect(board.lanes[2].cards[0].due == nil)
        #expect(Kanban.make("x @{2026-13-40}", done: false).due == nil)
    }

    @Test func relDue() {
        let c = Calendar.current
        let now = c.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 23))!
        func rel(_ d: Int) -> (String, Kanban.DueState) {
            let r = Kanban.relDue(c.date(from: DateComponents(year: 2026, month: 11, day: d))!, now: now)
            return (r.label, r.state)
        }
        #expect(rel(6) == ("3d late", .late))
        #expect(rel(8) == ("1d late", .late))
        #expect(rel(9) == ("today", .soon))
        #expect(rel(10) == ("tomorrow", .soon))
        #expect(rel(11) == ("2d", .soon))
        #expect(rel(14) == ("5d", .ok))
    }

    @Test func frontmatterSync() {
        #expect(board.lastSync == "2026-11-09T07:17:52+00:00")
        #expect(board.lastSyncNote == "3 new cards")
        #expect(Kanban.parse("## A").lastSync == nil)
    }

    @Test func fmtSync() {
        let c = Calendar.current
        let now = c.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 20))!
        let iso = ISO8601DateFormatter()
        func at(_ day: Int, _ h: Int) -> String { iso.string(from: c.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: 5))!) }
        #expect(Kanban.fmtSync(at(9, 7), now: now) == "today 07:05")
        #expect(Kanban.fmtSync(at(8, 22), now: now) == "yesterday 22:05")
        #expect(Kanban.fmtSync(at(3, 9), now: now) == "2026-11-03 09:05")
        #expect(Kanban.fmtSync("whenever", now: now) == "whenever")
    }

    @Test func hiddenMetadata() {
        let tut = board.lanes[0].cards[0]
        #expect(tut.src == "tutorial")
        #expect(tut.srcURL == nil)
        #expect(tut.likely == nil)
        let talk = board.lanes[0].cards[1]
        #expect(talk.src == "slack")
        #expect(talk.srcURL?.absoluteString == "https://x.slack.com/a")
        #expect(talk.likely == "held 5 Nov")
        #expect(Kanban.make("a %%likely:%%", done: false).likely == "Looks done")
        #expect(Kanban.make("a %%likely:sent%% %%nolikely%%", done: false).likely == nil)
        #expect(Kanban.make("a %%src:Moodle:12|https://m.example/x%%", done: false).src == "moodle")
        for bad in ["file:///etc/hosts", "javascript:alert(1)", "obsidian://open?x", "not a url"] {
            #expect(Kanban.make("a %%src:slack:1|\(bad)%%", done: false).srcURL == nil)
        }
    }

    @Test func groups() {
        #expect(Kanban.groupOf("Do COMP9999 Tutorial 5") == "COMP9999")
        #expect(Kanban.groupOf("notes #comp1001") == "COMP1001")
        #expect(Kanban.groupOf("comp 1002 sheet") == "COMP1002")
        #expect(Kanban.groupOf("x.COMP1003") == "COMP1003")
        #expect(Kanban.groupOf("COMP12345") == "Life")
        #expect(Kanban.groupOf("Fix footer #amra") == "Amra")
        #expect(Kanban.groupOf("Booking page #Chrononight") == "Amra")
        #expect(Kanban.groupOf("Invoice #work") == "Amra")
        #expect(Kanban.groupOf("Invoice #workshop") == "Life")
        #expect(Kanban.groupOf("Apply #internships") == "Careers")
        #expect(Kanban.groupOf("Apply #career") == "Careers")
        #expect(Kanban.groupOf("Buy chalk") == "Life")
        #expect(Kanban.groupOf("email#amra") == "Life") // a tag needs a space before it
        #expect(board.lanes[0].cards.map(\.group) == ["COMP9999", "Life"])
        let order = ["Life", "COMP2311", "Careers", "Amra", "COMP1001"].sorted { Kanban.groupRank($0) < Kanban.groupRank($1) }
        #expect(order == ["COMP1001", "COMP2311", "Amra", "Careers", "Life"])
        #expect(Kanban.groups(board) == ["COMP9999", "Life"])
        #expect(Kanban.groupName("Amra") == "Amra work")
    }

    @Test func colours() {
        #expect(Kanban.colourFor("2311") == 0x8B5CF6)
        #expect(Kanban.colourFor("1001") == 0xE0673A) // hashed into the palette like the plugin
        #expect(Kanban.colourFor("1002") == 0x3B9C5A)
        #expect(Kanban.groupColour("COMP2312") == 0x378ADD)
        #expect(Kanban.groupColour("Careers") == 0x2563EB)
        #expect(Kanban.groupColour("Other") == 0x888888)
    }

    @Test func laneKinds() {
        #expect(Kanban.laneKind("Completed") == .complete)
        #expect(Kanban.laneKind(" Overdue ") == .overdue)
        #expect(Kanban.laneKind("Due this week") == .week)
        #expect(Kanban.laneKind("not started") == .later)
        #expect(Kanban.laneKind("In-progress") == .progress)
        #expect(Kanban.laneKind("Ideas") == .other)
    }

    @Test func sectionsGroupAndSortByDue() {
        let cards = [
            "Buy milk", "Shop #amra @{2026-11-20}", "COMP2000 late @{2026-11-12}", "Apply #careers",
            "COMP1000 undated", "COMP2000 soon @{2026-11-10}", "Shop2 #amra @{2026-11-02}", "COMP1000 dated @{2026-11-30}",
        ].map { Kanban.make($0, done: false) }
        let s = Kanban.sections(cards)
        #expect(s.map(\.group) == ["COMP1000", "COMP2000", "Amra", "Careers", "Life"])
        #expect(s.map { $0.cards.map(\.text) } == [["COMP1000 dated", "COMP1000 undated"], ["COMP2000 soon", "COMP2000 late"],
                                                   ["Shop2", "Shop"], ["Apply"], ["Buy milk"]])
    }

    @Test func notesProgress() throws {
        let fm = FileManager.default
        let vault = fm.temporaryDirectory.appendingPathComponent("jarvis-notes-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: vault) }
        func put(_ path: String, bytes: Int) throws {
            let u = vault.appendingPathComponent(path)
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: 0x61, count: bytes).write(to: u)
        }
        try put("Uni/COMP1001/Lectures/COMP1001 - Lecture 1.md", bytes: 1300)
        try put("Uni/COMP1001/Lectures/COMP1001 - Lecture 2.md", bytes: 1299)
        try put("Uni/COMP1001/Lectures/COMP1001 - week 3.md", bytes: 5000)
        try put("Uni/COMP1002/Lectures/Trees - Lecture 4.md", bytes: 2000)
        try put("Uni/COMP1002/Lectures/Lecture 5.md", bytes: 2000)         // no " - Lecture "
        try put("Uni/COMP1002/Tutorials/COMP1002 - Lecture 6.md", bytes: 2000) // not under Lectures
        try put("Lectures/COMP1003 - Lecture 1.md", bytes: 2000)          // Lectures at the top has no "/" before it
        try put("Uni/Life/Lectures/Cooking - Lecture 1.md", bytes: 2000)  // no module code
        try put("Uni/COMP1002/Lectures/COMP1002 - Lecture 7.pdf", bytes: 2000)
        #expect(Kanban.notesProgress(vault: vault) == ["COMP1001": NotesProgress(done: 2, total: 3), "COMP1002": NotesProgress(done: 1, total: 1)])
    }

    @Test func hiddenNotesAreDropped() {
        #expect(board.lanes[0].cards[1].text == "Talk to Sam about the site")
        #expect(board.lanes[2].cards[0].text == "Multi-line after")
        #expect(Kanban.make("open %%never closed", done: false).text == "open")
    }

    @Test func continuationLinesAndBlockIds() {
        #expect(board.lanes[1].cards[0].text == "Lecture 17 notes\nsecond line of the card\n- [ ] a sub-step stays in the card")
        #expect(board.lanes[1].cards[1].text == "Buy chalk")
    }

    @Test func settingsAndArchiveAreNotLanes() {
        #expect(!board.lanes.contains { $0.cards.contains { $0.text.contains("kanban-plugin") } })
        let archived = Kanban.parse("## A\n- [ ] one\n***\n## Archive\n- [x] old")
        #expect(archived.lanes.map(\.title) == ["A"])
    }

    @Test(arguments: ["", "---", "---\nno end", "- [ ] card before any lane", "## ", "- [", "%%", "\r\n## L\r\n- [x]\r\n", "## L\n- [ ] [[unclosed|x"])
    func oddInputNeverCrashes(_ s: String) {
        _ = Kanban.parse(s)
    }

    @Test func obsidianURL() {
        let u = Kanban.obsidianURL(vault: URL(fileURLWithPath: "/v/Obsidian Master Vault"), note: "COMP2311 - Tutorial 5&x")
        #expect(u?.absoluteString == "obsidian://open?vault=Obsidian%20Master%20Vault&file=COMP2311%20%2D%20Tutorial%205%26x")
    }
}

@MainActor
@Suite struct KanbanFeedTests {
    /// Waits for the watcher (no fixed sleeps longer than needed).
    private func until(_ ok: () -> Bool) async {
        for _ in 0..<100 where !ok() { try? await Task.sleep(for: .milliseconds(20)) }
    }

    @Test func followsInPlaceWritesAndAtomicReplaces() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-kanban-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("Kanban.md")
        let feed = KanbanFeed(url: file)
        feed.start()
        #expect(feed.missing)

        try Data("## A\n- [ ] one".utf8).write(to: file) // appears
        await until { feed.board.lanes.first?.cards.count == 1 }
        #expect(feed.board.lanes.first?.cards.count == 1)

        let h = try FileHandle(forWritingTo: file) // in place
        try h.seekToEnd()
        try h.write(contentsOf: Data("\n- [ ] two".utf8))
        try h.close()
        await until { feed.board.lanes.first?.cards.count == 2 }
        #expect(feed.board.lanes.first?.cards.count == 2)

        for n in 3...4 { // replaced by rename, twice, so the re-opened watcher is checked too
            let tmp = dir.appendingPathComponent(".Kanban.md.tmp")
            try Data(("## A\n" + String(repeating: "- [ ] c\n", count: n)).utf8).write(to: tmp)
            _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
            await until { feed.board.lanes.first?.cards.count == n }
            #expect(feed.board.lanes.first?.cards.count == n)
        }

        feed.stop()
        try Data("## B".utf8).write(to: file)
        try? await Task.sleep(for: .milliseconds(400))
        #expect(feed.board.lanes.first?.title == "A") // stopped: not re-read
    }
}
