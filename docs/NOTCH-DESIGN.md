# Notch app: visual and motion spec

What the app/ thread builds from. DESIGN.md section 7 says what the notch does; this file says how it looks and moves. The interactive mockup is `docs/design/notch-mockup.html` (open it in a browser; 1 CSS px = 1 pt).

Status: three directions drafted, **waiting on Leo to pick one** (A Obsidian, B Aurora, C Signal). Everything except section 6 is shared by all three.

## 1. Geometry

All sizes are points.

| Thing | Value | Notes |
| - | - | - |
| Hardware notch | read at runtime | `NSScreen.safeAreaInsets.top` and `auxiliaryTopLeftArea`/`auxiliaryTopRightArea`, as DynamicNotchKit does. Mockup uses 185 × 32. |
| Compact | notch width + 2 × 52 wide, notch height tall (289 × 32 on the mockup) | Leading and trailing wings, 52 pt each. Keep them equal so the notch stays centred. |
| Expanded width | 340 | Fixed. Content is laid out at 340 from the first frame so text never reflows while the shape grows. |
| Expanded height | content height, max 200 | Strip (notch height) + body. Body padding 6 top, 16 sides, 14 bottom. |
| Bottom corner radius | idle 8, compact 14, expanded 22 | Signal: compact 9, expanded 14. |
| Top corner (ear) radius | compact 6, expanded 10 | DynamicNotchKit draws these as `topCornerRadius`. |

**"Never larger than the notch area"** is read as: nothing drawn outside a 340 × 200 box hanging from the top centre of the screen, and nothing at all while idle. Glows stay inside the shape. This is the one interpretation call in this file; if Leo means "compact only, never drop below the menu bar", the expanded states move into the compact wings and the transcript becomes a single scrolling line.

## 2. States

| State | Size | Leading | Trailing | Body | Enters on | Leaves on |
| - | - | - | - | - | - | - |
| Idle | hidden | | | | launch, end of Done/reminder | hotkey down, reminder, ask, hover (phase 2) |
| Listening | expanded | mic level (5 bars, 40 × 20) | elapsed `0:03` | live transcript; unconfirmed WhisperKit words at 45% white | hotkey down | hotkey up |
| Working | expanded | activity indicator | elapsed `1.6s` | request (12 pt, 50% white) + one status line per `tool_use` event | launcher spawned the run | first reply sentence, ask, or 8 s with nothing spoken |
| Working, long run | compact | activity indicator | elapsed | | 8 s in Working with nothing spoken | hover re-expands; reply/ask takes over |
| Done | expanded | check (draws in) | speaking bars | reply caption, words go 30% → 100% as spoken | first sentence streams, bridge `speak()` starts | 1.8 s after speech: compact check 1.4 s, then hidden |
| Done, saved | expanded | as Done | as Done | + chip "Saved · <name> ↗", click runs `claude --desktop --resume <id>` | result `keep: true` | 6 s after speech, then as Done |
| Needs you: question | expanded | amber attention | "Question" | question + up to two answer buttons + "or hold ⌥ Space" | bridge `ask()` | answered, or `ask()` timeout |
| Needs you: access | expanded | amber attention | "Access" | what's missing + where to fix it + "Got it" | `needs-access` skill, `permission_denied` | dismissed |
| Needs you: blocked | expanded | amber attention | "Blocked" | `guard:<rule-id>` as a label, plain sentence, safe-version button + Dismiss | guard deny reason relayed by the run | safe version picked or dismissed |
| Reminder | expanded 5 s, then compact | bell (rings twice) | time / short label | "Reminder" + text | launchd reminder via bridge | click or 60 s |
| Hover log (phase 2) | expanded, 340 × 192 | "Recent" | count | 8 rows × 18 pt: time, summary, ↗ for saved, "guard" for blocks | pointer rests 300 ms while idle | pointer away 400 ms |

Rules:

- Tool names map to plain status lines in the launcher, not the app (e.g. `WebSearch` → "Searching the web", `WebFetch` → "Reading <site name>"). Unknown tools show "Working".
- Needs-you always wins: it interrupts any state and stays until resolved. A macOS notification is posted at the same time.
- A second request while one is running: hotkey down still opens Listening; the running job drops to the compact pill when Listening ends.
- Phase 1 speech is `say` in the bridge, which reports no word timing, so the Done caption is paced by an estimate (about 48 ms per character at the default rate). Exact word sync needs in-app speech (`AVSpeechSynthesizer` delegate), which belongs with phase 2 TTS.
- The hotkey label "⌥ Space" is a placeholder; the app thread picks the real one.

## 3. Motion

Shared by all directions. Numbers are SwiftUI's.

| Token | Value | Use |
| - | - | - |
| `expand` | `.spring(response: 0.42, dampingFraction: 0.8)` | any change that makes the shape bigger |
| `collapse` | `.spring(response: 0.34, dampingFraction: 1)` | any change that makes it smaller; no overshoot so it never pokes past the hardware edge |
| `contentIn` | 240 ms ease-out, opacity 0→1, blur 6→0, y −4→0, scale 0.98→1, 40 ms delay | body and wing content arriving |
| `contentOut` | 110 ms ease-in, opacity 1→0, blur 0→4 | content leaving; runs before `contentIn` |
| `wordIn` | 180 ms ease-out, opacity 0→1, blur 6→0 | each transcript word |
| `shimmer` | 1.6 s linear loop, highlight band sweeps left to right | Working status line |
| `attention` | 1.2 s ease-in-out loop | needs-you dot, rim pulse |
| `check` | 350 ms stroke draw, 120 ms delay | Done |
| reduced motion | 160 ms ease crossfades, no springs, no loops, no blur | when `accessibilityDisplayShouldReduceMotion` is on |

