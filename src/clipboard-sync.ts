// The page's clipboard sync rules, with no DOM and no timers of its own: the local
// clipboard, the remote channel and the timers are injected. It decides when the local
// clipboard text goes to the remote computer (on focus gain and at a paste key), holds the
// paste key and everything after it until that text is sent (the paste barrier), and
// writes remote text to the local clipboard. Clipboard text is never logged.
import type { SkipReason } from "./agent-input";

export const MAX_CLIPBOARD_BYTES = 64 * 1024;
export const PASTE_BARRIER_MS = 500;
export const FOCUS_RETRY_MS = 150;

export type NoticeKey =
  SkipReason | "bridge-refused" | "read-timeout" | "unsupported-chars";

export const NOTICE_TEXT: Record<NoticeKey, string> = {
  "too-large": "클립보드가 너무 커서(64 KiB 초과) 보내지 못했습니다",
  "read-denied": "Mac이 클립보드 읽기를 허용하지 않았습니다",
  "locked-multiline": "잠금 화면에는 여러 줄을 붙여넣을 수 없습니다",
  "locked-empty": "입력할 텍스트가 없습니다",
  "bridge-refused": "클립보드에 접근하지 못했습니다",
  "read-timeout": "클립보드를 제때 읽지 못했습니다",
  "unsupported-chars": "이 화면은 한글 같은 문자를 붙여넣을 수 없습니다",
};

