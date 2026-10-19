import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const { createKeyLock, KEY_LOCK_NOTICE, KEY_LOCK_MS } =
  await loadTs("keyboard-lock.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

// Every enter / exit / lock is a promise the test settles by hand; time is a list of timers.
function rig({ supported = true } = {}) {
  const log = [];
  const pending = { enter: [], exit: [], lock: [] };
  const timers = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let htmlFullscreen = false;
  const hold = (kind, onSettle) => () => {
    log.push(kind);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      pending[kind].push({
        resolve: (value) => {
          inFlight--;
          onSettle?.(value);
          resolve(value);
        },
        reject: (error) => {
          inFlight--;
          reject(error);
        },
      });
    });
  };
  const notices = [];
  const reasons = [];
  const lock = createKeyLock({
    supported,
    enterHtml: hold("enter", (ok) => {
      if (ok) htmlFullscreen = true;
    }),
    exitHtml: hold("exit", () => {
      htmlFullscreen = false;
    }),
    // keyboard.lock() is not an enter/exit: it does not count as an HTML transition.
    lock: () => {
      log.push("lock");
      return new Promise((resolve, reject) =>
        pending.lock.push({ resolve, reject }),
      );
    },
    unlock: () => log.push("unlock"),
    isHtmlFullscreen: () => htmlFullscreen,
    notify: (key) => notices.push(key),
    log: (reason) => reasons.push(reason),
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cleared = true;
    },
  });
  const next = (kind) => pending[kind].shift();
  return {
    lock,
    log,
    notices,
    reasons,
    timers,
    next,
    get maxInFlight() {
      return maxInFlight;
    },
    // The document's HTML full screen changes by itself (hold-Escape).
    escapeHeld() {
      htmlFullscreen = false;
      lock.fullscreenChanged();
    },
    // enter -> true, lock granted
    async take() {
      next("enter").resolve(true);
      await settle();
      next("lock").resolve();
      await settle();
    },
    // exit answers whatever is queued
    async finishExits() {
      while (pending.exit.length) next("exit").resolve(true);
      await settle();
    },
  };
}
const ON = { session: true, focused: true };

test("the notice copy is the approved Korean text", () => {
  assert.deepEqual(
    { ...KEY_LOCK_NOTICE },
    {
      "key-lock-on": "Windows 키가 Mac으로 갑니다 · Esc를 길게 누르면 풀립니다",
      "key-lock-released":
        "키 잡기를 풀었습니다 · 화면을 클릭하면 다시 잡습니다",
    },
  );
});

test("it takes HTML full screen, then the lock, only for a session that is focused; the lock is held after both", async () => {
  const r = rig();
  r.lock.update({ session: true, focused: false });
  r.lock.update({ session: false, focused: true });
  await settle();
  assert.deepEqual(r.log, []);
  r.lock.update(ON);
  assert.deepEqual(r.log, ["enter"]);
  assert.equal(r.lock.held, false);
  r.next("enter").resolve(true);
  await settle();
  assert.deepEqual(r.log, ["enter", "lock"]);
  assert.equal(r.lock.held, false, "not held until the lock is granted");
  r.next("lock").resolve();
  await settle();
  assert.equal(r.lock.held, true);
  r.lock.update(ON);
  r.lock.click();
  await settle();
  assert.deepEqual(r.log, ["enter", "lock"], "already held: nothing more");
});

test("a platform without support never does anything", async () => {
  const r = rig({ supported: false });
  r.lock.update(ON);
  r.lock.click();
  await settle();
  assert.deepEqual(r.log, []);
  assert.equal(r.lock.held, false);
});

test("the 2 s timer starts after HTML full screen was entered, not before", async () => {
  const r = rig();
  r.lock.update(ON);
  assert.equal(r.timers.length, 0);
  r.next("enter").resolve(true);
  await settle();
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 2000);
  assert.equal(KEY_LOCK_MS, 2000);
  r.next("lock").resolve();
  await settle();
  assert.equal(r.timers[0].cleared, true, "a granted lock clears the timer");
});

