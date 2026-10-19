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

test("closing the session while candidates are gathered posts no offer, even after the gathering limit", async () => {
  const h = await agentHarness({ gathering: "never" });
  const started = h.session.start();
  await h.settle();
  const pc = h.peers[0];
  h.session.close();
  h.advance(1500);
  await h.settle();
  await started;
  assert.deepEqual(h.deps.offers, [], "a stale offer would take the Mac over");
  assert.equal(pc.closed, 1);
  assert.equal(pc.remote, undefined);
  assert.deepEqual(h.deps.ended, []);
  // Candidates arriving late change nothing either.
  pc.completeGathering();
  await h.settle();
  assert.deepEqual(h.deps.offers, []);
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

test("a connection that stays 'disconnected' for 3 seconds ends the session, and one that recovers in time does not", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  pc.setState("disconnected");
  h.advance(2999);
  assert.deepEqual(h.deps.ended, []);
  h.advance(1);
  assert.deepEqual(h.deps.ended, ["disconnected"]);
  assert.ok(pc.closed >= 1, "the connection is released");
  h.advance(60_000);
  assert.deepEqual(h.deps.ended, ["disconnected"], "reported once");
});

test("a recovery within 3 seconds cancels the wait, and the next loss starts a fresh 3 seconds", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  pc.setState("disconnected");
  h.advance(2500);
  pc.setState("connected");
  h.advance(10_000);
  assert.deepEqual(h.deps.ended, []);
  pc.setState("disconnected");
  h.advance(2999);
  assert.deepEqual(h.deps.ended, []);
  // A repeated 'disconnected' report does not restart the clock.
  pc.setState("disconnected");
  h.advance(1);
  assert.deepEqual(h.deps.ended, ["disconnected"]);
});

test("'failed' still ends at once, and a pending wait does not report a second time", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  pc.setState("disconnected");
  h.advance(1000);
  pc.setState("failed");
  assert.deepEqual(h.deps.ended, ["disconnected"]);
  h.advance(10_000);
  assert.deepEqual(h.deps.ended, ["disconnected"]);
});

test("a page that closes the session while the connection is 'disconnected' reports nothing later", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  pc.setState("disconnected");
  const channel = h.channel();
  assert.equal(h.timers.size, 1, "the wait is pending");
  h.session.close();
  assert.equal(h.timers.size, 0, "closing clears the wait");
  assert.equal(channel.onmessage, null, "and the handlers");
  assert.equal(channel.onclose, null);
  h.advance(60_000);
  assert.deepEqual(h.deps.ended, []);
});

test("the agent's 'replaced' notice ends the session at once with its own reason", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  h.channel().receive('{"type":"replaced"}');
  assert.deepEqual(h.deps.ended, ["replaced"]);
  assert.ok(pc.closed >= 1, "the connection is released");
  h.advance(60_000);
  assert.deepEqual(h.deps.ended, ["replaced"], "nothing more, no reconnect");
  assert.equal(h.peers.length, 1, "no new connection was made");
});

test("anything else the agent sends is ignored", async () => {
  const h = await agentHarness();
  await h.connect();
  for (const data of [
    "",
    "replaced",
    "not json",
    '{"type":"other"}',
    '{"type":"release"}',
    "[]",
    "null",
    new ArrayBuffer(4),
    undefined,
  ])
    h.channel().receive(data);
  assert.deepEqual(h.deps.ended, []);
});

test("a notice longer than 256 characters is ignored, one of exactly 256 is not", async () => {
  const h = await agentHarness();
  await h.connect();
  const notice = '{"type":"replaced"}';
  h.channel().receive(notice + " ".repeat(257 - notice.length));
  assert.deepEqual(h.deps.ended, []);
  h.channel().receive(notice + " ".repeat(256 - notice.length));
  assert.deepEqual(h.deps.ended, ["replaced"]);
});

