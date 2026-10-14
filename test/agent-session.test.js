import test from "node:test";
import assert from "node:assert/strict";
import { agentHarness } from "./helpers/agent-harness.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- connection setup ----

test("the page offers a receive-only H.264 video with RTX preferred-kept, and an ordered input channel, with no ICE servers", async () => {
  const h = await agentHarness();
  const started = h.session.start();
  await h.settle();
  const pc = h.peers[0];
  assert.deepEqual(plain(pc.config), { iceServers: [] });
  assert.equal(pc.transceivers.length, 1);
  assert.equal(pc.transceivers[0].kind, "video");
  assert.equal(pc.transceivers[0].init.direction, "recvonly");
  const offered = plain(pc.transceivers[0].preferences).map((c) => c.mimeType);
  assert.deepEqual(
    offered,
    ["video/H264", "video/rtx"],
    "VP8 is gone, RTX is kept",
  );
  assert.equal(pc.transceivers[0].receiver.jitterBufferTarget, 0);
  assert.equal(pc.transceivers[0].receiver.playoutDelayHint, 0);
  assert.equal(pc.channels.length, 1);
  assert.equal(pc.channels[0].label, "input");
  assert.equal(pc.channels[0].options.ordered, true);
  await started;
  assert.deepEqual(h.deps.offers, ["v=0\r\no=offer"]);
  assert.deepEqual(plain(pc.remote), { type: "answer", sdp: "v=0\r\nanswer" });
});

test("the offer waits for candidate gathering, but never longer than 1.5 seconds", async () => {
  const h = await agentHarness({ gathering: "never" });
  const started = h.session.start();
  await h.settle();
  assert.equal(h.deps.offers.length, 0, "still gathering");
  h.advance(1499);
  await h.settle();
  assert.equal(h.deps.offers.length, 0);
  h.advance(1);
  await h.settle();
  assert.equal(h.deps.offers.length, 1, "sent at the limit");
  await started;
  // And when gathering finishes first, the wait ends early.
  const early = await agentHarness({ gathering: "never" });
  const second = early.session.start();
  await early.settle();
  early.peers[0].completeGathering();
  await early.settle();
  assert.equal(early.deps.offers.length, 1);
  await second;
});

// Review Focus 4: a browser without H.264 or video frame callbacks must fail clearly.
test("a browser without H.264, or without WebRTC, ends the session at once and never contacts the gateway", async () => {
  const noH264 = await agentHarness({
    codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/rtx" }],
  });
  await noH264.session.start();
  assert.deepEqual(noH264.deps.ended, ["unsupported"]);
  assert.equal(noH264.deps.offers.length, 0);
  assert.equal(noH264.peers.length, 0, "no connection was even created");
  const none = await agentHarness({ peerConnection: false });
  await none.session.start();
  assert.deepEqual(none.deps.ended, ["unsupported"]);
  assert.equal(none.deps.offers.length, 0);
  const empty = await agentHarness({ codecs: [] });
  await empty.session.start();
  assert.deepEqual(empty.deps.ended, ["unsupported"]);
});

test("a gateway refusal rejects start with that error, closes the connection and reports no end", async () => {
  const h = await agentHarness();
  const refusal = Object.assign(new Error("권한"), { code: "permission" });
  h.deps.signalError = refusal;
  await assert.rejects(h.session.start(), (error) => error === refusal);
  assert.equal(h.peers[0].closed, 1);
  assert.deepEqual(
    h.deps.ended,
    [],
    "the caller shows the refusal; onEnded is for later endings",
  );
  assert.equal(h.deps.frames, 0);
});

// ---- the picture and the ending ----

test("the first picture reports the connection once; a picture that never comes ends it after 20 seconds", async () => {
  const h = await agentHarness();
  const firstStart = h.session.start();
  await h.settle();
  const shown = h.video.frameCallbacks.slice();
  assert.equal(shown.length, 1, "one callback waits for the first picture");
  const pc = h.peers.at(-1);
  pc.channels[0].open();
  await firstStart;
  // The browser may deliver the same notification again; the page reports once.
  shown[0](1, {});
  shown[0](2, {});
  assert.equal(h.deps.frames, 1, "reported once");
  assert.equal(pc.closed, 0);
  h.advance(60_000);
  assert.deepEqual(
    h.deps.ended,
    [],
    "a picture arrived, so there is nothing to time out",
  );

  const silent = await agentHarness();
  const started = silent.session.start();
  await silent.settle();
  await started;
  silent.advance(19_999);
  assert.deepEqual(silent.deps.ended, []);
  silent.advance(1);
  assert.deepEqual(silent.deps.ended, ["timeout"]);
  assert.equal(silent.peers[0].closed, 1);
});