test("a lock that is refused or does not answer in 2 s leaves HTML full screen at once, logs one line and shows no notice", async () => {
  for (const how of ["refused", "timeout"]) {
    const r = rig();
    r.lock.update(ON);
    r.next("enter").resolve(true);
    await settle();
    if (how === "refused") r.next("lock").reject(new Error("NotAllowedError"));
    else r.timers[0].callback();
    await settle();
    assert.deepEqual(r.log, ["enter", "lock", "unlock", "exit"], how);
    assert.deepEqual(r.reasons, [`key-lock-${how}`], how);
    assert.deepEqual(r.notices, [], how);
    assert.equal(r.lock.held, false, how);
    // A late grant after the timeout changes nothing.
    r.next("lock")?.resolve();
    await r.finishExits();
    assert.equal(r.lock.held, false, how);
    // No retry loop on its own; a click is a new chance.
    r.lock.update(ON);
    await settle();
    assert.equal(r.log.filter((x) => x === "enter").length, 1, how);
    r.lock.click();
    assert.equal(r.log.filter((x) => x === "enter").length, 2, how);
  }
});

test("a refused HTML full screen (main said no) logs the reason, leaves at once and shows no notice", async () => {
  const r = rig();
  r.lock.update(ON);
  r.next("enter").resolve(false);
  await settle();
  assert.deepEqual(r.log, ["enter", "unlock", "exit"]);
  assert.deepEqual(r.reasons, ["html-full-screen-refused"]);
  assert.deepEqual(r.notices, []);
  // A rejected bridge call is the same refusal.
  const q = rig();
  q.lock.update(ON);
  q.next("enter").reject(new Error("gone"));
  await settle();
  assert.deepEqual(q.reasons, ["html-full-screen-refused"]);
});

test("losing the focus or the session releases: unlock and exit; a blur also clears a refusal so the next focus tries again", async () => {
  for (const release of [
    (l) => l.update({ session: true, focused: false }),
    (l) => l.update({ session: false, focused: true }),
    (l) => l.end(),
  ]) {
    const r = rig();
    r.lock.update(ON);
    await r.take();
    release(r.lock);
    assert.deepEqual(r.log.slice(-2), ["unlock", "exit"]);
    assert.equal(r.lock.held, false);
    await r.finishExits();
  }
  const r = rig();
  r.lock.update(ON);
  r.next("enter").resolve(false);
  await settle();
  await r.finishExits();
  r.lock.update({ session: true, focused: false });
  r.lock.update(ON);
  assert.equal(r.log.filter((x) => x === "enter").length, 2);
});

test("focus returning re-takes the lock after a blur", async () => {
  const r = rig();
  r.lock.update(ON);
  await r.take();
  r.lock.update({ session: true, focused: false });
  await r.finishExits();
  r.lock.update(ON);
  assert.deepEqual(r.log.slice(-1), ["enter"]);
  await r.take();
  assert.equal(r.lock.held, true);
});

test("hold-Escape (full screen ends by itself while held) unlocks, notifies once and stays released until a click or a new focus", async () => {
  const r = rig();
  r.lock.update(ON);
  await r.take();
  assert.deepEqual(r.notices, ["key-lock-on"]);
  r.escapeHeld();
  await settle();
  assert.equal(r.lock.held, false);
  assert.deepEqual(r.log.slice(-1), ["unlock"]);
  assert.deepEqual(r.notices, ["key-lock-on", "key-lock-released"]);
  // Not re-taken by anything but a click or a fresh focus.
  r.lock.update(ON);
  r.lock.update(ON);
  await settle();
  assert.equal(r.log.filter((x) => x === "enter").length, 1);
  r.lock.click();
  assert.equal(r.log.filter((x) => x === "enter").length, 2);
  await r.take();
  assert.equal(r.lock.held, true);
  assert.deepEqual(
    r.notices,
    ["key-lock-on", "key-lock-released"],
    "the on notice is once per session",
  );
  // A new focus is the other way back.
  r.escapeHeld();
  r.lock.update({ session: true, focused: false });
  r.lock.update(ON);
  assert.equal(r.log.filter((x) => x === "enter").length, 3);
});

