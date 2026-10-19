// The Windows key lock of the desktop app (Windows only; main decides, the bridge tells the
// page). While a remote session is shown and the window is focused, the page keeps its
// document in HTML full screen (in-window: the app sets disableHtmlFullscreenWindowResize)
// and holds navigator.keyboard.lock(), so the system's keys (Windows key, Alt+Tab, ...) go
// to the remote computer. Chromium offers the lock only in HTML full screen, and the user
// keeps hold-Escape (about 1.5 s) as the way out.
export const KEY_LOCK_NOTICE = {
  "key-lock-on": "Windows 키가 Mac으로 갑니다 · Esc를 길게 누르면 풀립니다",
  "key-lock-released": "키 잡기를 풀었습니다 · 화면을 클릭하면 다시 잡습니다",
} as const;
export type KeyLockNotice = keyof typeof KEY_LOCK_NOTICE;

// How long keyboard.lock() may take after HTML full screen was entered. An unlocked HTML
// full screen would turn an Escape tap into "leave full screen" instead of a remote key.
export const KEY_LOCK_MS = 2000;

export interface KeyLockDeps {
  supported: boolean;
  enterHtml(): Promise<boolean>;
  exitHtml(): Promise<boolean>;
  lock(): Promise<void>;
  unlock(): void;
  isHtmlFullscreen(): boolean;
  notify(key: KeyLockNotice): void;
  log(reason: string): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export function createKeyLock(deps: KeyLockDeps) {
  let session = false;
  let focused = false;
  let releasedByUser = false; // hold-Escape: no re-take until a click or a new focus
  let failed = false; // refused or timed out: no retry until a click or a new focus
  let clickRetried = false; // a click retries a refusal once; a focus change clears this
  let held = false;
  let taking = false; // enterHtml sent and not yet resolved into held / failed
  let busy = false; // one enter or exit in flight at a time
  let lostWhileTaking = false;
  let notified = false;
  let epoch = 0;

  const wanted = () =>
    deps.supported && session && focused && !releasedByUser && !failed;

  const guardedLock = () =>
    new Promise<"ok" | "refused" | "timeout">((resolve) => {
      let done = false;
      const finish = (result: "ok" | "refused" | "timeout") => {
        if (done) return;
        done = true;
        deps.clearTimeout(timer);
        resolve(result);
      };
      const timer = deps.setTimeout(() => finish("timeout"), KEY_LOCK_MS);
      try {
        deps.lock().then(
          () => finish("ok"),
          () => finish("refused"),
        );
      } catch {
        finish("refused");
      }
    });
  const safely = (call: () => Promise<boolean>) =>
    new Promise<boolean>((resolve) => {
      try {
        call().then(resolve, () => resolve(false));
      } catch {
        resolve(false);
      }
    });

  function settle() {
    busy = false;
    evaluate();
  }
  function fail(reason: string, mine = epoch) {
    taking = false;
    if (mine === epoch) failed = true;
    deps.log(reason);
    deps.unlock();
    void safely(deps.exitHtml).then(settle);
  }
  function take() {
    busy = true;
    taking = true;
    lostWhileTaking = false;
    const mine = epoch;
    void safely(deps.enterHtml).then(async (entered) => {
      if (!entered) return fail("html-full-screen-refused", mine);
      const result = await guardedLock();
      if (result !== "ok") return fail(`key-lock-${result}`, mine);
      taking = false;
      if (lostWhileTaking || !deps.isHtmlFullscreen()) {
        // Hold-Escape (or a page that left full screen) while the lock was being granted.
        lostWhileTaking = false;
        deps.unlock();
        // A session that ended meanwhile must not leave its latch to the next one.
        if (mine === epoch) {
          releasedByUser = true;
          deps.notify("key-lock-released");
        }
        return settle();
      }
      held = true;
      clickRetried = false;
      if (mine === epoch && !notified) {
        notified = true;
        deps.notify("key-lock-on");
      }
      settle();
    });
  }
  function release() {
    busy = true;
    held = false;
    deps.unlock();
    void safely(deps.exitHtml).then(settle);
  }
  function evaluate() {
    if (busy) return;
    if (wanted()) {
      if (!held) take();
    } else if (held) release();
  }

  return {
    update(want: { session: boolean; focused: boolean }) {
      if (!focused || !want.focused) {
        // Losing or gaining the focus is a new chance after hold-Escape or a refusal.
        releasedByUser = false;
        failed = false;
        clickRetried = false;
      }
      session = want.session;
      focused = want.focused;
      evaluate();
    },
    // A click on the remote view: take the lock again after hold-Escape, and retry a
    // refusal once (a refusal that repeats would flicker through full screen on every
    // click); the next focus change allows one more retry.
    click() {
      releasedByUser = false;
      if (failed && !clickRetried) {
        clickRetried = true;
        failed = false;
      }
      evaluate();
    },
    // The document's fullscreenchange. With no full screen element while the lock is held
    // (or being granted) and not because of our own exit, the user held Escape.
    fullscreenChanged() {
      if (deps.isHtmlFullscreen()) return;
      if (taking) {
        lostWhileTaking = true;
        return;
      }
      if (!held) return;
      held = false;
      releasedByUser = true;
      deps.unlock();
      deps.notify("key-lock-released");
      evaluate();
    },
    end() {
      epoch++;
      session = false;
      releasedByUser = false;
      failed = false;
      clickRetried = false;
      notified = false;
      evaluate();
    },
    get held() {
      return held;
    },
  };
}
