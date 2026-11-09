// `--snapshots <dir>`: renders each state's expanded panel and pill to PNG,
// inside a stand-in for DynamicNotchKit's shape, so the look can be checked
// without a screen recording permission.

import AppKit
import SwiftUI

/// The filled notch outline (same curve as DynamicNotchKit's NotchShape).
struct NotchFillShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let t = topRadius, b = bottomRadius
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t, y: rect.minY + t), control: CGPoint(x: rect.minX + t, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX + t, y: rect.maxY - b))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t + b, y: rect.maxY), control: CGPoint(x: rect.minX + t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t - b, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - t, y: rect.maxY - b), control: CGPoint(x: rect.maxX - t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t, y: rect.minY + t))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: rect.maxX - t, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

@MainActor
enum Snapshots {
    final class ManualScheduler: Scheduling {
        var now: Double = 100
        /// Only the hover delay fires (so the Recent snapshot opens); nothing else moves.
        func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> Scheduled {
            if seconds == AppModel.Timing.hoverIn { action() }
            return Scheduled {}
        }
    }

    final class NoLauncher: LauncherRunning {
        func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {}
        func open(sessionId: String) {}
        func hushAll() {}
        func interrupted() async -> [InterruptedRun] { [] }
        func resume(_ sessionId: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {}
        func cancelAll() {}
    }

    /// Renders every panel once offscreen at launch, so fonts, glyphs and
    /// view types are warm before the first real transition (no first-show hitch).
    static func warmUp(env: NotchEnvironment) {
        OffscreenRender.active = true
        defer { OffscreenRender.active = false }
        for (_, m) in cases(env: env) {
            _ = ImageRenderer(content: expanded(m, env)).cgImage
            _ = ImageRenderer(content: pill(m, env)).cgImage
        }
    }

    static func render(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        OffscreenRender.active = true
        let level = AudioLevel()
        level.set(0.55)
        let env = NotchEnvironment(level: level)
        env.notchSize = CGSize(width: 185, height: 32)
        for (name, m) in cases(env: env) {
            write(expanded(m, env), to: dir.appendingPathComponent("\(name).png"))
            write(pill(m, env), to: dir.appendingPathComponent("\(name)-pill.png"))
        }
        let store = dashboardStore(level: level)
        // Its own defaults, so the tab shown is the one asked for, not the last one used.
        let defaults = UserDefaults(suiteName: "jarvis-snapshots")!
        defaults.set("Later|Amra", forKey: "KanbanCollapsedGroups") // one folded group in the Kanban snapshot
        for (name, ambient, tab) in [("dashboard", false, DashTab.dashboard), ("dashboard-ambient", true, .dashboard), ("dashboard-kanban", false, .kanban)] {
            store.ambient = ambient
            defaults.set(tab.rawValue, forKey: "DashboardTab")
            write(DashboardView(store: store, hotkeyLabel: "⌥ Space") {}.defaultAppStorage(defaults).frame(width: 1320, height: 840),
                  to: dir.appendingPathComponent("\(name).png"))
        }
        defaults.removePersistentDomain(forName: "jarvis-snapshots")
        store.ambient = false
        for (name, items) in [("dashboard-details", [runLogSample()]), ("dashboard-details-conversation", conversationSample())] {
            write(ZStack {
                Dash.bg
                Color.black.opacity(0.6)
                DetailsSheetView(sheet: DetailsSheet(items: items), store: store) {}
                    .padding(EdgeInsets(top: 44, leading: 40, bottom: 32, trailing: 40))
            }
            .frame(width: 1320, height: 840), to: dir.appendingPathComponent("\(name).png"))
        }
    }

