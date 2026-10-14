import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

// A document that fails the test on any use, to prove that nothing is touched.
const forbidden = new Proxy(
  {},
  {
    get(_target, name) {
      throw new Error(`document.${String(name)} used`);
    },
  },
);
const measure = await loadTs("measure.ts", { document: forbidden });
const {
  wantsMeasure,
  summarise,
  runMeasure,
  changed,
  initMeasure,
  CHANGE_THRESHOLD,
} = measure;

test("only a #measure token in the address turns the mode on", () => {
  for (const hash of [
    "#measure",
    "#a=1&measure",
    "#measure&a=1",
    "#x&measure&y",
  ])
    assert.equal(wantsMeasure(hash), true, hash);
  for (const hash of [
    "",
    "#",
    "#measured",
    "#nomeasure",
    "#a=measure",
    "?measure",
    "#measure=1",
    "#Measure",
    "measure",
  ])
    assert.equal(wantsMeasure(hash), false, hash);
});

test("without #measure the panel does not exist: no element, no listener, no global, no timer", () => {
  let published = 0;
  let asked = 0;
  for (const hash of ["", "#", "#other", "#measured"])
    assert.equal(
      initMeasure({
        hash,
        source: () => {
          asked++;
        },
        publish: () => published++,
        clock: {
          now: () => assert.fail("the clock was read"),
          poll: () => assert.fail("a poll was scheduled"),
          sleep: () => assert.fail("a timer was started"),
        },
      }),
      false,
      hash,
    );
  assert.equal(published, 0);
  assert.equal(asked, 0);
  // The document proxy above would have thrown on any access.
});

// Every way a page could be touched, as recording stand-ins; `used` lists what was
// reached, so a positive control can show that the tripwires work.
function tripwires() {
  const used = [];
  const recorder = (path) =>
    new Proxy(function () {}, {
      get: (_t, property) => {
        if (typeof property === "symbol") return undefined;
        used.push(`${path}.${property}`);
        return recorder(`${path}.${property}`);
      },
      set: (_t, property) => {
        used.push(`${path}.${property}=`);
        return true;
      },
      apply: () => {
        used.push(`${path}()`);
        return recorder(`${path}()`);
      },
      construct: () => {
        used.push(`new ${path}`);
        return recorder(`new ${path}`);
      },
    });
  const globals = {};
  for (const name of [
    "MessageChannel",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "addEventListener",
    "performance",
    "document",
    "location",
    "fetch",
  ])
    globals[name] = recorder(name);
  return { globals, used };
}

// The names the module's global scope has: its own declarations, plus anything it adds later.
const scope = (m) => Object.keys(m.__sandbox).sort();

test("without #measure the module touches no global at all: no document, listener, timer, port or published API", async () => {
  const t = tripwires();
  const m = await loadTs("measure.ts", t.globals);
  const before = scope(m);
  for (const hash of ["", "#", "#other", "#measured", "#a=measure"])
    assert.equal(
      m.initMeasure({
        hash,
        source: () => assert.fail("a source was asked for"),
        soak: () => assert.fail("a soak was started"),
      }),
      false,
      hash,
    );
  assert.deepEqual(t.used, []);
  assert.deepEqual(scope(m), before, "no global was published");
});

test("the tripwires do notice a panel being shown (positive control)", async () => {
  const t = tripwires();
  const m = await loadTs("measure.ts", t.globals);
  const before = scope(m);
  m.initMeasure({ hash: "#measure", source: () => undefined });
  assert.ok(
    t.used.some((u) => u.startsWith("document.")),
    t.used.join(),
  );
  assert.deepEqual(
    scope(m).filter((k) => !before.includes(k)),
    ["__gomeMeasure"],
  );
});

