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

// Cuts text into pieces of at most `max` UTF-16 units that never split a surrogate pair
// or a CR LF pair, so every message stays far below the agent's 8 KiB limit (4 bytes per
// pair at worst) and a line break reaches the Mac as one Return.
export function splitText(text: string, max = 2000): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const splitsPair =
        (last >= 0xd800 && last <= 0xdbff) || // would end on a high surrogate
        (last === 0x0d && text.charCodeAt(end) === 0x0a); // would end between CR and LF
      // A limit too small to hold the pair at all cuts it rather than looping forever.
      if (splitsPair && end - 1 > start) end -= 1;
    }
    pieces.push(text.slice(start, end));
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
};

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
