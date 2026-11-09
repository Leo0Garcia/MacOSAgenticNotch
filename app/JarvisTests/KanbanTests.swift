import Foundation
import Testing
@testable import Jarvis

/// The real board's structure (DESIGN section 9) with made-up cards.
private let fixture = """
---

kanban-plugin: board
last-sync: 2026-11-09T07:17:52+00:00

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
        let now = c.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 15))!
        let day = { c.date(from: DateComponents(year: 2026, month: 11, day: $0))! }
        #expect(Kanban.due(day(8), now: now) == .overdue)
        #expect(Kanban.due(day(9), now: now) == .today)
        #expect(Kanban.due(day(10), now: now) == .later)
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
