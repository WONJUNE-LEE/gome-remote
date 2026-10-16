import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMITS,
  acquireLock,
  pilotVerdict,
  checkVerdict,
  flipVerdict,
  PILOT_CLICKS,
  safeRect,
  clampToRect,
  dragPath,
  viewportPoint,
  nextSoakAction,
  runSoakLoop,
  MAX_UNVERIFIED_MS,
  SAFE_HALF,
  EDGE_MARGIN,
  suspectSamples,
  readOptions,
  SOAK_GRACE_MS,
  withDeadline,
  verdictClick,
  verdictSoak,
} from "../scripts/measure-drive.mjs";

const script = fileURLToPath(
  new URL("../scripts/measure-drive.mjs", import.meta.url),
);
const env = {
  MODE: "measure",
  GATEWAY_URL: "https://gateway.example.ts.net:8451/",
};
const good = {
  n: 30,
  ok: 30,
  timeouts: 0,
  medianMs: 80,
  p95Ms: 120,
  minMs: 60,
  maxMs: 140,
  over1000ms: 0,
};

test("the thresholds are the ones fixed in the spec", () => {
  assert.deepEqual(LIMITS, {
    medianMs: 100,
    p95Ms: 150,
    maxMs: 1000,
    vncRatio: 0.6,
    freezeMs: 500,
  });
});

test("the click verdict passes at the limits and names every condition that fails", () => {
  assert.deepEqual(verdictClick(good, 200), []);
  assert.deepEqual(
    verdictClick({ ...good, medianMs: 100, p95Ms: 150 }, undefined),
    [],
  );
  assert.equal(verdictClick({ ...good, medianMs: 101 }, undefined).length, 1);
  assert.equal(verdictClick({ ...good, p95Ms: 151 }, undefined).length, 1);
  assert.equal(verdictClick({ ...good, over1000ms: 1 }, undefined).length, 1);
  assert.equal(verdictClick({ ...good, timeouts: 2 }, undefined).length, 1);
  // 0.6 x the same client's VNC median: 80 passes against 134, fails against 133.
  assert.deepEqual(verdictClick(good, 134), []);
  assert.match(verdictClick(good, 133)[0], /VNC 133/);
  assert.equal(
    verdictClick(
      { ...good, medianMs: 200, p95Ms: 300, over1000ms: 3, timeouts: 1 },
      100,
    ).length,
    5,
  );
});

test("the soak verdict allows no frame gap over 500 ms and no browser-counted freeze", () => {
  assert.deepEqual(
    verdictSoak({
      frames: 3000,
      maxGapMs: 120,
      gapsOver500ms: 0,
      freezeCount: 0,
    }),
    [],
  );
  assert.deepEqual(
    verdictSoak({
      frames: 3000,
      maxGapMs: 120,
      gapsOver500ms: 0,
      freezeCount: null,
    }),
    [],
  );
  assert.equal(
    verdictSoak({
      frames: 3000,
      maxGapMs: 800,
      gapsOver500ms: 1,
      freezeCount: 0,
    }).length,
    1,
  );
  assert.equal(
    verdictSoak({
      frames: 3000,
      maxGapMs: 120,
      gapsOver500ms: 0,
      freezeCount: 2,
    }).length,
    1,
  );
});

test("a soak whose stream stopped ends with a failure instead of waiting for a frame that never comes", async () => {
  // The page's frame report is only finished by a frame that arrives after the duration.
  const never = new Promise(() => {});
  await assert.rejects(
    withDeadline(never, 30, "no frame report"),
    /no frame report/,
  );
  assert.equal(
    await withDeadline(Promise.resolve("report"), 1000, "late"),
    "report",
  );
  await assert.rejects(
    withDeadline(Promise.reject(new Error("page closed")), 1000, "late"),
    /page closed/,
  );
  // The report is due when the driver's dragging ends; the grace leaves room for a late last frame.
  assert.equal(SOAK_GRACE_MS, 15_000);
});

