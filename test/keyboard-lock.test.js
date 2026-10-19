import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const { createKeyboardLock, isLockedF11 } = await loadTs("keyboard-lock.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deps({ reject = false } = {}) {
  const calls = { lock: 0, unlock: 0 };
  let grant;
  return {
    calls,
    grant: () => grant(),
    deps: {
      lock: () => {
        calls.lock++;
        if (reject) return Promise.reject(new Error("refused"));
        return new Promise((resolve) => {
          grant = resolve;
        });
      },
      unlock: () => {
        calls.unlock++;
      },
    },
  };
}

test("update(true) locks once; a second update(true) does not lock again", async () => {
  const d = deps();
  const lock = createKeyboardLock(d.deps);
  lock.update(true);
  lock.update(true);
  d.grant();
  await tick();
  lock.update(true);
  assert.equal(d.calls.lock, 1);
  assert.equal(lock.locked, true);
});

test("update(false) after a lock unlocks; before a lock it does nothing", async () => {
  const d = deps();
  const lock = createKeyboardLock(d.deps);
  lock.update(false);
  assert.equal(d.calls.unlock, 0);
  lock.update(true);
  d.grant();
  await tick();
  lock.update(false);
  lock.update(false);
  assert.deepEqual(d.calls, { lock: 1, unlock: 1 });
  assert.equal(lock.locked, false);
});

test("a rejecting lock() leaves locked false, silently, and a later update(false) does not unlock", async () => {
  const d = deps({ reject: true });
  const lock = createKeyboardLock(d.deps);
  lock.update(true);
  await tick();
  assert.equal(lock.locked, false);
  lock.update(false);
  assert.equal(d.calls.unlock, 0);
  lock.update(true); // a later wish tries again
  await tick();
  assert.equal(d.calls.lock, 2);
});

test("a lock() that throws synchronously is the same as a refusal", () => {
  const lock = createKeyboardLock({
    lock: () => {
      throw new Error("no keyboard");
    },
    unlock() {},
  });
  lock.update(true);
  assert.equal(lock.locked, false);
});

test("a lock granted after update(false) is released at once and never leaks", async () => {
  const d = deps();
  const lock = createKeyboardLock(d.deps);
  lock.update(true);
  lock.update(false);
  d.grant();
  await tick();
  assert.deepEqual(d.calls, { lock: 1, unlock: 1 });
  assert.equal(lock.locked, false);
});

test("a wish that comes back while the lock is being granted is kept", async () => {
  const d = deps();
  const lock = createKeyboardLock(d.deps);
  lock.update(true);
  lock.update(false);
  lock.update(true);
  d.grant();
  await tick();
  assert.deepEqual(d.calls, { lock: 1, unlock: 0 });
  assert.equal(lock.locked, true);
});

test("isLockedF11 is true only for F11 while locked", () => {
  assert.equal(isLockedF11({ key: "F11" }, true), true);
  assert.equal(isLockedF11({ key: "F1" }, true), false);
  assert.equal(isLockedF11({ key: "F11" }, false), false);
});