    /// The dashboard with two launcher runs, the app's own run waiting on a
    /// question, and a day's worth of Today (the orb itself doesn't render offscreen).
    private static func dashboardStore(level: AudioLevel) -> DashboardStore {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-snapshots-\(getpid())")
        let fm = FileManager.default
        try? fm.createDirectory(at: home.appendingPathComponent("state/active"), withIntermediateDirectories: true)
        try? fm.createDirectory(at: home.appendingPathComponent("reminders"), withIntermediateDirectories: true)
        let ms = Date().timeIntervalSince1970 * 1000
        let iso = ISO8601DateFormatter()
        func put(_ path: String, _ json: String) { try? Data(json.utf8).write(to: home.appendingPathComponent(path)) }
        put("state/active/a.json", #"{"sessionId":"a","pid":\#(getpid()),"request":"Notes for COMP2311 lecture 12","startedAt":\#(ms - 340_000),"doing":"Reading the lecture 12 slides"}"#)
        put("state/active/b.json", #"{"sessionId":"b","pid":\#(getpid()),"request":"Fix the Amra Skincare footer","startedAt":\#(ms - 95_000),"doing":"Editing the footer"}"#)
        put("state/deadlines.json", #"{"deadlines":[{"title":"Coursework 2","course":"COMP2312","due":"\#(iso.string(from: Date().addingTimeInterval(3 * 86400)))"}]}"#)
        let t = iso.string(from: Date())
        func item(_ id: String, _ source: String, _ title: String, _ why: String, _ status: String, _ extra: String = "") -> String {
            #"{"id":"\#(id)","source":"\#(source)","title":"\#(title)","request":"\#(title)","why":"\#(why)","status":"\#(status)","createdAt":"\#(t)","updatedAt":"\#(t)"\#(extra)}"#
        }
        put("state/queue.json", #"{"closed":[],"items":["# + [
            item("q1", "university", "Write the COMP2311 Lecture 17 notes from the slides", "Lecture was on Tuesday and the note is empty", "proposed"),
            item("q2", "email", "Draft a reply to Sue about the Amra launch date", "She asked on Friday; a draft only, for you to send", "proposed"),
            item("q3", "university", "Notes for COMP2311 lecture 12", "", "running", #","sessionId":"a""#),
            item("q4", "university", "Make flashcards for COMP2312 Lecture 9", "", "approved"),
            item("q5", "freelance", "Audit the Chrononight booking page", "", "done", #","sessionId":"s","summary":"Audited the public pages; the members area needs you to sign in to Wix first.","needsYou":true"#),
            item("q6", "kanban", "Plan the week around Coursework 2", "", "done", #","sessionId":"s","summary":"Planned the week; Coursework 2 blocks are in your calendar notes.""#),
        ].joined(separator: ",") + "]}")
        put("reminders/r.json", #"{"id":"r","text":"Call Sue","at":"\#(iso.string(from: Date().addingTimeInterval(3600)))"}"#)
        let m = AppModel(scheduler: ManualScheduler())
        m.launcher = NoLauncher()
        m.submit("Apply to the Oracle internship")
        m.received(.ask(id: "q", question: "Oracle asks about visa sponsorship. Do you need it?", options: ["No", "Yes"], timeoutMs: 60000, sessionId: nil), from: 1)
        var paths = Paths(home: home, repo: home)
        paths.vault = home.appendingPathComponent("vault")
        try? fm.createDirectory(at: paths.vault, withIntermediateDirectories: true)
        try? Data(kanbanSample().utf8).write(to: paths.kanbanFile)
        // Lecture notes for the toolbar's progress bars: written ones are 1300+ bytes.
        for (module, written, total) in [("COMP1001", 16, 18), ("COMP1002", 5, 9), ("COMP1004", 2, 8)] {
            let dir = paths.vault.appendingPathComponent("Uni/\(module)/Lectures")
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            for n in 1...total {
                try? Data(repeating: 0x61, count: n <= written ? 2000 : 200).write(to: dir.appendingPathComponent("\(module) - Lecture \(n).md"))
            }
        }
        let store = DashboardStore(model: m, paths: paths, micLevel: level, voiceLevel: AudioLevel())
        store.refresh()
        store.kanban.load()
        let day = Calendar.current.startOfDay(for: Date())
        store.events = [TodayEvent(title: "COMP2311 lecture", start: day.addingTimeInterval(9 * 3600), end: day.addingTimeInterval(23.9 * 3600), allDay: false, location: "B32"),
                        TodayEvent(title: "COMP2321 lab", start: day.addingTimeInterval(14 * 3600), end: day.addingTimeInterval(23.95 * 3600), allDay: false, location: nil)]
        return store
    }

    /// A board shaped like Leo's (made-up cards), with due dates around today.
    private static func kanbanSample() -> String {
        func day(_ n: Int) -> String { Date().addingTimeInterval(Double(n) * 86400).formatted(.iso8601.year().month().day()) }
        return """
        ---

        kanban-plugin: board
        last-sync: \(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-2 * 3600)))
        last-sync-note: 2 new from Moodle

        ---

        ## Overdue

        - [ ] Do [[COMP1001 - Tutorial 5|COMP1001 Tutorial 5]] #comp1001 @{\(day(-8))} %%src:tutorial:COMP1001 - Tutorial 5|%%
        - [ ] Do COMP1002 Exercise Sheet 5 (Trees) + Progress Test Five #comp1002 @{\(day(-8))} %%src:moodle:51|https://moodle.example.ac.uk/mod/quiz/view.php?id=51%%
        - [ ] Call the client about the menu changes #amra @{\(day(-3))} %%src:slack:D1|https://example.slack.com/archives/D1%% %%likely:call held, quote sent after%%


        ## This week

        - [ ] Do [[COMP1001 - Tutorial 7|COMP1001 Tutorial 7]] #comp1001 @{\(day(0))}
        - [ ] Do the COMP1001 quiz (Grammars) #comp1001 @{\(day(5))} %%src:handin:q3%%
        - [ ] Do the COMP1002 lab sheet #comp1002 @{\(day(2))}
        - [ ] Send the CV to the careers fair stand #careers @{\(day(1))} %%src:trackr:7%%
        - [ ] [[COMP1001 - Lecture 17|Write notes: COMP1001 Lecture 17]] #comp1001
        - [ ] [[COMP1001 - Lecture 18|Write notes: COMP1001 Lecture 18]] #comp1001


        ## Later

        - [ ] Do the group project deliverable D2 #comp1003
        - [ ] Do the COMP1002 coursework @{\(day(30))} #comp1002
        - [ ] Build the bakery's new product page once the quote is approved #amra @{\(day(21))}
        - [ ] Invoice the clinic once the redesign is live #amra
        - [ ] Buy chalk


        ## In progress

        - [ ] [[COMP1004 - Coursework|Do the COMP1004 coursework]] #comp1004
        - [ ] Clinic site redesign
        \tmost pages done, service pages left #chrononight
        - [ ] Internship applications: 40 sent, 9 new openings #careers


        ## Completed

        **Complete**
        - [x] [[COMP1001 - Lecture 16|Write notes: COMP1001 Lecture 16]] #comp1001
        - [x] Chase the bakery about the quote #freelance
        - [x] Do the washing




        %% kanban:settings
        ```
        {"kanban-plugin":"board","list-collapse":[false,false,false,false,false]}
        ```
        %%
        """
    }

    /// A Kanban request with a failed first try, a checker note and the full chat.
    private static func runLogSample() -> ActionItem {
        typealias S = RunDetails.Step
        let d = RunDetails(v: 1, request: "Add buy chalk to my Kanban and tell me what's due this week", reply: "", route: "claude", model: "claude-sonnet-4-5", outcome: "done", saved: true,
                           startedAt: "2026-11-09T10:42:05.000Z", totalMs: 21_400,
                           breakdown: [.init(label: "Starting Claude", ms: 1900), .init(label: "Thinking", ms: 9300), .init(label: "Tools", ms: 5200), .init(label: "Speaking", ms: 5000)],
                           steps: [S(label: "Using the kanban skill", detail: "kanban", atMs: 2600, ms: 150, error: nil, tool: "Skill", input: "kanban", output: "Launching skill: kanban"),
                                   S(label: "Running a command", detail: "Add the card", atMs: 3400, ms: 1900, error: true, tool: "Bash", input: "bun ~/Documents/Jarvis/skills/kanban/kanban.ts add 'Buy chalk' --column 'Not Started'",
                                     output: "error: no column named 'Not Started' on the board.\nColumns: In-progress, Not started, Done"),
                                   S(label: "Running a command", detail: "Add the card", atMs: 6100, ms: 1400, error: nil, tool: "Bash", input: "bun ~/Documents/Jarvis/skills/kanban/kanban.ts add 'Buy chalk' --column 'Not started'",
                                     output: "Added \"Buy chalk\" to Not started (card 41)."),
                                   S(label: "Running a command", detail: "List this week's due cards", atMs: 8300, ms: 1600, error: nil, tool: "Bash", input: "bun ~/Documents/Jarvis/skills/kanban/kanban.ts due --days 7",
                                     output: "COMP2312 Coursework 2 · due Wed 12 Nov\nLiterature review papers · due Fri 14 Nov"),
                                   S(label: "Checking the result", detail: nil, atMs: 16_000, ms: 2400, error: nil)],
                           turns: 6, costUsd: 0.034, problem: nil,
                           chat: [.init(who: "leo", text: "Add buy chalk to my Kanban and tell me what's due this week", atMs: 0),
                                  .init(who: "jarvis", text: "On it, adding the card first.", atMs: 2300),
                                  .init(who: "jarvis", text: "The column is called \"Not started\", lower case. Trying again.", atMs: 5600),
                                  .init(who: "jarvis", text: "Done: \"Buy chalk\" is in Not started. Two things are due this week: COMP2312 Coursework 2 on Wednesday and the literature review papers on Friday.", atMs: 11_900),
                                  .init(who: "checker", text: "Checked: looks right", atMs: 18_400)])
        return ActionItem(id: 12, date: Date(), sessionId: "s", kind: "run", summary: "Added a Kanban card", saved: true, details: d)
    }

    /// Two follow-ups saved before chat was recorded, so their chat comes from request and reply.
    private static func conversationSample() -> [ActionItem] {
        func d(_ q: String, _ a: String, _ start: String, _ ms: Double, _ steps: [RunDetails.Step]) -> RunDetails {
            RunDetails(v: 1, request: q, reply: a, route: "warm", model: "claude-sonnet-4-5", outcome: "done", saved: false, startedAt: start, totalMs: ms,
                       breakdown: [.init(label: "Thinking", ms: ms * 0.5), .init(label: "Tools", ms: ms * 0.2), .init(label: "Speaking", ms: ms * 0.3)], steps: steps, turns: 2, costUsd: 0.01, problem: nil)
        }
        let iso = ISO8601DateFormatter()
        return [ActionItem(id: 1, date: iso.date(from: "2026-11-09T18:07:30Z")!, sessionId: nil, kind: "run", summary: "Described the screen", saved: false,
                           details: d("What am I watching?", "You're watching The Mentalist on Netflix, season one.", "2026-11-09T18:07:20Z", 8200,
                                      [.init(label: "Looking at the screen", detail: "Dia", atMs: 1800, ms: 2100, error: nil)])),
                ActionItem(id: 2, date: iso.date(from: "2026-11-09T18:08:40Z")!, sessionId: nil, kind: "run", summary: "Shared thoughts", saved: false,
                           details: d("What do you think of it?", "I really like it. Patrick Jane is a great lead: smug and charming, but his grief keeps him grounded.", "2026-11-09T18:08:20Z", 11300, []))]
    }

    private static func cases(env: NotchEnvironment) -> [(String, AppModel)] {
        func model(_ setup: (AppModel) -> Void) -> AppModel {
            let m = AppModel(scheduler: ManualScheduler())
            m.launcher = NoLauncher()
            m.speechModel = .ready
            setup(m)
            return m
        }

        return [
            ("listening", model { m in
                m.hotkeyDown()
                m.updateTranscript(Transcript(confirmed: "What's the weather in", hypothesis: "Southampton"))
            }),
            ("working", model { m in
                m.submit("What's the weather in Southampton")
                m.launcherEvent(.status(text: "Searching the web", detail: "southampton weather today"))
                m.launcherEvent(.status(text: "Reading BBC Weather", detail: "bbc.co.uk/weather/2637487"))
            }),
            ("done-saved", model { m in
                m.submit("Start a research session on Southampton rents")
                m.launcherEvent(.status(text: "Reading Zoopla", detail: "zoopla.co.uk/market/southampton"))
                m.speechStarted(id: "1", text: "I've started that. The first pass is in your vault under Southampton rents.")
                m.launcherEvent(.done(sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", keep: true, summary: "Research: Southampton rents", reply: "", name: "Jarvis: Research: Southampton rents"))
            }),
            ("question", model { m in
                m.received(.ask(id: "q", question: "Put “COMP2211 lab 4” in In-progress or Not Started?", options: ["In-progress", "Not Started"], timeoutMs: 60000, sessionId: nil), from: 1)
            }),
            ("blocked", model { m in
                m.submit("Pay my tuition fee")
                m.launcherEvent(.denied(tool: "mcp__claude-in-chrome__navigate", rule: "no-real-consequences", reason: "guard:no-real-consequences: tuition fee payment is for Leo to do himself. Safe alternative: a reminder to pay it at 6pm"))
                m.launcherExited(0)
            }),
            ("access", model { m in
                m.submit("Check my Notion")
                m.launcherEvent(.done(sessionId: "x", keep: false, summary: "", reply: "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again.", name: nil))
                m.launcherExited(0)
            }),
            ("recent", model { m in
                m.loadRecent = {
                    [ActionItem(id: 4, date: Date(), sessionId: nil, kind: "run", summary: "Weather in Southampton", saved: false),
                     ActionItem(id: 3, date: Date().addingTimeInterval(-900), sessionId: "a", kind: "run", summary: "Research: quiet study spots in Southampton", saved: true),
                     ActionItem(id: 2, date: Date().addingTimeInterval(-1800), sessionId: nil, kind: "guard", summary: "Blocked: tuition fee payment", saved: false),
                     ActionItem(id: 1, date: Date().addingTimeInterval(-2400), sessionId: nil, kind: "reminder", summary: "Reminder set: call Sue, 17:00", saved: false)]
                }
                m.notchHover(true)
            }),
            ("details", model { m in
                let d = RunDetails(v: 1, request: "What's on my Kanban board?", reply: "You've got 14 cards to start. Two are due today: the literature review papers and the three interviews.", route: "claude", model: "sonnet", outcome: "done", saved: false, startedAt: "2026-10-22T18:07:00.000Z", totalMs: 9400,
                                   breakdown: [.init(label: "Starting Claude", ms: 1800), .init(label: "Thinking", ms: 3100), .init(label: "Tools", ms: 1300), .init(label: "Speaking", ms: 3200)],
                                   steps: [.init(label: "Using the kanban skill", detail: nil, atMs: 2100, ms: 200, error: nil), .init(label: "Running a command", detail: "kanban list", atMs: 2400, ms: 1100, error: nil)],
                                   turns: 3, costUsd: 0.012, problem: nil)
                let item = ActionItem(id: 9, date: Date(), sessionId: nil, kind: "run", summary: "Read out the Kanban board", saved: false, details: d)
                m.loadRecent = { [item] }
                m.notchHover(true)
                m.openRecent(item)
            }),
            ("conversation", model { m in
                func d(_ q: String, _ a: String, _ start: String, _ ms: Double) -> RunDetails {
                    RunDetails(v: 1, request: q, reply: a, route: "warm", model: "sonnet", outcome: "done", saved: false, startedAt: start, totalMs: ms,
                               breakdown: [.init(label: "Thinking", ms: ms * 0.5), .init(label: "Tools", ms: ms * 0.2), .init(label: "Speaking", ms: ms * 0.3)], steps: [], turns: 2, costUsd: 0.01, problem: nil)
                }
                let iso = ISO8601DateFormatter()
                let a = ActionItem(id: 1, date: iso.date(from: "2026-10-22T18:07:30Z")!, sessionId: nil, kind: "run", summary: "Described the screen: Netflix in Dia showing The Mentalist", saved: false,
                                   details: d("What am I watching?", "You're watching The Mentalist on Netflix, season one.", "2026-10-22T18:07:20Z", 8200))
                let b = ActionItem(id: 2, date: iso.date(from: "2026-10-22T18:08:40Z")!, sessionId: nil, kind: "run", summary: "Shared thoughts on The Mentalist", saved: false,
                                   details: d("What do you think of it?", "I really like it. Patrick Jane is a great lead: smug and charming, but his grief keeps him grounded.", "2026-10-22T18:08:20Z", 11300))
                m.loadRecent = { [b, a] }
                m.notchHover(true)
            }),
            ("conversation-open", model { m in
                let iso = ISO8601DateFormatter()
                func d(_ q: String, _ a: String, _ start: String, _ ms: Double) -> RunDetails {
                    RunDetails(v: 1, request: q, reply: a, route: "warm", model: "sonnet", outcome: "done", saved: false, startedAt: start, totalMs: ms,
                               breakdown: [.init(label: "Thinking", ms: ms * 0.5), .init(label: "Tools", ms: ms * 0.2), .init(label: "Speaking", ms: ms * 0.3)], steps: [], turns: 2, costUsd: 0.01, problem: nil)
                }
                let a = ActionItem(id: 1, date: iso.date(from: "2026-10-22T18:07:30Z")!, sessionId: nil, kind: "run", summary: "Described the screen", saved: false,
                                   details: d("What am I watching?", "You're watching The Mentalist on Netflix, season one.", "2026-10-22T18:07:20Z", 8200))
                let b = ActionItem(id: 2, date: iso.date(from: "2026-10-22T18:08:40Z")!, sessionId: nil, kind: "run", summary: "Shared thoughts", saved: false,
                                   details: d("What do you think of it?", "I really like it. Patrick Jane is a great lead: smug and charming, but his grief keeps him grounded.", "2026-10-22T18:08:20Z", 11300))
                m.loadRecent = { [b, a] }
                m.notchHover(true)
                m.openConversation([a, b])
            }),
            ("reminder", model { m in
                m.received(.reminder(id: "r", text: "Call Sue about the Amra brief"), from: 1)
            }),
        ]
    }

    private static func expanded(_ m: AppModel, _ env: NotchEnvironment) -> some View {
        let notchH = env.notchSize.height
        return ExpandedView(model: m, env: env)
            .padding(EdgeInsets(top: notchH, leading: Theme.dnkInset, bottom: Theme.dnkInset, trailing: Theme.dnkInset))
            .padding(.horizontal, Theme.topRadius)
            .background(Color.black)
            .mask(NotchFillShape(topRadius: Theme.topRadius, bottomRadius: Theme.bottomRadius))
            .overlay(alignment: .top) {
                // Where the hardware notch sits, for reference.
                RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [3]))
                    .frame(width: env.notchSize.width, height: notchH)
            }
            .padding(30)
            .background(Color(white: 0.35))
            .environment(\.colorScheme, .dark)
    }

    private static func pill(_ m: AppModel, _ env: NotchEnvironment) -> some View {
        HStack(spacing: 0) {
            PillLeading(model: m, env: env).padding(.leading, 8).padding(.top, 4).padding(.bottom, 8)
            Spacer().frame(width: env.notchSize.width)
            PillTrailing(model: m, env: env).padding(.trailing, 8).padding(.top, 4).padding(.bottom, 8)
        }
        .padding(.horizontal, 6)
        .background(Color.black)
        .mask(NotchFillShape(topRadius: 6, bottomRadius: 14))
        .padding(30)
        .background(Color(white: 0.35))
    }

    private static func write(_ view: some View, to url: URL) {
        let r = ImageRenderer(content: view)
        r.scale = 2
        guard let img = r.nsImage, let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
            print("render failed: \(url.lastPathComponent)")
            return
        }
        try? png.write(to: url)
        print("wrote \(url.path)")
    }
}