test("the changed-pixel rule is the VNC baseline's: more than 60 on one channel", () => {
  assert.equal(CHANGE_THRESHOLD, 60);
  assert.equal(changed([0, 0, 0], [60, 0, 0]), false);
  assert.equal(changed([0, 0, 0], [61, 0, 0]), true);
  assert.equal(changed([200, 0, 0], [0, 0, 62]), true);
  assert.equal(
    changed([10, 10, 10], [40, 40, 40]),
    false,
    "small changes on all channels do not count",
  );
});

test("the summary uses the same quantile rule as the earlier VNC measurement and counts samples over a second", () => {
  const s = plain(summarise([100, 80, null, 120, 1500, 90, 60, 70, 110, 95]));
  assert.deepEqual(s, {
    n: 10,
    ok: 9,
    timeouts: 1,
    medianMs: 95,
    p95Ms: 1500,
    minMs: 60,
    maxMs: 1500,
    over1000ms: 1,
  });
  const empty = plain(summarise([null, null]));
  assert.equal(empty.ok, 0);
  assert.equal(empty.medianMs, null);
  assert.equal(plain(summarise([])).n, 0);
});

// A virtual clock and a screen whose pixel changes `delay` ms after each click.
function lab({ delay, readable = true, pollCost = 1 }) {
  let t = 0;
  const clicks = [];
  const reads = [];
  const sleeps = [];
  let flipAt = Infinity;
  let colour = 0;
  const source = {
    readPixel(fx, fy) {
      reads.push([fx, fy]);
      if (!readable) return undefined;
      if (t >= flipAt) {
        colour = 255 - colour;
        flipAt = Infinity;
      }
      return [colour, colour, colour];
    },
    sendClick(fx, fy) {
      clicks.push([fx, fy, t]);
      flipAt = delay === null ? Infinity : t + delay;
    },
  };
  const clock = {
    now: () => t,
    poll: (step) => {
      t += pollCost;
      step();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { source, clock, clicks, reads, sleeps };
}
const options = { n: 5, fx: 0.25, fy: 0.75, pauseMs: 700, timeoutMs: 3000 };

test("each sample is the time from the click to the first poll that sees the pixel change", async () => {
  const l = lab({ delay: 77 });
  const { summary, samples } = await runMeasure(l.source, l.clock, options);
  assert.deepEqual(plain(samples), [77, 77, 77, 77, 77]);
  assert.equal(summary.medianMs, 77);
  assert.equal(
    l.clicks.length,
    5,
    "one click per sample: the page's click count equals the sample count",
  );
  assert.deepEqual(
    l.clicks.map(([fx, fy]) => [fx, fy]),
    Array(5).fill([0.25, 0.75]),
  );
  assert.deepEqual(l.sleeps, Array(5).fill(700));
});

test("a polling step coarser than the delay still reports the first poll that saw it", async () => {
  const l = lab({ delay: 10, pollCost: 4 });
  const { samples } = await runMeasure(l.source, l.clock, { ...options, n: 1 });
  assert.deepEqual(
    plain(samples),
    [12],
    "polls at 4, 8, 12: the change is seen at 12",
  );
});

test("a pixel that never changes is a timeout, and so is a screen with no picture", async () => {
  const never = lab({ delay: null });
  const a = await runMeasure(never.source, never.clock, { ...options, n: 2 });
  assert.deepEqual(plain(a.samples), [null, null]);
  assert.equal(a.summary.timeouts, 2);
  const blank = lab({ delay: 10, readable: false });
  const b = await runMeasure(blank.source, blank.clock, { ...options, n: 2 });
  assert.deepEqual(plain(b.samples), [null, null]);
  assert.equal(
    blank.clicks.length,
    0,
    "no click is sent when there is nothing to read",
  );
});

// A video and a Guacamole canvas, both showing a pixel that flips `delay` ms after a click
// on a shared virtual clock, measured through one counting clock.
function bothSources(delay) {
  let t = 0;
  let flipAt = Infinity;
  let colour = 0;
  const current = () => {
    if (t >= flipAt) {
      colour = 255 - colour;
      flipAt = Infinity;
    }
    return colour;
  };
  const press = () => {
    flipAt = t + delay;
  };
  const document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: [current(), 0, 0, 255] }),
      }),
    }),
  };
  const canvas = {
    width: 100,
    height: 100,
    getContext: () => ({
      getImageData: () => ({ data: [current(), 0, 0, 255] }),
    }),
  };
  const polls = { count: 0, steps: [] };
  const clock = {
    now: () => t,
    poll: (step) => {
      polls.count++;
      t += 1;
      step();
    },
    sleep: async (ms) => {
      t += ms;
    },
  };
  const client = {
    getDisplay: () => ({ getWidth: () => 100, getHeight: () => 100 }),
    sendMouseState: (state) => state.left && press(),
  };
  return { document, canvas, client, clock, polls, press };
}