export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// UTF-8 length without TextEncoder; a lone surrogate counts as the 3 bytes of U+FFFD.
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export interface PasteKeyEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isPasteShortcut(
  e: PasteKeyEvent,
  target: "mac" | "other",
): boolean {
  const v = e.code === "KeyV" || e.key.toLowerCase() === "v";
  if (target === "mac") return v && e.metaKey && !e.ctrlKey && !e.altKey;
  if (v) return e.ctrlKey && !e.metaKey && !e.altKey;
  const insert = e.code === "Insert" || e.key === "Insert";
  return insert && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export type LocalResult =
  | { ok: true; text: string; concealed: boolean }
  | { ok: false; reason: "unfocused" | "failed" | "denied" };
export interface LocalClipboard {
  read(): Promise<LocalResult>;
  write(
    text: string,
    concealed: boolean,
  ): Promise<
    { ok: true } | { ok: false; reason: "unfocused" | "failed" | "denied" }
  >;
}
export interface RemoteClipboard {
  sendClipboard(
    text: string,
    concealed: boolean,
  ): "sent" | "too-large" | "closed";
  sendWatch?(on: boolean): void;
}
export interface SyncDeps {
  local: LocalClipboard;
  remote: RemoteClipboard;
  target: "mac" | "other";
  notify(key: NoticeKey): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  latin1Only?: boolean;
}
export interface ClipboardSync {
  setViewFocused(focused: boolean): void;
  setRemoteLocked(locked: boolean): void;
  remoteClipboard(text: string, concealed: boolean): void;
  remoteSkipped(reason: SkipReason): void;
  pasteShortcut(event: PasteKeyEvent): void;
  pasteFromMenu(press: () => void): void;
  gate(run: () => void): void;
  flush(): void;
  invalidate(): void;
  end(): void;
}

interface Flight {
  kind: "focus" | "paste";
  retried: boolean;
  // remoteClipboard() calls seen when the read began; a focus read that a newer remote
  // text overtook is stale and must not be sent back.
  epoch: number;
}
type Timer = ReturnType<typeof setTimeout>;

export function createClipboardSync(deps: SyncDeps): ClipboardSync {
  const { local, remote } = deps;
  let focused = false;
  let locked = false;
  // The normalised text last sent to or received from the remote computer.
  let lastSynced: string | undefined;
  // The refusal a focus trigger already told the user about, so one text is not repeated.
  let refused: string | undefined;
  let epoch = 0;
  // At most one read is in flight. A trigger waits in `queue` and re-reads when its turn
  // comes, so texts are sent in trigger order.
  let flight: Flight | undefined;
  let queue: Array<{ kind: "focus" | "paste"; retried: boolean }> = [];
  let barrier = false;
  let barrierTimer: Timer | undefined;
  let held: Array<() => void> = [];
  const retryTimers = new Set<Timer>();

  const refuse = (key: NoticeKey, text: string, paste: boolean) => {
    if (!paste) {
      const mark = `${key}\0${text}`;
      if (refused === mark) return;
      refused = mark;
    }
    deps.notify(key);
  };

  const handle = (read: Flight, result: LocalResult) => {
    const paste = read.kind === "paste";
    if (!result.ok) {
      if (paste) {
        if (result.reason !== "denied") deps.notify("bridge-refused");
      } else if (result.reason === "unfocused" && !read.retried) {
        const id = deps.setTimeout(() => {
          retryTimers.delete(id);
          if (!focused) return;
          queue.push({ kind: "focus", retried: true });
          pump();
        }, FOCUS_RETRY_MS);
        retryTimers.add(id);
      }
      return;
    }
    if (!paste && read.epoch !== epoch) return;
    const text = normaliseNewlines(result.text);
    if (text === "") return;
    if (text === lastSynced && !(paste && locked)) return;
    if (deps.latin1Only && /[^\u0000-ÿ]/.test(text))
      return refuse("unsupported-chars", text, paste);
    if (utf8Length(text) > MAX_CLIPBOARD_BYTES)
      return refuse("too-large", text, paste);
    const sent = remote.sendClipboard(text, result.concealed);
    if (sent === "sent") lastSynced = text;
    else if (sent === "too-large") refuse("too-large", text, paste);
  };

  const settle = (mine: Flight, result: LocalResult) => {
    if (flight !== mine) return; // abandoned: timed out, focus lost or ended
    flight = undefined;
    try {
      handle(mine, result);
    } finally {
      if (mine.kind === "paste") closeBarrier();
      pump();
    }
  };

  function pump() {
    if (flight || queue.length === 0) return;
    const trigger = queue.shift()!;
    const mine: Flight = { ...trigger, epoch };
    flight = mine;
    let read: Promise<LocalResult>;
    try {
      read = Promise.resolve(local.read());
    } catch {
      read = Promise.resolve({ ok: false, reason: "failed" });
    }
    read.then(
      (result) => settle(mine, result),
      () => settle(mine, { ok: false, reason: "failed" }),
    );
  }

  // Releases the held items in order. A read still pending for the barrier is abandoned:
  // its late result is ignored and never marks anything synced.
  function closeBarrier() {
    if (barrierTimer !== undefined) deps.clearTimeout(barrierTimer);
    barrierTimer = undefined;
    barrier = false;
    queue = queue.filter((t) => t.kind !== "paste");
    if (flight?.kind === "paste") flight = undefined;
    const run = held;
    held = [];
    // One failing item (a send on a closed channel) must not lose the ones after it, such
    // as a key-up, nor skip the next read.
    for (const item of run) {
      try {
        item();
      } catch {
        // dropped: nothing about the item may be logged
      }
    }
    pump();
  }

  function openBarrier() {
    if (!focused || barrier) return;
    barrier = true;
    barrierTimer = deps.setTimeout(() => {
      barrierTimer = undefined;
      if (!barrier) return;
      // Whatever read is in flight (even a focus read stuck behind a permission prompt)
      // is abandoned, so the next paste reads afresh.
      flight = undefined;
      closeBarrier();
      deps.notify("read-timeout");
    }, PASTE_BARRIER_MS);
    queue.push({ kind: "paste", retried: false });
    pump();
  }

  const gate = (run: () => void) => {
    if (barrier) held.push(run);
    else run();
  };

  const clearRetries = () => {
    for (const id of retryTimers) deps.clearTimeout(id);
    retryTimers.clear();
  };

  return {
    setViewFocused(next) {
      if (next === focused) return;
      focused = next;
      remote.sendWatch?.(next);
      if (next) {
        queue.push({ kind: "focus", retried: false });
        pump();
        return;
      }
      clearRetries();
      queue = [];
      flight = undefined;
      // Keys held for a paste go out without the text: the user is told.
      const pasting = barrier;
      closeBarrier();
      if (pasting) deps.notify("read-timeout");
    },
    setRemoteLocked(next) {
      if (next === locked) return;
      locked = next;
      lastSynced = undefined;
      refused = undefined;
    },
    remoteClipboard(text, concealed) {
      if (!focused) return;
      const normalised = normaliseNewlines(text);
      if (normalised === "") return;
      epoch++;
      const before = lastSynced;
      lastSynced = normalised;
      const failed = () => {
        if (lastSynced === normalised) lastSynced = before;
      };
      let write: Promise<{ ok: boolean }>;
      try {
        write = Promise.resolve(local.write(normalised, concealed));
      } catch {
        failed();
        return;
      }
      write.then((r) => {
        if (!r.ok) failed();
      }, failed);
    },
    remoteSkipped(reason) {
      deps.notify(reason);
    },
    pasteShortcut(event) {
      if (isPasteShortcut(event, deps.target)) openBarrier();
    },
    pasteFromMenu(press) {
      openBarrier();
      gate(press);
    },
    gate,
    flush() {
      closeBarrier();
    },
    invalidate() {
      lastSynced = undefined;
      refused = undefined;
    },
    end() {
      closeBarrier();
      clearRetries();
      queue = [];
      flight = undefined;
      focused = false;
      locked = false;
      lastSynced = undefined;
      refused = undefined;
    },
  };
}
