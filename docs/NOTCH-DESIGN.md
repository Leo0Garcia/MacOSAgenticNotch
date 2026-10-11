# Notch app: visual and motion spec

What the app/ thread builds from. DESIGN.md section 7 says what the notch does; this file says how it looks and moves. The interactive mockup is `docs/design/notch-mockup.html` (open it in a browser; 1 CSS px = 1 pt).

Status: Leo picked **B, Aurora** on 2026-10-11 and asked for a pixel character instead of the orb (section 6). Leo then picked the **Large** layout (520 × 360 max), on condition that it shows and hides efficiently, collapsing to the pill whenever it isn't needed (section 2.1). The Compact layout stays documented as the fallback.

## 1. Geometry

All sizes are points.

| Thing | Value | Notes |
| - | - | - |
| Hardware notch | read at runtime | `NSScreen.safeAreaInsets.top` and `auxiliaryTopLeftArea`/`auxiliaryTopRightArea`, as DynamicNotchKit does. Mockup uses 185 × 32. |
| Compact | notch width + 2 × 52 wide, notch height tall (289 × 32 on the mockup) | Leading and trailing wings, 52 pt each. Keep them equal so the notch stays centred. |
| Expanded width | Compact layout 340, Large layout 520 | Fixed. Content is laid out at full width from the first frame so text never reflows while the shape grows. |
| Expanded height | content height, max 200 (Compact) or 360 (Large) | Strip (notch height) + body. Body padding: Compact 6 top, 16 sides, 14 bottom; Large 12 top, 22 sides, 22 bottom. |
| Bottom corner radius | idle 8, compact 14, expanded 22 (Large 28) | |
| Top corner (ear) radius | compact 6, expanded 10 (Large 12) | DynamicNotchKit draws these as `topCornerRadius`. |

**Envelope.** Nothing is drawn outside the layout's max box hanging from the top centre of the screen, and nothing at all while idle. Glows stay inside the shape. Leo confirmed on 2026-10-11 that a large notch area is fine, which is why the Large layout exists.

### Layouts

| | Compact | Large |
| - | - | - |
| Character | 28 × 20 in the leading wing | 56 × 40 in a left column of the body; leading wing shows the state name in the state colour |
| Main text | 15 pt / 20 | 19 pt / 25 |
| Listening | mini mic bars beside the character | 20-bar level meter under the transcript |
| Working | request + one status line | + every tool step: status, site, time (last 4) |
| Done | reply caption | + sources used and time to first word |
| Needs you | label, question, buttons (24 pt) | + one line of context, buttons 30 pt |
| Reminder | text only | + when it was set, Done / In 10 minutes |
| Hover log | 8 rows × 18 pt | 8 rows × 26 pt with Ephemeral / Saved / Guard badge and duration |

Compact pills (Working long run, Done tail, Reminder pill) are the same in both: 289 × 32 with the small character in the leading wing.

## 2. States

### 2.1 Show and hide (Large layout)

The large panel is shown only while Leo needs to read or answer it; otherwise the notch is the pill or hidden.

| Moment | Large panel | Then |
| - | - | - |
| Listening | shown while the hotkey is held | Working |
| Working | first 3 s, so Leo sees it understood | pill (walking character + elapsed) until the reply; hover re-expands |
| Done | while speaking, plus 1.8 s (saved runs: 4 s, so the chip can be clicked) | pill 1.4 s, then hidden |
| Needs you | until answered; after 20 s without pointer or keyboard activity on it, pill with the waving character and amber rim | hover or click re-expands; notification already posted |
| Reminder | 5 s | pill until clicked or 60 s |
| Hover log | while the pointer is on it (300 ms in, 400 ms out) | hidden |

Always: Esc or a click outside collapses to the pill (or hides, if nothing is running). Nothing stays expanded for more than 6 s without new content except an unanswered needs-you. Expanding uses `expand`, shrinking uses `collapse` (section 3), so the panel never lingers mid-animation.


