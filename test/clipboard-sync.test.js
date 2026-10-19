import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const input = await loadTs("agent-input.ts");
const sync = await loadTs("clipboard-sync.ts", {}, { "./agent-input": input });
const {
  createClipboardSync,
  isPasteShortcut,
  utf8Length,
  normaliseNewlines,
  NOTICE_TEXT,
  MAX_CLIPBOARD_BYTES,
  PASTE_BARRIER_MS,
  FOCUS_RETRY_MS,
} = sync;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const key = (over = {}) => ({
  code: "KeyV",
  key: "v",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});
const ok = (text, concealed = false) => ({ ok: true, text, concealed });

// A scripted local clipboard: every read() is a deferred the test settles by hand; the
// timers are fake and only move when the test advances them.
function rig({ target = "other", latin1Only = false } = {}) {
  const reads = [];
  const writes = [];
  const sent = [];
  const watch = [];
  const notices = [];
  const log = [];
  let sendResult = "sent";
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const local = {
    read() {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      reads.push({ resolve, settled: false });
      return promise;
    },
    async write(text, concealed) {
      writes.push([text, concealed]);
      return { ok: true };
    },
  };
  const remote = {
    sendClipboard(text, concealed) {
      if (sendResult === "sent") {
        sent.push([text, concealed]);
        log.push(`clipboard ${text}`);
      }
      return sendResult;
    },
    sendWatch(on) {
      watch.push(on);
    },
  };
  const s = createClipboardSync({
    local,
    remote,
    target,
    latin1Only,
    notify: (k) => notices.push(k),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    s,
    reads,
    writes,
    sent,
    watch,
    notices,
    log,
    setSendResult: (r) => (sendResult = r),
    // Answers the oldest unanswered read.
    async answer(result) {
      const read = reads.find((r) => !r.settled);
      assert.ok(read, "no read waiting");
      read.settled = true;
      read.resolve(typeof result === "string" ? ok(result) : result);
      await tick();
    },
    pending: () => reads.filter((r) => !r.settled).length,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now);
        if (!due.length) break;
        due.sort((a, b) => a[1].at - b[1].at);
        const [id, t] = due[0];
        timers.delete(id);
        t.fn();
        await tick();
      }
    },
    timerCount: () => timers.size,
    // What the remote saw, as Task 10 would send it: key events pass through the gate.
    event(name) {
      s.gate(() => log.push(name));
    },
  };
}

test("focus_gain_sends_changed_text_once_and_starts_the_watch", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  assert.deepEqual(r.watch, [true]);
  await r.answer("hello");
  assert.deepEqual(r.sent, [["hello", false]]);
  r.s.setViewFocused(false);
  assert.deepEqual(r.watch, [true, false]);
  r.s.setViewFocused(true);
  await r.answer("hello");
  assert.equal(r.sent.length, 1);
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer(ok("secret", true));
  assert.deepEqual(r.sent[1], ["secret", true]);
});

test("focus_without_a_read_starts_the_watch_and_reads_nothing", async () => {
  const r = rig();
  r.s.setViewFocused(true, { read: false });
  await tick();
  assert.deepEqual(r.watch, [true]);
  assert.equal(r.reads.length, 0, "no read at the session start");
  assert.deepEqual(r.sent, []);
  // The view counts as focused: remote text is written, and the first paste still sends.
  r.s.setViewFocused(true);
  assert.equal(r.reads.length, 0, "already focused: still nothing");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("first paste");
  assert.deepEqual(r.sent, [["first paste", false]]);
  // A genuine focus gain after a loss reads as usual.
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("changed");
  assert.deepEqual(r.sent.at(-1), ["changed", false]);
});

test("unchanged_text_after_crlf_normalisation_is_not_resent", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("a\r\nb");
  assert.deepEqual(r.sent, [["a\nb", false]]);
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("a\nb");
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("a\rb");
  assert.equal(r.sent.length, 1);
  assert.equal(normaliseNewlines("x\r\ny\rz"), "x\ny\nz");
});

