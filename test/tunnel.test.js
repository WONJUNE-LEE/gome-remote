import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { bridge } from "../server/tunnel.js";

// The flow-control contract of the tunnel, pinned independently of the module's own constants.
const MiB = 1024 * 1024;
const HIGH_WATER = 1 * MiB;
const HARD_CAP = 32 * MiB;

const wire = (parts) =>
  parts.map((p) => `${Array.from(String(p)).length}.${p}`).join(",") + ";";
const blob = (i, size = 4096) =>
  wire(["blob", String(i), String(i % 10).repeat(size)]);

// A browser-side WebSocket whose send queue the test controls: bytes stay "buffered"
// until the test completes the send callbacks, like a client that reads slowly.
// Like `ws`, a callback fires after its own frame left the queue, so bufferedAmount still
// counts every later frame at that moment; flushOne() overrides that to pin an exact backlog.
class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  sentBytes = 0;
  pending = [];
  autoDrain = false;
  closeCall = null;
  send(data, callback) {
    const size = Buffer.byteLength(data);
    this.sent.push(data);
    this.sentBytes += size;
    this.bufferedAmount += size;
    if (this.autoDrain)
      setImmediate(() => {
        this.bufferedAmount -= size;
        callback?.();
      });
    else this.pending.push({ size, callback });
  }
  close(code, reason) {
    this.readyState = 3;
    this.closeCall = { code, reason };
    this.emit("close");
  }
  // Complete the oldest send, leaving `buffered` bytes queued, as the OS accepts a frame.
  // With `error`, the send fails instead.
  flushOne(buffered, error) {
    this.bufferedAmount = buffered;
    this.pending.shift()?.callback?.(error);
  }
  // Complete every send in flight, oldest first, each leaving the later frames queued.
  flushAll() {
    for (const { size, callback } of this.pending.splice(0)) {
      this.bufferedAmount -= size;
      callback?.();
    }
  }
}

