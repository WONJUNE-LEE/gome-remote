# Clipboard sync and Command key capture — design

Status: owner approved the direction in chat on 2026-10-19 (grade F); owner decisions from the
design review are recorded in §4 (marked "owner, 2026-10-19"). Revision 3: D4/G4 changed to
capture the Windows key in windowed mode too (owner, 2026-10-19), after implementation.
Implemented on branch `feat/clipboard-sync`; released as v0.3.3 (PR #9 merged as e6d124c, tag v0.3.3;
written 2026-10-19). Rehearsal partial: the owner reported Windows-to-Mac and Mac-to-Windows
paste and windowed Windows-key capture with release as passed; the other device checks are
not yet run (`docs/verification.md`).

## 1. Why

The owner works from a Windows PC in the Electron desktop app and connects to the Mac.
Text copied on Windows with Ctrl+C cannot be pasted on the Mac, the most painful case being
the macOS lock-screen password. Today:

- There is no clipboard sync on any path. `docs/mac-agent-spec.md` §11 and README list it as
  out of scope; `server/gateway.js` sets `disable-copy: true` for Guacamole; the native agent
  protocol has no clipboard message.
- On a Windows keyboard the Mac's Command key is the Windows key, and Windows consumes Win+V,
  Win+C and a bare Win tap before Chromium sees them. So even Cmd+V on the Mac cannot be typed.
- The only workaround is the 텍스트 입력 dialog.

The owner explicitly does NOT want key remapping (Ctrl stays Control, Alt stays Option, the
Windows key stays Command): swapping keys would make Mac shortcuts confusing. The owner wants:
copy on Windows with Ctrl+C, paste on the remote Mac with Cmd+V; and the reverse, copy on the
Mac with Cmd+C, paste on Windows with Ctrl+V.

## 2. Goals

- G1. Windows → remote: text copied on the client is what the remote's own paste pastes, at
  the moment the user pastes on the remote (no stale paste after a quick copy-and-switch).
- G2. remote → Windows: text copied on the remote while the user is looking at the remote view
  becomes the client's clipboard content.
- G3. Paste at the Mac lock screen: while the Mac is locked, a remote paste types the client's
  clipboard text into the focused field (the lock-screen field refuses a real paste).
- G4. On a Windows client, the Windows key reaches the Mac as Command, including Win+V / Win+C /
  Win+A, whenever the remote view is focused in the desktop app — windowed or full screen
  (owner, 2026-10-19, revision 3). Mac and Linux clients keep today's keys (no lock): on a Mac
  client Command already is Command.
- G5. A paste path that needs no Command key: a 원격 menu item 클립보드 붙여넣기 (and a button in
  the browser bar) that sends the client clipboard and pastes it. This is the fallback if G4
  fails on Windows or the key lock was released (hold-Escape).
- G6. Same clipboard behaviour for every client OS of the desktop app (Windows, Mac, Linux; G4 is
  Windows only); browsers get
  it where the browser allows clipboard access.

## 3. Non-goals and anti-goals

- No key remapping (owner decision). Keys keep their current meaning.
- Text only (plain Unicode). No images, rich text, files.
- No clipboard traffic while no session is open, and none while the remote view is not focused
  (both directions; owner, 2026-10-19).
- No automatic push of the client clipboard at session start (owner, 2026-10-19; replaced by the
  focus and paste triggers of D3).
- Anti-goal: an echo loop or a clipboard "fight" (each side overwriting the other).
- Anti-goal: a silent wrong paste — when text could not be synced, the user is told (D8).
- Anti-goal: breaking a session, input or full screen when the other side is an old version or
  a new mechanism is refused (old agent, old desktop app, old page, denied permission).
- Win+L and Ctrl+Alt+Del cannot be captured on Windows by any user-mode app; out of scope.
- No native keyboard hook of our own: G4 uses Chromium's keyboard lock (D4).

## 4. Decisions

### D1. Paths covered

| Path | local → remote | remote → local |
|------|----------------|----------------|
| Mac (agent), WebRTC data channel (ordered) | new `clipboard` input message; agent writes NSPasteboard | agent reads NSPasteboard on change, sends a `clipboard` notice |
| Guacamole VNC (Mac VNC) and RDP (Ubuntu) | clipboard stream (already used by the text dialog) | `client.onclipboard`; gateway sets `disable-copy: false` |

`disable-copy` is shared by every Guacamole target, so Ubuntu/RDP gains both directions too;
this is intended (same need, same mechanism). Whether macOS Screen Sharing's VNC server
carries non-Latin-1 text is unknown (VNC cut text is ISO-8859-1 by default; guacd has a
`clipboard-encoding` parameter); the builder measures it and picks the setting that works, or
records the limit in README if it only carries Latin-1.