test("remote_text_becomes_the_baseline_so_it_is_not_echoed_back", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.remoteClipboard("from mac\r\nline", true);
  await tick();
  assert.deepEqual(r.writes, [["from mac\nline", true]]);
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("from mac\nline");
  assert.equal(r.sent.length, 0);
});

test("a_failed_local_write_restores_the_previous_baseline", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("mine");
  const failing = rig();
  failing.s.setViewFocused(true);
  await failing.answer("mine");
  assert.equal(failing.sent.length, 1);
  // Same flow with a write that fails: the old text stays the baseline.
  const reads = [];
  const sent = [];
  const s = createClipboardSync({
    local: {
      read: () => new Promise((resolve) => reads.push(resolve)),
      write: async () => ({ ok: false, reason: "failed" }),
    },
    remote: {
      sendClipboard: (t) => (sent.push(t), "sent"),
    },
    target: "other",
    notify() {},
    setTimeout,
    clearTimeout,
  });
  s.setViewFocused(true);
  reads[0](ok("mine"));
  await tick();
  s.remoteClipboard("theirs", false);
  await tick();
  s.setViewFocused(false);
  s.setViewFocused(true);
  reads[1](ok("mine"));
  await tick();
  assert.deepEqual(sent, ["mine"]);
});

test("a_focus_read_overtaken_by_remote_text_is_not_sent_back", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  r.s.remoteClipboard("newer", false);
  await tick();
  await r.answer("older local");
  assert.equal(r.sent.length, 0);
});

test("empty_text_and_failed_non_text_reads_send_nothing_and_do_not_notify", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "failed" });
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "denied" });
  r.s.pasteShortcut(key({ metaKey: true, ctrlKey: true }));
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("");
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.notices, []);
});

test("unfocused_drops_remote_text_and_stops_the_watch", async () => {
  const r = rig();
  r.s.remoteClipboard("before any focus", false);
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.setViewFocused(false);
  assert.deepEqual(r.watch, [true, false]);
  r.s.remoteClipboard("dropped", false);
  await tick();
  assert.deepEqual(r.writes, []);
});

test("blur_drops_a_pending_focus_read", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  r.s.setViewFocused(false);
  await r.answer("late");
  assert.deepEqual(r.sent, []);
});

test("size_cap_counts_utf8_bytes", async () => {
  assert.equal(MAX_CLIPBOARD_BYTES, 65536);
  assert.equal(utf8Length("가".repeat(21845)), 65535);
  assert.equal(utf8Length("😀"), 4);
  assert.equal(utf8Length("\ud800"), 3);
  assert.equal(utf8Length("é"), 2);
  const fits = "가".repeat(21845);
  const big = "가".repeat(21846);
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer(fits);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.notices, []);
  // Focus trigger: once per distinct oversize text.
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer(big);
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer(big);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.notices, ["too-large"]);
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer(big + "가");
  assert.deepEqual(r.notices, ["too-large", "too-large"]);
  // Paste barrier: every time.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer(big);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer(big);
  assert.deepEqual(r.notices, [
    "too-large",
    "too-large",
    "too-large",
    "too-large",
  ]);
  assert.equal(r.sent.length, 1);
});

test("a_too_large_answer_from_the_channel_notices_the_same", async () => {
  const r = rig();
  r.setSendResult("too-large");
  r.s.setViewFocused(true);
  await r.answer("x");
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("x");
  assert.deepEqual(r.notices, ["too-large"]);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("x");
  assert.deepEqual(r.notices, ["too-large", "too-large"]);
  // lastSynced is unchanged, so a closed channel later still sends the same text.
  r.setSendResult("sent");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("x");
  assert.deepEqual(r.sent, [["x", false]]);
});

test("a_closed_channel_sends_nothing_and_stays_silent", async () => {
  const r = rig();
  r.setSendResult("closed");
  r.s.setViewFocused(true);
  await r.answer("x");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("x");
  assert.deepEqual(r.notices, []);
});