test("options are checked, and the address always ends in #measure", () => {
  const o = readOptions(env);
  assert.equal(o.url, "https://gateway.example.ts.net:8451/#measure");
  assert.equal(o.n, 30);
  assert.equal(o.fx, 0.5);
  assert.equal(
    readOptions({
      ...env,
      GATEWAY_URL: "https://gateway.example.ts.net:8451/#x?y",
    }).url,
    "https://gateway.example.ts.net:8451/#measure",
  );
  assert.equal(
    readOptions({ ...env, N: "5", FLIP_X: "0.25", VNC_MEDIAN_MS: "180" })
      .vncMedianMs,
    180,
  );
  for (const bad of [
    { MODE: "run" },
    { MODE: undefined },
    { GATEWAY_URL: undefined },
    { GATEWAY_URL: "ftp://x.example/" },
    { GATEWAY_URL: "not a url" },
    { N: "0" },
    { N: "501" },
    { N: "x" },
    { FLIP_X: "1.5" },
    { FLIP_Y: "-0.1" },
    { VIEWPORT: "100x100" },
    { VIEWPORT: "big" },
    { VNC_MEDIAN_MS: "0" },
  ])
    assert.throws(
      () => readOptions({ ...env, ...bad }),
      /./,
      JSON.stringify(bad),
    );
});

test("run without arguments the script prints its usage and exits 2 without starting a browser", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GATEWAY_URL: "", PW_CORE: "/nonexistent" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mode is/);
});

test("the target page flips on every press, counts the flips, and has no transition", async () => {
  const html = await readFile(
    new URL("../scripts/measure-target.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /addEventListener\(["']mousedown/);
  assert.match(html, /\+\+n/);
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /transition\s*:|animation\s*:/);
});

test("only one driver measures at a time: a live holder refuses, a dead holder's lock is taken over, release removes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gome-lock-"));
  const path = join(dir, "lock");
  const release = acquireLock(path, 4001, () => true);
  assert.throws(() => acquireLock(path, 4002, () => true), /pid 4001/);
  release();
  assert.equal(existsSync(path), false);
  await writeFile(path, "4003");
  const takeover = acquireLock(path, 4004, (pid) => pid !== 4003);
  assert.equal(existsSync(path), true);
  // A release by a driver that no longer owns the lock leaves it alone.
  await writeFile(path, "4005");
  takeover();
  assert.equal(existsSync(path), true);
  await writeFile(path, "garbage");
  acquireLock(path, 4006, () => true)();
  assert.equal(existsSync(path), false);
});

test("the lock holds its pid from the moment it exists, and leaves no private file behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gome-lock-"));
  const path = join(dir, "lock");
  const release = acquireLock(path, 4101, () => true);
  assert.equal(await readFile(path, "utf8"), "4101");
  assert.deepEqual(await readdir(dir), ["lock"]);
  release();
  assert.deepEqual(await readdir(dir), []);
});

test("an empty lock is not stale: it is retried briefly, then refused, and a holder that appears meanwhile wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gome-lock-"));
  const path = join(dir, "lock");
  await writeFile(path, "");
  let sleeps = 0;
  assert.throws(
    () =>
      acquireLock(
        path,
        4201,
        () => false,
        () => {
          sleeps++;
        },
      ),
    /has no holder/,
  );
  assert.ok(sleeps >= 1, "it waited before giving up");
  assert.equal(existsSync(path), true, "the empty lock was left alone");
  assert.deepEqual(await readdir(dir), ["lock"], "and no private file is left");
  // The holder writes its pid while we wait: that holder is alive, so we are refused.
  assert.throws(
    () =>
      acquireLock(
        path,
        4202,
        () => true,
        () => {
          writeFileSync(path, "4203");
        },
      ),
    /pid 4203/,
  );
  assert.equal(await readFile(path, "utf8"), "4203");
});

test("of several drivers starting together exactly one gets the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gome-lock-"));
  const path = join(dir, "lock");
  const code = `
    import { acquireLock } from ${JSON.stringify(script)};
    try {
      acquireLock(${JSON.stringify(path)});
      console.log("won");
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch (error) {
      console.log("lost " + /pid \\d+/.test(error.message));
    }
  `;
  const outputs = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            code,
          ]);
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("close", () => resolve(out.trim()));
        }),
    ),
  );
  assert.equal(outputs.filter((o) => o === "won").length, 1, outputs.join(","));
  assert.equal(
    outputs.filter((o) => o === "lost true").length,
    5,
    outputs.join(","),
  );
});