test("the Mac (video) and Guacamole readers are timed by the same loop: equal behaviour gives equal samples and equal poll counts", async () => {
  const results = [];
  for (const kind of ["video", "guacamole"]) {
    const lab = bothSources(143);
    const m = await loadTs("measure.ts", { document: lab.document });
    const source =
      kind === "video"
        ? m.videoSource({ videoWidth: 100, videoHeight: 100 }, lab.press)
        : m.guacamoleSource(lab.client, {
            querySelectorAll: () => [lab.canvas],
          });
    const run = await m.runMeasure(source, lab.clock, options);
    results.push({ run: plain(run), polls: lab.polls.count });
  }
  assert.deepEqual(results[0].run.samples, [143, 143, 143, 143, 143]);
  assert.deepEqual(results[1], results[0]);
  assert.ok(
    results[0].polls >= 5 * 143,
    "the clock the loop polls with was really used: one poll per millisecond waited",
  );
});

test("a source cannot carry its own timing: readers expose only readPixel and sendClick", async () => {
  const lab = bothSources(1);
  const m = await loadTs("measure.ts", { document: lab.document });
  const video = m.videoSource({ videoWidth: 1, videoHeight: 1 }, () => {});
  const guac = m.guacamoleSource(lab.client, { querySelectorAll: () => [] });
  assert.deepEqual(Object.keys(video).sort(), ["readPixel", "sendClick"]);
  assert.deepEqual(Object.keys(guac).sort(), ["readPixel", "sendClick"]);
});

// ---- the panel, with a minimal document ----

function fakeDocument() {
  const made = [];
  const node = (tag) => ({
    tag,
    children: [],
    style: {},
    value: "",
    textContent: "",
    append(...c) {
      this.children.push(...c);
    },
  });
  return {
    made,
    document: {
      createElement: (tag) => {
        const n = node(tag);
        made.push(n);
        return n;
      },
      body: node("body"),
    },
  };
}

test("with #measure the panel appears and runs the measurement on demand through the published functions", async () => {
  const d = fakeDocument();
  const m = await loadTs("measure.ts", {
    document: d.document,
    MessageChannel,
    performance,
    setTimeout,
  });
  const l = lab({ delay: 88, pollCost: 1 });
  let api;
  const shown = m.initMeasure({
    hash: "#measure",
    source: () => l.source,
    clock: l.clock,
    publish: (a) => (api = a),
  });
  assert.equal(shown, true);
  assert.equal(d.document.body.children.length, 1);
  assert.equal(d.document.body.children[0].id, "measure-panel");
  const result = await api.run({ n: 3, pauseMs: 10 });
  assert.deepEqual(plain(result.samples), [88, 88, 88]);
  assert.equal(l.clicks.length, 3);
  assert.equal(plain(api.results.summary).medianMs, 88);
});

test("with no session on screen the panel says so instead of measuring", async () => {
  const d = fakeDocument();
  const m = await loadTs("measure.ts", { document: d.document });
  let api;
  m.initMeasure({
    hash: "#measure",
    source: () => undefined,
    clock: lab({ delay: 1 }).clock,
    publish: (a) => (api = a),
  });
  assert.equal(await api.run(), undefined);
});