// Review Focus 4: a browser without H.264 or video frame callbacks must fail clearly.
test("a browser without video frame callbacks reports the first picture when playback starts", async () => {
  const h = await agentHarness({ frameCallbacks: false });
  const started = h.session.start();
  await h.settle();
  await started;
  assert.equal(h.deps.frames, 0);
  h.video.fire("playing");
  assert.equal(h.deps.frames, 1);
});

test("the stream is attached to the video element and played", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  assert.equal(h.video.srcObject.id, "stream");
  assert.ok(h.video.played >= 1);
  pc.track(undefined);
  assert.equal(
    h.video.srcObject.tracks[0].id,
    "t",
    "a track without a stream gets its own",
  );
});

for (const state of ["failed", "closed"])
  test(`connection state ${state} ends the session once as disconnected`, async () => {
    const h = await agentHarness();
    const pc = await h.connect();
    pc.setState(state);
    pc.setState(state);
    assert.deepEqual(h.deps.ended, ["disconnected"]);
    assert.ok(pc.closed >= 1, "the connection is released");
  });

test("the transient 'disconnected' state is waited out, not reported", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  pc.setState("disconnected");
  assert.deepEqual(h.deps.ended, []);
  pc.setState("connected");
  assert.deepEqual(h.deps.ended, []);
});

test("a closed data channel ends the session", async () => {
  const h = await agentHarness();
  await h.connect();
  h.channel().onclose();
  assert.deepEqual(h.deps.ended, ["disconnected"]);
});

test("nothing is reported after the page itself closes the session", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  h.session.close();
  pc.setState("closed");
  pc.channels[0].onclose?.();
  h.advance(60_000);
  assert.deepEqual(h.deps.ended, []);
});

// ---- the mouse ----

const move = (h, x, y) =>
  h.surface.fire("mousemove", { clientX: x, clientY: y });
// The element is 1000 x 1000 and the picture 16:9, so it spans y 218.75 .. 781.25.
const MIDDLE = { clientX: 500, clientY: 500 };

test("moves are coalesced to one per frame, carry picture coordinates, and the newest wins", async () => {
  const h = await agentHarness();
  await h.connect();
  for (const x of [100, 200, 300, 400, 500]) move(h, x, 500);
  assert.equal(h.messages().length, 0, "nothing is sent before the frame");
  h.flushFrame();
  const sent = h.messages().filter((m) => m.type === "pointer");
  assert.deepEqual(sent, [{ type: "pointer", x: 0.5, y: 0.5 }]);
  move(h, 0, 500);
  h.flushFrame();
  assert.deepEqual(h.messages().at(-1), { type: "pointer", x: 0, y: 0.5 });
});

test("a press first sends the latest position, then the button, in that order", async () => {
  const h = await agentHarness();
  await h.connect();
  move(h, 250, 500);
  h.surface.fire("mousedown", { ...MIDDLE, button: 0 });
  const types = h.messages().map((m) => m.type);
  assert.deepEqual(types, ["pointer", "button"]);
  assert.deepEqual(h.messages()[1], {
    type: "button",
    b: 0,
    down: true,
    x: 0.5,
    y: 0.5,
  });
  h.flushFrame();
  assert.equal(h.messages().length, 2, "the flushed move is not sent twice");
});

test("all three buttons map to the DOM numbers, and the back and forward buttons are ignored", async () => {
  const h = await agentHarness();
  await h.connect();
  for (const button of [0, 1, 2]) {
    h.surface.fire("mousedown", { ...MIDDLE, button });
    h.documentNode.fire("mouseup", { ...MIDDLE, button });
  }
  for (const button of [3, 4]) {
    h.surface.fire("mousedown", { ...MIDDLE, button });
    h.documentNode.fire("mouseup", { ...MIDDLE, button });
  }
  const buttons = h.messages().filter((m) => m.type === "button");
  assert.deepEqual(
    buttons.map((m) => [m.b, m.down]),
    [
      [0, true],
      [0, false],
      [1, true],
      [1, false],
      [2, true],
      [2, false],
    ],
  );
});

