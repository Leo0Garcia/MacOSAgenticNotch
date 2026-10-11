# app/

The Jarvis notch app: Swift 6 / SwiftUI on DynamicNotchKit, macOS 15+. Spec: docs/DESIGN.md section 7 (what it does) and docs/NOTCH-DESIGN.md (how it looks and moves: Aurora, the pixel character, the Large 520 × 360 layout collapsing to the 289 × 32 pill).

```
cd app && xcodebuild -scheme Jarvis build          # the project is generated from project.yml (xcodegen) and committed
xcodebuild -scheme Jarvis -destination 'platform=macOS,arch=arm64' test
open ~/Library/Developer/Xcode/DerivedData/Jarvis-*/Build/Products/Debug/Jarvis.app
```

Hold **⌥ Space** and talk; let go to send. The request goes to `launcher/run.sh run "<request>"`, and replies are spoken by the launcher and bridge (`say`), captioned in the notch.

## Pieces

| File | Does |
| - | - |
| `Model/AppModel.swift` | The state machine: Listening, Working, Done, Needs you (question, access, blocked), Reminder, and the show/hide timings of NOTCH-DESIGN 2.1. Everything else feeds it; views only read it. |
| `Notch/NotchController.swift` | One DynamicNotch for the app's lifetime, driven from `model.size`. "Hidden" keeps the window alive (compact, empty wings, alpha 0, click-through) so showing never rebuilds it. |
| `Views/` | The Large body, the pill, the Aurora rim, the character, bars, shimmer. The rim, character and needs-you dot are Core Animation layers, so idle panels cost no app CPU. |
| `Services/NotchServer.swift` | The notch socket (DESIGN 8.2): WebSocket on 127.0.0.1, random port, `~/Jarvis/notch.json` (0600, fresh token per launch). |
| `Services/Launcher.swift` | Spawns the launcher and parses its NDJSON stdout; snoozes reminders through `launcher/src/reminders.ts schedule`. |
| `Services/HotKey.swift` | Carbon `RegisterEventHotKey`: press and release, no Accessibility permission. Esc is registered only while a dismissable panel is open. |
| `Voice/` | AVAudioEngine capture while the hotkey is held, resampled to 16 kHz; WhisperKit (`openai_whisper-small.en`, stored in `~/Jarvis/models`) re-transcribes the buffer about twice a second for the live transcript and once on release. |

## Permissions

- **Microphone**: asked the first time you hold the hotkey. Nothing listens otherwise.
- **Notifications**: asked the first time Jarvis needs you or a reminder fires.
- No Accessibility, Input Monitoring, Screen Recording or Full Disk Access.

Install with `app/install.sh`: it builds Release, signs with **Jarvis Local Signing** and puts the app in `~/Jarvis/Jarvis.app`. That identity is a self-signed certificate in the login keychain, made once by `app/setup-signing.sh`. Signing every build with the same identity is what keeps macOS's permissions (microphone, calendars, automation, screen recording) across rebuilds. An ad-hoc signed build looks like a new app to macOS, which then asks again. `xcodebuild -scheme Jarvis build` stays ad-hoc so it builds anywhere.

## Testing without a mic

```
Jarvis.app/Contents/MacOS/Jarvis --request "what's the weather in Southampton"   # typed request, as if spoken
Jarvis.app/Contents/MacOS/Jarvis --audio-file question.aiff                      # audio through WhisperKit, as if spoken
Jarvis.app/Contents/MacOS/Jarvis --demo                                          # every state, canned content, looping
Jarvis.app/Contents/MacOS/Jarvis --demo-working                                  # a run that stays in Working (CPU)
Jarvis.app/Contents/MacOS/Jarvis --snapshots /tmp/notch                          # each state rendered to PNG
```

`JARVIS_REPO` points the app at another repo (tests use a stub `launcher/run.sh`); `JARVIS_HOME` moves `~/Jarvis`. Unit tests use a fake launcher, a fake voice input and a test clock; nothing calls a model.

## Smoothness checks (NOTCH-DESIGN section 3)

- Hitches: `xcrun xctrace record --template 'Animation Hitches' --launch -- Jarvis.app/Contents/MacOS/Jarvis --demo`, Release build.
- CPU while Working: `--demo-working` and `top -pid <pid> -stats cpu`.
