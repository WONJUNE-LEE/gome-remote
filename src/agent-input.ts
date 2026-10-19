// The pure parts of the agent session's input (spec D4), free of the DOM so they can be
// tested directly: where the picture is on screen, how a pointer position becomes 0..1
// coordinates, how a wheel event becomes pixels, how text is cut into messages, and the
// exact shape of every message on the `input` data channel.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface VideoSize {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

// Where `object-fit: contain` draws the picture inside its element. Undefined while the
// video has no size yet.
export function contentRect(box: Rect, video: VideoSize): Rect | undefined {
  if (!(video.width > 0) || !(video.height > 0)) return undefined;
  if (!(box.width > 0) || !(box.height > 0)) return undefined;
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

const unit = (value: number) => Math.min(1, Math.max(0, value));
const short = (value: number) => Math.round(value * 1e5) / 1e5;

// A pointer position as fractions of the *picture*, not of the element: the black bars of a
// letterboxed video are not part of the Mac's screen. With `clamp` a position in a bar
// becomes the nearest edge of the picture (a drag that leaves the picture keeps working);
// without it a position outside the picture is undefined (a press there is not a click on
// the Mac's edge).
export function normalise(
  clientX: number,
  clientY: number,
  box: Rect,
  video: VideoSize,
  clamp: boolean,
): Point | undefined {
  const content = contentRect(box, video);
  if (!content || !Number.isFinite(clientX) || !Number.isFinite(clientY))
    return undefined;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return undefined;
  return { x: short(unit(x)), y: short(unit(y)) };
}

// The agent cuts larger values to this as well; cutting here keeps the message honest.
export const MAX_WHEEL = 2000;
const LINE_PIXELS = 16;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number; // 0 pixels, 1 lines, 2 pages
}
export function wheelDelta(event: WheelLike, pageHeight: number): Point {
  const factor =
    event.deltaMode === 1
      ? LINE_PIXELS
      : event.deltaMode === 2
        ? pageHeight
        : 1;
  const cut = (value: number) =>
    Number.isFinite(value)
      ? Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, Math.round(value * factor)))
      : 0;
  return { x: cut(event.deltaX), y: cut(event.deltaY) };
}

// `KeyboardEvent.code` as the agent's key table knows it. Some browsers report the Korean
// Hangul key by `key` ("HangulMode") with a different or empty `code`.
export function keyCode(event: {
  code: string;
  key: string;
}): string | undefined {
  if (event.key === "HangulMode") return "Lang1";
  return event.code && event.code !== "Unidentified" ? event.code : undefined;
}

// The agent refuses a data channel message over 8 KiB; stay a little under it.
export const MAX_TEXT_MESSAGE_BYTES = 8000;
// `{"type":"text","s":""}`: what a text message costs with nothing in it.
const TEXT_OVERHEAD_BYTES = 22;

// A lone surrogate cannot be sent: JSON.stringify writes it as a `\udXXX` escape, which the
// agent's JSON parser rejects, and the whole piece would be lost. U+FFFD stands in.
export function wellFormed(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(i, i + 2);
        i += 1;
      } else out += "�";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) out += "�";
    else out += text[i];
  }
  return out;
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

// UTF-8 bytes of one code point once JSON.stringify has escaped it.
function jsonBytes(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2; // \" \\
  if (code < 0x20)
    return code === 8 || code === 9 || code === 10 || code === 12 || code === 13
      ? 2 // \b \t \n \f \r
      : 6; // \u00XX
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

// Cuts text into pieces of at most `max` UTF-16 units whose JSON-encoded message is at most
// MAX_TEXT_MESSAGE_BYTES, never splitting a surrogate pair or a CR LF pair (a line break
// reaches the Mac as one Return). Lone surrogates are replaced with U+FFFD first. A piece
// always holds at least one code point, so a limit too small for one still makes progress.
export function splitText(text: string, max = 2000): string[] {
  const clean = wellFormed(text);
  const budget = MAX_TEXT_MESSAGE_BYTES - TEXT_OVERHEAD_BYTES;
  const pieces: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = start;
    let bytes = 0;
    while (end < clean.length) {
      const code = clean.codePointAt(end)!;
      const units = code > 0xffff ? 2 : 1;
      const cost = jsonBytes(code);
      if (end > start && (end + units - start > max || bytes + cost > budget))
        break;
      end += units;
      bytes += cost;
    }
    // Would end between CR and LF: the CR goes to the next piece with its LF.
    if (
      end < clean.length &&
      end - 1 > start &&
      clean.charCodeAt(end - 1) === 0x0d &&
      clean.charCodeAt(end) === 0x0a
    )
      end -= 1;
    pieces.push(clean.slice(start, end));
    start = end;
  }
  return pieces;
}