Pick the spring by comparing areas: new area larger → `expand`, otherwise `collapse`.

Hand-offs:

- Listening → Working: the transcript text moves into the 12 pt request line (`matchedGeometryEffect` on the text), status line fades in under it.
- Working → Done: status line and steps leave with `contentOut`; reply enters with `contentIn`; height follows with `expand` or `collapse`.
- Any → Idle: content out first, then `collapse` to the hardware outline, then `notch.hide()`.

## 4. Type and colour (shared)

- Type: system font (SF Pro). Body/transcript/reply 15 pt medium, tracking −0.01 em, line height 20. Request line 12 pt. Labels 11 pt semibold uppercase, tracking 0.04 em. Wings 12.5 pt medium, tabular figures.
- Shape fill: pure black, so it merges with the hardware notch.
- Text: white at 100% (primary), 60% (secondary), 45–50% (unconfirmed words, request line), 30% (unspoken reply words).
- Semantic colours are Apple system colours so they match macOS: success `#30D158`, attention `#FF9F0A` (text `#FFB340`), reminder `#FFD60A`, recording dot `#FF453A`.
- Buttons in the notch: 24 pt tall capsules, white 12% fill (20% hover); the safe/primary one amber 24% fill with `#FFC266` text.

## 5. DynamicNotchKit mapping

Checked against DynamicNotchKit main (`cd0b3e5`, tag 1.1.0).

- One `DynamicNotch(hoverBehavior:style:expanded:compactLeading:compactTrailing:)` for the app's lifetime. `expand()`, `compact()`, `hide()` drive the three DNK states; Jarvis's own states are a `@Observable` model the views read.
- `style: .notch(topCornerRadius: 10, bottomCornerRadius: 22)` (Signal: 10 / 14). DNK fixes compact radii at 6 / 14.
- `transitionConfiguration`: set `openingAnimation` and `conversionAnimation` to `expand`, `closingAnimation` to `collapse`. DNK's defaults (`.bouncy(0.4)` / `.smooth(0.4)` / `.snappy(0.4)`) are close but not ours.
- Expanded view: a fixed 340-wide `VStack`; its height animates with our springs when the state changes inside it. DNK sizes its window to the content (`fixedSize`).
- Hover: `hoverBehavior: [.keepVisible]`; skip `.hapticFeedback` and `.increaseShadow` (the shadow would draw outside the envelope).
- Blur transitions: SwiftUI has no built-in blur transition; use `.transition(.modifier(active: BlurFade(1), identity: BlurFade(0)))` with a small `ViewModifier` applying blur, opacity and offset.
- Mic bars and the Signal trace: `TimelineView(.animation)` + `Canvas`, fed by an RMS value from the `AVAudioEngine` input tap, smoothed 0.25 per frame.
- Rim (Aurora): `AngularGradient` stroked on the notch shape, rotated with `TimelineView`; no third-party code.

## 6. Directions

### A. Obsidian

Looks like part of the hardware. Black and white; colour only for state.

- Listening bars and type in white.
- Working: 14 pt ring spinner, conic white tail, 0.9 s per turn.
- Needs you: 8 pt amber dot with an expanding halo on `attention`.
- No rim, no glow.

### B. Aurora

A 1.5 pt band of light runs round the sides and bottom of the shape (not the top, which meets the screen edge), with a soft glow inside the bottom edge. The band's `AngularGradient` turns continuously; its colours and speed carry the state.

| State | Colours | One turn |
| - | - | - |
| Listening | `#5AC8FA` → `#7D7AFF` → `#64D2FF` | 3 s |
| Working | `#7D7AFF` → `#BF5AF2` → `#5AC8FA` | 1.5 s |
| Done | `#30D158` → `#63E6BE` → `#5AC8FA` | 5 s |
| Needs you | `#FF9F0A` → `#FF6B3D` → `#FFD60A`, opacity pulses on `attention` | 2.4 s |
| Reminder | `#FFD60A` → `#FF9F0A` → `#FFF3B0` | 3 s |
| Hover log | greys at 40% | 8 s |

Mic bars take the state gradient. Working indicator is a breathing 14 pt orb in the same colours. Inner glow: 60 pt tall ellipse under the bottom edge, blur 12, opacity 0.3–0.45. Costs a little GPU while visible; nothing runs when hidden.

### C. Signal

An instrument readout for someone who likes to see the machinery.

- Accent `#9FD8FF` (ice). Labels, steps and timings in a monospaced face (SF Mono), uppercase labels tracked 0.08 em.
- Listening: an oscilloscope trace instead of bars; trailing wing reads `● REC 0:03`; footer "ON-DEVICE · WHISPERKIT · RELEASE TO SEND".
- Working: last 3 tool steps as rows (`01 WEBSEARCH southampton weather today 1.4s`), newest in white, plus the 4 s budget bar: 8 ticks at 0.5 s, fills ice, turns amber past 4 s. The time to first spoken word is marked on the bar and frozen there in Done.
- Hairline under the strip when expanded. Corners tighter (14 expanded, 9 compact), buttons 4 pt radius.
- Working indicator: three 4 pt squares lighting in turn.

## 7. Accessibility

- Every state change posts an `NSAccessibility` announcement with the body text (question, reply, reminder).
- Buttons are real `Button`s, reachable with the keyboard when the notch has focus; Esc dismisses needs-you access/blocked and reminders.
- Reduced motion as in section 3. Increase contrast raises secondary text to 75% and unconfirmed words to 60%.