test("the pilot needs every pilot click to flip: the first click that shows nothing refuses the run", () => {
  assert.equal(PILOT_CLICKS, 2);
  assert.deepEqual(pilotVerdict([90, 80]), []);
  assert.match(pilotVerdict([null])[0], /click 1 showed no flip.*in front/);
  assert.match(pilotVerdict([90, null])[0], /click 2 showed no flip/);
  assert.match(pilotVerdict([null, 90])[0], /click 1 showed no flip/);
  // Fewer clicks than expected were sent (or nothing came back): not verified.
  assert.match(pilotVerdict([90])[0], /1 of 2 clicks/);
  assert.match(pilotVerdict([])[0], /0 of 2 clicks/);
  assert.match(pilotVerdict(undefined)[0], /0 of 2 clicks/);
  // A check click is one click that must show.
  assert.deepEqual(checkVerdict([5]), []);
  assert.deepEqual(checkVerdict([0]), []);
  assert.match(checkVerdict([null])[0], /check click.*showed no flip/);
  assert.equal(checkVerdict([]).length, 1);
  assert.equal(flipVerdict([1, 2, 3], 3, "x").length, 0);
  assert.equal(flipVerdict([1, 2, undefined], 3, "x").length, 1);
});

test("impossibly fast samples are named", () => {
  assert.deepEqual(suspectSamples([60, 95, null, 20]), []);
  assert.equal(suspectSamples([60, 7.9, 12, null]).length, 1);
  assert.match(suspectSamples([60, 7.9, 12])[0], /2 samples under 20 ms/);
});

