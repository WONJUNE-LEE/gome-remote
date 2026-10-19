# Clipboard Sync and Command Key Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text copied on the client pastes on the remote and the reverse (Mac agent, VNC, RDP), a lock-screen paste types the client text into the Mac password field, and the Windows key reaches the Mac as Command in the desktop app's full screen, with no key remapping.

**Architecture:** The page owns the sync rules (a pure TS core: focus and paste-barrier triggers, dedupe, notices) and talks to the client clipboard through desktop bridge 4 (main-process Electron `clipboard`) or `navigator.clipboard`. The Mac agent gains clipboard and lock messages on the existing `input` data channel, a pasteboard layer behind its `Platform` trait, a per-session state machine (watch, held lock-screen text) and an outbound queue on the peer. The desktop app enters HTML full screen on request of main and the page takes `keyboard.lock()` while a session is open.

**Tech Stack:** Node.js 24 (`node --test`), TypeScript 5.9 + Vite 8, Electron 44.5.1 (async `clipboard` module), Rust 2021 (str0m 0.24, objc2 0.6 family), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-clipboard-sync-design.md` (converged; source of truth, do not edit decisions). Cited as D1-D8, G1-G6, §5, §6. The older plan `docs/superpowers/plans/2026-10-14-mac-agent.md` ("Working conventions": the Mac build loop with `$MAC`) still governs how Rust is built on the Mac.

## Global Constraints

- Size cap: **64 KiB of UTF-8** (65 536 bytes of `text`) in both directions; larger text is **never truncated**, it is not synced and the user is told (D3, D8). The encoded data-channel message is capped at 256 KiB (str0m `LOCAL_MAX_MESSAGE_SIZE`, `str0m-0.24.1/src/sctp/mod.rs:35`); JSON escaping can make 64 KiB of control characters larger than that, so the page checks the encoded length too.
- Dedupe compares text after **CRLF (and lone CR) to LF** normalisation; Mac and Ubuntu receive LF, Windows receives CRLF (written by the main process on `win32`).
- Paste barrier: bounded wait **500 ms** (`PASTE_BARRIER_MS`). Agent pasteboard poll: `changeCount` about every **300 ms** (`POLL`) while watch is on.
- Empty text and non-text clipboards are ignored on both sides (never clear the other side). Text only.
- No clipboard traffic while no session is open or the remote view is unfocused (both directions); no automatic push at session start; remote changes while unfocused are dropped, not queued.
- Bridge version **3 → 4**; an app with bridge < 4 gets no sync and no G5 item, and the page never falls back to `navigator.clipboard` inside the app. Agent version **0.1.0 → 0.2.0** (`agent/mac/Cargo.toml`).
- Main answers `remote:clipboard-read` / `remote:clipboard-write` only while `window.isFocused()` and only for the gateway origin in the top frame (the `handle("gateway", ...)` rule).
- Permission handler grants `fullscreen` and `keyboardLock` **only** when `details.requestingUrl` is the gateway origin; everything else stays denied. Leaving full screen always goes through `document.exitFullscreen()`; `win.setFullScreen(false)` does not end HTML full screen (D4, measured).
- Lock signal: the console lock (`IOConsoleLocked` or an equivalent shown to agree with it), never `CGSSessionScreenIsLocked` alone; display asleep or screen saver within grace counts as unlocked. While locked the client text is held in agent memory only and never written to NSPasteboard; held text is dropped on unlock and at session end.
- Mac pasteboard writes use `prepareForNewContents(with: .currentHostOnly)`; concealed text adds `org.nspasteboard.ConcealedType`; the agent reads content only after a change while watch is on; `alwaysDeny` or a refused read is a `clipboard-skipped` notice, not an error.
- **No clipboard text in any log** (agent, gateway, app, page console): reason and byte length only, one line per skip. The gateway never stores clipboard text.
- No key remapping: Ctrl stays Control, Alt stays Option, the Windows key stays Command. Escape stays a remote key on tap; hold-Escape exits full screen. Windowed mode captures no Windows key.
- Unknown messages are dropped, never guessed at: old agents drop the new inbound types, old pages ignore the new notices (they parse only `replaced`). No capability negotiation.
- Public repository hygiene: never commit owner identifiers (logins, device names such as the Mac host's, real tailnet addresses, home paths); use `100.64.0.10`, `100.64.0.20`, `owner@example.com`, `*.example.ts.net`, `/home/user`. Run `node --test test/public-hygiene.test.js` after staging, before every commit.
- Rust: `cargo fmt` (`agent/mac/rustfmt.toml`, width 120), `cargo clippy --locked --all-targets -- -D warnings`, `--locked` on every cargo command except the one that regenerates `Cargo.lock`; `cargo deny check` (0.20.2) stays green, no new licence outside `deny.toml`'s list. TypeScript/JS: `npx prettier --write <files>`, `npm run check`.
- Korean copy is exactly the strings in the tests. Commits: one per task, one imperative sentence like the existing history, plus the session's usual trailers.

## Review Focus

Spec-implied inputs that no happy-path test covers, most likely first; each has its test in the owning task (marked `Review Focus N`).

1. **Copy then paste at once, and slow clipboard reads.** Ctrl+C on Windows, switch to the app, Cmd+V within the same moment: the text must reach the remote before the V, a focus-trigger read still in flight must not overtake or reorder the paste read, a read slower than 500 ms must release the held keys without a stale late send, and a window that is not yet "focused" for main at the focus instant must not produce an error notice. Owners: Task 9 (`test/clipboard-sync.test.js`), Task 10 (`test/viewer-agent.test.js`, order on the real channel), Task 7 (focus guard).
2. **Lock state flapping around a paste.** Locked → unlocked → locked between two polls, a `lock` notice arriving while the barrier is open, unlock right after a lock-screen type, a lock change with unchanged client text. The decision must use a fresh signal at the V key-down, text synced before the lock must be sent again and held, the Mac pasteboard must never get lock-screen text, and the next paste after unlock must write the client text (no stale paste). Owners: Task 5 (`clipboard.rs` tests), Task 6 (`session.rs` tests), Task 9.
3. **Multi-byte text across every limit.** Korean/emoji text: the 64 KiB cap counts UTF-8 bytes, not UTF-16 units (21 845 Korean characters fit, 21 846 do not); lone surrogates; escaped control characters inflating the encoded message past 256 KiB; the lock-screen Unicode fallback for non-ABC characters; macOS VNC cut text that may be Latin-1 only (a silent `?` paste is the anti-goal). Owners: Task 1 (`protocol.rs`), Task 4 (`typing.rs`), Task 9, Task 11 (VNC encoding outcome).
4. **Version skew both ways.** Old agent + new page (no `lock`, no watch reply, unknown inbound messages dropped: Cmd+V must behave exactly as today and no notice may appear); old page + new agent (agent never sees watch-on, so it never reads the pasteboard; unknown notices ignored); old app (bridge 3) + new page (no sync, no G5, no lock, native full screen unchanged); new app + old page (HTML full screen entered and left by main without the page ever taking the lock). Owners: Task 10 (`test/viewer-agent.test.js`), Task 6, Task 7/8 (`test/desktop.test.js`, `test/preload.test.js`).
5. **Every way out of full screen.** `showSetup`'s `requestFullscreen(false)` (`desktop/main.cjs:186`) while HTML full screen and the lock are active, `back()` (`src/main.ts:456`, `void setFullscreen(false)`), the page's F11 while locked, a menu F11 that also reaches main (double toggle must not re-enter), hold-Escape (`leave-html-full-screen`), a dead page (`executeJavaScript` rejects), and a session ending while full screen (lock released). Owner: Task 8.

## Decisions taken by the main session while planning

- The `read-timeout` and `unsupported-chars` notices are added to D8's list (they follow from "no silent wrong paste").
- Concealed marks on the client side are Windows only (D7); no `org.nspasteboard.ConcealedType` on Mac clients.
- Keyboard lock is taken only in the desktop app with bridge ≥ 4, never in browsers.
- Status `locked` and the tile keep the CGS signal; only the paste decision and the `lock` notice use the console lock.
- `package.json` stays 0.3.2 on this branch; the 0.3.3 bump goes with the release tag after the rehearsal (§5 step 3).

## Working conventions

- Node/TS tests: `node --test test/<file>`; all: `npm test`; types: `npm run check`. CI (`.github/workflows/build.yml`) runs `npm test`, `npm run check`, the Electron smoke test (Linux, `xvfb-run -a npx electron . --no-sandbox --smoke-test --user-data-dir=...`) on three OSes, and the `agent-mac` job (macOS runner): `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, `cargo test --locked --features dev-install`, release-build greps, `cargo deny check`.
- Rust on Linux: everything outside `agent/mac/src/mac/` compiles and tests with `cd agent/mac && cargo test --locked` (fast loop). **macOS only** (compile and run on the Mac build loop or the macOS CI runner): `src/mac/pasteboard.rs` (Task 3), `src/mac/system.rs` and `src/mac/ffi.rs` additions (Task 3), `src/mac/inject.rs` (Task 4), `src/mac/agent.rs` (Tasks 3, 6). Each task that touches them says so; the Linux run alone does not prove them.
- Tests load TS modules through `test/helpers/load-ts.js` (`loadTs(name, globals, modules)`); a module imported by `main.ts` must be added to the `modules` map in `test/helpers/viewer-harness.js` (`:400-410`). `agent.ts` imports only `./agent-input`; keep it that way so `test/helpers/agent-harness.js` (`:243`) needs no new module.
- `tsc` does not know `navigator.keyboard`: Task 8 declares it in `src/types.d.ts`.

---

### Task 1: Wire protocol: agent messages and the page's wire module

**Files:**
- Modify: `agent/mac/src/protocol.rs:10-14` (limits, notice constant), `:27-47` (`InputMsg`), `:59-70` (early size gates in `parse`), add arms before `_ => None` (~`:103`); tests at the bottom (`:203` and `:218-240` assert the old limits and change).
- Modify: `agent/mac/tests/fixtures/contract.json` (`input` +3, `notice` grows), `agent/mac/tests/contract.rs:19-35` (limit per kind, new kinds), `:53-66` (notices test).
- Modify: `src/agent-input.ts:163-190` (`message`, `parseNotice`) and add exports below.
- Test: `agent/mac/src/protocol.rs` (unit), `agent/mac/tests/contract.rs`, `test/agent-contract.test.js:19-70`, `test/agent-input.test.js`.