| State | Size | Leading | Trailing | Body | Enters on | Leaves on |
| - | - | - | - | - | - | - |
| Idle | hidden | | | | launch, end of Done/reminder | hotkey down, reminder, ask, hover (phase 2) |
| Listening | expanded | character (listening) + mic level | elapsed `0:03` | live transcript; unconfirmed WhisperKit words at 45% white | hotkey down | hotkey up |
| Working | expanded 3 s, then pill | character (walking) | elapsed `1.6s` | request (12 pt, 50% white) + one status line per `tool_use` event | launcher spawned the run | first reply sentence, ask, or 3 s with nothing spoken |
| Working, long run | compact | character (walking) | elapsed | | 3 s in Working with nothing spoken | hover re-expands; reply/ask takes over |
| Done | expanded | character (hop, then talks) | speaking bars | reply caption, words go 30% → 100% as spoken | first sentence streams, bridge `speak()` starts | 1.8 s after speech: pill 1.4 s, then hidden |
| Done, saved | expanded | as Done | as Done | + chip "Saved · <name> ↗", click runs `claude --desktop --resume <id>` | result `keep: true` | 4 s after speech, then as Done |
| Needs you: question | expanded | character (waving) | "Question" | question + up to two answer buttons + "or hold ⌥ Space" | bridge `ask()` | answered, or `ask()` timeout |
| Needs you: access | expanded | character (waving) | "Access" | what's missing + where to fix it + "Got it" | `needs-access` skill, `permission_denied` | dismissed |
| Needs you: blocked | expanded | character (waving) | "Blocked" | `guard:<rule-id>` as a label, plain sentence, safe-version button + Dismiss | guard deny reason relayed by the run | safe version picked or dismissed |
| Reminder | expanded 5 s, then compact | character (looks up) | bell (rings twice) + time / short label | "Reminder" + text | launchd reminder via bridge | click or 60 s |
| Hover log (phase 2) | expanded | character (reading) + "Recent" | count | 8 rows × 18 pt: time, summary, ↗ for saved, "guard" for blocks | pointer rests 300 ms while idle | pointer away 400 ms |

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
| `character` | sprite frames at 8 fps; hop 2 px over 0.5 s | see section 6 |
| reduced motion | 160 ms ease crossfades, no springs, no loops, no blur | when `accessibilityDisplayShouldReduceMotion` is on |

Pick the spring by comparing areas: new area larger → `expand`, otherwise `collapse`.

Hand-offs:

- Listening → Working: the transcript text moves into the 12 pt request line (`matchedGeometryEffect` on the text), status line fades in under it.
- Working → Done: status line and steps leave with `contentOut`; reply enters with `contentIn`; height follows with `expand` or `collapse`.
- Any → Idle: content out first, then `collapse` to the hardware outline, then `notch.hide()`.

### Smoothness requirements

Leo's bar is "everything is smooth". The app thread treats these as acceptance criteria:

- **Frame rate:** no dropped frames during any transition on the M4's 120 Hz display. Check with Instruments' Animation Hitches template; target hitch ratio under 1 ms/s.
- **Interruptible:** every change is a SwiftUI spring, so a new state mid-animation retargets from the current size and velocity instead of snapping or queueing. Never chain `expand()`/`compact()` calls with sleeps; set the model and let one animation run.
- **Coalesce updates:** stream events arrive faster than the eye can read. Status line changes at most every 350 ms; transcript words are batched per frame; the panel's height animates only when content height changes by 4 pt or more.
- **No reflow:** content is laid out at full width from the first frame (section 1), text uses `.contentTransition(.opacity)` or the blur transition, never resizing mid-word.
- **Cheap drawing:** the rim, character and bars draw only while visible; `TimelineView` pauses when hidden. Canvas for the character and bars, no per-frame view rebuilds of the text. Measured CPU while Working under 5% on the M4.
- **Startup:** the notch window is created at launch and kept hidden, so the first hotkey press expands in the same frame (DynamicNotchKit's `expand()` starts the animation before showing the window).
- **Audio first:** speech starts the instant the first sentence arrives, independent of animation state; the UI follows the audio, never the other way round.

## 4. Type and colour (shared)

- Type: system font (SF Pro). Body/transcript/reply 15 pt medium, tracking −0.01 em, line height 20. Request line 12 pt. Labels 11 pt semibold uppercase, tracking 0.04 em. Wings 12.5 pt medium, tabular figures.
- Shape fill: pure black, so it merges with the hardware notch.
- Character: body `#D97757`, bottom row and legs `#B8613F`; eyes are holes showing the black notch.
- Text: white at 100% (primary), 60% (secondary), 45–50% (unconfirmed words, request line), 30% (unspoken reply words).
- Semantic colours are Apple system colours so they match macOS: success `#30D158`, attention `#FF9F0A` (text `#FFB340`), reminder `#FFD60A`, recording dot `#FF453A`.
- Buttons in the notch: 24 pt tall capsules, white 12% fill (20% hover); the safe/primary one amber 24% fill with `#FFC266` text.

## 5. DynamicNotchKit mapping

Checked against DynamicNotchKit main (`cd0b3e5`, tag 1.1.0).

- One `DynamicNotch(hoverBehavior:style:expanded:compactLeading:compactTrailing:)` for the app's lifetime. `expand()`, `compact()`, `hide()` drive the three DNK states; Jarvis's own states are a `@Observable` model the views read.
- `style: .notch(topCornerRadius: 10, bottomCornerRadius: 22)` (Large: 12 / 28). DNK fixes compact radii at 6 / 14.
- `transitionConfiguration`: set `openingAnimation` and `conversionAnimation` to `expand`, `closingAnimation` to `collapse`. DNK's defaults (`.bouncy(0.4)` / `.smooth(0.4)` / `.snappy(0.4)`) are close but not ours.
- Expanded view: a fixed 340-wide `VStack`; its height animates with our springs when the state changes inside it. DNK sizes its window to the content (`fixedSize`).
- Hover: `hoverBehavior: [.keepVisible]`; skip `.hapticFeedback` and `.increaseShadow` (the shadow would draw outside the envelope).
- Blur transitions: SwiftUI has no built-in blur transition; use `.transition(.modifier(active: BlurFade(1), identity: BlurFade(0)))` with a small `ViewModifier` applying blur, opacity and offset.
- Mic bars and the character: `TimelineView(.animation)` + `Canvas`, the bars fed by an RMS value from the `AVAudioEngine` input tap, smoothed 0.25 per frame.
- Rim (Aurora): `AngularGradient` stroked on the notch shape, rotated with `TimelineView`; no third-party code.

## 6. Look: Aurora with the Jarvis character

Picked by Leo on 2026-10-11. The Obsidian (plain black and white) and Signal (instrument readout) drafts were dropped; the mockup's first version is in git history if wanted.

### Light rim

A 1.5 pt band of light runs round the sides and bottom of the shape (not the top, which meets the screen edge), with a soft glow inside the bottom edge. The band's `AngularGradient` turns continuously; its colours and speed carry the state.

| State | Colours | One turn |
| - | - | - |
| Listening | `#5AC8FA` → `#7D7AFF` → `#64D2FF` | 3 s |
| Working | `#7D7AFF` → `#BF5AF2` → `#5AC8FA` | 1.5 s |
| Done | `#30D158` → `#63E6BE` → `#5AC8FA` | 5 s |
| Needs you | `#FF9F0A` → `#FF6B3D` → `#FFD60A`, opacity pulses on `attention` | 2.4 s |
| Reminder | `#FFD60A` → `#FF9F0A` → `#FFF3B0` | 3 s |
| Hover log | greys at 40% | 8 s |

Mic bars take the state gradient. The Large layout's state name in the leading wing uses the first colour. Inner glow: 60 pt tall ellipse under the bottom edge, blur 12, opacity 0.3–0.45. Nothing animates while hidden.

### The character

An original 14 × 10 pixel sprite in the spirit of Claude's mascot (not Anthropic's artwork): a terracotta block body (10 × 5), two 1 × 2 eye holes, short side arms, four legs. Drawn at 2 pt per pixel (28 × 20) in Compact and the pills, 4 pt per pixel (56 × 40) in the Large body. In SwiftUI: frames as `[[UInt8]]` grids drawn in a `Canvas`, driven by `TimelineView(.periodic(from:by: 1/8))`; no image assets needed.

| Mood | Used in | Animation |
| - | - | - |
| listen | Listening | eyes look up, blinks every ~3.4 s, hops 1 px on loud syllables (mic level > 0.6) |
| work | Working, long-run pill | legs walk (4-frame cycle at 8 fps), eyes scan left / centre / right |
| happy | Done, Done pill | hop 2 px with arms up for 0.5 s, ^ ^ eyes for 1.6 s, then bobs 1 px while speech is loud |
| wave | all Needs you | right arm waves at 3 fps with a 1 px bob |
| look | Reminder, reminder pill | eyes up, arms flap for 1.2 s, then a small bob every 2 s |
| read | Hover log | eyes look down and across, as if reading the rows |

Reduced motion: a single still frame per mood (eyes open, no bob or walk).

## 7. Accessibility

- Every state change posts an `NSAccessibility` announcement with the body text (question, reply, reminder).
- Buttons are real `Button`s, reachable with the keyboard when the notch has focus; Esc dismisses needs-you access/blocked and reminders.
- Reduced motion as in section 3. Increase contrast raises secondary text to 75% and unconfirmed words to 60%.