// Review Focus 1: a window whose shape differs from the Mac's screen has black bars.
test("a press on a black bar is not a click on the Mac, and its release is not sent either", async () => {
  const h = await agentHarness();
  await h.connect();
  h.surface.fire("mousedown", { clientX: 500, clientY: 100, button: 0 }); // above the picture
  h.documentNode.fire("mouseup", { clientX: 500, clientY: 100, button: 0 });
  h.surface.fire("mousedown", { clientX: 500, clientY: 900, button: 2 }); // below it
  assert.deepEqual(
    h.messages().filter((m) => m.type === "button"),
    [],
  );
});

// Review Focus 1: a window whose shape differs from the Mac's screen has black bars.
test("a drag that ends outside the picture or the element still releases the button at the nearest edge", async () => {
  const h = await agentHarness();
  await h.connect();
  h.surface.fire("mousedown", { clientX: 900, clientY: 500, button: 0 });
  h.documentNode.fire("mouseup", { clientX: 5000, clientY: -300, button: 0 });
  const up = h.messages().filter((m) => m.type === "button" && !m.down);
  assert.deepEqual(up, [{ type: "button", b: 0, down: false, x: 1, y: 0 }]);
  // A second release of the same button is a stray event and is not sent.
  h.documentNode.fire("mouseup", { clientX: 5, clientY: 5, button: 0 });
  assert.equal(
    h.messages().filter((m) => m.type === "button" && !m.down).length,
    1,
  );
});

test("the context menu is suppressed and a click focuses the surface", async () => {
  const h = await agentHarness();
  await h.connect();
  assert.equal(h.surface.fire("contextmenu").prevented, true);
  const down = h.surface.fire("mousedown", { ...MIDDLE, button: 2 });
  assert.equal(down.prevented, true);
  assert.ok(h.surface.focused >= 1);
});

test("the wheel is sent in pixels, only over the picture, and its page scroll is suppressed", async () => {
  const h = await agentHarness();
  await h.connect();
  const over = h.surface.fire("wheel", {
    ...MIDDLE,
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
  });
  assert.equal(over.prevented, true);
  assert.deepEqual(h.messages().at(-1), { type: "wheel", dx: 0, dy: 100 });
  const before = h.messages().length;
  h.surface.fire("wheel", {
    clientX: 500,
    clientY: 50,
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
  });
  h.surface.fire("wheel", { ...MIDDLE, deltaX: 0, deltaY: 0, deltaMode: 0 });
  assert.equal(
    h.messages().length,
    before,
    "over a bar, or a zero delta: nothing",
  );
  h.surface.fire("wheel", { ...MIDDLE, deltaX: 0, deltaY: -3, deltaMode: 1 });
  assert.deepEqual(h.messages().at(-1), { type: "wheel", dx: 0, dy: -48 });
  assert.equal(
    h.surface.listeners.wheel[0].options.passive,
    false,
    "must be able to prevent default",
  );
});

test("when the channel is backed up, moves are dropped but clicks are not", async () => {
  const h = await agentHarness();
  await h.connect();
  h.channel().bufferedAmount = 65 * 1024;
  move(h, 300, 500);
  h.flushFrame();
  assert.equal(h.messages().filter((m) => m.type === "pointer").length, 0);
  h.surface.fire("mousedown", { ...MIDDLE, button: 0 });
  assert.equal(h.messages().filter((m) => m.type === "button").length, 1);
});

// ---- the keyboard ----

test("keys are sent by physical code, down and up, with the browser's own action suppressed", async () => {
  const h = await agentHarness();
  await h.connect();
  const down = h.surface.fire("keydown", { code: "KeyA", key: "a" });
  h.surface.fire("keyup", { code: "KeyA", key: "a" });
  assert.equal(down.prevented, true);
  assert.equal(down.stopped, true);
  assert.deepEqual(
    h.messages().filter((m) => m.type === "key"),
    [
      { type: "key", code: "KeyA", down: true },
      { type: "key", code: "KeyA", down: false },
    ],
  );
});

test("modifiers keep their physical positions and key repeat sends every key-down", async () => {
  const h = await agentHarness();
  await h.connect();
  for (const code of ["ControlLeft", "AltRight", "MetaLeft"])
    h.surface.fire("keydown", { code, key: "x" });
  for (let i = 0; i < 3; i++)
    h.surface.fire("keydown", { code: "KeyZ", key: "z", repeat: i > 0 });
  const keys = h.messages().filter((m) => m.type === "key");
  assert.deepEqual(
    keys.slice(0, 3).map((m) => m.code),
    ["ControlLeft", "AltRight", "MetaLeft"],
  );
  assert.equal(keys.filter((m) => m.code === "KeyZ").length, 3);
});

