// The keyboard lock of the desktop app: while a remote session is open in HTML full
// screen, navigator.keyboard.lock() sends the system's keys (Windows key, Alt+Tab, ...) to
// the page, so they reach the remote computer instead of this one. Chromium offers the
// lock only in full screen, and the user keeps hold-Escape as the way out.
export interface KeyboardLockDeps {
  lock(): Promise<void>;
  unlock(): void;
}

export function createKeyboardLock(deps: KeyboardLockDeps) {
  let locked = false;
  let pending = false;
  let want = false;
  const take = () => {
    pending = true;
    let request: Promise<void>;
    try {
      request = deps.lock();
    } catch {
      pending = false;
      return;
    }
    request.then(
      () => {
        pending = false;
        // The wish may have gone while the lock was being granted: give it back at once.
        if (want) locked = true;
        else deps.unlock();
      },
      () => {
        // Refused (or no such API): the session simply runs without the lock.
        pending = false;
      },
    );
  };
  return {
    update(wanted: boolean) {
      want = wanted;
      if (wanted) {
        if (!locked && !pending) take();
      } else if (locked) {
        locked = false;
        deps.unlock();
      }
    },
    get locked() {
      return locked;
    },
  };
}

// While the lock is held the page receives F11 (the app's main process does not), and
// F11 has to leave full screen by the page's own hand.
export function isLockedF11(event: { key: string }, locked: boolean) {
  return locked && event.key === "F11";
}