test("paste_shortcut_matrix", () => {
  const mac = (o) => isPasteShortcut(key(o), "mac");
  const other = (o) => isPasteShortcut(key(o), "other");
  assert.equal(mac({ metaKey: true }), true);
  assert.equal(mac({ metaKey: true, shiftKey: true }), true);
  assert.equal(mac({}), false);
  assert.equal(mac({ ctrlKey: true }), false);
  assert.equal(mac({ metaKey: true, altKey: true }), false);
  assert.equal(mac({ metaKey: true, ctrlKey: true }), false);
  assert.equal(other({ ctrlKey: true }), true);
  assert.equal(other({ ctrlKey: true, shiftKey: true }), true);
  assert.equal(other({ code: "Insert", key: "Insert", shiftKey: true }), true);
  assert.equal(other({ ctrlKey: true, altKey: true }), false);
  assert.equal(other({ metaKey: true }), false);
  assert.equal(other({}), false);
  assert.equal(other({ code: "Insert", key: "Insert" }), false);
  assert.equal(
    other({ code: "Insert", key: "Insert", shiftKey: true, ctrlKey: true }),
    false,
  );
  // A Korean IME reports another key but the same physical code.
  assert.equal(other({ key: "ㅍ", ctrlKey: true }), true);
});

test("paste_holds_the_key_and_everything_after_it_in_order_until_the_text_is_sent", async () => {
  const r = rig({ target: "mac" });
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ metaKey: true }));
  r.event("V-down");
  r.s.pasteShortcut(key({ metaKey: true })); // not a paste key: the V key-up is a keyup
  r.event("V-up");
  r.event("pointer");
  assert.deepEqual(r.log, []);
  await r.answer("new");
  assert.deepEqual(r.log, ["clipboard new", "V-down", "V-up", "pointer"]);
  // The barrier is closed again: events run at once.
  r.event("after");
  assert.equal(r.log.at(-1), "after");
});

test("a_slow_focus_read_cannot_overtake_the_paste_read", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  assert.equal(r.pending(), 1, "reads are serialised");
  await r.answer("old");
  assert.deepEqual(r.log, ["clipboard old"]);
  assert.equal(r.pending(), 1);
  await r.answer("new");
  assert.deepEqual(r.log, ["clipboard old", "clipboard new", "V"]);
});

test("a_read_slower_than_500ms_releases_the_keys_and_its_late_result_is_discarded", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.advance(PASTE_BARRIER_MS - 1);
  assert.deepEqual(r.log, []);
  await r.advance(1);
  assert.deepEqual(r.log, ["V"]);
  assert.deepEqual(r.notices, ["read-timeout"]);
  await r.answer("late");
  assert.deepEqual(r.sent, []);
  // The late text was not marked synced: the next trigger re-reads and sends it.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  assert.equal(r.pending(), 1);
  await r.answer("late");
  assert.deepEqual(r.sent, [["late", false]]);
  assert.deepEqual(r.notices, ["read-timeout"]);
});

test("a_paste_read_that_never_answers_does_not_block_the_next_one", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.advance(PASTE_BARRIER_MS);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  assert.equal(r.pending(), 2);
  r.reads[2].settled = true;
  r.reads[2].resolve(ok("second"));
  await tick();
  assert.deepEqual(r.sent, [["second", false]]);
});

test("a_barrier_behind_a_slow_focus_read_times_out_without_a_late_paste_read", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.advance(PASTE_BARRIER_MS);
  assert.deepEqual(r.log, ["V"]);
  assert.deepEqual(r.notices, ["read-timeout"]);
  await r.answer("focus text");
  assert.equal(r.pending(), 0, "the dropped paste trigger does not read");
  assert.deepEqual(r.sent, [], "the abandoned focus read is discarded");
});

