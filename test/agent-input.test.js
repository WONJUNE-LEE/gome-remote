import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const {
  contentRect,
  normalise,
  wheelDelta,
  keyCode,
  splitText,
  message,
  preferredCodecs,
  MAX_WHEEL,
} = await loadTs("agent-input.ts");

const wide = { left: 10, top: 20, width: 1000, height: 1000 }; // a square element
const video = { width: 1920, height: 1080 }; // a 16:9 picture

test("the picture is centred in its element with bars above and below (letterbox)", () => {
  const rect = plain(contentRect(wide, video));
  assert.ok(Math.abs(rect.width - 1000) < 1e-9);
  assert.ok(Math.abs(rect.height - 562.5) < 1e-9);
  assert.ok(Math.abs(rect.left - 10) < 1e-9);
  assert.ok(Math.abs(rect.top - (20 + (1000 - 562.5) / 2)) < 1e-9);
});

test("a tall picture gets bars at the sides (pillarbox) and an exact fit gets none", () => {
  const rect = plain(
    contentRect(
      { left: 0, top: 0, width: 1600, height: 900 },
      { width: 900, height: 900 },
    ),
  );
  assert.deepEqual(rect, { left: 350, top: 0, width: 900, height: 900 });
  assert.deepEqual(
    plain(contentRect({ left: 5, top: 6, width: 1920, height: 1080 }, video)),
    { left: 5, top: 6, width: 1920, height: 1080 },
  );
});

test("an element or video without a size has no picture", () => {
  for (const [box, size] of [
    [wide, { width: 0, height: 0 }],
    [wide, { width: 1920, height: 0 }],
    [{ ...wide, width: 0 }, video],
    [{ ...wide, height: NaN }, video],
  ])
    assert.equal(contentRect(box, size), undefined);
});

test("positions are fractions of the picture, not of the element", () => {
  const rect = contentRect(wide, video);
  const middle = plain(
    normalise(10 + 500, rect.top + rect.height / 2, wide, video, true),
  );
  assert.deepEqual(middle, { x: 0.5, y: 0.5 });
  const corner = plain(normalise(rect.left, rect.top, wide, video, true));
  assert.deepEqual(corner, { x: 0, y: 0 });
  const far = plain(
    normalise(
      rect.left + rect.width,
      rect.top + rect.height,
      wide,
      video,
      true,
    ),
  );
  assert.deepEqual(far, { x: 1, y: 1 });
  const quarter = plain(
    normalise(
      rect.left + rect.width / 4,
      rect.top + rect.height * 0.75,
      wide,
      video,
      false,
    ),
  );
  assert.deepEqual(quarter, { x: 0.25, y: 0.75 });
});

// Review Focus 1: a window whose shape differs from the Mac's screen has black bars.
test("a position in a bar is clamped to the picture's edge, or refused when clamping is off", () => {
  const rect = contentRect(wide, video);
  const inTopBar = (clamp) => normalise(500, rect.top - 30, wide, video, clamp);
  assert.deepEqual(plain(inTopBar(true)), { x: 0.49, y: 0 });
  assert.equal(inTopBar(false), undefined);
  const inBottomBar = (clamp) =>
    normalise(500, rect.top + rect.height + 30, wide, video, clamp);
  assert.equal(plain(inBottomBar(true)).y, 1);
  assert.equal(inBottomBar(false), undefined);
  assert.deepEqual(plain(normalise(-500, 5000, wide, video, true)), {
    x: 0,
    y: 1,
  });
  assert.equal(normalise(NaN, 10, wide, video, true), undefined);
  assert.equal(normalise(Infinity, 10, wide, video, true), undefined);
  assert.equal(normalise(5, 5, wide, { width: 0, height: 0 }, true), undefined);
});

test("coordinates carry at most five decimals", () => {
  const rect = contentRect(wide, video);
  const p = normalise(
    rect.left + rect.width / 3,
    rect.top + rect.height / 3,
    wide,
    video,
    true,
  );
  assert.equal(p.x, 0.33333);
  assert.equal(p.y, 0.33333);
});

test("wheel deltas are pixels; lines and pages are converted, and everything is cut to 2000", () => {
  assert.deepEqual(
    plain(wheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 900)),
    { x: 0, y: 100 },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: 1, deltaY: -3, deltaMode: 1 }, 900)),
    { x: 16, y: -48 },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 900)),
    { x: 0, y: 900 },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: 0, deltaY: 5, deltaMode: 2 }, 900)),
    { x: 0, y: MAX_WHEEL },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: -1e9, deltaY: 1e9, deltaMode: 0 }, 900)),
    { x: -MAX_WHEEL, y: MAX_WHEEL },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: NaN, deltaY: 0.4, deltaMode: 0 }, 900)),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    plain(wheelDelta({ deltaX: 0, deltaY: 0.6, deltaMode: 0 }, 900)),
    { x: 0, y: 1 },
  );
});