test("the target page records presses, focus and visibility changes and long frame gaps for a debugger", async () => {
  const html = await readFile(
    new URL("../scripts/measure-target.html", import.meta.url),
    "utf8",
  );
  // Code only: the page's comments name all of these too.
  const code = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /addEventListener\(["']mousedown["']/);
  assert.match(code, /note\(["']down["']/);
  assert.match(code, /addEventListener\(["']visibilitychange["']/);
  assert.match(code, /addEventListener\(["']focus["']/);
  assert.match(code, /addEventListener\(["']blur["']/);
  assert.match(code, /note\(["']frame-gap["']/);
  assert.match(code, /window\.__target\s*=/);
  // The stripping really drops comments (positive control).
  assert.doesNotMatch(code, /Read it with/);
});

test("the safe rectangle is the flip point plus or minus 0.3, never nearer the edge than 0.05", () => {
  assert.equal(SAFE_HALF, 0.3);
  assert.equal(EDGE_MARGIN, 0.05);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const centre = safeRect(0.5, 0.5);
  near(centre.x0, 0.2);
  near(centre.x1, 0.8);
  near(centre.y0, 0.2);
  near(centre.y1, 0.8);
  // Clamped at the edge margin instead of reaching the screen's edge.
  const corner = safeRect(0.1, 0.9);
  near(corner.x0, 0.05);
  near(corner.x1, 0.4);
  near(corner.y0, 0.6);
  near(corner.y1, 0.95);
  // The flip point itself on the margin is allowed; just outside it is refused.
  assert.doesNotThrow(() => safeRect(0.05, 0.95));
  for (const [x, y] of [
    [0.049, 0.5],
    [0.5, 0.951],
    [0, 0.5],
    [0.5, 1],
    [NaN, 0.5],
    [0.5, undefined],
  ])
    assert.throws(() => safeRect(x, y), RangeError, `${x},${y}`);
});

test("the options refuse a flip point near the screen's edge in every mode", () => {
  assert.throws(() => readOptions({ ...env, FLIP_X: "0.01" }), /edge/);
  assert.throws(
    () => readOptions({ ...env, MODE: "soak", FLIP_Y: "1" }),
    /edge/,
  );
  assert.equal(readOptions({ ...env, FLIP_X: "0.05" }).fx, 0.05);
});

test("a point is clamped into the rectangle, boundaries included", () => {
  const rect = { x0: 0.2, x1: 0.8, y0: 0.3, y1: 0.7 };
  assert.deepEqual(clampToRect({ x: 0.5, y: 0.5 }, rect), { x: 0.5, y: 0.5 });
  assert.deepEqual(clampToRect({ x: 0.2, y: 0.7 }, rect), { x: 0.2, y: 0.7 });
  assert.deepEqual(clampToRect({ x: 0.19, y: 0.71 }, rect), { x: 0.2, y: 0.7 });
  assert.deepEqual(clampToRect({ x: 0.81, y: 0.29 }, rect), { x: 0.8, y: 0.3 });
  assert.deepEqual(clampToRect({ x: -5, y: 9 }, rect), { x: 0.2, y: 0.7 });
  assert.deepEqual(clampToRect({ x: NaN, y: Infinity }, rect), {
    x: 0.2,
    y: 0.3,
  });
});

test("every drag starts and ends inside the safe rectangle, for any flip point and any drag number", () => {
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.05, 0.05],
    [0.95, 0.95],
    [0.1, 0.9],
    [0.3, 0.6],
  ]) {
    const rect = safeRect(fx, fy);
    for (const i of [0, 1, 9, 10, 11, 99, 1234567, -3, 2.7]) {
      const { from, to } = dragPath(i, rect);
      for (const p of [from, to]) {
        assert.ok(p.x >= rect.x0 && p.x <= rect.x1, `x ${p.x} ${fx}`);
        assert.ok(p.y >= rect.y0 && p.y <= rect.y1, `y ${p.y} ${fy}`);
        assert.ok(p.x >= EDGE_MARGIN && p.x <= 1 - EDGE_MARGIN);
        assert.ok(p.y >= EDGE_MARGIN && p.y <= 1 - EDGE_MARGIN);
      }
    }
  }
});

test("a place of the screen maps onto the letterboxed picture in the viewer, not onto the black bars", () => {
  const box = { left: 0, top: 0, width: 1920, height: 1080 };
  // A 4:3 Mac in a 16:9 viewer: black bars of 240 px on each side.
  const video = { width: 1024, height: 768 };
  assert.deepEqual(viewportPoint({ x: 0, y: 0 }, box, video), { x: 240, y: 0 });
  assert.deepEqual(viewportPoint({ x: 1, y: 1 }, box, video), {
    x: 1680,
    y: 1080,
  });
  assert.deepEqual(viewportPoint({ x: 0.5, y: 0.5 }, box, video), {
    x: 960,
    y: 540,
  });
  assert.throws(() =>
    viewportPoint({ x: 0.5, y: 0.5 }, box, { width: 0, height: 0 }),
  );
});

const GOOD_STATE = {
  connected: true,
  frameCallback: true,
  frameWatching: true,
};

test("the next soak step: check before a drag could end after 5 s unverified, stop on any unexpected state", () => {
  const at = (now, extra = {}) =>
    nextSoakAction({
      now,
      endAt: 60_000,
      lastVerifiedAt: 0,
      dragMs: 1000,
      state: GOOD_STATE,
      ...extra,
    }).action;
  assert.equal(MAX_UNVERIFIED_MS, 5000);
  assert.equal(at(0), "drag");
  assert.equal(
    at(4000),
    "drag",
    "a 1 s drag from 4.0 s ends at 5.0 s: allowed",
  );
  assert.equal(at(4001), "check");
  assert.equal(at(5000), "check");
  assert.equal(at(4001, { dragMs: 500 }), "drag");
  assert.equal(at(4501, { dragMs: 500 }), "check");
  assert.equal(at(7000, { lastVerifiedAt: 6000 }), "drag", "verified again");
  assert.equal(at(60_000, { lastVerifiedAt: 59_000 }), "done");
  for (const [state, reason] of [
    [{ ...GOOD_STATE, connected: false }, /session ended/],
    [{ ...GOOD_STATE, frameCallback: false }, /frame callback/],
    [{ ...GOOD_STATE, frameWatching: false }, /frame report ended early/],
    [undefined, /session ended/],
  ]) {
    const step = nextSoakAction({
      now: 0,
      endAt: 60_000,
      lastVerifiedAt: 0,
      dragMs: 1000,
      state,
    });
    assert.equal(step.action, "stop");
    assert.match(step.reason, reason);
  }
  // An unexpected state wins over a finished soak.
  assert.equal(
    at(70_000, { state: { ...GOOD_STATE, connected: false } }),
    "stop",
  );
});

// A virtual machine for the soak loop: time passes by drags (`dragCost`) and checks
// (`checkCost`); `checkResults` says which check clicks flip.
function soakLab({
  dragCost = 300,
  checkCost = 700,
  checkResults = [],
  state,
} = {}) {
  let t = 0;
  const log = [];
  let lastVerified = 0;
  let nChecks = 0;
  const lab = {
    log,
    maxUnverified: 0,
    io: {
      now: () => t,
      state: async () => (state ? state(t) : GOOD_STATE),
      async drag(i) {
        log.push(`drag${i}`);
        t += dragCost;
        lab.maxUnverified = Math.max(lab.maxUnverified, t - lastVerified);
      },
      async check() {
        const verifiedAt = t;
        log.push("check");
        t += checkCost;
        const ok = checkResults[nChecks++] ?? true;
        if (ok) lastVerified = verifiedAt;
        return ok;
      },
      async release() {
        log.push("release");
      },
    },
  };
  return lab;
}
const soakWindow = { endAt: 600_000, verifiedAt: 0 };

test("a soak whose checks all flip runs to its end and never goes 5 s without a verified flip", async () => {
  const l = soakLab({});
  const r = await runSoakLoop(l.io, { endAt: 60_000, verifiedAt: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.checks >= 60_000 / 5000, `${r.checks} checks`);
  assert.ok(l.maxUnverified <= MAX_UNVERIFIED_MS, `${l.maxUnverified} ms`);
  assert.ok(!l.log.includes("release"));
});

test("a slow drag brings the check forward, so the 5 s bound holds", async () => {
  const l = soakLab({ dragCost: 2200 });
  const r = await runSoakLoop(l.io, { endAt: 60_000, verifiedAt: 0 });
  assert.equal(r.ok, true);
  assert.ok(l.maxUnverified <= MAX_UNVERIFIED_MS, `${l.maxUnverified} ms`);
});

test("the first failed check stops all input at once and releases the button", async () => {
  // The 3rd check does not flip: the flip page went behind another window.
  const l = soakLab({ checkResults: [true, true, false, true, true] });
  const r = await runSoakLoop(l.io, soakWindow);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no flip.*no longer in front/);
  assert.equal(r.checks, 3);
  assert.equal(l.log.filter((e) => e === "check").length, 3);
  const afterFail = l.log.slice(l.log.lastIndexOf("check") + 1);
  assert.deepEqual(
    afterFail,
    ["release"],
    "only the release follows the failed check",
  );
});

test("a check that throws counts as a failed check", async () => {
  const l = soakLab({});
  l.io.check = async () => {
    l.log.push("check");
    throw new Error("page closed");
  };
  const r = await runSoakLoop(l.io, soakWindow);
  assert.equal(r.ok, false);
  assert.deepEqual(l.log.slice(-2), ["check", "release"]);
});

test("an unexpected state (session ended, frame callback missing, frame report gone) stops the input before the next drag", async () => {
  for (const [bad, reason] of [
    [{ ...GOOD_STATE, connected: false }, /session ended/],
    [{ ...GOOD_STATE, frameCallback: false }, /frame callback/],
    [{ ...GOOD_STATE, frameWatching: false }, /ended early/],
  ]) {
    // Fine for 2 s of dragging, then bad.
    const l = soakLab({ state: (t) => (t < 2000 ? GOOD_STATE : bad) });
    const r = await runSoakLoop(l.io, soakWindow);
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
    assert.equal(l.log.at(-1), "release");
    assert.equal(l.log.filter((e) => e.startsWith("drag")).length, r.drags);
    assert.ok(r.drags <= 7, "no drag was started after the state turned bad");
  }
  // A state that cannot be read is unexpected too: no input at all.
  const l = soakLab({
    state: () => {
      throw new Error("page crashed");
    },
  });
  const r = await runSoakLoop(l.io, soakWindow);
  assert.equal(r.ok, false);
  assert.equal(r.drags, 0);
  assert.deepEqual(l.log, ["release"]);
});

test("a drag that throws stops the soak and releases the button", async () => {
  const l = soakLab({});
  l.io.drag = async (i) => {
    l.log.push(`drag${i}`);
    throw new Error("mouse down failed");
  };
  const r = await runSoakLoop(l.io, soakWindow);
  assert.equal(r.ok, false);
  assert.deepEqual(l.log, ["drag0", "release"]);
});
