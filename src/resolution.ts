// The resolution decisions of the viewer, free of the DOM so they can be tested
// directly: what size "자동 (창 크기)" means, and when a new size is sent to the remote.

export const AUTO = "auto";
// The gateway refuses anything outside these (server/gateway.js).
export const LIMITS = {
  minWidth: 640,
  maxWidth: 3840,
  minHeight: 480,
  maxHeight: 2160,
};
// How long the window must stay still before an automatic size is sent.
export const RESIZE_DELAY_MS = 300;

export interface Size {
  width: number;
  height: number;
}
// The viewer element's size in CSS pixels and the device pixel ratio of its window.
export interface Viewport extends Size {
  ratio: number;
}

// Rounds down to an even integer, then clamps. The limits are even themselves.
function fit(value: number, min: number, max: number) {
  const whole = Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.min(max, Math.max(min, whole - (whole % 2)));
}
export function autoSize(viewport: Viewport): Size {
  const ratio = viewport.ratio > 0 ? viewport.ratio : 1;
  return {
    width: fit(viewport.width * ratio, LIMITS.minWidth, LIMITS.maxWidth),
    height: fit(viewport.height * ratio, LIMITS.minHeight, LIMITS.maxHeight),
  };
}
// `choice` is the value of the resolution picker: "auto" or a fixed "1920x1080".
export function sizeFor(choice: string, viewport: Viewport): Size {
  if (choice === AUTO) return autoSize(viewport);
  const [width, height] = choice.split("x").map(Number);
  return { width, height };
}

export interface ResolutionEffects {
  // Asks the remote to change its size (client.sendSize).
  send(size: Size): void;
  viewport(): Viewport;
  // Default to the global timers. They only debounce a resize; nothing here
  // starts a connection.
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

// One session at a time: begin() when a connection starts, connected() once the remote
// is up, stopped() when it is gone. Only a session that can resize (RDP) ever sends;
// macOS ignores resize requests from non-Apple clients, so VNC never does.
export function createResolution(effects: ResolutionEffects) {
  const setTimer =
    effects.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    effects.clearTimer ?? ((handle) => clearTimeout(handle as number));
  let choice = AUTO;
  let canResize = false;
  let live = false;
  let sent: Size | undefined;
  let timer: unknown;
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const send = (size: Size) => {
    sent = size;
    if (canResize) effects.send(size);
  };
  const settle = () => {
    timer = undefined;
    if (!live || choice !== AUTO) return;
    const size = autoSize(effects.viewport());
    if (sent && sent.width === size.width && sent.height === size.height)
      return;
    send(size);
  };
  const schedule = () => {
    cancel();
    if (live && canResize && choice === AUTO)
      timer = setTimer(settle, RESIZE_DELAY_MS);
  };
  return {
    get choice() {
      return choice;
    },
    // The picker changed. Returns the size the choice stands for. A fixed size is
    // sent once; auto sends the current auto size, and follows the window from then on.
    choose(value: string): Size {
      choice = value;
      cancel();
      const size = sizeFor(choice, effects.viewport());
      if (live) send(size);
      return size;
    },
    // A connection starts with `size` (what the session was created with).
    begin(size: Size, resizable: boolean) {
      cancel();
      live = false;
      canResize = resizable;
      sent = size;
    },
    // The remote is up. The window may have changed while connecting.
    connected() {
      live = true;
      schedule();
    },
    stopped() {
      live = false;
      cancel();
    },
    // The viewer element changed size.
    viewportChanged() {
      schedule();
    },
  };
}