test("the Hangul key is Lang1 whichever way the browser names it; unnamed keys are not sent", () => {
  assert.equal(keyCode({ code: "KeyA", key: "a" }), "KeyA");
  assert.equal(keyCode({ code: "Lang1", key: "HangulMode" }), "Lang1");
  assert.equal(keyCode({ code: "", key: "HangulMode" }), "Lang1");
  assert.equal(keyCode({ code: "Unidentified", key: "HangulMode" }), "Lang1");
  assert.equal(keyCode({ code: "", key: "a" }), undefined);
  assert.equal(
    keyCode({ code: "Unidentified", key: "Unidentified" }),
    undefined,
  );
});

// Review Focus 3: text pasted into the text window is emoji, line breaks and long.
test("text is cut into pieces that never split an emoji or a surrogate pair", () => {
  assert.deepEqual(plain(splitText("")), []);
  assert.deepEqual(plain(splitText("짧은 글")), ["짧은 글"]);
  const long = "a".repeat(4500);
  assert.deepEqual(
    plain(splitText(long).map((p) => p.length)),
    [2000, 2000, 500],
  );
  // A pair sits across the 2000 boundary: it moves wholly to the next piece.
  const text = `${"a".repeat(1999)}😀${"b".repeat(10)}`;
  const pieces = splitText(text);
  assert.deepEqual(plain(pieces.map((p) => p.length)), [1999, 12]);
  assert.equal(pieces.join(""), text);
  for (const piece of pieces) {
    const first = piece.charCodeAt(0);
    const last = piece.charCodeAt(piece.length - 1);
    assert.ok(
      !(first >= 0xdc00 && first <= 0xdfff),
      "starts with a low surrogate",
    );
    assert.ok(
      !(last >= 0xd800 && last <= 0xdbff),
      "ends with a high surrogate",
    );
  }
  // A CR LF pair sits across the boundary: it moves wholly to the next piece too.
  const lines = `${"a".repeat(1999)}\r\n${"b".repeat(10)}`;
  const linePieces = splitText(lines);
  assert.deepEqual(plain(linePieces.map((p) => p.length)), [1999, 12]);
  assert.equal(linePieces[1].startsWith("\r\n"), true);
  assert.equal(linePieces.join(""), lines);
  // The same with a small limit, for every cut position over a text of pairs and breaks.
  const mixed = "a😀\r\nb😀😀\r\n\r\nc";
  for (const max of [2, 3, 4, 5, 6]) {
    const parts = splitText(mixed, max);
    assert.equal(parts.join(""), mixed);
    for (const part of parts) {
      assert.ok(part.length > 0 && part.length <= max);
      assert.ok(
        !/^[\udc00-\udfff]/.test(part),
        `max ${max}: starts inside a pair`,
      );
      assert.ok(
        !/[\ud800-\udbff]$/.test(part),
        `max ${max}: ends inside a pair`,
      );
      assert.ok(
        !part.endsWith("\r") || mixed.endsWith(part),
        `max ${max}: CR cut from its LF`,
      );
      assert.ok(!part.startsWith("\n"), `max ${max}: LF cut from its CR`);
    }
  }
  // Every piece fits the agent's 8 KiB limit even when it is all four-byte characters.
  const emoji = "😀".repeat(3000);
  for (const piece of splitText(emoji))
    assert.ok(Buffer.byteLength(piece) + 40 <= 8 * 1024, "piece too large");
  assert.equal(splitText(emoji).join(""), emoji);
});

// Final review 3: the limit is on the JSON-encoded message, which escapes controls and quotes.
const messageBytes = (piece) => Buffer.byteLength(message.text(piece));
const assertAllFit = (pieces, label) => {
  for (const piece of pieces) {
    assert.ok(piece.length > 0, `${label}: empty piece`);
    assert.ok(
      messageBytes(piece) <= 8000,
      `${label}: ${messageBytes(piece)} bytes`,
    );
  }
};
const wellFormed = (s) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    s,
  );

test("control characters and quotes, which JSON escapes, still fit 8000 bytes per message", () => {
  for (const [name, text] of [
    ["control characters", "\u0001".repeat(2000)],
    ["many controls", "\u0001".repeat(9000)],
    ["quotes", '"'.repeat(7000)],
    ["backslashes", "\\".repeat(7000)],
    ["newlines", "\n".repeat(9000)],
    ["bmp text", "한".repeat(5000)],
    ["emoji", "😀".repeat(3000)],
    ["mixed", `a\u0000"\\${"😀한\u001f".repeat(1500)}`],
  ]) {
    const pieces = splitText(text);
    assertAllFit(pieces, name);
    assert.equal(pieces.join(""), text, `${name}: nothing lost`);
  }
  // 2000 control characters used to make a ~12 KB message.
  assert.ok(splitText("\u0001".repeat(2000)).length > 1);
  // Plain text keeps its 2000-unit pieces.
  assert.deepEqual(
    plain(splitText("a".repeat(4500)).map((p) => p.length)),
    [2000, 2000, 500],
  );
});

