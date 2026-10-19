# Clipboard sync and Command key capture — design

Status: owner approved the direction in chat on 2026-10-19 (grade F). This document records
the design decisions; the plan and code come after the design review converges.

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

- G1. Windows → remote: text the user copies on the client while a session is open becomes the
  remote clipboard's content, so the remote's own paste (Cmd+V on Mac, Ctrl+V on Ubuntu) pastes it.
- G2. remote → Windows: text copied on the remote becomes the client's clipboard content.
- G3. Cmd+V works at the Mac lock screen: while the Mac is locked, Command+V from the client
  types the clipboard text into the focused field instead of a paste.
- G4. The Windows key reaches the Mac as Command, including Win+V / Win+C / Win+A, in the
  desktop app's full-screen mode.
- G5. Same behaviour for every client OS of the desktop app (Windows, Mac, Linux); browsers get
  it where the browser allows clipboard access.

## 3. Non-goals and anti-goals

- No key remapping (owner decision). Keys keep their current meaning.
- Text only (plain Unicode). No images, rich text, files.
- No sync while no session is open, and no sync from a window the user is not looking at
  (local → remote only while the remote view has focus).
- Anti-goal: an echo loop or a clipboard "fight" (each side overwriting the other forever).
- Anti-goal: breaking a session or input when the other side is an old version (old agent,
  old desktop app, old page).
- Win+L and Ctrl+Alt+Del cannot be captured on Windows by any user-mode app; out of scope.

## 4. Decisions

### D1. Paths covered

| Path | local → remote | remote → local |
|------|----------------|----------------|
| Mac (agent), WebRTC data channel | new `clipboard` input message; agent writes NSPasteboard | agent watches NSPasteboard, sends `clipboard` notice |
| Guacamole VNC (Mac VNC) and RDP (Ubuntu) | `client.setClipboard`-style clipboard stream (already used by the text dialog) | `client.onclipboard`; gateway sets `disable-copy: false` |

`disable-copy` is shared by every Guacamole target, so Ubuntu/RDP gains both directions too;
this is intended (same need, same mechanism). Whether macOS Screen Sharing's VNC server
carries non-Latin-1 text is unknown (VNC cut text is ISO-8859-1 by default; guacd has a
`clipboard-encoding` parameter); the builder measures it and picks the setting that works, or
records the limit in README if it only carries Latin-1.

### D2. Where the local clipboard is read and written

- Desktop app: the Electron 44 `clipboard` module is main-process only and has no change event.
  The main process polls `readText` (about every 500 ms) only while the page has told it a
  session is active and the window is focused, and pushes changes to the page over IPC. Writes
  from the page go through IPC to main. Exposed through the preload bridge; the bridge version
  goes from 3 to 4 so the page can tell an old app (no clipboard) from a new one. The bridge is
  only available to the gateway origin page, as today.
- Browser: best effort with `navigator.clipboard` — read on view focus / before a remote
  paste shortcut when the browser grants it, write when a remote change arrives and the
  document has focus. Failures are silent (no prompt loops, no error banners).
- The permission handlers in `desktop/main.cjs` keep denying everything except what D4 needs;
  clipboard access in the app goes through IPC, not web permissions.

### D3. Sync rules (both directions, every path)

- Each side remembers the last text it sent and the last text it received. A change equal to
  the last received text is not sent back (no echo). The client side sends on change only, not
  on every poll.
- On session start the client sends its current clipboard text once (so text copied before
  connecting can be pasted), and the remote side sends nothing until its clipboard changes.
- Size cap: 64 KiB of UTF-8 per clipboard text. Larger text is not synced in either direction
  (no truncation — a truncated password or snippet is worse than none). Exact framing on the
  data channel (one message vs chunks) is the builder's call within the agent's existing
  per-message parse limits, which must be raised only for this message type.
- Empty text and non-text clipboards are ignored (they do not clear the other side).

### D4. Command key capture (Windows key)

- Mechanism: Chromium's Keyboard Lock API (`navigator.keyboard.lock()`), which on Windows
  installs Chromium's own low-level keyboard hook. Chromium only honours it while the page is in
  HTML (JavaScript-initiated) full screen, and Electron gates it behind the `keyboardLock` and
  `fullscreen` permissions.
- So: in the desktop app, entering full screen (F11 / View → 전체 화면) also puts the page in
  HTML full screen and requests keyboard lock while a session is open; leaving full screen
  releases it. The permission handler grants `keyboardLock` and `fullscreen` to the gateway
  origin only; everything else stays denied.
- In a normal (windowed) app window the Windows key is not captured. This matches Microsoft's own
  Remote Desktop client default ("Windows key combinations: only when using the full screen").
  A native low-level hook for windowed mode is NOT part of this work (needs a native module in
  an unsigned Windows build; Windows silently drops slow LL hooks); it can be a follow-up if the
  owner wants it after using full screen.