test("the Guacamole reader takes the largest canvas and clicks through the client like a user", () => {
  const canvas = (w, h, r) => ({
    width: w,
    height: h,
    getContext: () => ({
      getImageData: (x, y) => ({ data: [r + x, y, 0, 255] }),
    }),
  });
  const root = {
    querySelectorAll: () => [
      canvas(10, 10, 1),
      canvas(1920, 1080, 100),
      canvas(640, 480, 5),
    ],
  };
  const client = fakeGuacamoleClient({ width: 1920, height: 1080, scale: 1 });
  const source = measure.guacamoleSource(client, root);
  assert.deepEqual(
    plain(source.readPixel(0.5, 0.5)),
    [100 + 960, 540, 0],
    "the 1920x1080 canvas, at its middle",
  );
  assert.equal(
    source.readPixel(1, 1)[0],
    100 + 1919,
    "the last pixel is clamped inside the canvas",
  );
  source.sendClick(0.25, 0.5);
  assert.deepEqual(
    client.sent.map((s) => [s.remoteX, s.remoteY, s.left]),
    [
      [480, 540, true],
      [480, 540, false],
    ],
    "a press and a release at the intended remote pixel",
  );
  const none = measure.guacamoleSource(client, { querySelectorAll: () => [] });
  assert.equal(none.readPixel(0.5, 0.5), undefined);
});

test("a scaled Guacamole display still receives the click at the intended remote pixel", () => {
  for (const scale of [0.5, 0.75, 1, 2]) {
    const client = fakeGuacamoleClient({ width: 1920, height: 1080, scale });
    const source = measure.guacamoleSource(client, {
      querySelectorAll: () => [],
    });
    source.sendClick(0.25, 0.5);
    assert.deepEqual(
      client.sent.map((s) => [s.remoteX, s.remoteY, s.left]),
      [
        [480, 540, true],
        [480, 540, false],
      ],
      `at display scale ${scale}`,
    );
  }
});

// A client that maps a mouse state to the remote pixel the way Guacamole.Client does:
// with applyDisplayScale the coordinates are divided by the display scale (they are
// then taken to be in scaled, on-screen units), without it they are remote pixels.
function fakeGuacamoleClient({ width, height, scale }) {
  const sent = [];
  return {
    sent,
    getDisplay: () => ({
      getWidth: () => width,
      getHeight: () => height,
      getScale: () => scale,
    }),
    sendMouseState: (state, applyDisplayScale) =>
      sent.push({
        remoteX: Math.floor(applyDisplayScale ? state.x / scale : state.x),
        remoteY: Math.floor(applyDisplayScale ? state.y / scale : state.y),
        left: state.left,
      }),
  };
}

test("the video reader copies one source pixel and reads nothing before the video has a size", async () => {
  const draws = [];
  const context = {
    drawImage: (...args) => draws.push(args.slice(1)),
    getImageData: () => ({ data: [9, 8, 7, 255] }),
  };
  const document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  const { videoSource } = await loadTs("measure.ts", { document });
  {
    const video = { videoWidth: 0, videoHeight: 0 };
    const clicks = [];
    const source = videoSource(video, (...a) => clicks.push(a));
    assert.equal(source.readPixel(0.5, 0.5), undefined);
    video.videoWidth = 2560;
    video.videoHeight = 1440;
    assert.deepEqual(plain(source.readPixel(0.5, 0.25)), [9, 8, 7]);
    assert.deepEqual(draws[0], [1280, 360, 1, 1, 0, 0, 1, 1]);
    source.readPixel(1, 1);
    assert.deepEqual(
      draws[1].slice(0, 4),
      [2559, 1439, 1, 1],
      "clamped inside the frame",
    );
    source.sendClick(0.1, 0.2);
    assert.deepEqual(clicks, [[0.1, 0.2]]);
  }
});