test("emoji and CR LF at the byte boundary move whole to the next piece", () => {
  // 6-byte controls fill the budget up to a pair or a CR LF that no longer fits.
  for (const tail of ["😀", "\r\n"]) {
    for (let controls = 1300; controls <= 1330; controls++) {
      const text = `${"\u0001".repeat(controls)}${tail}${"b".repeat(5)}`;
      const pieces = splitText(text);
      assertAllFit(pieces, `${controls} controls + ${JSON.stringify(tail)}`);
      assert.equal(pieces.join(""), text);
      for (const piece of pieces) {
        assert.ok(wellFormed(piece), "a pair was split");
        assert.ok(!piece.startsWith("\n") || piece === "\n", "LF cut from CR");
      }
      for (const piece of pieces.slice(0, -1))
        assert.ok(!piece.endsWith("\r"), "CR cut from its LF");
    }
  }
});

test("lone surrogates become U+FFFD so every message is valid JSON for the agent", () => {
  const lone = `a\ud800b\udc00c${"\ud83d"}`;
  const pieces = splitText(lone);
  assert.equal(pieces.join(""), "a\ufffdb\ufffdc\ufffd");
  for (const piece of pieces) {
    assert.ok(wellFormed(piece));
    assert.ok(!/\\ud[89a-f]/i.test(message.text(piece)), "\\udXXX escape");
  }
  // A pair stays a pair, a reversed pair is two replacements.
  assert.equal(splitText("😀").join(""), "😀");
  assert.equal(splitText("\udc00\ud800").join(""), "\ufffd\ufffd");
  // A pile of lone surrogates is still cut into messages that fit.
  const pile = "\ud800".repeat(5000);
  assertAllFit(splitText(pile), "pile");
  assert.equal(splitText(pile).join(""), "\ufffd".repeat(5000));
});

test("every message has the shape agent/mac/src/protocol.rs parses", () => {
  assert.deepEqual(JSON.parse(message.pointer({ x: 0.25, y: 1 })), {
    type: "pointer",
    x: 0.25,
    y: 1,
  });
  assert.deepEqual(JSON.parse(message.button(2, true, { x: 0, y: 0.5 })), {
    type: "button",
    b: 2,
    down: true,
    x: 0,
    y: 0.5,
  });
  assert.deepEqual(JSON.parse(message.wheel({ x: 0, y: -120 })), {
    type: "wheel",
    dx: 0,
    dy: -120,
  });
  assert.deepEqual(JSON.parse(message.key("KeyA", false)), {
    type: "key",
    code: "KeyA",
    down: false,
  });
  assert.deepEqual(JSON.parse(message.text("안녕")), {
    type: "text",
    s: "안녕",
  });
  assert.deepEqual(JSON.parse(message.release()), { type: "release" });
  assert.deepEqual(JSON.parse(message.size(1920, 1080)), {
    type: "size",
    w: 1920,
    h: 1080,
  });
  for (const small of [
    message.pointer({ x: 0.123456, y: 0.123456 }),
    message.button(0, false, { x: 1, y: 1 }),
    message.key("ControlRight", true),
  ])
    assert.ok(small.length < 512);
});

const codecs = [
  { mimeType: "video/VP8" },
  { mimeType: "video/VP9", sdpFmtpLine: "profile-id=0" },
  { mimeType: "video/AV1" },
  {
    mimeType: "video/H264",
    sdpFmtpLine:
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
  },
  {
    mimeType: "video/H264",
    sdpFmtpLine:
      "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
  },
  {
    mimeType: "video/H264",
    sdpFmtpLine:
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  },
  { mimeType: "video/rtx", sdpFmtpLine: "apt=102" },
  { mimeType: "video/rtx", sdpFmtpLine: "apt=104" },
  { mimeType: "video/red" },
  { mimeType: "video/ulpfec" },
];

test("the codec preference keeps H.264 and video/rtx, drops the rest, and puts constrained baseline mode 1 first", () => {
  const list = plain(preferredCodecs(codecs));
  assert.deepEqual(
    list.map((c) => `${c.mimeType}|${c.sdpFmtpLine ?? ""}`),
    [
      "video/H264|level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "video/H264|level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
      "video/H264|level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
      "video/rtx|apt=102",
      "video/rtx|apt=104",
    ],
  );
  assert.ok(
    list.some((c) => c.mimeType === "video/rtx"),
    "RTX must stay: without it a lost packet freezes the picture for a second",
  );
});

test("a browser that offers no H.264 gets a list without it, which the session refuses to use", () => {
  assert.deepEqual(
    plain(
      preferredCodecs([{ mimeType: "video/VP8" }, { mimeType: "video/rtx" }]),
    ).map((c) => c.mimeType),
    ["video/rtx"],
  );
  assert.deepEqual(plain(preferredCodecs([])), []);
});