test("two_paste_keys_in_one_barrier_read_once", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V1");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V2");
  assert.equal(r.reads.length, 2);
  await r.answer("text");
  assert.deepEqual(r.log, ["clipboard text", "V1", "V2"]);
  assert.equal(r.reads.length, 2);
  assert.equal(r.timerCount(), 0, "the barrier timer is cleared");
});

test("focus_loss_during_a_barrier_releases_the_queue_without_sending", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  r.s.setViewFocused(false);
  assert.deepEqual(r.log, ["V"]);
  await r.answer("late");
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.notices, ["read-timeout"]);
  assert.equal(r.timerCount(), 0);
});

test("unfocused_refusal_at_the_focus_instant_retries_once_silently_but_at_a_paste_notifies", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "unfocused" });
  assert.equal(r.pending(), 0);
  await r.advance(FOCUS_RETRY_MS);
  assert.equal(r.pending(), 1);
  await r.answer("text");
  assert.deepEqual(r.sent, [["text", false]]);
  assert.deepEqual(r.notices, []);
  // A second refusal is not retried again.
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "unfocused" });
  await r.advance(FOCUS_RETRY_MS);
  await r.answer({ ok: false, reason: "unfocused" });
  await r.advance(FOCUS_RETRY_MS * 4);
  assert.equal(r.pending(), 0);
  assert.deepEqual(r.notices, []);
  // At a paste the refusal is told, and the keys are released.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.answer({ ok: false, reason: "unfocused" });
  assert.deepEqual(r.notices, ["bridge-refused"]);
  assert.deepEqual(r.log.slice(-1), ["V"]);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer({ ok: false, reason: "failed" });
  assert.deepEqual(r.notices, ["bridge-refused", "bridge-refused"]);
});

test("a_focus_retry_is_cancelled_by_blur", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "unfocused" });
  r.s.setViewFocused(false);
  await r.advance(FOCUS_RETRY_MS * 2);
  assert.equal(r.pending(), 0);
});

test("denied_browser_reads_are_silent_at_focus_and_at_paste", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer({ ok: false, reason: "denied" });
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.answer({ ok: false, reason: "denied" });
  assert.deepEqual(r.log, ["V"]);
  assert.deepEqual(r.notices, []);
  await r.advance(1000);
  assert.equal(r.pending(), 0);
});

test("lock_change_clears_the_baseline_and_a_locked_paste_resends_unchanged_text", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("pw");
  assert.equal(r.sent.length, 1);
  r.s.setRemoteLocked(true);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 2);
  // While locked, a second paste with unchanged text still sends.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 3);
  // But a focus trigger with unchanged text does not.
  r.s.setViewFocused(false);
  r.s.setViewFocused(true);
  await r.answer("pw");
  assert.equal(r.sent.length, 3);
  // Unlock: the baseline was cleared, so the first paste sends again, the next does not.
  r.s.setRemoteLocked(false);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 4);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 4);
  // Flapping true/false/true between two pastes sends at each paste.
  r.s.setRemoteLocked(true);
  r.s.setRemoteLocked(false);
  r.s.setRemoteLocked(true);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 5);
  r.s.setRemoteLocked(false);
  r.s.setRemoteLocked(true);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("pw");
  assert.equal(r.sent.length, 6);
});

test("no_local_clipboard_means_no_gate_no_notice_and_no_watch", async () => {
  // The page does not build the core without a local clipboard; the locator decides.
  const modules = (version, appMode) => ({
    "./api": { appMode, clipboardBridge: appMode && version >= 4 },
  });
  const clipboard = { readText: async () => "x", writeText: async () => {} };
  const desktop = (v) => ({
    bridgeVersion: v,
    readClipboard: async () => ({ ok: true, text: "x", concealed: false }),
    writeClipboard: async () => ({ ok: true, concealed: false }),
  });
  const load = (v, appMode, withBridge = true) =>
    loadTs(
      "clipboard-local.ts",
      {
        window: withBridge ? { desktop: desktop(v) } : {},
        navigator: { clipboard },
      },
      modules(v, appMode),
    );
  const old = await load(3, true);
  assert.equal(old.localClipboardFor(), undefined);
  const noDesktop = await load(0, true, false);
  assert.equal(noDesktop.localClipboardFor(), undefined);
  assert.notEqual((await load(4, true)).localClipboardFor(), undefined);
  assert.notEqual((await load(0, false, false)).localClipboardFor(), undefined);
  const noApi = await loadTs(
    "clipboard-local.ts",
    { window: {}, navigator: {} },
    modules(0, false),
  );
  assert.equal(noApi.localClipboardFor(), undefined);
  assert.equal(noApi.browserClipboard({}), undefined);
});