**Interfaces:**
- Produces (JSON, inbound page → agent): `{"type":"clipboard","text":string,"concealed"?:bool}` (text non-empty, ≤ 65 536 UTF-8 bytes, whole message ≤ 262 144 bytes; `concealed` absent = false) and `{"type":"clipboard-watch","on":bool}` (≤ 512 bytes).
- Produces (JSON, outbound agent → page, text frames): `{"type":"clipboard","text":string,"concealed":bool}`, `{"type":"clipboard-skipped","reason":"too-large"|"read-denied"|"locked-multiline"|"locked-empty"}`, `{"type":"lock","locked":bool}`; `{"type":"replaced"}` unchanged.
- Produces (Rust): `pub const MAX_CLIPBOARD_TEXT: usize = 64 * 1024; pub const MAX_CLIPBOARD_MESSAGE: usize = 256 * 1024;` `InputMsg::Clipboard { text: String, concealed: bool }`, `InputMsg::ClipboardWatch(bool)`; `pub enum SkipReason { TooLarge, ReadDenied, LockedMultiline, LockedEmpty }` with `pub fn as_str(self) -> &'static str`; `pub fn clipboard_notice(text: &str, concealed: bool) -> String`, `pub fn skipped_notice(reason: SkipReason) -> String`, `pub fn lock_notice(locked: bool) -> String`.
- Produces (TS, `src/agent-input.ts`): `export const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024; export const MAX_CLIPBOARD_MESSAGE_BYTES = 256 * 1024; export type SkipReason = "too-large" | "read-denied" | "locked-multiline" | "locked-empty"; export type AgentMessage = {type:"replaced"} | {type:"lock";locked:boolean} | {type:"clipboard";text:string;concealed:boolean} | {type:"clipboard-skipped";reason:SkipReason}; export function parseAgentMessage(data: unknown): AgentMessage | undefined;` and `message.clipboard(text: string, concealed: boolean): string`, `message.clipboardWatch(on: boolean): string`. `parseNotice` is unchanged (still only `replaced`, ≤ 256 chars).

- [ ] **Step 1: Write the failing Rust tests** in `protocol.rs` `mod tests` and replace the limit tests:

```rust
#[test]
fn clipboard_messages_parse_with_and_without_concealed() {
    assert_eq!(p(r#"{"type":"clipboard","text":"안녕\n😀"}"#), Some(InputMsg::Clipboard { text: "안녕\n😀".into(), concealed: false }));
    assert_eq!(p(r#"{"type":"clipboard","text":"x","concealed":true}"#), Some(InputMsg::Clipboard { text: "x".into(), concealed: true }));
    assert_eq!(p(r#"{"type":"clipboard-watch","on":true}"#), Some(InputMsg::ClipboardWatch(true)));
    for bad in [r#"{"type":"clipboard","text":""}"#, r#"{"type":"clipboard","text":5}"#, r#"{"type":"clipboard","text":"x","concealed":"yes"}"#, r#"{"type":"clipboard-watch","on":1}"#, r#"{"type":"clipboard-watch"}"#] {
        assert_eq!(p(bad), None, "{bad}");
    }
}
#[test]
fn clipboard_text_is_capped_at_64_kib_of_utf8_not_characters() {   // Review Focus 3
    let fits = "가".repeat(21_845); // 65 535 bytes
    assert!(p(&format!(r#"{{"type":"clipboard","text":"{fits}"}}"#)).is_some());
    assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"{}"}}"#, "가".repeat(21_846))), None);
    let exact = "a".repeat(MAX_CLIPBOARD_TEXT);
    assert!(p(&format!(r#"{{"type":"clipboard","text":"{exact}"}}"#)).is_some());
    assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"{exact}a"}}"#)), None);
}
#[test]
fn only_clipboard_may_exceed_8_kib_and_its_message_stops_at_256_kib() {
    let big = format!(r#"{{"type":"text","s":"{}"}}"#, "a".repeat(MAX_TEXT_MESSAGE)); assert_eq!(p(&big), None);
    let pad = " ".repeat(MAX_CLIPBOARD_MESSAGE);
    assert_eq!(p(&format!(r#"{{"type":"clipboard","text":"a","pad":"{pad}"}}"#)), None);
    assert_eq!(p(&format!(r#"{{"type":"pointer","x":0.5,"y":0.5,"pad":"{}"}}"#, " ".repeat(600))), None);
}
#[test]
fn notices_are_valid_json_and_never_parse_as_input() {
    assert_eq!(lock_notice(true), r#"{"type":"lock","locked":true}"#);
    assert_eq!(skipped_notice(SkipReason::LockedMultiline), r#"{"type":"clipboard-skipped","reason":"locked-multiline"}"#);
    let n = clipboard_notice("a\"\n한", true);
    assert_eq!(serde_json::from_str::<Value>(&n).unwrap()["text"], "a\"\n한");
    for m in [n, lock_notice(false), skipped_notice(SkipReason::TooLarge)] { assert!(parse(m.as_bytes()).is_none()); }
}
```

  The old `only_text_may_exceed_512_bytes_and_nothing_exceeds_8_kib` keeps its text/512 assertions but drops the "nothing exceeds 8 KiB" claim (rename it `only_text_and_clipboard_exceed_512_bytes`).