test("our own exit is not mistaken for hold-Escape, and fullscreenchange without a hold does nothing", async () => {
  const r = rig();
  r.lock.update(ON);
  await r.take();
  r.lock.fullscreenChanged(); // still in full screen
  r.lock.update({ session: true, focused: false }); // our exit
  r.escapeHeld(); // the change event of our exit
  await r.finishExits();
  assert.deepEqual(r.notices, ["key-lock-on"], "no released notice");
  r.lock.update(ON);
  assert.deepEqual(r.log.slice(-1), ["enter"], "and no hold-Escape latch");
});

test("hold-Escape while the lock is still being granted releases as soon as the grant lands", async () => {
  const r = rig();
  r.lock.update(ON);
  r.next("enter").resolve(true);
  await settle();
  r.escapeHeld();
  r.next("lock").resolve();
  await settle();
  assert.equal(r.lock.held, false);
  assert.deepEqual(r.notices, ["key-lock-released"]);
  assert.deepEqual(r.log.slice(-1), ["unlock"]);
});

test("the lock-on notice shows once per session; end() starts a new session", async () => {
  const r = rig();
  r.lock.update(ON);
  await r.take();
  r.lock.update({ session: true, focused: false });
  await r.finishExits();
  r.lock.update(ON);
  await r.take();
  assert.deepEqual(
    r.notices,
    ["key-lock-on"],
    "blur and refocus: same session",
  );
  r.lock.end();
  await r.finishExits();
  r.lock.update(ON);
  await r.take();
  assert.deepEqual(r.notices, ["key-lock-on", "key-lock-on"]);
});

test("a session that ends while the lock is being taken gives it back at once and shows no notice", async () => {
  const r = rig();
  r.lock.update(ON);
  r.next("enter").resolve(true);
  await settle();
  r.lock.end();
  r.next("lock").resolve();
  await settle();
  assert.deepEqual(r.log.slice(-2), ["unlock", "exit"]);
  assert.deepEqual(r.notices, []);
  assert.equal(r.lock.held, false);
});

test("enter and exit never overlap, and the latest want wins", async () => {
  const r = rig();
  // want, unwant, want again while the first enter is still pending
  r.lock.update(ON);
  r.lock.update({ session: true, focused: false });
  r.lock.update(ON);
  assert.deepEqual(r.log, ["enter"], "one in flight");
  await r.take(); // lock granted: held; the wish went and came back
  assert.equal(r.lock.held, true);
  assert.equal(r.maxInFlight, 1);
  // unwant while held, want again while the exit is pending
  r.lock.update({ session: true, focused: false });
  r.lock.update(ON);
  assert.equal(r.maxInFlight, 1, "the exit is still alone");
  await r.finishExits();
  assert.deepEqual(r.log.slice(-1), ["enter"]);
  await r.take();
  assert.equal(r.lock.held, true);
  assert.equal(r.maxInFlight, 1);
  // unwant during the next enter: it settles and then leaves
  r.lock.update({ session: true, focused: false });
  r.lock.update(ON);
  r.lock.update({ session: true, focused: false });
  await r.finishExits();
  assert.equal(r.lock.held, false);
  assert.equal(r.maxInFlight, 1);
});

test("hold-Escape at the end of a session, while a take is in flight, does not latch the next session", async () => {
  const r = rig();
  r.lock.update(ON);
  r.next("enter").resolve(true);
  await settle();
  r.escapeHeld();
  r.lock.end();
  r.next("lock").resolve();
  await settle();
  assert.deepEqual(r.notices, [], "no notice for the ended session");
  await r.finishExits();
  r.lock.update(ON);
  assert.deepEqual(
    r.log.slice(-1),
    ["enter"],
    "the next session takes at once",
  );
  // The same for a refusal that lands after the session ended.
  const q = rig();
  q.lock.update(ON);
  q.lock.end();
  q.next("enter").resolve(false);
  await settle();
  await q.finishExits();
  q.lock.update(ON);
  assert.equal(q.log.filter((x) => x === "enter").length, 2);
});