test("the_bridge_and_browser_adapters_map_their_results", async () => {
  const { bridgeClipboard, browserClipboard } = await loadTs(
    "clipboard-local.ts",
    {},
    { "./api": { appMode: false, clipboardBridge: false } },
  );
  const calls = [];
  const bridge = bridgeClipboard({
    readClipboard: async () => ({ ok: true, text: "t", concealed: true }),
    writeClipboard: async (t, o) => (calls.push([t, o]), { ok: true }),
  });
  const read = await bridge.read();
  assert.deepEqual([read.ok, read.text, read.concealed], [true, "t", true]);
  assert.equal((await bridge.write("w", true)).ok, true);
  assert.deepEqual(calls[0][0], "w");
  assert.equal(calls[0][1].concealed, true);
  const refuse = (reason) =>
    bridgeClipboard({
      readClipboard: async () => ({ ok: false, reason }),
      writeClipboard: async () => ({ ok: false, reason }),
    });
  assert.equal((await refuse("unfocused").read()).reason, "unfocused");
  assert.equal((await refuse("failed").read()).reason, "failed");
  assert.equal((await refuse("too-large").write("x", false)).reason, "failed");
  const throwing = bridgeClipboard({
    readClipboard: async () => {
      throw new Error("x");
    },
    writeClipboard: async () => {
      throw new Error("x");
    },
  });
  assert.equal((await throwing.read()).reason, "failed");
  assert.equal((await throwing.write("x", false)).reason, "failed");
  const browser = browserClipboard({
    clipboard: {
      readText: async () => "b",
      writeText: async () => {},
    },
  });
  const br = await browser.read();
  assert.deepEqual([br.ok, br.text, br.concealed], [true, "b", false]);
  assert.equal((await browser.write("x", true)).ok, true);
  const denied = browserClipboard({
    clipboard: {
      readText: () => Promise.reject(new Error("NotAllowed")),
      writeText: () => Promise.reject(new Error("NotAllowed")),
    },
  });
  assert.equal((await denied.read()).reason, "denied");
  assert.equal((await denied.write("x", false)).reason, "denied");
});

test("paste_from_menu_runs_the_barrier_then_presses_through_the_gate", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteFromMenu(() => r.log.push("press"));
  r.event("other");
  assert.deepEqual(r.log, []);
  await r.answer("menu text");
  assert.deepEqual(r.log, ["clipboard menu text", "press", "other"]);
});

test("old_agent_never_answers_so_nothing_waits_for_a_reply", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("text");
  // No lock notice, no watch reply: a paste completes as soon as the read is processed.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.answer("text");
  assert.deepEqual(r.log, ["clipboard text", "V"]);
  assert.deepEqual(r.notices, []);
  assert.equal(r.timerCount(), 0);
});

test("latin1_only_refuses_korean_but_sends_latin1_text", async () => {
  const r = rig({ latin1Only: true });
  r.s.setViewFocused(true);
  await r.answer("café ÿ");
  assert.deepEqual(r.sent, [["café ÿ", false]]);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.answer("안녕");
  assert.deepEqual(r.notices, ["unsupported-chars"]);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.log.slice(-1), ["V"]);
  // Code point above 0xFF but below 0x1FFFF (euro sign, emoji) counts too.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("€");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("😀");
  assert.equal(r.notices.length, 3);
  // Without the flag the same text is sent.
  const free = rig();
  free.s.setViewFocused(true);
  await free.answer("안녕");
  assert.equal(free.sent.length, 1);
});