- [ ] **Step 2: Run** `cd agent/mac && cargo test --locked protocol::` — Expected: FAIL (compile error: no variant `Clipboard`, no `lock_notice`).
- [ ] **Step 3: Implement** in `protocol.rs`: the constants, `InputMsg` variants, the builders and `SkipReason` as in Interfaces. `parse`: gate on `MAX_CLIPBOARD_MESSAGE` first, then per kind (`text` ≤ `MAX_TEXT_MESSAGE`, `clipboard` text ≤ `MAX_CLIPBOARD_TEXT` bytes and non-empty, everything else ≤ `MAX_MESSAGE`). Build notices with `serde_json::json!(...).to_string()` (escaping is serde's job).
- [ ] **Step 4: Extend the fixture and the Rust contract test.** `contract.json` `input` gains `{"type":"clipboard","text":"안녕 😀\n둘째 줄","concealed":false}`, `{"type":"clipboard","text":"비밀","concealed":true}`, `{"type":"clipboard-watch","on":true}`; `notice` becomes the list of every outbound sample: `replaced`, `{"type":"lock","locked":true}`, `{"type":"lock","locked":false}`, `{"type":"clipboard","text":"복사 \"됨\"\n","concealed":false}`, `{"type":"clipboard","text":"x","concealed":true}`, and one `clipboard-skipped` per reason. In `contract.rs`: the size limit per kind (`text` 8 KiB, `clipboard` 256 KiB, else 512), the `expected` match gains `clipboard` / `clipboard-watch`, and `the_notices_the_agent_sends_are_exactly_the_contracts` builds each fixture notice with `NOTICE_REPLACED` / `lock_notice` / `clipboard_notice` / `skipped_notice` and compares JSON values (drop the `len() == 1` assertion; assert every `SkipReason` appears).
- [ ] **Step 5: Run** `cd agent/mac && cargo test --locked` — Expected: PASS (Linux).
- [ ] **Step 6: Write the failing TS tests.** `test/agent-contract.test.js`: `build` gains `clipboard: (m) => message.clipboard(m.text, m.concealed)` and `"clipboard-watch": (m) => message.clipboardWatch(m.on)`; the notices test becomes: every fixture notice satisfies `deepEqual(parseAgentMessage(JSON.stringify(sample)), sample)`, `parseNotice` still returns `"replaced"` only for `replaced` and `undefined` for the rest, no fixture input parses as an agent message, binary frames (`ArrayBuffer`, `Uint8Array`) give `undefined`. `test/agent-input.test.js` adds:

```js
test("parseAgentMessage rejects malformed, unknown and oversized messages", () => {
  for (const bad of ['{"type":"lock"}', '{"type":"lock","locked":"yes"}', '{"type":"clipboard","text":1,"concealed":false}',
    '{"type":"clipboard","text":"x"}', '{"type":"clipboard-skipped","reason":"nope"}', "[]", "x", ""])
    assert.equal(parseAgentMessage(bad), undefined, bad);
  const big = JSON.stringify({ type: "clipboard", text: "a".repeat(MAX_CLIPBOARD_MESSAGE_BYTES), concealed: false });
  assert.equal(parseAgentMessage(big), undefined);
  assert.equal(parseAgentMessage(JSON.stringify({ type: "lock", locked: true, pad: " ".repeat(300) })), undefined, "small messages stay small");
});
test("the clipboard builders write exactly the contract and keep Korean and escapes intact", () => {
  assert.equal(message.clipboard("a\n한", true), '{"type":"clipboard","text":"a\\n한","concealed":true}');
  assert.equal(message.clipboardWatch(false), '{"type":"clipboard-watch","on":false}');
});
```
- [ ] **Step 7: Run** `node --test test/agent-contract.test.js test/agent-input.test.js` — Expected: FAIL (`parseAgentMessage` / `message.clipboard` undefined).
- [ ] **Step 8: Implement** the TS exports in `src/agent-input.ts` (signatures in Interfaces). `parseAgentMessage`: strings only; length ≤ 256 for `replaced`/`lock`/`clipboard-skipped`, ≤ `MAX_CLIPBOARD_MESSAGE_BYTES` (compare `data.length`, UTF-16 units, as a cheap upper bound) for `clipboard`; every field type-checked.
- [ ] **Step 9: Run** `node --test test/agent-contract.test.js test/agent-input.test.js && npm run check` — Expected: PASS.
- [ ] **Step 10: Commit**

```bash
git add agent/mac/src/protocol.rs agent/mac/tests/contract.rs agent/mac/tests/fixtures/contract.json src/agent-input.ts test/agent-contract.test.js test/agent-input.test.js
node --test test/public-hygiene.test.js && git commit -m "Add the clipboard and lock messages to the agent wire contract"
```

---

### Task 2: Peer outbound queue and the channel-open hook

**Files:**
- Modify: `agent/mac/src/peer.rs`: `trait PeerHooks` (`:49-65`, add `channel_open`), `impl PeerHandle` (`:85-130`, add `send_text`), `enum Msg` (`:172`), `QueueProbe` (`:137-150`, handle the new variant, add `texts()`), run loop (`:465` `Event::ChannelOpen`, `:493` `Ok(Msg::Frame(..))` sibling arm).
- Test: `agent/mac/src/peer.rs` `mod tests` (the browser-simulating `call` harness, `:735-960`; `call.browser.notices` records text frames, `:780`, `:879`).

**Interfaces:**
- Produces: `PeerHandle::send_text(&self, text: String) -> bool` (false when the peer is gone or the queue is full and the text was dropped; never blocks); `PeerHooks::channel_open(&self) {}` (default no-op; called on the peer thread when the `input` channel opens); `QueueProbe::texts(&self) -> Vec<String>` (`#[cfg(test)]`).
- Consumes: Task 1 notice builders (used by Task 6, not here).

- [ ] **Step 1: Write failing tests** in `peer.rs` `mod tests`:

```rust
#[test] fn send_text_on_a_dead_peer_is_false_and_on_a_live_one_true() {
    let (handle, probe) = PeerHandle::observed(2);
    assert!(handle.send_text("a".into()) && handle.send_text("b".into()));
    assert!(!handle.send_text("dropped: queue full".into()));
    assert_eq!(probe.texts(), vec!["a", "b"]);
    handle.close(); assert!(!handle.send_text("x".into()));
}
#[test] fn texts_reach_the_page_in_order_as_text_frames() {     // existing harness: Call::start(IDLE_LIMIT), call.connect()
    let mut call = Call::start(IDLE_LIMIT); call.connect();
    call.handle.send_text("one".into()); call.handle.send_text("zwei 한글".into());
    assert!(call.until(Duration::from_secs(5), |c| c.browser.notices == ["one", "zwei 한글"]));
}
#[test] fn a_message_near_64_kib_arrives_whole() { /* 65_000-byte text -> browser.notices[0].len() == 65_000 */ }
#[test] fn a_write_the_channel_refuses_is_dropped_and_the_peer_lives_on() {
    /* send_text("x".repeat(400_000)) then send_text("ok"): notices == ["ok"], call.handle.is_alive(), !call.finished() */
}
#[test] fn the_session_hears_the_channel_open_exactly_once() { /* the harness hooks (`:815-840`) gain `channel_opens: AtomicUsize`; == 1 after connect, still 1 after 100 ms of traffic */ }
```
- [ ] **Step 2: Run** `cd agent/mac && cargo test --locked peer::tests::send_text` — Expected: FAIL (no method `send_text`).
- [ ] **Step 3: Implement** `Msg::Text(String)` on a **separate control queue** (bounded, capacity 64), not the frame queue: frames under load must never crowd out a clipboard or lock message. The run loop drains every queued text before the next frame. `send_text` uses `try_send` on that queue (`Full` → false); add a test that 256 queued frames do not make `send_text` return false; in `run`, `Event::ChannelOpen(id, _) => { channel = Some(id); hooks.channel_open(); }` and a `Msg::Text` arm that writes `rtc.channel(id)?.write(false, text.as_bytes())`; an `Err` is logged through `limited(&mut write_log, ...)` as `[peer] data channel write failed ({n} bytes)` — **length only, never the text**. Update `QueueProbe::frames` to ignore `Msg::Text`.
- [ ] **Step 4: Run** `cd agent/mac && cargo test --locked peer::` — Expected: PASS (Linux).
- [ ] **Step 5: Commit**

```bash
git add agent/mac/src/peer.rs
node --test test/public-hygiene.test.js && git commit -m "Let a session queue a text message to the page's data channel"
```

---

### Task 3: Pasteboard and console-lock layer behind `Platform`

**Files:**
- Create: `agent/mac/src/clipboard.rs` (shared types and the `Board` trait; the state machine joins it in Task 5); `agent/mac/src/mac/pasteboard.rs`.
- Modify: `agent/mac/src/lib.rs:3-28` (`pub mod clipboard;`), `agent/mac/src/mac/mod.rs:2-10` (`pub mod pasteboard;`), `agent/mac/src/session.rs:43-56` (`Platform: Board + Send + Sync + 'static`; `FakePlatform` `:432-476` implements `Board`), `agent/mac/src/mac/system.rs:36-49` (add `console_locked`), `agent/mac/src/mac/ffi.rs:315-320` (IOKit registry bindings), `agent/mac/src/mac/agent.rs:56-82` (`System` implements `Board`), `agent/mac/Cargo.toml:27-34` (+ `objc2-app-kit` with feature `NSPasteboard`, or `msg_send!` on `AnyClass::get(c"NSPasteboard")` if the crate lacks `accessBehavior`; builder's call) and `agent/mac/Cargo.lock`.
- Test: `agent/mac/src/mac/pasteboard.rs` `mod tests` (macOS only); the fake in `session.rs`/`clipboard.rs` tests (Linux).

**Interfaces:**
- Produces (`clipboard.rs`): `pub const MAX_TEXT: usize = protocol::MAX_CLIPBOARD_TEXT; pub const POLL: Duration = Duration::from_millis(300);` `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Access { AlwaysAllow, Ask, AlwaysDeny }`; `#[derive(Debug, Clone, PartialEq, Eq)] pub enum PasteRead { Text { text: String, concealed: bool }, NoText, Denied }`;

```rust
pub trait Board: Send + Sync {
    fn change_count(&self) -> i64;                 // never prompts
    fn access(&self) -> Access;                    // NSPasteboard.accessBehavior; macOS < 15.4 => AlwaysAllow
    fn read(&self) -> PasteRead;                   // only called after a change while watch is on
    fn write(&self, text: &str, concealed: bool) -> i64; // currentHostOnly; returns the change count after the write
    fn console_locked(&self) -> bool;              // IOConsoleLocked (D5), NOT screen_locked()
}
```
- Produces (`mac/pasteboard.rs`): `pub struct Pasteboard` with `general()`, `#[cfg(test)] unique()`, and the four pasteboard methods above; `system::console_locked() -> bool`.
- `Platform::screen_locked()` (CGS, feeds status `locked` and the tile) is unchanged; the contract's `status.locked` therefore still reads the old signal (spec is silent; see report).

- [ ] **Step 1: Write failing tests** (macOS only, `mac/pasteboard.rs`, on `Pasteboard::unique()` so the user's clipboard is never touched):

```rust
#[test] fn write_then_read_round_trips_korean_and_reports_each_write_in_the_change_count() {
    let b = Pasteboard::unique(); let before = b.change_count();
    let after = b.write("비밀번호 😀\nline2", false);
    assert!(after > before);
    assert_eq!(b.read(), PasteRead::Text { text: "비밀번호 😀\nline2".into(), concealed: false });
}
#[test] fn concealed_text_carries_the_nspasteboard_marker_and_reads_back_concealed() {
    let b = Pasteboard::unique(); b.write("pw", true);
    assert_eq!(b.read(), PasteRead::Text { text: "pw".into(), concealed: true });
    b.write("plain", false);
    assert_eq!(b.read(), PasteRead::Text { text: "plain".into(), concealed: false });
}
#[test] fn a_pasteboard_without_text_reads_as_no_text() { /* declare only a non-text type -> PasteRead::NoText */ }
#[test] fn the_console_lock_signal_is_readable_and_false_in_ci() { let _ = system::console_locked(); }
```
  Linux: extend the `FakePlatform` in `session.rs` with `board: FakeBoard` (atomics: `change_count`, `access`, `read` result, `locked`, a write log, a read counter) so Tasks 5-6 can drive it; add it now and keep every existing session test green.
- [ ] **Step 2: Run** on the Mac loop: `cargo test --locked mac::pasteboard` — Expected: FAIL (module missing). On Linux `cargo test --locked` — FAIL (trait `Board` missing).
- [ ] **Step 3: Implement** the types/trait in `clipboard.rs`; the Linux fake; then macOS: `Pasteboard` over `NSPasteboard` (`general`; `changeCount`; `types`; `stringForType:` for `public.utf8-plain-text`; concealed = `types` contains `org.nspasteboard.ConcealedType`; write = `prepareForNewContentsWithOptions:` with `NSPasteboardContentsCurrentHostOnly`, then `setString:forType:` and, if concealed, `setData:forType:` with empty data for the marker; `accessBehavior` through `respondsToSelector` so macOS < 15.4 gives `AlwaysAllow`; a nil read with `Ask`/`AlwaysDeny` gives `Denied`). `system::console_locked`: `IORegistryEntryCreateCFProperty(IORegistryGetRootEntry(0), "IOConsoleLocked", ...)` as a CFBoolean, false when absent. `System` in `mac/agent.rs` implements `Board` by delegation. Regenerate the lock once with `cargo build` (no `--locked`) and commit `Cargo.lock`; confirm `cargo build --locked` and, in CI, `cargo deny check`.
- [ ] **Step 4: Run** Linux `cd agent/mac && cargo test --locked` and the Mac loop `cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check` — Expected: PASS. Device note for the rehearsal (recorded in Task 13): `console_locked()` is false with the display only asleep and true at the lock screen.
- [ ] **Step 5: Commit**

```bash
git add agent/mac/src/clipboard.rs agent/mac/src/lib.rs agent/mac/src/session.rs agent/mac/src/mac agent/mac/Cargo.toml agent/mac/Cargo.lock
node --test test/public-hygiene.test.js && git commit -m "Add the pasteboard and console lock layer behind the agent's platform trait"
```

---

### Task 4: Key-code typing for the lock screen

**Files:**
- Modify: `agent/mac/src/keymap.rs` (add after `lookup`, `:133`), `agent/mac/src/typing.rs:6-14` (`TypeStep::Key`, new `plan_keys`), `agent/mac/src/session.rs:37-41` (`Input::type_keys`; `FakeInput` `:423-430` logs it), `agent/mac/src/mac/inject.rs:122-134` and `:172-188` neighbourhood (`Injector::type_keys`), `agent/mac/src/mac/agent.rs:48-55`.
- Test: `agent/mac/src/keymap.rs` and `typing.rs` `mod tests` (Linux); `inject.rs` is compile-checked on macOS and exercised in the rehearsal (§6 item 3).

**Interfaces:**
- Produces: `keymap::us_key(c: char) -> Option<(u16, bool)>` (virtual key code, Shift) for the ABC/US layout; `TypeStep::Key { code: u16, shift: bool }`; `typing::plan_keys(text: &str) -> Vec<TypeStep>` (single-line text: ABC/US characters become `Key`, tab becomes `Tab`, other control characters are dropped, every other character becomes `Units` runs of at most `MAX_UNITS`, surrogate pairs never split); `trait Input { fn type_keys(&self, text: &str); }`.
- `Injector::type_keys` posts each `Key` as shift-down (flags-changed 56 with `0x0002_0000`), key down/up with flags `0x0002_0000` or `0`, shift-up; `Units` through `post_units(&units, 0)`. It ignores `Pressed` flags (Command may still be held when it runs). Existing `plan` and the 텍스트 입력 path are unchanged.

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn us_key_covers_letters_digits_and_symbols_with_shift() {
    for (c, expect) in [('a', (0, false)), ('A', (0, true)), ('1', (18, false)), ('!', (18, true)), ('@', (19, true)),
        ('-', (27, false)), ('_', (27, true)), ('`', (50, false)), ('~', (50, true)), (' ', (49, false)), ('/', (44, false)), ('?', (44, true))] {
        assert_eq!(us_key(c), Some(expect), "{c}");
    }
    for c in ['é', '한', '😀', '€'] { assert_eq!(us_key(c), None, "{c}"); }
}
#[test] fn every_printable_ascii_character_has_a_key() { for c in ' '..='~' { assert!(us_key(c).is_some(), "{c:?}"); } }
#[test] fn plan_keys_types_ascii_as_keys_and_everything_else_as_unicode_without_splitting_pairs() {  // Review Focus 3
    assert_eq!(plan_keys("aB1!"), vec![Key { code: 0, shift: false }, Key { code: 11, shift: true }, Key { code: 18, shift: false }, Key { code: 18, shift: true }]);
    assert_eq!(plan_keys("p한w"), vec![Key { code: 35, shift: false }, Units(units("한")), Key { code: 13, shift: false }]);
    let steps = plan_keys(&format!("{}😀", "한".repeat(19)));
    assert!(steps.iter().all(|s| !matches!(s, Units(u) if u.len() > MAX_UNITS)));
    assert_eq!(plan_keys("a\u{7}b\tc"), vec![Key{code:0,shift:false}, Key{code:11,shift:false}, Tab, Key{code:8,shift:false}]);
}
```
- [ ] **Step 2: Run** `cd agent/mac && cargo test --locked keymap:: typing::` — Expected: FAIL (no `us_key`, no `plan_keys`).
- [ ] **Step 3: Implement** `us_key` from the existing `TABLE` codes (letters by `Key*` entries, digits by `Digit*`, symbol pairs by the physical key: `-=[]\;',./\``); `plan_keys`; `Input::type_keys` (+ `FakeInput` logging `type_keys {n chars}`, never the text); the macOS `Injector::type_keys` and the `Input for Injector` delegation.
- [ ] **Step 4: Run** Linux `cargo test --locked`; Mac loop `cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add agent/mac/src/keymap.rs agent/mac/src/typing.rs agent/mac/src/session.rs agent/mac/src/mac/inject.rs agent/mac/src/mac/agent.rs
node --test test/public-hygiene.test.js && git commit -m "Type text as key codes for the lock screen, with a Unicode fallback"
```

---

### Task 5: Clipboard state machine (watch, poll, hold, locked paste)

**Files:**
- Modify: `agent/mac/src/clipboard.rs` (add `ClipState` and friends below the Task 3 types).
- Test: `agent/mac/src/clipboard.rs` `mod tests` with a `FakeBoard` (counts `read`/`write` calls; settable `change_count`, `access`, `read` result, `locked`).

**Interfaces:**
- Consumes: Task 1 builders and `SkipReason`; Task 3 `Board`, `Access`, `PasteRead`; `keymap::{KeyAction, modifier_flag}`.
- Produces:

```rust
pub struct ClipState { /* watch, baseline, own write, last_lock, held: Option<String>, modifier bitmask, swallowed_v */ }
impl ClipState {
    pub fn new() -> Self;
    pub fn watch(&mut self, board: &dyn Board, on: bool);               // off->on takes change_count as baseline, no read; on->on keeps it
    pub fn tick(&mut self, board: &dyn Board) -> Vec<String>;           // outbound JSON texts, in order: lock change first, then clipboard/skipped
    pub fn inbound(&mut self, board: &dyn Board, text: &str, concealed: bool); // fresh console_locked(): held when locked, else board.write
    pub fn on_key(&mut self, board: &dyn Board, action: KeyAction, down: bool) -> KeyDecision;
    pub fn release(&mut self);                                          // modifiers/swallow state forgotten (Release, channel closed, silence)
    pub fn end(&mut self);                                              // session over: held text dropped
    pub fn forget_lock(&mut self);                                      // the lock notice was not delivered: the next tick announces it again
}
pub struct KeyDecision { pub act: KeyAct, pub notice: Option<String> }
pub enum KeyAct { Inject, Swallow, Type(String) }
```
- Rules (pin): `tick` emits `lock_notice` when the console lock differs from the last one sent (the first call always emits: it is the session-open notice) and drops held text on a change to unlocked; while watch is on and `change_count` moved, `baseline` follows it, a change equal to the agent's own write is ignored, otherwise `access()` is checked (`AlwaysDeny` → `skipped_notice(ReadDenied)` and **no** `read`), then `read()`: `Denied` → `ReadDenied`, `NoText` or empty → nothing, text over `MAX_TEXT` bytes → `TooLarge` (log reason+length), else `clipboard_notice(text, concealed)`. `on_key`: a Command-only (`modifier_flag` bitmask == `0x0010_0000`) key-down of code 9 (V) with a fresh `console_locked() == true` is decided: held text with one trailing `\r\n`/`\n`/`\r` stripped → `Type(text)` if it has no line break and is non-empty; if it still has a line break → `Swallow` + `LockedMultiline` notice; no held text or empty after stripping → `Inject` + `LockedEmpty` notice. After `Type`/multi-line `Swallow`, autorepeat down and the matching up of V are `Swallow`ed until V's up. Everything else is `Inject`. Held text is never logged.

- [ ] **Step 1: Write failing tests** (names; each asserts the stated behaviour with `FakeBoard`):
  - `watch_on_takes_the_baseline_without_reading_and_a_change_before_it_is_never_sent` (change_count 5, copy at 6 before watch-on at 6 → `tick` empty and `reads == 0`; copy at 7 → one `clipboard` message, `reads == 1`).
  - `a_second_watch_on_keeps_the_baseline_and_watch_off_stops_polling_and_reading`.
  - `the_agents_own_write_is_not_sent_back_but_the_next_user_copy_is` (inbound writes → `board.write` returns 9 → `tick` empty; change to 10 → sent).
  - `access_deny_skips_without_reading_and_a_refused_read_is_read_denied`; `no_text_and_empty_text_are_silent`.
  - `text_over_64_kib_is_skipped_as_too_large_and_one_byte_under_is_sent` (65 536 'a' sent, 65 537 skipped; Korean 21 846 chars skipped) — Review Focus 3.
  - `concealed_flag_passes_through_to_the_notice`.
  - `the_first_tick_announces_the_lock_state_and_each_change_once`; `unlock_drops_the_held_text`.
  - `inbound_when_unlocked_writes_with_the_concealed_flag_and_when_locked_holds_without_writing` (`writes == []` while locked, even after unlock — the Mac pasteboard never receives it).
  - `locked_command_v_types_the_held_text_and_injects_no_v` plus the matrix: `"pw\n"`, `"pw\r\n"`, `"pw\r"` → `Type("pw")`; `"a\nb"` → `Swallow` + `locked-multiline`; `"\n"` and no held text → `Inject` + `locked-empty`; Command+Shift+V, Control+V, bare V, unlocked Command+V → `Inject`, no notice.
  - `repeat_and_release_of_a_swallowed_v_are_swallowed_and_the_next_v_decides_again`.
  - `lock_flapping_around_a_paste_uses_the_fresh_signal` (Review Focus 2): locked, held "pw"; board flips to unlocked without a `tick` → the next Command+V is `Inject` (not typed); flips back to locked, `inbound("pw2")` → held replaced; `tick` after unlock clears held.
  - `release_forgets_the_modifiers_so_a_stuck_command_cannot_make_a_later_v_a_paste`.
- [ ] **Step 2: Run** `cd agent/mac && cargo test --locked clipboard::` — Expected: FAIL (compile error: no `ClipState`).
- [ ] **Step 3: Implement** `ClipState` with the rules above (pure: no clock, no threads; the caller passes the `Board`).
- [ ] **Step 4: Run** `cd agent/mac && cargo test --locked clipboard:: && cargo clippy --locked --all-targets -- -D warnings` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add agent/mac/src/clipboard.rs
node --test test/public-hygiene.test.js && git commit -m "Add the agent's clipboard state machine with the locked paste decision"
```

---

### Task 6: Session wiring, lock notices, agent 0.2.0

**Files:**
- Modify: `agent/mac/src/session.rs`: `struct Hooks` (`:123-137`: `clip: Mutex<ClipState>`, `peer: OnceLock<PeerHandle>`), `Hooks::input` (`:152-170`), `input_closed`/`silent` (`:172-178`), `closed` (`:180-198`), `start_session` (`:300-335`: set `peer` after `accept`), `Core` (add `poll: Duration`), `Sessions::new`/`with_lock_policy` (`:103-120`, add a `with_options(parts, refuse_when_locked, poll)` test constructor), `impl PeerHooks for Hooks` (add `channel_open`); `agent/mac/Cargo.toml:3` → `0.2.0` and `Cargo.lock`.
- Modify: `agent/mac/src/mac/agent.rs` only if `Parts` changes (it must not).
- Test: `agent/mac/src/session.rs` `mod tests` (Rig `:482+`; use `Rig::open`, `queues` probes for what the peer was asked to send, `FakeBoard` from Task 3).

**Interfaces:**
- Consumes: `PeerHandle::send_text`, `PeerHooks::channel_open` (Task 2), `Input::type_keys` (Task 4), `ClipState` (Task 5), `Board` via `Platform` (Task 3).
- Produces: behaviour only. `channel_open` runs `clip.tick` once (session-open `lock` notice) and starts one ticker thread per session that every `poll` (production `clipboard::POLL`) takes `slot.with_current(id, ...)`, runs `clip.tick`, and sends each result with `peer.send_text` (if a `lock` notice's `send_text` returns false, it calls `clip.forget_lock()` so the next tick re-sends it — a lost lock notice would bring back the stale paste of spec D5); it exits when the session is replaced, ended or its peer dead. `input()` routes `Clipboard`/`ClipboardWatch` to `clip.inbound`/`clip.watch`, runs `Key` messages through `clip.on_key` (`Inject` → `input.handle`, `Swallow` → nothing, `Type(t)` → `input.type_keys(&t)`; a returned `notice` is sent), calls `clip.release()` next to every `input.release_all()` and `clip.end()` in `closed`. An unparseable message longer than `MAX_TEXT_MESSAGE` logs `[clipboard] dropped message ({n} bytes)`; bytes only.

- [ ] **Step 1: Write failing tests** (names and the assertion each makes):
  - `the_channel_opening_sends_the_lock_state_once` (`hooks.channel_open()` → probe texts `[lock_notice(false)]`; a second tick with no change sends nothing).
  - `a_lock_change_is_sent_once_within_one_poll` (Rig built with `poll = 5 ms`; flip `board.locked`; wait → exactly one `lock_notice(true)`).
  - `watch_on_then_a_pasteboard_change_sends_the_text_and_watch_off_stops_reading` via `hooks.input(br#"{"type":"clipboard-watch","on":true}"#)`.
  - `an_old_page_that_never_sends_watch_never_has_its_pasteboard_read` (Review Focus 4: board `reads == 0` after many polls).
  - `a_clipboard_message_is_written_when_unlocked_and_held_when_locked` (no `board.write` while locked).
  - `locked_command_v_types_held_text_and_injects_no_v` (hooks: MetaLeft down, KeyV down, KeyV up → `FakeInput` log has `type_keys` once, no `Key{Code(9)}`; the multi-line case sends the `clipboard-skipped` notice; the none-held case injects V and sends `locked-empty`).
  - `held_text_is_dropped_on_unlock_replacement_and_session_end` (end the session, open another, locked V types nothing).
  - `a_replaced_session_sends_no_more_notices` (ticker of the old session silent after takeover).
  - `the_status_reports_version_0_2_0` (`agent.status().version == "0.2.0"`).
  - `release_and_a_closed_channel_forget_a_held_command` (Review Focus 2).
- [ ] **Step 2: Run** `cd agent/mac && cargo test --locked session::` — Expected: FAIL (new hooks not wired; version test fails).
- [ ] **Step 3: Implement** the wiring and bump `Cargo.toml` version (and `Cargo.lock`'s `gome-remote-agent` entry through `cargo build` once, then `--locked`). Literal `"0.1.0"` in `status.rs`, `http.rs`, `tests/contract.rs`, `contract.json` are status fixtures passed in, not the crate version: leave them.
- [ ] **Step 4: Run** Linux `cd agent/mac && cargo test --locked`; Mac loop `cargo test --locked && cargo test --locked --features dev-install && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add agent/mac/src/session.rs agent/mac/Cargo.toml agent/mac/Cargo.lock
node --test test/public-hygiene.test.js && git commit -m "Wire clipboard sync and lock notices into the agent session and release 0.2.0"
```

---

### Task 7: Desktop bridge 4: clipboard IPC

**Files:**
- Create: `desktop/clipboard.cjs`.
- Modify: `desktop/preload.cjs:3-30` (`bridgeVersion: 4`, comment, two members), `desktop/main.cjs:1-9` (import `clipboard`, `ClipboardItem`), `:242-261` (two handlers after `remote:viewer-state`), `:360-370` (smoke check), `src/types.d.ts:34-45` (bridge 4 members), `package.json` untouched (`desktop/**/*` already packaged).
- Test: `test/preload.test.js:32-47`, `test/desktop.test.js` (stand-in at `:62-300` gains `clipboard`, `ClipboardItem`, `isFocused`; `goodPage` `:1036`; smoke tests `:1042-1100`; origin test `:376-437`).

**Interfaces:**
- Produces (`desktop/clipboard.cjs`): `createClipboardService({ clipboard, ClipboardItem, Blob, platform, isFocused, log }) => { read(): Promise<ClipboardRead>, write(text: unknown, opts: unknown): Promise<ClipboardWrite> }`, with `type ClipboardRead = { ok: true; text: string; concealed: boolean } | { ok: false; reason: "unfocused" | "failed" }` and `type ClipboardWrite = { ok: true; concealed: boolean } | { ok: false; reason: "unfocused" | "failed" | "too-large" }` (`concealed` in the write result = the mark was actually applied).
- Produces (bridge): `window.desktop.readClipboard(): Promise<ClipboardRead>`, `window.desktop.writeClipboard(text: string, opts?: { concealed?: boolean }): Promise<ClipboardWrite>`; IPC channels `remote:clipboard-read`, `remote:clipboard-write` (`handle("gateway", ...)`).
- Pinned behaviour: refusals are results, not throws, except an invalid argument (`typeof text !== "string"`, `opts` not a plain `{concealed?: boolean}`) which throws `Invalid clipboard text.`; `write` over 64 KiB UTF-8 → `{ok:false, reason:"too-large"}` and the clipboard is untouched; on `win32` LF becomes CRLF; read uses `clipboard.readText()`; concealed = `clipboard.has('electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"')` or `CanIncludeInClipboardHistory` read as DWORD 0 through `read()[i].getType(...)` (any rejection = not concealed); write with `concealed` and `win32` uses `clipboard.write([new ClipboardItem({ "text/plain": text, 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"': new Blob([new Uint8Array(4)]) })])` and, if that throws, falls back to `writeText` with `{ok:true, concealed:false}` and one log line `[clipboard] concealed mark dropped`; other platforms never mark (D7 names only the Windows formats). Log lines carry reason and byte length only.
- Electron 44.5.1 facts used (read from `electron.d.ts`): `clipboard` is main-process and **async only** (`readText`, `writeText`, `has`, `read`, `write(ClipboardItem[])`); `has()` documents the `electron application/osclipboard;format="..."` form; writing an osclipboard key through `ClipboardItem` is **not documented**, hence the fallback and the rehearsal check (Task 13 item 3 of the checklist).

- [ ] **Step 1: Write failing tests.**
  `preload.test.js`: title "the bridge announces version 4 ..."; `bridgeVersion === 4`; the sorted key list gains `readClipboard`, `writeClipboard`; calls: `await desktop.readClipboard()` → `["remote:clipboard-read"]`, `await desktop.writeClipboard("a", {concealed:true})` → `["remote:clipboard-write", "a", {concealed:true}]`.
  `desktop.test.js` (new tests, stand-in gets `clipboard` fakes, `window.isFocused()` toggled by `f.setFocused(bool)`):

```js
test("clipboard channels answer only while the window is focused, from the gateway origin in the top frame", async (t) => {
  const f = await desktop({ clipboardText: "복사" }, t);
  f.setFocused(true);
  assert.deepEqual(await f.invoke("clipboard-read"), { ok: true, text: "복사", concealed: false });
  f.setFocused(false);
  assert.deepEqual(await f.invoke("clipboard-read"), { ok: false, reason: "unfocused" });
  assert.deepEqual(await f.invoke("clipboard-write", "x"), { ok: false, reason: "unfocused" });
  assert.deepEqual(f.clipboardWrites, []);
  for (const url of ["https://evil.example/", SETUP, "about:blank"]) {
    f.show(url);
    for (const name of ["clipboard-read", "clipboard-write"]) await assert.rejects(f.invoke(name, "x"), /Untrusted origin/);
  }
  // + the subframe and foreign-sender rejections used for the other bridge channels
});
test("write validates its arguments, caps at 64 KiB of UTF-8 and never logs the text", ...);   // "가".repeat(21846) -> too-large; logs contain "bytes" and not "가"
test("on win32 LF is written as CRLF and a concealed write adds the exclusion format; elsewhere nothing is added", ...);
test("a failing concealed write falls back to plain text and says so", ...);
test("read reports concealed when the exclusion format or CanIncludeInClipboardHistory=0 is present", ...);
test("an empty or non-text clipboard reads as empty text", ...);
```
  Update `goodPage.bridgeVersion` to 4 plus `read: "function"`; the "exits 1" matrix drops `bridgeVersion: 4` from the bad list and adds `{...goodPage, bridgeVersion: 3}`, `{...goodPage, read: "undefined"}`; extend the origin-guard loop at `:386-402` with the two channels. `the updater adds no IPC channel` stays as is.
- [ ] **Step 2: Run** `node --test test/preload.test.js test/desktop.test.js` — Expected: FAIL (version 3, no channels).
- [ ] **Step 3: Implement** `desktop/clipboard.cjs`, the two `handle("gateway", ...)` registrations (callback calls the service; `isFocused: () => window.isFocused()`), preload members and version 4, smoke check `state.bridgeVersion !== 4 || state.read !== "function"` (the executed script gains `read: typeof window.desktop.readClipboard`), `types.d.ts`.
- [ ] **Step 4: Run** `node --test test/preload.test.js test/desktop.test.js && npm run check` — Expected: PASS. On Linux CI also `xvfb-run -a npx electron . --no-sandbox --smoke-test --user-data-dir="$(mktemp -d)"` (needs `npm ci`) — exit 0.
- [ ] **Step 5: Commit**

```bash
git add desktop/clipboard.cjs desktop/main.cjs desktop/preload.cjs src/types.d.ts test/preload.test.js test/desktop.test.js
node --test test/public-hygiene.test.js && git commit -m "Add bridge version 4 with focus-guarded clipboard read and write"
```

---

### Task 8: Desktop full screen with page-side keyboard lock

**Files:**
- Modify: `desktop/main.cjs`: `:34-45` (`applyFullscreenTarget`/`requestFullscreen`), `:182-190` (`showSetup`), `:300-318` (window events), `:345-348` (permission handlers).
- Create: `src/keyboard-lock.ts`.
- Modify: `src/main.ts`: `fullscreenChanged` `:153-159`, `setFullscreen` `:160-171`, `localShortcut` block `:172-182`, `stop` `:234`, `sessionEnded` `:270`, `connectAgent` `onFirstFrame` `:408-425`, Guacamole `onstatechange` `:381`, `back` `:452-465`; `src/types.d.ts` (declare `Navigator.keyboard`).
- Test: `test/desktop.test.js` (stand-in `executeJavaScript` at `:104-109`, tests `:577-672`, `:790-816`, `:989-1040`), new `test/keyboard-lock.test.js`, `test/viewer-agent.test.js` / `test/viewer-flow.test.js` for the page glue, `test/helpers/viewer-harness.js` (`navigator`, `document.fullscreenElement` and a `fullscreenchange` dispatcher, `desktop.fullscreen` recording).

**Interfaces:**
- Produces (main, internal): `enterFullscreen()` = `window.webContents.executeJavaScript("document.documentElement.requestFullscreen()", true)` with `.catch(() => window.setFullScreen(true))` (refused permission or dead page: today's native full screen, no dialog); `leaveFullscreen()` = when `htmlFullscreen` (set by `enter-html-full-screen`, cleared by `leave-html-full-screen`) `executeJavaScript("document.fullscreenElement ? document.exitFullscreen() : undefined", true)` with `.catch(() => window.setFullScreen(false))`, else `window.setFullScreen(false)`. `applyFullscreenTarget` calls these instead of `setFullScreen` directly; the serialisation flags keep their meaning. Permission request handler: `(wc, permission, callback, details) => callback((permission === "fullscreen" || permission === "keyboardLock") && originOf(details.requestingUrl) === gateway)`; the check handler stays `() => false`.
- Produces (page): `export interface KeyboardLockDeps { lock(): Promise<void>; unlock(): void }`, `export function createKeyboardLock(deps: KeyboardLockDeps): { update(want: boolean): void; readonly locked: boolean }` (`want` = app bridge ≥ 4 && `document.fullscreenElement` && session active; a rejected `lock()` leaves `locked` false silently), and `export function isLockedF11(event: { key: string }, locked: boolean): boolean`.
- Page behaviour: `fullscreenchange` and every session start/end call `lock.update(...)`; a capturing window `keydown`/`keyup` handler (app mode only) swallows F11 while `lock.locked` and calls `api.fullscreen(false)` once on a non-repeat keydown; `back()` and `showSetup` rely on main's exit path.
- Main's `remote:fullscreen-state` IPC and `publishFullscreen` stay the state channel; the harness stand-in records an HTML-path request into `fullscreenRequests` as the same boolean so the existing assertions hold, and exposes `scriptCalls` (`[script, userGesture]` per `executeJavaScript(script, userGesture)`; `scripts` keeps only the strings the smoke test counts), `nativeRequests` (only `setFullScreen` calls) and `finishFullscreen(value, { html: true })` (emits `enter-html-full-screen`/`leave-html-full-screen` around the native event).

- [ ] **Step 1: Write failing tests** (`desktop.test.js`):

```js
test("entering full screen asks the page for HTML full screen with a user gesture; native full screen is not requested", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.scriptCalls.at(-1), ["document.documentElement.requestFullscreen()", true]);
  assert.deepEqual(f.nativeRequests, []);
});
test("a refused or failing HTML full screen falls back to native full screen without any dialog", async (t) => {
  const f = await desktop({ html: "refused" }, t);
  await f.invoke("fullscreen", true); await settle();
  assert.deepEqual(f.nativeRequests, [true]); assert.deepEqual(f.dialogs, []);
});
test("leaving ends HTML full screen through document.exitFullscreen, never win.setFullScreen(false) alone", async (t) => {   // Review Focus 5
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true); f.finishFullscreen(true, { html: true });
  await f.invoke("fullscreen", false);
  assert.match(f.scriptCalls.at(-1)[0], /exitFullscreen/); assert.deepEqual(f.nativeRequests, []);
});
test("showing the address page while in HTML full screen leaves through exitFullscreen", ...);          // desktop/main.cjs:186, all three `how` variants of the existing test
test("hold-Escape (leave-html-full-screen then leave-full-screen) publishes false and the next exit uses the native path", ...);
test("the exit survives a dead page: executeJavaScript rejects -> setFullScreen(false)", ...);
test("F11 from the menu or before-input-event toggles relative to the pending target (no re-entry after a page-requested exit)", ...);  // Review Focus 5
test("the permission handler grants fullscreen and keyboardLock only for the gateway origin's requestingUrl", async (t) => {
  const f = await desktop({}, t); const ask = (permission, requestingUrl) => new Promise((r) => f.permissions.request({}, permission, r, { requestingUrl }));
  for (const p of ["fullscreen", "keyboardLock"]) { assert.equal(await ask(p, `${GATEWAY}/`), true, p); for (const u of ["https://evil.example/", "https://gateway.tail123.ts.net:8451/", SETUP, "", undefined]) assert.equal(await ask(p, u), false, `${p} ${u}`); }
  for (const p of ["media", "clipboard-read", "notifications", "geolocation", "pointerLock"]) assert.equal(await ask(p, `${GATEWAY}/`), false, p);
  assert.equal(f.permissions.check({}, "fullscreen", GATEWAY), false);
});
```
  `keyboard-lock.test.js`: `update(true)` calls `lock` once and a second `update(true)` does not; `update(false)` after a lock calls `unlock`, before a lock does not; a rejecting `lock()` leaves `locked === false` and a later `update(false)` does not call `unlock`; a lock that resolves after `update(false)` is released at once (no leaked lock); `isLockedF11({key:"F11"}, true) === true`, `({key:"F1"}, true)` and `({key:"F11"}, false)` false. Page glue tests (`viewer-agent.test.js`): connecting while `document.fullscreenElement` is set takes the lock; a `fullscreenchange` to none releases it; ending the session (`onEnded`, 연결 종료, back) releases it; F11 while locked calls `desktop.fullscreen(false)` exactly once for down+repeat+up and is not sent to the Mac; with bridge 3 the lock is never taken (Review Focus 4); in a browser (`appMode: false`) it is never taken.
- [ ] **Step 2: Run** `node --test test/desktop.test.js test/keyboard-lock.test.js test/viewer-agent.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Escape needs no code (tap stays remote, hold is Chromium's). Run a throwaway Xvfb spike like the spec's (not committed) to confirm `keyboardLock` is granted with the check handler denying; if the lock is refused, stop and report (the decision is the main session's, not widening the check handler).
- [ ] **Step 4: Run** `node --test test/desktop.test.js test/keyboard-lock.test.js test/viewer-agent.test.js test/viewer-flow.test.js && npm run check` — Expected: PASS; Linux Electron smoke test exit 0.
- [ ] **Step 5: Commit**

```bash
git add desktop/main.cjs src/keyboard-lock.ts src/main.ts src/types.d.ts test/desktop.test.js test/keyboard-lock.test.js test/viewer-agent.test.js test/helpers/viewer-harness.js
node --test test/public-hygiene.test.js && git commit -m "Enter and leave full screen through HTML full screen and lock the keyboard in a session"
```

---

### Task 9: Page clipboard sync core (pure TS)

**Files:**
- Create: `src/clipboard-sync.ts`, `src/clipboard-local.ts`.
- Modify: `src/api.ts:28-37` (export `bridgeVersion`, `clipboardBridge = appMode && bridgeVersion >= 4`).
- Test: new `test/clipboard-sync.test.js` (loads the module with fake timers, no DOM).

**Interfaces:**
- Produces (`clipboard-sync.ts`):

```ts
export const MAX_CLIPBOARD_BYTES = 64 * 1024;  export const PASTE_BARRIER_MS = 500;  export const FOCUS_RETRY_MS = 150;
export type NoticeKey = "too-large" | "read-denied" | "locked-multiline" | "locked-empty" | "bridge-refused" | "read-timeout" | "unsupported-chars";
export const NOTICE_TEXT: Record<NoticeKey, string>;   // exact Korean copy below
export function normaliseNewlines(text: string): string;          // \r\n and \r -> \n
export function utf8Length(text: string): number;
export interface PasteKeyEvent { code: string; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; }
export function isPasteShortcut(e: PasteKeyEvent, target: "mac" | "other"): boolean; // mac: V with Meta, no ctrl/alt (shift allowed); other: Ctrl+V (no meta/alt, shift allowed) or Shift+Insert (no ctrl/meta/alt)
export type LocalResult = { ok: true; text: string; concealed: boolean } | { ok: false; reason: "unfocused" | "failed" | "denied" };
export interface LocalClipboard { read(): Promise<LocalResult>; write(text: string, concealed: boolean): Promise<{ ok: true } | { ok: false; reason: "unfocused" | "failed" | "denied" }>; }
export interface RemoteClipboard { sendClipboard(text: string, concealed: boolean): "sent" | "too-large" | "closed"; sendWatch?(on: boolean): void; }
export interface SyncDeps { local: LocalClipboard; remote: RemoteClipboard; target: "mac" | "other"; notify(key: NoticeKey): void; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; latin1Only?: boolean; }
export interface ClipboardSync {
  setViewFocused(focused: boolean): void;                  // window focus && session view shown && session active
  setRemoteLocked(locked: boolean): void;                  // agent `lock` notice
  remoteClipboard(text: string, concealed: boolean): void; // remote -> local
  remoteSkipped(reason: "too-large" | "read-denied" | "locked-multiline" | "locked-empty"): void; // -> notify
  pasteShortcut(event: PasteKeyEvent): void;               // call on every keydown BEFORE gate(send)
  pasteFromMenu(press: () => void): void;                  // G5: barrier, then press() through the gate
  gate(run: () => void): void;                             // runs now, or queued in order behind an open barrier
  flush(): void;                                           // run queued items now, in order (session end)
  invalidate(): void;                                      // forget last sent/received text (text dialog, lock change)
  end(): void;                                             // flush + reset all state
}
export function createClipboardSync(deps: SyncDeps): ClipboardSync;
```
- Produces (`clipboard-local.ts`): `bridgeClipboard(desktop: { readClipboard(): Promise<any>; writeClipboard(t: string, o?: any): Promise<any> }): LocalClipboard` (maps the bridge results, `reason:"unfocused"|"failed"`), `browserClipboard(nav: Pick<Navigator, "clipboard">): LocalClipboard | undefined` (`readText`/`writeText`; any rejection → `denied`; `undefined` when `navigator.clipboard` is missing), `localClipboardFor(): LocalClipboard | undefined` (app with bridge ≥ 4 → bridge; app with a lower bridge → `undefined`, never the browser API; browser → `browserClipboard`).
- Korean copy (`NOTICE_TEXT`): `too-large` "클립보드가 너무 커서(64 KiB 초과) 보내지 못했습니다"; `read-denied` "Mac이 클립보드 읽기를 허용하지 않았습니다"; `locked-multiline` "잠금 화면에는 여러 줄을 붙여넣을 수 없습니다"; `locked-empty` "입력할 텍스트가 없습니다"; `bridge-refused` "클립보드에 접근하지 못했습니다"; `read-timeout` "클립보드를 제때 읽지 못했습니다"; `unsupported-chars` "이 화면은 한글 같은 문자를 붙여넣을 수 없습니다".
- Rules (the algorithm the signatures do not determine): reads are **serialised** (one in flight; a trigger queues behind it and re-reads, so sends keep trigger order). A trigger sends only when the normalised text differs from `lastSynced` (set on send and on remote receive) or, for the paste barrier, when the remote is locked. `setViewFocused(true)` is trigger 1 and also calls `sendWatch(true)`; `false` calls `sendWatch(false)`, drops a pending focus read and drops later `remoteClipboard`. `setRemoteLocked` on a change clears `lastSynced`. Barrier: opens at the first paste key-down (further paste keys while open join it); `gate` queues; it closes when the barrier read is processed or after 500 ms (then queued items run, a still-pending read's late result is discarded and not marked synced, `notify("read-timeout")`) or on `setViewFocused(false)`/`end()`. Local failures: focus trigger, `unfocused` → one retry after `FOCUS_RETRY_MS`, silent; paste barrier, `unfocused`/`failed` → `notify("bridge-refused")`; `denied` (browser) → silent in both. Over 64 KiB or `sendClipboard` → `"too-large"`: paste barrier always `notify("too-large")`; focus trigger once per distinct oversize text; `lastSynced` unchanged. Empty text: ignored. `latin1Only` and text with a code point > 0xFF: `notify("unsupported-chars")`, not sent.

- [ ] **Step 1: Write failing tests** (`test/clipboard-sync.test.js`, a `rig()` with a scripted `local.read` queue of deferred promises, a recording `remote`, fake timers):
  - `focus_gain_sends_changed_text_once_and_starts_the_watch`; `unchanged_text_after_crlf_normalisation_is_not_resent` (`"a\r\nb"` then `"a\nb"`); `remote_text_becomes_the_baseline_so_it_is_not_echoed_back`.
  - `empty_text_and_failed_non_text_reads_send_nothing_and_do_not_notify`.
  - `unfocused_drops_remote_text_and_stops_the_watch` (`remoteClipboard` while unfocused → `local.write` not called).
  - `size_cap_counts_utf8_bytes` (Review Focus 3): 21 845 Korean chars sent; 21 846 → no send, `notify("too-large")`; `sendClipboard` returning `"too-large"` notices the same; focus trigger notices once per distinct oversize text, paste barrier every time; lone surrogates are not the core's job (the wire module sanitises).
  - `paste_shortcut_matrix`: mac: Meta+V true (Shift allowed: "V with Meta held"), bare V, Ctrl+V and Meta+Alt+V false; other: Ctrl+V, Ctrl+Shift+V and Shift+Insert true, Ctrl+Alt+V, Meta+V and bare V false.
  - `paste_holds_the_key_and_everything_after_it_in_order_until_the_text_is_sent` (Review Focus 1): events `[V-down, V-up, pointer]` queued behind a pending read; after the read resolves the log is `[clipboard "new", V-down, V-up, pointer]`.
  - `a_slow_focus_read_cannot_overtake_the_paste_read` (Review Focus 1): focus read pending with "old", paste starts; resolve focus "old" → sent, then paste read "new" → sent, then V.
  - `a_read_slower_than_500ms_releases_the_keys_and_its_late_result_is_discarded` (`notify("read-timeout")` once, nothing sent late, next trigger re-reads).
  - `two_paste_keys_in_one_barrier_read_once`; `focus_loss_during_a_barrier_releases_the_queue_without_sending`.
  - `unfocused_refusal_at_the_focus_instant_retries_once_silently_but_at_a_paste_notifies` (Review Focus 1).
  - `lock_change_clears_the_baseline_and_a_locked_paste_resends_unchanged_text` (Review Focus 2): synced "pw", `setRemoteLocked(true)`, paste with unchanged "pw" → sent again; `setRemoteLocked(false)` then paste with unchanged text → sent again (baseline cleared); lock flapping true/false/true between two pastes sends at each paste.
  - `no_local_clipboard_means_no_gate_no_notice_and_no_watch` (old app / no browser API: `createClipboardSync` with `local` undefined is not built; `localClipboardFor()` returns `undefined` for bridge 3 even when `navigator.clipboard` exists) — Review Focus 4.
  - `paste_from_menu_runs_the_barrier_then_presses_through_the_gate`.
  - `old_agent_never_answers_so_nothing_waits_for_a_reply` (no `lock` ever: paste still completes within the barrier, no notice) — Review Focus 4.
  - `latin1_only_refuses_korean_but_sends_latin1_text` (Review Focus 3).
  - `invalidate_forgets_the_baseline` (text dialog path, Task 11).
- [ ] **Step 2: Run** `node --test test/clipboard-sync.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both modules and the `api.ts` exports to the rules above.
- [ ] **Step 4: Run** `node --test test/clipboard-sync.test.js && npm run check` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/clipboard-sync.ts src/clipboard-local.ts src/api.ts test/clipboard-sync.test.js
node --test test/public-hygiene.test.js && git commit -m "Add the page's clipboard sync rules as a tested module"
```

---

### Task 10: Agent path integration (agent.ts, main.ts, notice toast)

**Files:**
- Modify: `src/agent.ts`: `AgentDeps` `:21-29`, `AgentSession` `:39-58`, `send` `:89-91`, `onKey` `:159-176`, `release`/`end`/`close` `:191-235`, `channel.onopen`/`onmessage` `:292-296`, `sendText` `:341`; `src/main.ts`: imports `:1-16`, template `:20-70` (a `#notice` element in `#viewport`), `connectAgent` `:408-451`, `stop` `:234`, `sessionEnded` `:270`, window listeners `:556`; `src/style.css` (`.notice`, hidden by default; no animation required).
- Modify (test helpers): `test/helpers/viewer-harness.js` (`desktop` stub gets `readClipboard`/`writeClipboard` driven by `clipboardText`, `bridgeVersion` default 4, a `navigator`, `FakeAgent` gains `sendClipboard`, `sendWatch`, `pasteShortcut`; add `./clipboard-sync`, `./clipboard-local`, `./keyboard-lock` to the `modules` map), `test/helpers/agent-harness.js` (nothing new if `agent.ts` still imports only `./agent-input`).
- Test: `test/viewer-agent.test.js`, `test/agent-session.test.js`.

**Interfaces:**
- Consumes: Task 1 `parseAgentMessage`/`message`, Task 9 `ClipboardSync`, `localClipboardFor`.
- Produces (`agent.ts`): `AgentDeps` gains optional `gate?(run: () => void): void`, `onPasteKey?(event: KeyboardEvent): void`, `onChannelOpen?(): void`, `onAgentMessage?(m: Exclude<AgentMessage, { type: "replaced" }>): void`; `AgentSession` gains `sendClipboard(text: string, concealed: boolean): "sent" | "too-large" | "closed"` (`"too-large"` when `message.clipboard(...).length` > `MAX_CLIPBOARD_MESSAGE_BYTES`; text is made well-formed first), `sendWatch(on: boolean): void`, `pasteShortcut(): void` (MetaLeft down, KeyV down, KeyV up, MetaLeft up, through `gate`). Every `send` goes through `deps.gate ?? ((r) => r())`; `onKey` calls `deps.onPasteKey?.(event)` before it sends; `release()` in `end()`/`close()` is preceded by `deps.gate`-bypassing `flush` (the main.ts glue calls `sync.flush()` first).
- `main.ts`: builds `createClipboardSync` for an agent session only when `localClipboardFor()` is defined; focus = `document.hasFocus() && flow.active` re-evaluated on `window` `focus`/`blur`, first frame, session end; `setRemoteLocked` from `lock` messages; `remoteSkipped` from `clipboard-skipped`; `remoteClipboard` from `clipboard`; toast shows `NOTICE_TEXT[key]` in `#notice` and hides after 4 s (timer through the existing fake in the harness).

- [ ] **Step 1: Write failing tests** (`viewer-agent.test.js` with `realAgent: true`, bridge 4, `clipboardText`):
  - `copy_then_cmd_v_reaches_the_channel_in_order` (Review Focus 1): after connect → `[...,{"type":"clipboard-watch","on":true}]`; local clipboard changes to "새 텍스트"; keydown MetaLeft, keydown KeyV (`metaKey:true`), keyup KeyV, keyup MetaLeft with the read pending → channel has only MetaLeft-down so far; resolve → `[clipboard "새 텍스트", key KeyV down, key KeyV up, key MetaLeft up]` in that order.
  - `window_blur_sends_watch_off_and_release_and_focus_sends_watch_on` ; `a_lock_message_resets_the_baseline`; `clipboard_from_the_mac_is_written_through_the_bridge_only_while_focused` (`writeClipboard` called with `"x", {concealed:true}` for a concealed message; not called when blurred).
  - `clipboard_skipped_and_too_large_show_the_notice_and_it_hides_after_4_seconds`.
  - `an_old_agent_session_works_exactly_as_before` (Review Focus 4): no `lock`/`clipboard` ever arrives; Cmd+V still goes to the channel within 500 ms; no `#notice`.
  - `an_old_app_bridge_3_creates_no_sync_and_sends_no_watch`; `a_browser_uses_navigator_clipboard_and_a_denied_read_is_silent`.
  - `agent_session` unit: `parseAgentMessage` routing — `replaced` still ends the session, `lock`/`clipboard`/`clipboard-skipped` reach `onAgentMessage`, binary and malformed are ignored; a text whose encoded message exceeds 256 KiB (65 536 `"\u0001"`, 6 bytes each) makes `sendClipboard` return `"too-large"` and sends nothing (Review Focus 3); a lone surrogate is replaced by U+FFFD; `sendWatch`/`sendClipboard` after close return false/`"closed"`.
- [ ] **Step 2: Run** `node --test test/viewer-agent.test.js test/agent-session.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the `agent.ts` additions and the `main.ts` glue; add the toast markup and CSS.
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: PASS (whole suite: the harness changes touch other viewer tests).
- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/main.ts src/style.css test/helpers/viewer-harness.js test/viewer-agent.test.js test/agent-session.test.js
node --test test/public-hygiene.test.js && git commit -m "Sync the clipboard over the Mac agent session with a paste barrier"
```

---

### Task 11: Guacamole path (VNC and RDP) and `disable-copy: false`

**Files:**
- Modify: `server/gateway.js:81` (`"disable-copy": false`), `src/main.ts`: `connect` Guacamole branch `:300-405` (clipboard handler after `connection` is created, key and mouse sends wrapped in `sync.gate`, a surface `keydown` listener registered **before** `new Guacamole.Keyboard(surface)` at `:366`), text dialog submit `:512-532` (call `sync.invalidate()` after the clipboard stream write).
- Test: `test/gateway.test.js:728-735` (connect args), `test/viewer-flow.test.js` or a new `test/viewer-guacamole-clipboard.test.js`, `test/helpers/viewer-harness.js` (`Client.createClipboardStream`, `onclipboard`, `Guacamole.StringReader/StringWriter` fakes, `Keyboard` gets `modifiers`).

**Interfaces:**
- Consumes: Task 9 `createClipboardSync`, `isPasteShortcut`; the existing text-dialog sequence (`Guacamole.StringWriter(client.createClipboardStream("text/plain"))`, `sendText`, `sendEnd`).
- Produces: `main.ts` local helper `sendRemoteClipboard(text: string): "sent"` (the same stream-writer sequence, reused by the text dialog) and `pasteKeysFor(platform): [modifierKeysym, 0x76]` (`0xffe7` for `selected.platform === "mac"`, `0xffe3` otherwise; the text dialog and Task 12 both use it). Remote → local: `connection.onclipboard = (stream, mimetype)` reads `text/plain` with `Guacamole.StringReader`, and at `onend` calls `sync.remoteClipboard(text, false)`; other mimetypes are ignored.

- [ ] **Step 1: Write failing tests.**
  `gateway.test.js`: the expected `connect` array at `:728-735` changes the `disable-copy` position from `"true"` to `"false"` for both protocols (`read-only` stays `"false"`, `disable-paste` is not in the fake guacd's `args`). `main` tests:
  - `a_guacamole_session_sends_changed_client_text_before_the_paste_key` (the recorded `sendKeyEvent` calls follow the stream's `sendEnd`; VNC Mac target uses Meta+V, RDP uses Ctrl+V, Ctrl+Shift+V and Shift+Insert also hold).
  - `remote_clipboard_updates_the_client_only_while_focused_and_is_not_echoed` (`onclipboard` with a mocked reader; `writeClipboard` not called when blurred; a second identical text ignored).
  - `the_text_dialog_invalidates_the_baseline` (silent-wrong-paste bug): synced "A", dialog sends "B" through the stream, local clipboard still "A", next Ctrl+V sends "A" again.
  - `mouse_and_key_events_queue_behind_the_barrier_in_order` (`sendMouseState` and `sendKeyEvent` are held and flushed in order).
  - `an_old_app_or_browser_without_permission_still_types_and_pastes_as_before` (Review Focus 4).
- [ ] **Step 2: Run** `node --test test/gateway.test.js test/viewer-flow.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** Order matters: our `keydown` listener (`sync.pasteShortcut`) is registered on `surface` before `Guacamole.Keyboard(surface)` so the barrier is open when Guacamole's handler runs; `keyboard.onkeydown/onkeyup` and `sendMouseState` go through `sync.gate`.
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: PASS.
- [ ] **Step 5: Device step (not automatable; Mac VNC + Ubuntu RDP from the rehearsal app, Task 13):** measure what macOS Screen Sharing's VNC carries for `안녕 한글` and an emoji, with guacd's default encoding and with `clipboard-encoding` `UTF-8`. Record the result in `docs/verification.md`, then exactly one of:
  - **Outcome A (UTF-8 works):** add `"clipboard-encoding": "UTF-8"` to the VNC branch of `connectionSettings` (`server/gateway.js:86-90`), add `"clipboard-encoding"` to the fake guacd `args` list (`test/gateway.test.js:128-141`) and its value to the expected `connect` array; no page change.
  - **Outcome B (Latin-1 only):** pass `latin1Only: true` into `createClipboardSync` for `protocol === "vnc"` targets (Task 9 rule), with a viewer test that Korean text produces the `unsupported-chars` notice and is not sent, and README states the limit. (The notice is not in D8's list; see decisions.)
- [ ] **Step 6: Commit**

```bash
git add server/gateway.js src/main.ts test/gateway.test.js test/helpers/viewer-harness.js test/viewer-flow.test.js
node --test test/public-hygiene.test.js && git commit -m "Sync the clipboard on the VNC and RDP paths and enable guacd copy"
```

---

### Task 12: G5 paste menu item and browser bar button

**Files:**
- Modify: `desktop/main.cjs:87` (enable rule), `:145` (menu item after `text-input`); `src/main.ts` template `:44-52` (button), `connectAgent`/Guacamole `onFirstFrame`/`state === 3` enable points, `api.onViewerAction` `:536-554`, `stop`/`sessionEnded` disable points; `src/style.css` only if the bar needs spacing.
- Test: `test/desktop.test.js:709-790` (menu), `test/viewer-agent.test.js`, `test/viewer-flow.test.js`.

**Interfaces:**
- Produces: menu item `command("paste-clipboard", "클립보드 붙여넣기")` (id `paste-clipboard`, sends viewer action `"paste-clipboard"`), enabled when `state.open && state.connected`; browser bar `<button id="paste-remote" disabled>클립보드 붙여넣기</button>` before `#text-input`; page function `pasteClipboard()`: no-op unless `flow.active` and a `ClipboardSync` exists, else `sync.pasteFromMenu(press)` where `press` is `agent.pasteShortcut()` (agent) or the Guacamole key sequence from `pasteKeysFor` (Task 11). The viewer-state validation and `forBridge` are unchanged (no new state field); an app with bridge < 4 has neither the item nor a page that sends the action.

- [ ] **Step 1: Write failing tests.** `desktop.test.js`: the Remote menu contains `paste-clipboard` labelled `클립보드 붙여넣기`, disabled at home, disabled when connected is false, enabled when open and connected for `rdp`, `vnc`, `agent`; clicking it sends `["remote:viewer-action", "paste-clipboard"]`; `showSetup` disables it. Page tests: the action `"paste-clipboard"` on an agent session produces, in order, the clipboard message (if changed) then MetaLeft/KeyV/KeyV/MetaLeft on the channel; on a Guacamole VNC Mac session the clipboard stream then `0xffe7, 0x76` down/up; `#paste-remote` is disabled until connected, enabled after the first frame, disabled after the session ends; clicking it does the same; with no local clipboard (bridge 3) the button and action do nothing; at the lock screen the same click is a Meta+V the agent decides (covered in Task 6, no extra test).
- [ ] **Step 2: Run** `node --test test/desktop.test.js test/viewer-agent.test.js test/viewer-flow.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** to the interface; extend the existing list in the "native remote menu enables valid commands" test (`:712-716`, `:727-760`) with the new id.
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/main.cjs src/main.ts src/style.css test/desktop.test.js test/viewer-agent.test.js test/viewer-flow.test.js
node --test test/public-hygiene.test.js && git commit -m "Add the clipboard paste menu item and bar button"
```

---

### Task 13: Documentation, device checklist and spec status

**Files:**
- Modify: `README.md:236` (scope line: clipboard sync now exists; lock-screen typing; no key remapping), `README.md` "Using it" (`~:280-300`: paste, 클립보드 붙여넣기, full screen captures the Windows key, F11 and hold-Escape, the 64 KiB limit, Korean over VNC per Task 11's outcome, "a Mac copy in the last few hundred milliseconds before focus loss may not arrive", browser best effort, residual Windows Clipboard History risk if the mark could not be written), `docs/mac-agent-spec.md:202-216` (D4: the new messages, the `lock`/`clipboard`/`clipboard-skipped` notices replacing "`replaced` only", the text-dialog note), `:433-436` (§11 drops "양방향 클립보드 동기화" and "잠금 해제 자동화" is narrowed: only a typed paste), `docs/verification.md` (new section after `:320`: "Clipboard sync and Command key capture: device checks (not yet run)" with the spec §6 list items 1-8 verbatim as entries, the Task 3 console-lock check, the Task 7 osclipboard write check, the Task 8 menu-F11 double-toggle watch, the Task 11 VNC encoding measurement, each to be filled with date and evidence), `docs/superpowers/specs/2026-10-19-clipboard-sync-design.md` (Status line: "implemented on branch ...; rehearsal pending").
- Test: `test/public-hygiene.test.js` (existing), a docs guard in `test/agent-ci.test.js` is not needed.

**Interfaces:** documentation only; no new names.

- [ ] **Step 1: Write the docs** with the exact facts above (64 KiB, 500 ms, 300 ms, bridge 4, agent 0.2.0, installing the agent needs the owner's `./install.sh`, the app update arrives with the next desktop tag).
- [ ] **Step 2: Run** `node --test test/public-hygiene.test.js && npm test && npm run check && cd agent/mac && cargo test --locked` — Expected: PASS (full suite, one last time on Linux; the macOS-only parts run in CI).
- [ ] **Step 3: Commit**

```bash
git add README.md docs/mac-agent-spec.md docs/verification.md docs/superpowers/specs/2026-10-19-clipboard-sync-design.md
node --test test/public-hygiene.test.js && git commit -m "Document clipboard sync, lock-screen paste and the device checks"
```

---

## Self-review (done while writing)

- **Spec coverage:** D1 paths: Tasks 1-6 (agent), 11 (Guacamole, `disable-copy`, VNC encoding). D2: Tasks 7, 9. D3 triggers/dedupe/cap/CRLF: Task 9; barrier ordering on both paths: Tasks 10, 11. D4: Task 8. D5: Tasks 3-6 (lock signal, held text, locked Cmd+V, key-code typing). D6: Tasks 1-3, 6 (messages, watch, `currentHostOnly`, access, queue, version). D7: Tasks 7, 3 (marks, fallback), README in 13. D8: Tasks 5, 9, 10, 12 (notices). G5: Task 12. §5 rollout and §6 verification: Task 13 (device list) plus Task 8/11 rehearsal steps; the release tag/`package.json` bump is the owner's (release.yml checks tag == package.json version, `package.json` stays 0.3.2 here).
- **Placeholders:** none intended; Task 2 uses the existing `Call` harness (`peer.rs:787-960`).
- **Type consistency:** `SkipReason` strings (Task 1) = `NoticeKey` subset (Task 9) = `remoteSkipped` argument (Task 10). `PasteKeyEvent` (Task 9) is a subset of `KeyboardEvent` used in Tasks 10-11. `Board`/`ClipState` names are the same in Tasks 3, 5, 6. Bridge result shapes (Task 7) are what `bridgeClipboard` (Task 9) maps.
- **Proportion:** signatures, pinned values and test names/assertions only; bodies appear nowhere.