### D2. Reading and writing the client clipboard

- Desktop app: Electron 44's `clipboard` module is main-process only and has no change event.
  The preload bridge (version 3 → 4) gains `readClipboard()` and `writeClipboard(text, opts)`;
  the page decides when to call them (D3). There is no background polling.
- Main enforces the boundary itself, not the page's word: `readClipboard` and `writeClipboard`
  answer only while the app window is focused and the page is the gateway origin; otherwise
  they refuse. Trust assumption, stated: the gateway page already controls the remote machines;
  with bridge 4 a compromised gateway could also read the client clipboard while the app window
  is focused. This is accepted for a single-owner tailnet deployment.
- An old app (bridge 3) gets no clipboard sync and no G5 menu item; the page must decide app
  mode from the bridge version and must not fall back to `navigator.clipboard` inside the app
  (the app denies web permissions).
- Browser: best effort with `navigator.clipboard` at the same triggers; a refused permission is
  silent (the only silent failure, D8).

### D3. Sync rules (both directions, every path)

- Local → remote is sent at two triggers, each only if the text differs from the last text sent
  or received in this session (compared after CRLF → LF normalisation):
  1. the remote view gains focus (window focus while the session view is shown);
  2. a paste barrier: when the page sees a remote paste shortcut key-down (Mac targets: V with
     Meta held; other targets: Ctrl+V, Ctrl+Shift+V, Shift+Insert) or the G5 menu item, it holds
     that key-down and every later input event in order, reads the client clipboard (bounded
     wait, about 500 ms), sends the clipboard if changed, then releases the held events. On the
     agent path the data channel is ordered, so the text arrives before the V. On Guacamole the
     builder verifies the clipboard is applied before the key (same WebSocket, in order).
- Remote → local is applied only while the remote view is focused (owner, 2026-10-19). Remote
  changes while unfocused are dropped, not queued. The agent reads its pasteboard only while the
  client says the view is focused (a `clipboard-watch` on/off message; D6); on watch-on it takes
  the current change count as the baseline without reading, so a change made while unfocused is
  never sent.
- Line endings: Mac and Ubuntu get LF; Windows gets CRLF. Echo comparison uses normalised text.
- Size cap: 64 KiB of UTF-8. Larger text is not synced (no truncation) and D8 tells the user.
- Empty text and non-text clipboards are ignored (they do not clear the other side).

### D4. Command key capture (Windows key) — measured on Electron 44.5.1

First spike, 2026-10-19 (Linux/Xvfb, Electron 44.5.1, throwaway; HISTORICAL — it measured the
revision-2 design without `disableHtmlFullscreenWindowResize`; where it differs, the second
spike below is current):

- `keyboard.lock()` resolves in native full screen alone but does nothing: keys still reach
  main's `before-input-event`. With HTML full screen (`requestFullscreen` run from main through
  `executeJavaScript(..., true)`) and then `keyboard.lock()`, keys go only to the page:
  main's `before-input-event` sees nothing except Escape (F11 included).
- HTML full screen started this way also makes the window natively full screen
  (`enter-full-screen` then `enter-html-full-screen`).
- `win.setFullScreen(false)` does NOT end HTML full screen or the lock;
  `document.exitFullscreen()` ends both and the native state follows.
