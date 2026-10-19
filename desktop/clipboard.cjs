// Clipboard access for the page, behind two focus-guarded IPC calls. The main process is
// the only place Electron's clipboard exists (it is async-only and main-process-only), so
// the page asks here. Refusals are results, not throws; only an invalid argument throws.
// Nothing here ever logs clipboard text: a log line carries a reason and a byte length.

const MAX_BYTES = 64 * 1024;
const EXCLUDE_TYPE =
  'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
const HISTORY_TYPE =
  'electron application/osclipboard;format="CanIncludeInClipboardHistory"';

function createClipboardService({
  clipboard,
  ClipboardItem,
  Blob,
  platform,
  isFocused,
  log = () => {},
}) {
  const focused = () => {
    try {
      return isFocused() === true;
    } catch {
      return false;
    }
  };

  // Windows clipboard managers skip an entry that carries the exclusion format or that
  // sets CanIncludeInClipboardHistory to DWORD 0. Any failure to find out means "not
  // concealed": the mark only ever lowers what is shared, never raises it.
  async function isConcealed() {
    try {
      if (await clipboard.has(EXCLUDE_TYPE)) return true;
    } catch {
      // not concealed
    }
    try {
      for (const item of await clipboard.read()) {
        if (!item.types.includes(HISTORY_TYPE)) continue;
        const bytes = new DataView(
          await (await item.getType(HISTORY_TYPE)).arrayBuffer(),
        );
        if (bytes.byteLength >= 4 && bytes.getUint32(0, true) === 0)
          return true;
      }
    } catch {
      // not concealed
    }
    return false;
  }

  async function read() {
    if (!focused()) return { ok: false, reason: "unfocused" };
    let text;
    try {
      text = await clipboard.readText();
    } catch {
      log("[clipboard] read failed");
      return { ok: false, reason: "failed" };
    }
    if (typeof text !== "string" || text === "")
      return { ok: true, text: "", concealed: false };
    return { ok: true, text, concealed: await isConcealed() };
  }

  async function write(text, opts) {
    if (typeof text !== "string" || !validOptions(opts))
      throw new Error("Invalid clipboard text.");
    if (!focused()) return { ok: false, reason: "unfocused" };
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_BYTES) {
      log(`[clipboard] write refused: too-large, ${bytes} bytes`);
      return { ok: false, reason: "too-large" };
    }
    const windows = platform === "win32";
    // Windows text uses CRLF; the page and the agent keep LF.
    const out = windows ? text.replace(/\r\n?|\n/g, "\r\n") : text;
    try {
      if (windows && opts?.concealed === true) {
        try {
          await clipboard.write([
            new ClipboardItem({
              "text/plain": out,
              [EXCLUDE_TYPE]: new Blob([new Uint8Array(4)]),
            }),
          ]);
          return { ok: true, concealed: true };
        } catch {
          log("[clipboard] concealed mark dropped");
        }
      }
      await clipboard.writeText(out);
      return { ok: true, concealed: false };
    } catch {
      log(`[clipboard] write failed, ${bytes} bytes`);
      return { ok: false, reason: "failed" };
    }
  }

  return { read, write };
}

// `opts` is absent or a plain object whose only member is an optional boolean `concealed`.
function validOptions(opts) {
  if (opts === undefined) return true;
  if (opts === null || typeof opts !== "object") return false;
  const proto = Object.getPrototypeOf(opts);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(opts);
  return (
    keys.every((key) => key === "concealed") &&
    (opts.concealed === undefined || typeof opts.concealed === "boolean")
  );
}

module.exports = { createClipboardService, MAX_BYTES };