// The wire format (agent/mac, src/protocol.rs). Buttons follow MouseEvent.button.
export const message = {
  pointer: (p: Point) => JSON.stringify({ type: "pointer", x: p.x, y: p.y }),
  button: (b: number, down: boolean, p: Point) =>
    JSON.stringify({ type: "button", b, down, x: p.x, y: p.y }),
  wheel: (d: Point) => JSON.stringify({ type: "wheel", dx: d.x, dy: d.y }),
  key: (code: string, down: boolean) =>
    JSON.stringify({ type: "key", code, down }),
  text: (s: string) => JSON.stringify({ type: "text", s }),
  release: () => JSON.stringify({ type: "release" }),
  size: (w: number, h: number) => JSON.stringify({ type: "size", w, h }),
  clipboard: (text: string, concealed: boolean) =>
    JSON.stringify({ type: "clipboard", text, concealed }),
  clipboardWatch: (on: boolean) =>
    JSON.stringify({ type: "clipboard-watch", on }),
};

// Clipboard limits, the same as agent/mac/src/protocol.rs: 64 KiB of UTF-8 text, and the
// whole encoded message at most 256 KiB (the data channel's limit; JSON escaping can make
// control characters take up to six times their size).
export const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024;
export const MAX_CLIPBOARD_MESSAGE_BYTES = 256 * 1024;

// What the agent may send back over the same channel. Only `replaced`: another device took
// the session over and the agent is about to close this connection. Anything else (other
// types, binary data, malformed text) is ignored.
export type Notice = "replaced";
export function parseNotice(data: unknown): Notice | undefined {
  if (typeof data !== "string" || data.length > 256) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    const type = (value as { type?: unknown } | null)?.type;
    return type === "replaced" ? type : undefined;
  } catch {
    return undefined;
  }
}

// Every message the agent may send back, text frames only. A message that is malformed,
// unknown, binary or too long is `undefined`: dropped, never guessed at.
export type SkipReason =
  "too-large" | "read-denied" | "locked-multiline" | "locked-empty";
export type AgentMessage =
  | { type: "replaced" }
  | { type: "lock"; locked: boolean }
  | { type: "clipboard"; text: string; concealed: boolean }
  | { type: "clipboard-skipped"; reason: SkipReason };
const SKIP_REASONS: readonly string[] = [
  "too-large",
  "read-denied",
  "locked-multiline",
  "locked-empty",
];
export function parseAgentMessage(data: unknown): AgentMessage | undefined {
  // `length` counts UTF-16 units: a cheap upper bound on the bytes, checked before parsing.
  if (typeof data !== "string" || data.length > MAX_CLIPBOARD_MESSAGE_BYTES)
    return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const m = value as Record<string, unknown>;
  if (m.type === "clipboard") {
    if (typeof m.text !== "string" || typeof m.concealed !== "boolean")
      return undefined;
    return { type: "clipboard", text: m.text, concealed: m.concealed };
  }
  if (data.length > 256) return undefined;
  if (m.type === "replaced") return { type: "replaced" };
  if (m.type === "lock")
    return typeof m.locked === "boolean"
      ? { type: "lock", locked: m.locked }
      : undefined;
  if (m.type === "clipboard-skipped")
    return typeof m.reason === "string" && SKIP_REASONS.includes(m.reason)
      ? { type: "clipboard-skipped", reason: m.reason as SkipReason }
      : undefined;
  return undefined;
}

// The codecs the page offers, in order: H.264 only (the Mac encodes in hardware), with
// the constrained-baseline, packetization-mode 1 variants first, and `video/rtx` KEPT.
// Without RTX the agent cannot answer a NACK and every lost packet waits for a keyframe
// (about one second of freeze); the spike lost that to a filter that only kept H.264.
export interface CodecLike {
  mimeType: string;
  sdpFmtpLine?: string;
}
export function preferredCodecs<T extends CodecLike>(all: readonly T[]): T[] {
  const kind = (codec: T) => codec.mimeType.toLowerCase();
  const rank = (codec: T) => {
    if (kind(codec) === "video/rtx") return 0;
    const fmtp = codec.sdpFmtpLine ?? "";
    const baseline = /profile-level-id=42e01f/i.test(fmtp);
    const mode1 = /packetization-mode=1/.test(fmtp);
    return baseline && mode1 ? 3 : baseline ? 2 : 1;
  };
  return all
    .filter((codec) => ["video/h264", "video/rtx"].includes(kind(codec)))
    .map((codec, index) => ({ codec, index }))
    .sort((a, b) => rank(b.codec) - rank(a.codec) || a.index - b.index)
    .map(({ codec }) => codec);
}
