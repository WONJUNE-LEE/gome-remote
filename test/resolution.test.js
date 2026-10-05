import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";
import { viewer } from "./helpers/viewer-harness.js";

// Objects from the module under test live in another realm; compare them as data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const { autoSize, sizeFor, createResolution, RESIZE_DELAY_MS } =
  await loadTs("resolution.ts");

const rdp = {
  id: "linux",
  name: "Linux",
  platform: "linux",
  protocol: "rdp",
  persistent: true,
  online: true,
  ready: true,
};
const vnc = {
  ...rdp,
  id: "mac",
  name: "Mac",
  platform: "mac",
  protocol: "vnc",
};
const view = (width, height, ratio = 1) => ({ width, height, ratio });

test("auto is the window size in device pixels, rounded down to even numbers", () => {
  assert.deepEqual(plain(autoSize(view(1280, 720))), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(plain(autoSize(view(1001, 701))), {
    width: 1000,
    height: 700,
  });
  // 1001 * 1.5 = 1501.5 and 701 * 1.5 = 1051.5: floor first, then to even.
  assert.deepEqual(plain(autoSize(view(1001, 701, 1.5))), {
    width: 1500,
    height: 1050,
  });
  assert.deepEqual(plain(autoSize(view(1440, 900, 2))), {
    width: 2880,
    height: 1800,
  });
});

test("auto stays inside the gateway limits, at both ends and on bad input", () => {
  assert.deepEqual(plain(autoSize(view(100, 100))), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(plain(autoSize(view(0, 0))), { width: 640, height: 480 });
  assert.deepEqual(plain(autoSize(view(5000, 3000))), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(plain(autoSize(view(3000, 1500, 2))), {
    width: 3840,
    height: 2160,
  });
  // Exactly on a limit is kept; one pixel inside is not rounded onto it wrongly.
  assert.deepEqual(plain(autoSize(view(640, 480))), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(plain(autoSize(view(3840, 2160))), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(plain(autoSize(view(3841, 2161))), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(plain(autoSize(view(NaN, Infinity))), {
    width: 640,
    height: 480,
  });
  // A missing or zero ratio counts as 1, never as 0 (which would clamp to the minimum).
  assert.deepEqual(plain(autoSize(view(1280, 720, 0))), {
    width: 1280,
    height: 720,
  });
});

test("a fixed choice is its own size, auto is measured", () => {
  assert.deepEqual(plain(sizeFor("1920x1080", view(800, 600))), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(plain(sizeFor("auto", view(800, 600))), {
    width: 800,
    height: 600,
  });
});

// The controller with a viewport and timers the test moves.
function control({ resizable = true, initial = view(1280, 720) } = {}) {
  let viewport = initial;
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const sent = [];
  const c = createResolution({
    send: (size) => sent.push([size.width, size.height]),
    viewport: () => viewport,
    setTimer: (callback, ms) => {
      timers.set(nextTimer, { callback, at: now + ms });
      return nextTimer++;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    c,
    sent,
    timers,
    resize(next) {
      viewport = next;
      c.viewportChanged();
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
    // A session that is up with the window as it is now.
    up() {
      c.begin(autoSize(viewport), resizable);
      c.connected();
    },
  };
}

test("auto is the default choice", () => {
  assert.equal(control().c.choice, "auto");
});

test("a window resize sends the new size once, after it has been still for the delay", () => {
  const t = control();
  t.up();
  t.resize(view(1000, 700));
  t.advance(RESIZE_DELAY_MS - 1);
  assert.deepEqual(t.sent, [], "not before the delay");
  t.advance(1);
  assert.deepEqual(t.sent, [[1000, 700]]);
});

test("a window that keeps moving is sent once, with its last size", () => {
  const t = control();
  t.up();
  t.resize(view(1000, 700));
  t.advance(200);
  t.resize(view(1100, 800));
  t.advance(200);
  t.resize(view(1200, 900));
  t.advance(299);
  assert.deepEqual(t.sent, []);
  t.advance(1);
  assert.deepEqual(t.sent, [[1200, 900]]);
});

test("nothing is sent when the size did not change, including a round trip inside the delay", () => {
  const t = control();
  t.up();
  t.resize(view(1280, 720));
  t.advance(1000);
  assert.deepEqual(t.sent, [], "same as the session started with");
  t.resize(view(1000, 700));
  t.advance(100);
  t.resize(view(1280, 720));
  t.advance(1000);
  assert.deepEqual(t.sent, [], "back to the old size before the delay");
  // 1281 x 721 rounds to the same even size.
  t.resize(view(1281, 721));
  t.advance(1000);
  assert.deepEqual(t.sent, []);
  t.resize(view(1000, 700));
  t.advance(1000);
  t.resize(view(1000, 700));
  t.advance(1000);
  assert.deepEqual(t.sent, [[1000, 700]], "the same size is not sent twice");
});

test("a size that clamps to the same value as before is not sent again", () => {
  const t = control({ initial: view(4000, 2200) });
  t.up();
  t.resize(view(4200, 2400));
  t.advance(1000);
  assert.deepEqual(t.sent, []);
});

test("the window may change while connecting: the size is checked once the remote is up", () => {
  const t = control();
  t.c.begin(autoSize(view(1280, 720)), true);
  t.resize(view(900, 600));
  t.advance(1000);
  assert.deepEqual(t.sent, [], "nothing is sent before the remote is up");
  t.c.connected();
  t.advance(RESIZE_DELAY_MS);
  assert.deepEqual(t.sent, [[900, 600]]);
});

test("fixed, then auto, then fixed: each switch sends once and a fixed size ignores the window", () => {
  const t = control();
  t.up();
  assert.deepEqual(plain(t.c.choose("1920x1080")), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(t.sent, [[1920, 1080]]);
  t.resize(view(1000, 700));
  t.advance(1000);
  assert.deepEqual(
    t.sent,
    [[1920, 1080]],
    "a fixed size does not follow the window",
  );
  assert.deepEqual(plain(t.c.choose("auto")), { width: 1000, height: 700 });
  assert.deepEqual(t.sent.at(-1), [1000, 700]);
  t.resize(view(1100, 800));
  t.advance(RESIZE_DELAY_MS);
  assert.deepEqual(t.sent.at(-1), [1100, 800], "auto follows the window again");
  t.c.choose("2560x1440");
  assert.deepEqual(t.sent.at(-1), [2560, 1440]);
  assert.equal(t.sent.length, 4);
  t.resize(view(1500, 900));
  t.advance(1000);
  assert.equal(t.sent.length, 4);
});

test("switching to a fixed size cancels a resize that was waiting", () => {
  const t = control();
  t.up();
  t.resize(view(1000, 700));
  t.c.choose("1920x1080");
  t.advance(1000);
  assert.deepEqual(t.sent, [[1920, 1080]]);
});

test("switching to auto sends the current size even when it equals the last one", () => {
  const t = control();
  t.up();
  t.c.choose("1280x720");
  t.c.choose("auto");
  assert.deepEqual(t.sent, [
    [1280, 720],
    [1280, 720],
  ]);
});

test("a stopped session sends nothing, and the picker only changes the choice", () => {
  const t = control();
  t.up();
  t.resize(view(1000, 700));
  t.c.stopped();
  t.advance(1000);
  assert.deepEqual(t.sent, []);
  assert.equal(t.timers.size, 0);
  assert.deepEqual(plain(t.c.choose("1920x1080")), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(t.sent, []);
  assert.equal(t.c.choice, "1920x1080");
});

test("a session that cannot resize (VNC) never sends a size", () => {
  const t = control({ resizable: false });
  t.up();
  t.resize(view(1000, 700));
  assert.equal(t.timers.size, 0);
  t.advance(1000);
  t.c.choose("1920x1080");
  t.c.choose("auto");
  t.resize(view(900, 600));
  t.advance(1000);
  assert.deepEqual(t.sent, []);
});

// ---- the page: main.ts with a fake browser ----

test("the browser resolution picker offers auto first and selected, then the fixed sizes", async () => {
  const v = await viewer({ targets: [rdp] });
  const select = v.el("resolution");
  assert.deepEqual(
    select.options.map((o) => o.value),
    ["auto", "1440x900", "1920x1080", "2560x1440"],
  );
  assert.equal(select.value, "auto", "auto is the default");
});

test("the first session is created with the window size in device pixels", async () => {
  const v = await viewer({ targets: [rdp] });
  v.setPixelRatio(2);
  v.resizeViewport(1001, 701);
  v.tiles()[0].click();
  await v.settle();
  assert.deepEqual(plain(v.sessionRequests()), [
    { targetId: "linux", width: 2002, height: 1402 },
  ]);
});

test("the session size is clamped to the gateway limits", async () => {
  for (const [css, expected] of [
    [
      [100, 100],
      [640, 480],
    ],
    [
      [5000, 3000],
      [3840, 2160],
    ],
  ]) {
    const v = await viewer({ targets: [rdp] });
    v.resizeViewport(...css);
    v.tiles()[0].click();
    await v.settle();
    assert.deepEqual(plain(v.sessionRequests()), [
      { targetId: "linux", width: expected[0], height: expected[1] },
    ]);
  }
});

async function connected(options = {}, target = rdp) {
  const v = await viewer({ targets: [target], ...options });
  v.resizeViewport(1280, 720);
  v.tiles()[0].click();
  await v.settle();
  v.clients[0].onstatechange(3);
  return v;
}

test("while connected in auto mode, a resized window sends one debounced size", async () => {
  const v = await connected();
  const client = v.clients[0];
  v.resizeViewport(1000, 700);
  v.advance(100);
  v.resizeViewport(1100, 800);
  v.advance(299);
  assert.deepEqual(plain(client.sizes), []);
  v.advance(1);
  assert.deepEqual(plain(client.sizes), [[1100, 800]]);
  v.resizeViewport(1100, 800);
  v.advance(1000);
  assert.deepEqual(plain(client.sizes), [[1100, 800]], "unchanged: not sent");
});

test("the device pixel ratio counts in the debounced size", async () => {
  const v = await connected();
  v.setPixelRatio(2);
  v.resizeViewport(1000, 700);
  v.advance(300);
  assert.deepEqual(plain(v.clients[0].sizes), [[2000, 1400]]);
});

test("a resize before the remote is up is checked when it comes up", async () => {
  const v = await viewer({ targets: [rdp] });
  v.resizeViewport(1280, 720);
  v.tiles()[0].click();
  await v.settle();
  v.resizeViewport(900, 600);
  v.advance(1000);
  assert.deepEqual(plain(v.clients[0].sizes), []);
  v.clients[0].onstatechange(3);
  v.advance(300);
  assert.deepEqual(plain(v.clients[0].sizes), [[900, 600]]);
});

test("the picker and the native menu go fixed, auto, fixed, each sending once", async () => {
  const v = await connected({ appMode: true });
  const client = v.clients[0];
  v.action("resolution:1920x1080");
  assert.deepEqual(plain(client.sizes), [[1920, 1080]]);
  assert.equal(v.el("resolution").value, "1920x1080");
  v.resizeViewport(1000, 700);
  v.advance(1000);
  assert.deepEqual(
    plain(client.sizes),
    [[1920, 1080]],
    "fixed ignores the window",
  );
  v.action("resolution:auto");
  assert.deepEqual(plain(client.sizes).at(-1), [1000, 700]);
  assert.equal(v.el("resolution").value, "auto");
  v.resizeViewport(1200, 800);
  v.advance(300);
  assert.deepEqual(plain(client.sizes).at(-1), [1200, 800]);
  v.action("resolution:2560x1440");
  assert.deepEqual(plain(client.sizes).at(-1), [2560, 1440]);
  assert.equal(client.sizes.length, 4);
  assert.equal(v.bridgeCalls.viewerState.at(-1).resolution, "2560x1440");
  v.action("resolution:auto");
  assert.equal(v.bridgeCalls.viewerState.at(-1).resolution, "auto");
});

test("the browser select does the same as the menu", async () => {
  const v = await connected();
  const select = v.el("resolution");
  select.value = "1440x900";
  select.dispatchEvent(new Event("change"));
  assert.deepEqual(plain(v.clients[0].sizes), [[1440, 900]]);
  select.value = "auto";
  select.dispatchEvent(new Event("change"));
  assert.deepEqual(plain(v.clients[0].sizes).at(-1), [1280, 720]);
});

test("a reconnect measures the window again, and a fixed choice keeps its size", async () => {
  const v = await connected({ appMode: true });
  v.clients[0].onstatechange(5);
  v.resizeViewport(1600, 900);
  v.el("overlay-reconnect").click();
  await v.settle();
  assert.deepEqual(plain(v.sessionRequests()).at(-1), {
    targetId: "linux",
    width: 1600,
    height: 900,
  });
  v.clients[1].onstatechange(3);
  v.action("resolution:1920x1080");
  v.clients[1].onstatechange(5);
  v.resizeViewport(1000, 700);
  v.el("overlay-reconnect").click();
  await v.settle();
  assert.deepEqual(plain(v.sessionRequests()).at(-1), {
    targetId: "linux",
    width: 1920,
    height: 1080,
  });
});

test("an ended session sends nothing for a resized window", async () => {
  const v = await connected();
  v.clients[0].onstatechange(5);
  v.resizeViewport(1000, 700);
  v.advance(1000);
  assert.deepEqual(plain(v.clients[0].sizes), []);
});

test("a VNC session never sends a size and keeps the picker disabled", async () => {
  const v = await connected({ appMode: true }, vnc);
  const client = v.clients[0];
  assert.equal(v.el("resolution").disabled, true);
  assert.deepEqual(plain(v.sessionRequests()), [
    { targetId: "mac", width: 1280, height: 720 },
  ]);
  v.resizeViewport(1000, 700);
  v.advance(1000);
  v.action("resolution:1920x1080");
  v.action("resolution:auto");
  v.resizeViewport(900, 600);
  v.advance(1000);
  assert.deepEqual(plain(client.sizes), []);
  assert.equal(v.pendingTimers(), 0);
});