test("a notice that arrives after the page let go reports nothing", async () => {
  const h = await agentHarness();
  await h.connect();
  h.session.close();
  h.channel().receive('{"type":"replaced"}');
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

test("a move is sent with exactly 64 KiB queued in the channel and dropped one byte over", async () => {
  const h = await agentHarness();
  await h.connect();
  const pointers = () =>
    h.messages().filter((m) => m.type === "pointer").length;
  h.channel().bufferedAmount = 64 * 1024;
  move(h, 300, 500);
  h.flushFrame();
  assert.equal(pointers(), 1, "exactly the limit still sends");
  h.channel().bufferedAmount = 64 * 1024 + 1;
  move(h, 400, 500);
  h.flushFrame();
  assert.equal(pointers(), 1, "one byte over drops the move");
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

test("when Command comes up, every other key still held is let go first (macOS browsers send no keyup for them)", async () => {
  const h = await agentHarness();
  await h.connect();
  const keys = () => h.messages().filter((m) => m.type === "key");
  for (const code of ["ShiftLeft", "MetaLeft", "KeyC", "KeyV"])
    h.surface.fire("keydown", { code, key: "x" });
  h.surface.fire("keyup", { code: "MetaLeft", key: "Meta" });
  assert.deepEqual(keys().slice(4), [
    { type: "key", code: "KeyC", down: false },
    { type: "key", code: "KeyV", down: false },
    { type: "key", code: "MetaLeft", down: false },
  ]);
  // Shift is a modifier with its own keyup and stays down; nothing is let go twice.
  const before = h.messages().length;
  h.surface.fire("keyup", { code: "ShiftLeft", key: "Shift" });
  h.surface.fire("keyup", { code: "KeyC", key: "c" });
  assert.deepEqual(h.messages().slice(before), [
    { type: "key", code: "ShiftLeft", down: false },
    { type: "key", code: "KeyC", down: false },
  ]);
  // Releasing the right Command key does the same, and without Command nothing is invented.
  h.surface.fire("keydown", { code: "MetaRight", key: "Meta" });
  h.surface.fire("keydown", { code: "KeyA", key: "a" });
  h.surface.fire("keyup", { code: "MetaRight", key: "Meta" });
  assert.deepEqual(keys().slice(-2), [
    { type: "key", code: "KeyA", down: false },
    { type: "key", code: "MetaRight", down: false },
  ]);
  h.surface.fire("keydown", { code: "KeyB", key: "b" });
  h.surface.fire("keyup", { code: "ControlLeft", key: "Control" });
  assert.deepEqual(keys().at(-1), {
    type: "key",
    code: "ControlLeft",
    down: false,
  });
  assert.equal(
    keys().filter((m) => m.code === "KeyB").length,
    1,
    "only a Command key-up lets the other keys go",
  );
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

for (const [how, end, reason] of [
  ["the connection fails", (h, pc) => pc.setState("failed"), "disconnected"],
  ["no picture ever arrives", (h) => h.advance(20_000), "timeout"],
])
  test(`when ${how}, a release is sent on the channel before it is closed`, async () => {
    const h = await agentHarness();
    const started = h.session.start();
    await h.settle();
    const pc = h.peers.at(-1);
    const channel = pc.channels[0];
    channel.open();
    pc.setState("connected");
    await started;
    h.surface.fire("keydown", { code: "KeyA", key: "a" });
    h.surface.fire("mousedown", { ...MIDDLE, button: 0 });
    let closedWhenSent;
    const send = channel.send.bind(channel);
    channel.send = (text) => {
      closedWhenSent = channel.closed;
      send(text);
    };
    end(h, pc);
    assert.deepEqual(h.deps.ended, [reason]);
    assert.deepEqual(h.messages().at(-1), { type: "release" });
    assert.equal(closedWhenSent, 0, "the release went out before the close");
    assert.equal(channel.closed, 1);
    assert.equal(
      h.messages().filter((m) => m.type === "release").length,
      1,
      "once",
    );
  });

test("a session that ends while its channel is already gone does not fail on the release", async () => {
  const h = await agentHarness();
  const pc = await h.connect();
  const channel = pc.channels[0];
  channel.readyState = "closed";
  channel.onclose();
  assert.deepEqual(h.deps.ended, ["disconnected"]);
  assert.equal(
    h.messages().filter((m) => m.type === "release").length,
    0,
    "nothing can be sent on a closed channel",
  );
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

// ---- clipboard over the channel ----

test("agent messages are routed: replaced ends the session, lock, clipboard and skip notices reach onAgentMessage, binary and malformed are ignored", async () => {
  const h = await agentHarness();
  const got = [];
  h.deps.onAgentMessage = (m) => got.push(plain(m));
  await h.connect();
  const channel = h.channel();
  channel.receive(JSON.stringify({ type: "lock", locked: true }));
  channel.receive(
    JSON.stringify({ type: "clipboard", text: "글", concealed: false }),
  );
  channel.receive(
    JSON.stringify({ type: "clipboard-skipped", reason: "too-large" }),
  );
  channel.receive(new ArrayBuffer(4));
  channel.receive("{not json");
  channel.receive(JSON.stringify({ type: "unknown" }));
  channel.receive(JSON.stringify({ type: "lock", locked: "yes" }));
  assert.deepEqual(got, [
    { type: "lock", locked: true },
    { type: "clipboard", text: "글", concealed: false },
    { type: "clipboard-skipped", reason: "too-large" },
  ]);
  assert.deepEqual(h.deps.ended, [], "none of them ends the session");
  channel.receive(JSON.stringify({ type: "replaced" }));
  assert.deepEqual(h.deps.ended, ["replaced"]);
  assert.equal(got.length, 3, "replaced is not passed on");
});

test("a throwing onAgentMessage cannot break the channel", async () => {
  const h = await agentHarness();
  h.deps.onAgentMessage = () => {
    throw new Error("boom");
  };
  await h.connect();
  h.channel().receive(JSON.stringify({ type: "lock", locked: true }));
  h.channel().receive(JSON.stringify({ type: "replaced" }));
  assert.deepEqual(h.deps.ended, ["replaced"]);
});

test("sendClipboard sends the message; text over 256 KiB once encoded is too large and nothing is sent", async () => {
  const h = await agentHarness();
  await h.connect();
  const before = h.channel().sent.length;
  assert.equal(h.session.sendClipboard("안녕\r\n", true), "sent");
  assert.deepEqual(h.messages().slice(before), [
    { type: "clipboard", text: "안녕\r\n", concealed: true },
  ]);
  // 65 536 control characters are 64 KiB of text but 6 bytes each once escaped.
  assert.equal(
    h.session.sendClipboard("\u0001".repeat(65_536), false),
    "too-large",
  );
  // The limit counts UTF-8 bytes of the encoded message, not UTF-16 units. 40 000 control
  // characters (6 bytes escaped) and 8 512 Hangul (3 bytes each) are 64 KiB of text; the
  // message is under 256 KiB in UTF-16 units and over it in UTF-8 bytes.
  const mixed = "\u0001".repeat(40_000) + "가".repeat(8_512);
  const encoded = JSON.stringify({
    type: "clipboard",
    text: mixed,
    concealed: false,
  });
  assert.equal(
    new TextEncoder().encode(mixed).length,
    65_536,
    "the text is 64 KiB",
  );
  assert.ok(encoded.length <= 262_144, `units ${encoded.length}`);
  assert.ok(new TextEncoder().encode(encoded).length > 262_144, "bytes");
  assert.equal(h.session.sendClipboard(mixed, false), "too-large");
  assert.equal(h.channel().sent.length, before + 1, "nothing else went out");
  // A text near the limit still goes: 64 KiB of plain text.
  assert.equal(h.session.sendClipboard("a".repeat(65_536), false), "sent");
});

test("sendClipboard replaces a lone surrogate with U+FFFD", async () => {
  const h = await agentHarness();
  await h.connect();
  assert.equal(h.session.sendClipboard("a\ud800b\udc00c😀", false), "sent");
  const raw = h.channel().sent.at(-1);
  assert.equal(raw.includes("\\ud800"), false);
  assert.equal(JSON.parse(raw).text, "a�b�c😀");
});

test("sendClipboard on a closed channel answers closed, sendWatch sends only while open", async () => {
  const h = await agentHarness();
  assert.equal(h.session.sendClipboard("x", false), "closed", "not yet open");
  await h.connect();
  h.session.sendWatch(true);
  h.session.sendWatch(false);
  assert.deepEqual(h.messages().slice(-2), [
    { type: "clipboard-watch", on: true },
    { type: "clipboard-watch", on: false },
  ]);
  const channel = h.channel();
  h.session.close();
  const sent = channel.sent.length;
  assert.equal(h.session.sendClipboard("x", false), "closed");
  h.session.sendWatch(true);
  assert.equal(channel.sent.length, sent);
});

test("every send goes through the gate, clipboard and watch do not, and the key hook sees key-downs only", async () => {
  const h = await agentHarness();
  const held = [];
  const seen = [];
  h.deps.gate = (run) => held.push(run);
  h.deps.onPasteKey = (event) => seen.push(event.code);
  await h.connect();
  const before = h.channel().sent.length;
  h.surface.fire("keydown", { code: "KeyV", key: "v", metaKey: true });
  h.surface.fire("keyup", { code: "KeyV", key: "v", metaKey: true });
  assert.deepEqual(seen, ["KeyV"], "key-down only, and before the send");
  assert.equal(h.channel().sent.length, before, "the keys wait in the gate");
  assert.equal(h.session.sendClipboard("x", false), "sent");
  h.session.sendWatch(true);
  assert.deepEqual(
    h
      .messages()
      .slice(before)
      .map((m) => m.type),
    ["clipboard", "clipboard-watch"],
    "the clipboard text and watch bypass the gate",
  );
  held.splice(0).forEach((run) => run());
  assert.deepEqual(h.messages().slice(-2), [
    { type: "key", code: "KeyV", down: true },
    { type: "key", code: "KeyV", down: false },
  ]);
});

test("a key whose code the page cannot name does not reach onPasteKey", async () => {
  const h = await agentHarness();
  const seen = [];
  h.deps.onPasteKey = (event) => seen.push(event.code);
  await h.connect();
  h.surface.fire("keydown", { code: "Unidentified", key: "v", metaKey: true });
  assert.deepEqual(seen, []);
});

test("pasteShortcut sends Command down, V down, V up, Command up through the gate", async () => {
  const h = await agentHarness();
  const held = [];
  h.deps.gate = (run) => held.push(run);
  await h.connect();
  const before = h.channel().sent.length;
  h.session.pasteShortcut();
  assert.equal(held.length, 4);
  assert.equal(h.channel().sent.length, before);
  held.splice(0).forEach((run) => run());
  assert.deepEqual(h.messages().slice(before), [
    { type: "key", code: "MetaLeft", down: true },
    { type: "key", code: "KeyV", down: true },
    { type: "key", code: "KeyV", down: false },
    { type: "key", code: "MetaLeft", down: false },
  ]);
});

test("a held item that runs after the channel closed is dropped, and the end sends its release without waiting for the gate", async () => {
  const h = await agentHarness();
  const held = [];
  h.deps.gate = (run) => held.push(run);
  await h.connect();
  const channel = h.channel();
  h.surface.fire("keydown", { code: "KeyV", key: "v", metaKey: true });
  const before = channel.sent.length;
  h.session.close();
  assert.deepEqual(
    channel.messages().slice(before),
    [{ type: "release" }],
    "the release is not held behind the barrier",
  );
  held.splice(0).forEach((run) => run());
  assert.equal(channel.sent.length, before + 1, "the late V is dropped");
});

test("onChannelOpen is called when the channel opens", async () => {
  const h = await agentHarness();
  let opened = 0;
  h.deps.onChannelOpen = () => opened++;
  await h.connect();
  assert.equal(opened, 1);
});