// A guacd that completes the handshake and then writes `payload` (one string or an
// array of instructions) as fast as it can, recording whether its own writes back up.
async function guacd(t, payload) {
  const server = net.createServer((socket) => {
    server.socket = socket;
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk;
      if (seen.includes("6.select,") && !server.argsSent) {
        server.argsSent = true;
        socket.write(wire(["args", "hostname"]));
      }
      if (seen.includes("7.connect,") && !server.readySent) {
        server.readySent = true;
        socket.write(wire(["ready", "$test"]));
        for (const part of [].concat(payload)) socket.write(part);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // Not awaited: a paused bridge does not notice the hang-up until its own cleanup runs.
  t.after(() => {
    server.socket?.destroy();
    server.close();
  });
  return server;
}

// The bridge's own connection to guacd, so a test can observe whether it is paused.
function captureUpstream(t) {
  let upstream;
  const connect = net.connect;
  t.mock.method(net, "connect", (...args) => (upstream = connect(...args)));
  return () => upstream;
}

const connection = {
  type: "rdp",
  settings: { width: 1920, height: 1080, dpi: 96, hostname: "h" },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(10);
  assert.ok(condition(), "condition not reached in time");
}
const blobs = (ws) => ws.sent.filter((s) => s.startsWith("4.blob"));
// A client that drains everything it is given, yet does so in the open (unlike autoDrain).
async function drainUntil(ws, condition) {
  const deadline = Date.now() + 15_000;
  while (!condition() && Date.now() < deadline) {
    ws.flushAll();
    await sleep(5);
  }
  assert.ok(condition(), "condition not reached in time");
}

test("a client that stops draining pauses guacd, instead of closing the tunnel", async (t) => {
  const BLOBS = 1500; // ~6 MiB, above the old 4 MiB limit
  const payload = Array.from({ length: BLOBS }, (_, i) => blob(i));
  const daemon = await guacd(t, payload);
  const upstream = captureUpstream(t);
  const ws = new FakeWs();
  const logs = [];
  const close = bridge(ws, structuredClone(connection), daemon.address().port, {
    log: (line) => logs.push(line),
  });
  t.after(close);
  await until(() => ws.sentBytes > HIGH_WATER);
  await sleep(300);
  assert.equal(
    ws.readyState,
    1,
    "the tunnel is not closed while the client lags",
  );
  assert.equal(upstream().isPaused(), true, "the guacd socket is paused");
  // Memory stays bounded near the high-water mark (plus the chunk in flight).
  assert.ok(ws.sentBytes < HIGH_WATER + 512 * 1024, `sent ${ws.sentBytes}`);
  const stalled = ws.sentBytes;
  await sleep(200);
  assert.equal(ws.sentBytes, stalled, "nothing more is read while paused");

  await drainUntil(ws, () => blobs(ws).length === BLOBS);
  assert.equal(upstream().isPaused(), false, "the guacd socket is resumed");
  assert.deepEqual(blobs(ws), payload, "every instruction arrives, in order");
  assert.equal(ws.readyState, 1);
  assert.deepEqual(logs, [], "pausing and resuming is silent");
});

test("guacd is resumed only once the WebSocket drains below the low-water mark", async (t) => {
  const BLOBS = 1500;
  const payload = Array.from({ length: BLOBS }, (_, i) => blob(i));
  const daemon = await guacd(t, payload);
  const ws = new FakeWs();
  t.after(bridge(ws, structuredClone(connection), daemon.address().port));
  await until(() => ws.sentBytes > HIGH_WATER);
  await sleep(200);
  const stalled = ws.sent.length;
  // A frame completes but the queue is still above the low-water mark: stay paused.
  ws.flushOne(768 * 1024);
  await sleep(200);
  assert.equal(ws.sent.length, stalled, "still paused at 768 KiB buffered");
  // Now the queue is below the low-water mark: guacd is read again.
  ws.flushOne(64 * 1024);
  await until(() => ws.sent.length > stalled);
  assert.equal(ws.readyState, 1);
});

test("a ws queue beyond the hard cap closes the tunnel with a reason and one log line", async (t) => {
  const daemon = await guacd(t, [blob(0), blob(1)]);
  const ws = new FakeWs();
  ws.bufferedAmount = HARD_CAP; // a stuck client that never drains at all
  const logs = [];
  bridge(ws, structuredClone(connection), daemon.address().port, {
    log: (line) => logs.push(line),
  });
  await until(() => ws.readyState !== 1);
  assert.equal(ws.closeCall.code, 1000);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ws-queue-cap/);
  assert.match(logs[0], /bufferedAmount=\d+/);
  assert.ok(!logs[0].includes("blob"), "no instruction content is logged");
});

test("a single instruction larger than the hard cap closes the tunnel", async (t) => {
  const huge = wire(["blob", "0", "x".repeat(HARD_CAP + 1024)]);
  const daemon = await guacd(t, [huge]);
  const ws = new FakeWs();
  ws.autoDrain = true;
  const logs = [];
  bridge(ws, structuredClone(connection), daemon.address().port, {
    log: (line) => logs.push(line),
  });
  await until(() => ws.readyState !== 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ws-queue-cap/);
  assert.ok(!logs[0].includes("xxxx"), "no instruction content is logged");
  assert.equal(blobs(ws).length, 0);
});

test("a second burst after a full drain pauses guacd again, with the queue still bounded", async (t) => {
  const BLOBS = 1500;
  const first = Array.from({ length: BLOBS }, (_, i) => blob(i));
  const second = Array.from({ length: BLOBS }, (_, i) => blob(BLOBS + i));
  const daemon = await guacd(t, first);
  const upstream = captureUpstream(t);
  const ws = new FakeWs();
  t.after(bridge(ws, structuredClone(connection), daemon.address().port));
  await until(() => upstream()?.isPaused());
  await drainUntil(
    ws,
    () => blobs(ws).length === BLOBS && ws.pending.length === 0,
  );
  await until(() => !upstream().isPaused());
  assert.equal(ws.bufferedAmount, 0, "the first burst is fully drained");

  // The client stalls again while guacd sends another burst: backpressure must re-engage.
  for (const part of second) daemon.socket.write(part);
  await until(() => upstream().isPaused());
  await sleep(300);
  assert.equal(upstream().isPaused(), true, "the guacd socket is paused again");
  assert.equal(ws.readyState, 1);
  assert.ok(
    ws.bufferedAmount < HIGH_WATER + 512 * 1024,
    `queued ${ws.bufferedAmount}, growing toward the ${HARD_CAP} cap`,
  );
  const stalled = ws.sent.length;
  await sleep(200);
  assert.equal(ws.sent.length, stalled, "nothing more is read while paused");

  await drainUntil(ws, () => blobs(ws).length === 2 * BLOBS);
  assert.deepEqual(blobs(ws), [...first, ...second]);
});

test("guacd is resumed when the last pending send completes, even if bufferedAmount is still above the low-water mark", async (t) => {
  const payload = Array.from({ length: 1500 }, (_, i) => blob(i));
  const daemon = await guacd(t, payload);
  const upstream = captureUpstream(t);
  const ws = new FakeWs();
  t.after(bridge(ws, structuredClone(connection), daemon.address().port));
  await until(() => upstream()?.isPaused());
  await sleep(200);
  const stalled = ws.sent.length;
  // Complete the sends one by one, each leaving 500 KiB queued (above the low-water mark).
  while (ws.pending.length > 1) ws.flushOne(500 * 1024);
  await sleep(200);
  assert.equal(
    upstream().isPaused(),
    true,
    "still paused while a send is in flight",
  );
  assert.equal(ws.sent.length, stalled);
  // No callback is left to wait for, so waiting any longer would stall guacd forever.
  ws.flushOne(500 * 1024);
  await until(() => ws.sent.length > stalled);
  assert.equal(ws.readyState, 1);
});

test("an instruction above the old 4 MiB limit but under the hard cap is delivered", async (t) => {
  const big = wire(["blob", "0", "x".repeat(7 * MiB)]);
  const daemon = await guacd(t, [big]);
  const ws = new FakeWs();
  ws.autoDrain = true;
  const logs = [];
  t.after(
    bridge(ws, structuredClone(connection), daemon.address().port, {
      log: (line) => logs.push(line),
    }),
  );
  await until(() => blobs(ws).length === 1);
  assert.equal(blobs(ws)[0], big);
  assert.equal(ws.readyState, 1);
  assert.deepEqual(logs, []);
});

test("a failed ws.send closes the tunnel", async (t) => {
  const daemon = await guacd(t, [blob(0), blob(1)]);
  const upstream = captureUpstream(t);
  const ws = new FakeWs();
  bridge(ws, structuredClone(connection), daemon.address().port);
  await until(() => blobs(ws).length === 2);
  ws.flushOne(0, new Error("write EPIPE"));
  assert.notEqual(ws.readyState, 1);
  assert.equal(ws.closeCall.code, 1000);
  await until(() => upstream().destroyed);
});