- Holding Escape about 2 s exits both and releases the lock (Chromium's escape hatch).
- Permission requests seen: `fullscreen` and `keyboardLock` (with `requestingUrl`).
- Not measurable there: whether Chromium's Windows low-level hook captures the Win key and
  Win+V. That is the rehearsal gate in §5.

Measured 2026-10-19 (second spike, same setup) with `webPreferences.disableHtmlFullscreenWindowResize:
true`: HTML full screen no longer resizes the window (`isFullScreen()` false, size unchanged,
`document.fullscreenElement` set), and `keyboard.lock()` is effective in that normal window
(main's `before-input-event` sees only Escape; Meta, V, Tab, F11 go to the page). The lock
survives a window blur and refocus; native full screen (`win.setFullScreen`) toggles
independently and the lock survives it; `document.exitFullscreen()` releases the lock without
touching the window; holding Escape about 1.5 s exits HTML full screen and releases the lock; an
Escape tap reaches the page and keeps the lock. Chromium's KeyboardLockController only locks
when `web_contents->IsFullscreen()`, which is the HTML full-screen state, hence this design.

Decisions (revision 3, owner approved 2026-10-19: capture "always" while the remote view is
focused, windowed or full screen):

- Windows clients only (`process.platform === "win32"` in main decides; the bridge tells the
  page). Mac and Linux desktop apps: F11 is plain native full screen, no HTML full screen, no
  lock — the same keys as the released 0.3.2.
- The desktop app sets `disableHtmlFullscreenWindowResize: true`. HTML full screen becomes an
  in-window state that only serves the key lock; it is not what F11 does.
- While a session view is shown AND the window is focused (Windows app with bridge ≥ 4; only a
  new page calls `keyLock`, an old page has no lock code and never calls it), the page holds HTML full screen + `keyboard.lock()`. It is
  taken when the session's first frame arrives, when the window gains focus, and when the user
  clicks the remote view while not held — always through main's `executeJavaScript(..., true)`,
  so no page user-activation is needed. It is released (`keyboard.unlock()` +
  `document.exitFullscreen()`) on window blur and when the session ends, so nothing is captured
  while another Windows app is in front, whatever Chromium's hook does on blur.
- If the lock is refused or does not resolve within 2 s after HTML full screen was entered, the
  page leaves HTML full screen at once (an unlocked HTML full screen would make an Escape tap
  leave full screen instead of reaching the Mac).
- F11 / View → 전체 화면 go back to plain native full screen (`win.setFullScreen`), independent of
  the lock (measured: the lock survives native toggles). Because the lock hides F11 from main,
  the page forwards an F11 key-down to main's native toggle while locked.
- Hold-Escape (Chromium, ~1.5 s) releases the lock until the user clicks the remote view or the
  window gains focus again; an Escape tap stays a remote key. Win+L and Ctrl+Alt+Del stay with
  Windows. While locked, Alt+Tab, Win+D etc. go to the Mac too; the user leaves the window with
  the mouse (owner accepted).
- Signals: when the lock is first taken in a session the viewer shows a short notice
  ("Windows 키가 Mac으로 갑니다 · Esc를 길게 누르면 풀립니다"); when hold-Escape releases it,
  "키 잡기를 풀었습니다 · 화면을 클릭하면 다시 잡습니다". A refused / timed-out lock logs one
  line (reason only) and shows no dialog.
- Permission handler: grant `fullscreen` and `keyboardLock` only for the gateway origin, as before.
- If HTML full screen or the lock is refused or hangs, the session works, the Windows key is not
  captured, G5 still works; no error dialog. An old page never calls `keyLock`, so it never gets HTML full screen.
- Kill switch: repointing the gateway to the previous candidate turns the lock off for every
  installed app without an app downgrade (its page never calls `keyLock`).
- Browsers: unchanged (no lock).

### D5. Lock-screen paste (Mac agent path)

- The lock-screen password field refuses a normal paste (indirect evidence: N-able
  remote-control docs; NSSecureTextField). The agent knows the lock state
  (`CGSSessionScreenIsLocked`), but on 2026-10-19 its status said `locked:true` while the Mac's display
  was only asleep and the session was not locked (lock delay 300 s; `IOConsoleLocked` false). The
  lock-screen paste decision must use a signal that means the session is really locked: the
  console lock (`IOConsoleLocked`, or an equivalent the builder shows to agree with it), so the
  display-asleep and screen-saver-within-grace cases count as unlocked.
- The agent tells the page the lock state: `{"type":"lock","locked":bool}` when the session
  opens and on every change of that signal. On every lock change the page forgets its last sent
  and received text (so the next trigger sends again), and while the Mac is locked the paste
  barrier always sends the client text even if unchanged. So text synced before the lock is sent
  again and held for a lock-screen paste, and after unlock the next paste writes the client text
  to the pasteboard (no stale paste). An old agent sends no lock notice; the page then behaves as
  without lock handling.
- While the screen is locked, clipboard text from the client is held in the agent's memory only
  and is NOT written to NSPasteboard (nothing of a lock-screen password stays on the Mac). The
  held text is dropped on unlock and at session end.
- While locked, V key-down with Command held and no other modifier is not injected. If held text
  exists, the agent types it through the existing typing path and treats V as released; if none
  exists (the client clipboard was empty or not text), the key is injected as usual (a no-op at
  the lock screen) and D8 tells the user there was nothing to type.
- Line breaks at the lock screen: one trailing CR/LF/CRLF is stripped; text that still contains
  a line break is not typed and D8 tells the user (a multi-line paste would submit several wrong
  passwords).
- Typing at the lock screen uses key codes, not the Unicode-string path: P1 (2026-10-16) measured
  that key-code input reaches the lock-screen password field; the Unicode-string path
  (`CGEventKeyboardSetUnicodeString`, used by 텍스트 입력) is unmeasured there. Characters that
  exist on the ABC/US layout (letters, digits, symbols, with Shift where needed) are typed as key
  codes; any other character falls back to the Unicode path. The rehearsal (§5) measures both.
- When unlocked, Cmd+V is injected normally (a real paste of the synced pasteboard).
- The VNC path gets no lock-screen special case (its key input at the lock screen did not work in
  P1; unchanged).

### D6. Agent changes

- Inbound `{"type":"clipboard","text":...}` (written to NSPasteboard when unlocked, held when
  locked, D5) and `{"type":"clipboard-watch","on":bool}` (D3).
- Outbound `{"type":"clipboard","text":...}` on a pasteboard change while watch is on (poll
  `changeCount` about every 300 ms; ignore changes the agent made itself), and
  `{"type":"clipboard-skipped","reason":...}` for D8 cases (too large, read denied, lock-screen
  multi-line, nothing to type), and `{"type":"lock","locked":bool}` (D5).
- Writes use `prepareForNewContents(with: .currentHostOnly)` (exists since macOS 10.12, checked in
  the macOS 27 SDK) so Universal Clipboard does not carry the text to other Apple devices.
- macOS paste privacy: the SDK header says the general pasteboard defaults to asking on
  programmatic content reads (`accessBehavior`, macOS 15.4+), and `changeCount`/`types` never
  ask. A probe on the owner's Mac (macOS 27.0.1, ad-hoc signed, run in the GUI session) reported
  `accessBehavior = alwaysAllow`; content reads were not tested. So: the agent reads content only
  after a change while watch is on (the user is looking at the Mac, so a one-time macOS alert is
  visible and answerable through the remote view); `alwaysDeny` means no read and a
  `clipboard-skipped` notice; a refused read is a normal state, not an error.
- The peer's handle can only queue frames today; the builder adds a way to queue an outbound
  data-channel message.
- Old pages ignore the new notices (they only parse `replaced`); old agents drop the unknown
  inbound messages (`protocol::parse` drops unknown types). No capability negotiation is needed.
- Pasteboard access via objc2 (existing dependency), builder's call how, keeping `cargo deny`
  and `--locked` green. All messages go into `agent/mac/tests/fixtures/contract.json`.
- Agent version 0.1.0 → 0.2.0. The owner runs `install.sh` on the Mac (sudo) to install it.

### D7. Privacy

- Owner was told (2026-10-19) that Mac-copied text, passwords included, can land in Windows
  Clipboard History. Mitigation: password-manager marks travel across. On Windows → Mac, if the
  Windows clipboard carries `ExcludeClipboardContentFromMonitorProcessing` (or
  `CanIncludeInClipboardHistory` = 0) the text is sent marked concealed and the agent adds
  `org.nspasteboard.ConcealedType`. On Mac → Windows, if the pasteboard carries
  `org.nspasteboard.ConcealedType` the app writes `ExcludeClipboardContentFromMonitorProcessing`
  alongside the text. If Electron 44's `clipboard.has/write` with
  `application/osclipboard;format=...` cannot read or set these, that direction's mark is dropped
  and README records the residual risk.
- No automatic session-start push (§3). No traffic while unfocused (§3). Mac writes are
  current-host-only (D6). Lock-screen text never reaches the Mac pasteboard (D5).
- No clipboard text is logged by the agent, gateway or app — reason and byte length only (D8).
  The gateway never stores clipboard text (Guacamole streams pass through guacd).

### D8. Failure signals

- The viewer shows a short non-blocking notice (not the error dialog) when text exists but was
  not synced or typed: too large (either direction), the Mac refused the pasteboard read, a
  multi-line lock-screen paste, nothing to type at the lock screen, the bridge refused (window
  not focused at that instant).
- Known limit, accepted: a Mac copy made in the last few hundred milliseconds before the remote
  view loses focus may not reach the client (the watch stops on focus loss); copying again with
  the view focused fixes it. README states it.
- The agent and the app log one line per skip with the reason and byte length.
- A browser permission refusal is the only silent case.

## 5. Rollout, rehearsal and rollback

1. Implementation review converges; branch pushed.
2. Rehearsal before any tag or production change:
   - Install agent 0.2.0 on the Mac (I sync the build dir; the owner runs `./install.sh`). An old
     production page against the new agent is inert (D6), so this is safe before step 4.
   - Run the new gateway as a candidate on :8451 (off today) and install the CI build artifact
     of the PR (build.yml makes a Windows .exe, not published) on the owner's Windows PC,
     pointed at :8451.
   - Run the §6 device checks there and record them in docs/verification.md.
   - At the end of the rehearsal (pass or withdraw) the owner's app is pointed back at :8450
     (서버 주소 바꾸기) and, if the rehearsal build is not released, reinstalled from the current
     release; the :8451 candidate is stopped.
   - Withdraw criteria: D4's key lock is removed from the release (G5 and G1–G3 still ship) and
     the owner decides on a follow-up if any of these happens on Windows: the Windows key is not
     captured; capture leaks outside the focused window (other apps lose Win / Alt+Tab / Win+D,
     also after minimising or clicking away); hold-Escape or the click re-lock does not work; F11
     no longer toggles full screen; the user can get stuck. If lock-screen typing fails, G3 is
     dropped (VNC tile stays the fallback).
3. Merge; tag desktop v0.3.3 → installed apps self-update (Windows, Mac).
4. Point :8450 at the new gateway candidate like the 0.3.0 cutover (new dir under
   ~/remote-candidates; previous dir kept).
5. Rollback: gateway — repoint the unit to the previous dir; agent — reinstall `.prev`
   (owner, sudo); desktop app — auto-update cannot downgrade, so a fix ships as v0.3.4; until
   then the app keeps working against the old gateway because bridge-4 features are only used
   when the page also supports them.

## 6. Verification

- Automated: TS unit tests for the sync rules (triggers, echo suppression with normalisation,
  size cap, empty/non-text, unfocused drop, paste-barrier ordering and timeout), message shapes,
  bridge 4 and main's focus/origin guard, full-screen state transitions with lock and refusal
  fallback, permission grants limited to the gateway origin; Rust tests for the new messages,
  watch baseline, outbound queue, locked Cmd+V decision (held text, none held, multi-line,
  trailing newline), held text dropped on unlock; contract fixture.
- Device, recorded in docs/verification.md (owner + me):
  1. Windows: Ctrl+C in Notepad, switch to the app, immediately Cmd+V (full screen) in TextEdit
     pastes the new text (not the previous one).
  2. Mac: Cmd+C in TextEdit → Ctrl+V in Notepad pastes it; a Mac-side change while the app is
     in the background does not change the Windows clipboard.
  3. Mac locked: dummy text first, then the real password, via Cmd+V and via 클립보드 붙여넣기;
     the Mac pasteboard does not contain it afterwards. Both cases: text copied after the lock,
     and text already synced before the lock. Negative: with only the display asleep (within the
     lock delay) Cmd+V pastes normally and types nothing; right after unlock, pasting the same
     text again pastes it (not the older pasteboard content).
  4. Windows, windowed AND full screen: Win+V / Win+C / Win+A reach the Mac; a bare Win tap does
     not open Start; an Escape tap reaches the Mac; F11 toggles native full screen while locked;
     hold-Escape releases the lock (notice shown) and a click on the remote view takes it again;
     negative: after clicking another app, after minimising the window, and after hold-Escape,
     Win / Alt+Tab / Win+D work in Windows as usual; Win+L locks Windows (expected).
     After clicking back into the app window, Win+V reaches the Mac again (focus re-lock).
  4b. Mac client app: Cmd+Q / Cmd+W / Cmd+H act on the local app as in
     0.3.2 (no lock on Mac clients).
  5. 클립보드 붙여넣기 pastes on the Mac (windowed, and after hold-Escape).
  6. VNC and Ubuntu RDP: both directions, Korean text, multi-line text with no ping-pong.
  7. Over 64 KiB: notice shown, nothing pasted silently.
  8. Old app against the new gateway/agent and new app against the old agent: sessions work.

## 7. Docs to update

README (scope line, Mac agent session notes, text input note, residual privacy risk if any),
docs/mac-agent-spec.md (D4 input messages, §11 out-of-scope), docs/verification.md (device
checks), this spec's status.

## 8. Pre-implementation measurements

- Electron keyboard lock (D4): done 2026-10-19, results in D4.
- Mac pasteboard metadata probe (D6): done 2026-10-19, results in D6.
- Lock-screen typing (D5): attempted 2026-10-19 with the owner's approval, not run. `pmset
  displaysleepnow` only sleeps the display (lock delay 300 s), and during the wait another Gome
  Remote session opened the Mac and woke it, so the gate (locked, display on, `IOConsoleLocked`)
  never passed and no input was sent. D5 therefore types with key codes (measured in P1) and the
  rehearsal measures the Unicode fallback.