test("invalidate_forgets_the_baseline", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("same");
  r.s.invalidate();
  r.s.pasteShortcut(key({ ctrlKey: true }));
  await r.answer("same");
  assert.equal(r.sent.length, 2);
});

test("remote_skips_become_notices_and_end_resets_everything", async () => {
  const r = rig();
  for (const k of [
    "too-large",
    "read-denied",
    "locked-multiline",
    "locked-empty",
  ])
    r.s.remoteSkipped(k);
  assert.deepEqual(r.notices, [
    "too-large",
    "read-denied",
    "locked-multiline",
    "locked-empty",
  ]);
  r.s.setViewFocused(true);
  await r.answer("keep");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  r.s.end();
  assert.deepEqual(r.log.slice(-1), ["V"]);
  assert.equal(r.timerCount(), 0);
  await r.answer("late");
  assert.equal(r.sent.length, 1);
  // Reset: unfocused again, baseline gone.
  r.s.remoteClipboard("x", false);
  await tick();
  assert.deepEqual(r.writes, []);
  r.s.setViewFocused(true);
  await r.answer("keep");
  assert.equal(r.sent.length, 2);
});

test("flush_runs_the_queue_now_in_order", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("a");
  r.event("b");
  r.s.flush();
  assert.deepEqual(r.log, ["a", "b"]);
  await r.answer("late");
  assert.deepEqual(r.sent, []);
});

test("notice_text_is_the_approved_korean_copy", () => {
  assert.deepEqual(
    { ...NOTICE_TEXT },
    {
      "too-large": "클립보드가 너무 커서(64 KiB 초과) 보내지 못했습니다",
      "read-denied": "Mac이 클립보드 읽기를 허용하지 않았습니다",
      "locked-multiline": "잠금 화면에는 여러 줄을 붙여넣을 수 없습니다",
      "locked-empty": "입력할 텍스트가 없습니다",
      "bridge-refused": "클립보드에 접근하지 못했습니다",
      "read-timeout": "클립보드를 제때 읽지 못했습니다",
      "unsupported-chars": "이 화면은 한글 같은 문자를 붙여넣을 수 없습니다",
    },
  );
});

test("a_throwing_held_item_does_not_lose_the_rest_or_stop_the_next_read", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V-down");
  r.s.gate(() => {
    throw new Error("channel closed");
  });
  r.event("V-up");
  await r.answer("text");
  assert.deepEqual(r.log, ["clipboard text", "V-down", "V-up"]);
  // The core still works: the next paste reads again.
  r.s.pasteShortcut(key({ ctrlKey: true }));
  assert.equal(r.pending(), 1);
});

test("a_focus_read_that_never_settles_is_abandoned_at_the_barrier_timeout", async () => {
  const r = rig();
  r.s.setViewFocused(true); // read 0 never settles
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  await r.advance(PASTE_BARRIER_MS);
  assert.deepEqual(r.log, ["V"]);
  assert.deepEqual(r.notices, ["read-timeout"]);
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V2");
  assert.equal(r.reads.length, 2, "the next paste reads at once");
  r.reads[1].settled = true;
  r.reads[1].resolve(ok("fresh"));
  await tick();
  assert.deepEqual(r.log, ["V", "clipboard fresh", "V2"]);
  // The stuck read's late result is discarded.
  r.reads[0].settled = true;
  r.reads[0].resolve(ok("stale"));
  await tick();
  assert.deepEqual(r.sent, [["fresh", false]]);
});

test("end_releases_a_barrier_without_a_notice", async () => {
  const r = rig();
  r.s.setViewFocused(true);
  await r.answer("");
  r.s.pasteShortcut(key({ ctrlKey: true }));
  r.event("V");
  r.s.end();
  assert.deepEqual(r.log, ["V"]);
  assert.deepEqual(r.notices, []);
});