test("the Hangul key is sent as Lang1 however the browser names it; unnamed keys are not sent", async () => {
  const h = await agentHarness();
  await h.connect();
  h.surface.fire("keydown", { code: "Lang1", key: "HangulMode" });
  h.surface.fire("keydown", { code: "", key: "HangulMode" });
  const before = h.messages().length;
  h.surface.fire("keydown", { code: "", key: "Dead" });
  h.surface.fire("keydown", { code: "Unidentified", key: "Unidentified" });
  assert.equal(h.messages().length, before);
  assert.deepEqual(
    h
      .messages()
      .filter((m) => m.type === "key")
      .map((m) => m.code),
    ["Lang1", "Lang1"],
  );
});

// ---- letting go ----

test("losing focus releases everything, and the button that was down is not released twice", async () => {
  const h = await agentHarness();
  await h.connect();
  h.surface.fire("mousedown", { ...MIDDLE, button: 0 });
  h.surface.fire("keydown", { code: "ShiftLeft", key: "Shift" });
  h.surface.fire("blur");
  assert.deepEqual(h.messages().at(-1), { type: "release" });
  const before = h.messages().length;
  h.documentNode.fire("mouseup", { ...MIDDLE, button: 0 });
  assert.equal(
    h.messages().length,
    before,
    "the late mouse-up after a release is not a second release",
  );
});

test("release() always sends a release, so a dialog, fullscreen switch or end can rely on it", async () => {
  const h = await agentHarness();
  await h.connect();
  const before = h.messages().length;
  h.session.release();
  h.session.release();
  assert.deepEqual(h.messages().slice(before), [
    { type: "release" },
    { type: "release" },
  ]);
});

test("closing the session sends a release, then closes the channel and the connection, once", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  h.session.close();
  h.session.close();
  assert.deepEqual(pc.channels[0].messages().at(-1), { type: "release" });
  assert.equal(pc.channels[0].closed, 1);
  assert.equal(pc.closed, 1);
  assert.equal(
    h.documentNode.count("mouseup"),
    0,
    "the document listener is removed",
  );
  assert.equal(h.video.srcObject, null);
});

test("nothing is sent while the channel is not open, and text reports that it was not sent", async () => {
  const h = await agentHarness();
  const started = h.session.start();
  await h.settle();
  const channel = h.channel();
  h.surface.fire("keydown", { code: "KeyA", key: "a" });
  h.session.release();
  h.session.sendSize(1920, 1080);
  assert.equal(h.session.sendText("hi"), false);
  assert.deepEqual(channel.sent, []);
  await started;
});

// ---- size and text ----

test("a size change is sent as a size message", async () => {
  const h = await agentHarness();
  await h.connect();
  h.session.sendSize(2560, 1440);
  assert.deepEqual(h.messages().at(-1), { type: "size", w: 2560, h: 1440 });
});

// Review Focus 3: text pasted into the text window is emoji, line breaks and long.
test("text goes as text messages that never split an emoji", async () => {
  const h = await agentHarness();
  await h.connect();
  assert.equal(h.session.sendText("안녕"), true);
  assert.deepEqual(h.messages().at(-1), { type: "text", s: "안녕" });
  const text = `${"a".repeat(1999)}😀tail`;
  assert.equal(h.session.sendText(text), true);
  const pieces = h
    .messages()
    .filter((m) => m.type === "text")
    .slice(1)
    .map((m) => m.s);
  assert.equal(pieces.join(""), text);
  assert.ok(pieces.length >= 2);
  for (const piece of pieces)
    assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(piece));
});

// ---- the measurement hooks ----

test("clickAt sends a move, a press and a release at the same picture position", async () => {
  const h = await agentHarness();
  await h.connect();
  h.session.clickAt(0.25, 0.75);
  assert.deepEqual(h.messages().slice(-3), [
    { type: "pointer", x: 0.25, y: 0.75 },
    { type: "button", b: 0, down: true, x: 0.25, y: 0.75 },
    { type: "button", b: 0, down: false, x: 0.25, y: 0.75 },
  ]);
});

test("watchFrames reports frame gaps over 500 ms and the freeze count that changed", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  const report = h.session.watchFrames(3000);
  await h.settle();
  h.video.showFrame(100);
  h.video.showFrame(200);
  h.video.showFrame(900); // a 700 ms gap
  pc.freezeCount = 2;
  h.video.showFrame(3200);
  const result = plain(await report);
  assert.equal(result.frames, 4);
  assert.equal(result.maxGapMs, 2300);
  assert.equal(result.gapsOver500ms, 2);
  assert.equal(result.freezeCount, 2);
});