- F11 must still leave full screen while the keyboard is locked (Electron's `before-input-event`
  sees it before the page). Escape stays a remote key; Chromium's hold-Escape exit remains.
- Whether Win+V / Win+C / Win+A actually reach the page under keyboard lock is confirmed on the
  owner's Windows PC (no Windows machine is available to me); if they do not, the owner decides
  on the follow-up.

### D5. Lock-screen paste (Mac agent path)

- The macOS lock-screen password field does not accept a normal paste (indirect evidence:
  N-able remote-control docs; NSSecureTextField). The agent already reports the lock state
  (`CGSSessionScreenIsLocked`).
- While the screen is locked, a V key-down with Command held (and no other modifier) is not
  injected; the agent types the current clipboard text instead through the existing `text`
  typing path, then behaves as if V was released. Line breaks are not special-cased: the text is
  typed as is, so a trailing newline would press Return (a password manager copy has none).
- When unlocked, Cmd+V is injected normally (a real paste of the synced pasteboard).
- Plain key injection at the lock screen was measured to work (P1, docs/verification.md);
  Unicode-string typing at the lock screen is not yet measured and is part of verification.
- The VNC path gets no lock-screen special case (its key input at the lock screen did not work
  in P1 for unknown reasons; unchanged).

### D6. Agent changes

- New inbound message `{"type":"clipboard","text":...}` → write the general NSPasteboard
  (string type). New outbound notice `{"type":"clipboard","text":...}` on pasteboard change
  (watch `changeCount` about every 300 ms during an open session; ignore changes the agent made
  itself). Both added to `agent/mac/tests/fixtures/contract.json` and its two tests.
- The peer's handle can only queue frames today; the builder adds a way to queue an outbound
  data-channel message.
- Old pages ignore the new notice (they only parse `replaced`); old agents drop the unknown
  inbound message (`protocol::parse` drops unknown types). No capability negotiation is needed.
- Pasteboard access via objc2 (existing dependency) — `objc2-app-kit` or `msg_send!`, builder's
  call, keeping `cargo deny` and `--locked` green.
- Agent version 0.1.0 → 0.2.0. The owner runs `install.sh` on the Mac (sudo) to install it.

### D7. Privacy

- Remote text lands on the client clipboard, so Windows Clipboard History / cloud sync may keep
  it (for example a password copied on the Mac). When writing remote text on Windows, the app
  also sets the `ExcludeClipboardContentFromMonitorProcessing` format if Electron 44's
  `clipboard.write` can set an `application/osclipboard;format=...` entry; if it cannot, this is
  recorded as a residual risk in README.
- No clipboard text is logged by the agent, the gateway or the app (lengths only, if anything).
- Text flows only between the user's own client and the user's own remote over the existing
  authenticated session; the gateway never stores it (Guacamole streams pass through guacd).

## 5. Rollout and rollback

1. Merge after review; tag desktop v0.3.3 → installed apps self-update (Windows, Mac).
2. Gateway: deploy a new candidate the same way as 0.3.0 (new dir under ~/remote-candidates,
   unit points at it, keep the previous dir for rollback by repointing).
3. Agent 0.2.0: I sync the build dir on the Mac; the owner runs `./install.sh` (sudo). `.prev` is
   kept by the installer for rollback.
4. Any order works: each piece is inert against an old counterpart (D6, D2 bridge version).

## 6. Verification

- Automated: TS unit tests for the sync rules (echo suppression, size cap, empty/non-text,
  session start push), message shapes, bridge 4; desktop tests for the IPC, polling only when
  active+focused, permission grants limited to the gateway origin; Rust tests for the new
  messages, the outbound queue, the locked Cmd+V decision; contract fixture.
- Device (owner + me), recorded in docs/verification.md:
  1. Windows: Ctrl+C in Notepad → Cmd+V (in full screen) in a Mac TextEdit window pastes it.
  2. Mac: Cmd+C in TextEdit → Ctrl+V in Notepad pastes it.
  3. Mac locked: copy a test password on Windows → Cmd+V at the lock screen types it (use a
     dummy wrong password first; then the real one).
  4. Windows full screen: Win+V / Win+C / Win+A reach the Mac; Win+L locks Windows (expected).
  5. VNC and Ubuntu RDP: both directions, including Korean text.
  6. Old app against new gateway/agent and new app against old agent: sessions still work.

## 7. Docs to update

README (scope line, Mac agent session notes, text input note), docs/mac-agent-spec.md (D4 input
messages, §11 out-of-scope), docs/verification.md (device checks), this spec's status.
