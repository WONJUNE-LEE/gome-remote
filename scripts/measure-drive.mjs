// Drives the page's measurement mode (src/measure.ts) from a headless Chrome, for the
// verification runs V1 to V3 of the Mac agent spec (section 8). It needs playwright-core,
// which is deliberately not a dependency of this repository:
//
//   PW_CORE=/path/to/node_modules/playwright-core \
//   GATEWAY_URL=https://your-server.your-tailnet.ts.net:8451/ \
//   TILE_MATCH='새 방식' node scripts/measure-drive.mjs measure
//
// Modes: `measure` (click-to-picture, N clicks) and `soak` (60 s of dragging and scrolling,
// reporting the frame gaps). Run it once per tile (Mac agent, then Mac (VNC) with
// TILE_MATCH='VNC') and compare the medians. On the Mac, the page scripts/measure-target.html
// must be open full screen in front: the Mac's pointer is moved by the clicks.
//
// Safety: this script injects real input into the Mac it measures, so it never injects any
// unless the flip page is verifiably in front. Every mode starts with pilot clicks that must
// each flip the page; the soak keeps its drags inside a safe rectangle around the flip point
// and clicks the flip point again to re-verify at least every 5 s. The first click that shows
// no flip, or any unexpected state (session ended, no frame callback), stops all input.
import { createRequire } from "node:module";
import {
  linkSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The thresholds are fixed before measuring and are not moved to fit a result (spec S2, S3).
export const LIMITS = {
  medianMs: 100,
  p95Ms: 150,
  maxMs: 1000,
  vncRatio: 0.6,
  freezeMs: 500,
};

export function readOptions(env) {
  const mode = env.MODE;
  if (!["measure", "soak"].includes(mode))
    throw new Error("The mode is `measure` or `soak`.");
  if (!env.GATEWAY_URL) throw new Error("GATEWAY_URL is required.");
  const url = new URL(env.GATEWAY_URL);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("GATEWAY_URL must be an http(s) address.");
  const number = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`${name} must be a number from ${min} to ${max}.`);
    return value;
  };
  const [vw, vh] = (env.VIEWPORT || "1920x1080").split("x").map(Number);
  if (!(vw >= 640 && vh >= 480))
    throw new Error("VIEWPORT is WxH, at least 640x480.");
  // The first click is unverified input: it goes nowhere near the screen's edge.
  safeRect(number("FLIP_X", 0.5, 0, 1), number("FLIP_Y", 0.5, 0, 1));
  return {
    mode,
    url: `${url.origin}${url.pathname}#measure`,
    tile: new RegExp(env.TILE_MATCH || "mac", "i"),
    n: number("N", 30, 1, 500),
    fx: number("FLIP_X", 0.5, 0, 1),
    fy: number("FLIP_Y", 0.5, 0, 1),
    pauseMs: number("PAUSE_MS", 1200, 100, 10_000),
    soakSeconds: number("SOAK_SECONDS", 60, 5, 600),
    vncMedianMs:
      env.VNC_MEDIAN_MS === undefined
        ? undefined
        : number("VNC_MEDIAN_MS", 0, 1, 100_000),
    viewport: { width: vw, height: vh },
    out: env.OUT_JSON,
    shots: env.SHOT_PREFIX || "/tmp/gome-measure",
  };
}

// S2 for one client and one run of 30 clicks; `vncMedianMs` is the same client's VNC median
// from the same time of day. Returns the failed conditions (empty: passed).
export function verdictClick(summary, vncMedianMs) {
  const failed = [];
  if (summary.timeouts > 0)
    failed.push(`${summary.timeouts} clicks never showed`);
  if (summary.medianMs > LIMITS.medianMs)
    failed.push(`median ${summary.medianMs} ms > ${LIMITS.medianMs}`);
  if (summary.p95Ms > LIMITS.p95Ms)
    failed.push(`p95 ${summary.p95Ms} ms > ${LIMITS.p95Ms}`);
  if (summary.over1000ms > 0)
    failed.push(`${summary.over1000ms} samples over 1 s`);
  if (
    vncMedianMs !== undefined &&
    summary.medianMs > vncMedianMs * LIMITS.vncRatio
  )
    failed.push(
      `median ${summary.medianMs} ms > ${LIMITS.vncRatio} x VNC ${vncMedianMs} ms`,
    );
  return failed;
}

// Two drivers clicking the same Mac at once flip the target page twice per click (the
// flips cancel, so clicks "never show", and one session sees the other's flips as
// impossibly fast answers). One measurement at a time per machine running this script:
// a lock file holds the pid of the driver that is running.
export const LOCK_PATH = join(tmpdir(), "gome-measure.lock");
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The lock is created in one step with the pid already inside (written to a private file that
// is then hard-linked to the lock path), so no driver can ever read a lock that is still
// empty and mistake it for a stale one. An empty or unreadable holder (a lock not made by this
// code) is retried for a short while and never treated as stale. A holder that is not a live
// process is stale; it is moved out of the way and checked before it is deleted, so a driver
// that took the lock meanwhile does not lose it.
export function acquireLock(
  path = LOCK_PATH,
  pid = process.pid,
  alive = processAlive,
  sleep = sleepSync,
) {
  const mine = `${path}.${process.pid}.${pid}.tmp`;
  writeFileSync(mine, String(pid));
  const release = () => {
    try {
      if (readFileSync(path, "utf8") === String(pid)) unlinkSync(path);
    } catch {}
  };
  try {
    let unreadable = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        linkSync(mine, path);
        return release;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let text;
      try {
        text = readFileSync(path, "utf8").trim();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        continue; // released between the link and the read: try again
      }
      if (text === "") {
        if (++unreadable > 5)
          throw new Error(
            `the lock ${path} has no holder; remove it if no measurement is running`,
          );
        sleep(20);
        continue;
      }
      const holder = Number(text);
      if (Number.isInteger(holder) && holder > 0 && alive(holder))
        throw new Error(
          `another measurement is running (pid ${holder}); two sessions clicking the same Mac spoil both`,
        );
      // Stale: its driver is gone. Move it aside first, so that what is deleted is what was judged.
      const grave = `${path}.${process.pid}.stale`;
      try {
        renameSync(path, grave);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (readFileSync(grave, "utf8").trim() === text) unlinkSync(grave);
      else {
        try {
          linkSync(grave, path); // a fresh lock of another driver: put it back
        } catch {}
        unlinkSync(grave);
      }
    }
    throw new Error(`could not take the lock ${path}`);
  } finally {
    unlinkSync(mine);
  }
}

// Input is only allowed while the flip page is verifiably in front. A "verification" is a
// click at the flip point whose flip shows within the timeout. `samples` are the click
// timings of one verification (null: no flip); `expected` clicks must all have been sent
// and all have shown, so the first click that shows nothing refuses everything after it.
// A page covered by a window or a dialog, behind another window, or not under the clicked
// place gets no flip at all.
export const PILOT_CLICKS = 2;
export const PILOT_TIMEOUT_MS = 3000;
export const CHECK_TIMEOUT_MS = 2000;
// Before a check click the last drag's flip must have been shown, or it could pass for the check's.
export const SETTLE_MS = 500;
export function flipVerdict(samples, expected, what) {
  const hint =
    "the flip page (scripts/measure-target.html) is not under the clicked place or not in front on the Mac (a window or a dialog may cover it)";
  const list = Array.isArray(samples) ? samples : [];
  const lost = list.findIndex((s) => s === null || s === undefined);
  if (lost !== -1)
    return [`${what}: click ${lost + 1} showed no flip: ${hint}`];
  if (list.length < expected)
    return [
      `${what}: ${list.length} of ${expected} clicks were sent (${hint})`,
    ];
  return [];
}
export const pilotVerdict = (samples) =>
  flipVerdict(samples, PILOT_CLICKS, "pilot");
export const checkVerdict = (samples) => flipVerdict(samples, 1, "check click");

// Nothing real answers a click in under this; a sample below it is another session's flip.
export const IMPOSSIBLY_FAST_MS = 20;
export function suspectSamples(samples) {
  const fast = samples.filter((s) => s !== null && s < IMPOSSIBLY_FAST_MS);
  return fast.length
    ? [
        `${fast.length} samples under ${IMPOSSIBLY_FAST_MS} ms: something else is clicking or flipping the same page; discard this run`,
      ]
    : [];
}

// The page ends its frame report with the first frame after the soak's duration, so a stream
// that stopped never produces it. The driver waits this long once its own dragging (which lasts
// the duration) is over, then fails.
export const SOAK_GRACE_MS = 15_000;

// `promise`, or a rejection with `message` once `ms` have passed; the timer never outlives it.
export function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ---- the soak's safety: where it may drag and when it must prove the page is in front ----

// Drags stay inside a rectangle around the flip point (fractions of the Mac's screen, where
// the flip page fills it): the flip point plus or minus SAFE_HALF, never nearer the screen's
// edge than EDGE_MARGIN (the menu bar, the Dock and the hot corners live at the edge).
export const SAFE_HALF = 0.3;
export const EDGE_MARGIN = 0.05;
export function safeRect(fx, fy) {
  const inside = (v) =>
    Number.isFinite(v) && v >= EDGE_MARGIN && v <= 1 - EDGE_MARGIN;
  if (!inside(fx) || !inside(fy))
    throw new RangeError(
      `the flip point (${fx}, ${fy}) must be at least ${EDGE_MARGIN} from every screen edge`,
    );
  const lo = (v) => Math.max(EDGE_MARGIN, v - SAFE_HALF);
  const hi = (v) => Math.min(1 - EDGE_MARGIN, v + SAFE_HALF);
  return { x0: lo(fx), x1: hi(fx), y0: lo(fy), y1: hi(fy) };
}
export function clampToRect(point, rect) {
  const cut = (v, lo, hi) =>
    Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return {
    x: cut(point.x, rect.x0, rect.x1),
    y: cut(point.y, rect.y0, rect.y1),
  };
}
// The i-th drag: from the left edge of the rectangle, at a height that steps down it, to the
// right edge at the middle. Every point is clamped, so no drag starts or ends outside.
export function dragPath(i, rect) {
  const step = (Math.abs(Math.trunc(i)) % 10) / 10;
  return {
    from: clampToRect(
      { x: rect.x0, y: rect.y0 + (rect.y1 - rect.y0) * step },
      rect,
    ),
    to: clampToRect({ x: rect.x1, y: (rect.y0 + rect.y1) / 2 }, rect),
  };
}
// A fraction of the remote picture as a point of the viewer's viewport: the picture is the
// video letterboxed (object-fit: contain) in the viewer's `box`, as src/agent-input.ts has it.
export function viewportPoint(point, box, video) {
  if (!(video.width > 0 && video.height > 0 && box.width > 0 && box.height > 0))
    throw new Error(
      "the viewer has no picture to map a place of the screen onto",
    );
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const w = video.width * scale;
  const h = video.height * scale;
  return {
    x: box.left + (box.width - w) / 2 + point.x * w,
    y: box.top + (box.height - h) / 2 + point.y * h,
  };
}

// No more than this may pass between a verified flip and any input that follows it.
export const MAX_UNVERIFIED_MS = 5000;
// What the next step of the soak is. `dragMs` is the longest drag so far (a drag is only
// started if it would end inside the window), `state` says whether the session is still
// what the soak needs; anything else stops the input.
export function nextSoakAction({ now, endAt, lastVerifiedAt, dragMs, state }) {
  if (!state?.connected) return { action: "stop", reason: "the session ended" };
  if (!state.frameCallback)
    return {
      action: "stop",
      reason: "the browser has no video frame callback",
    };
  if (!state.frameWatching)
    return { action: "stop", reason: "the frame report ended early" };
  if (now >= endAt) return { action: "done" };
  if (now - lastVerifiedAt + dragMs > MAX_UNVERIFIED_MS)
    return { action: "check" };
  return { action: "drag" };
}

// The soak's loop with everything it touches passed in. Stops on the first unverified input:
// a failed or throwing check, an unexpected state, or a drag that throws. On every way out
// but a normal end `io.release()` lets go of whatever button is held, and no input follows.
// io: now(), state(), drag(i), check() (true: the flip showed), release().
export async function runSoakLoop(io, { endAt, verifiedAt }) {
  let lastVerifiedAt = verifiedAt;
  let dragMs = 1000;
  let drags = 0;
  let checks = 0;
  const stop = async (reason) => {
    try {
      await io.release();
    } catch {}
    return { ok: false, reason, drags, checks };
  };
  for (;;) {
    let step;
    try {
      step = nextSoakAction({
        now: io.now(),
        endAt,
        lastVerifiedAt,
        dragMs,
        state: await io.state(),
      });
    } catch (error) {
      return stop(`the session state could not be read: ${error.message}`);
    }
    if (step.action === "stop") return stop(step.reason);
    if (step.action === "done") return { ok: true, drags, checks };
    if (step.action === "check") {
      const at = io.now();
      let verified = false;
      try {
        verified = (await io.check()) === true;
      } catch {}
      checks++;
      if (!verified)
        return stop(
          `the check click showed no flip after ${drags} drags: the flip page is no longer in front`,
        );
      lastVerifiedAt = at;
      continue;
    }
    const began = io.now();
    try {
      await io.drag(drags);
    } catch (error) {
      return stop(`a drag failed: ${error.message}`);
    }
    drags++;
    dragMs = Math.max(dragMs, io.now() - began);
  }
}

// S3: no freeze longer than 500 ms during the dragging and scrolling.
export function verdictSoak(report) {
  const failed = [];
  if (report.gapsOver500ms > 0)
    failed.push(
      `${report.gapsOver500ms} frame gaps over ${LIMITS.freezeMs} ms (longest ${Math.round(report.maxGapMs)} ms)`,
    );
  if (report.freezeCount)
    failed.push(`the browser counted ${report.freezeCount} freezes`);
  return failed;
}

async function main() {
  let options;
  try {
    options = readOptions({ ...process.env, MODE: process.argv[2] });
  } catch (error) {
    console.error(
      `${error.message}\nUsage: see the top of scripts/measure-drive.mjs`,
    );
    return 2;
  }
  let release;
  try {
    release = acquireLock();
  } catch (error) {
    console.error(`FAILED ${error.message}`);
    return 1;
  }
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PW_CORE || "playwright-core");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  let code = 0;
  try {
    const page = await browser.newPage({ viewport: options.viewport });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(options.url);
    const tile = page.locator("button.tile", { hasText: options.tile }).first();
    await tile.waitFor({ timeout: 20_000 });
    await page
      .waitForFunction(
        () => !document.querySelector("button.tile")?.disabled,
        null,
        { timeout: 20_000 },
      )
      .catch(() => {});
    await tile.click();
    await page.waitForFunction(
      () => document.getElementById("session-state")?.textContent === "연결됨",
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(3000); // the first frames and the cursor settle
    await page.screenshot({ path: `${options.shots}-before.png` });
    let result;
    let failed;
    // One verification: clicks at the flip point, each of which must show its flip. Nothing
    // else is sent to the Mac before the pilot has been verified.
    const verifyClicks = (n, pauseMs, timeoutMs) =>
      page.evaluate((o) => window.__gomeMeasure.run(o), {
        n,
        fx: options.fx,
        fy: options.fy,
        pauseMs,
        timeoutMs,
      });
    const refuseUnless = (samples, verdict) => {
      const refused = [...verdict(samples), ...suspectSamples(samples ?? [])];
      if (refused.length) throw new Error(refused[0]);
    };
    if (options.mode === "measure") {
      const pilot = await verifyClicks(PILOT_CLICKS, 500, PILOT_TIMEOUT_MS);
      refuseUnless(pilot?.samples, pilotVerdict);
      result = await page.evaluate(
        (o) =>
          window.__gomeMeasure.run({
            n: o.n,
            fx: o.fx,
            fy: o.fy,
            pauseMs: o.pauseMs,
          }),
        options,
      );
      failed = [
        ...(result.aborted ? [result.aborted] : []),
        ...suspectSamples(result.samples),
        ...verdictClick(result.summary, options.vncMedianMs),
      ];
    } else {
      const rect = safeRect(options.fx, options.fy);
      // What the soak needs of the page, read before any input and before every step.
      const pageState = () =>
        page.evaluate(() => ({
          connected:
            document.getElementById("session-state")?.textContent === "연결됨",
          frameCallback:
            !!document.querySelector("video.agent-video") &&
            typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
              "function",
        }));
      const unexpected = nextSoakAction({
        now: 0,
        endAt: 1,
        lastVerifiedAt: 0,
        dragMs: 0,
        state: { ...(await pageState()), frameWatching: true },
      });
      if (unexpected.action === "stop") throw new Error(unexpected.reason);
      // Where the safe rectangle is in the viewer, worked out (and so failing) before input.
      const geometry = await page.evaluate(() => {
        const video = document.querySelector("video.agent-video");
        const r = video.getBoundingClientRect();
        return {
          box: { left: r.left, top: r.top, width: r.width, height: r.height },
          video: { width: video.videoWidth, height: video.videoHeight },
        };
      });
      for (let i = 0; i < 10; i++)
        for (const p of Object.values(dragPath(i, rect)))
          viewportPoint(p, geometry.box, geometry.video);

      const verifiedAt = Date.now();
      const pilot = await verifyClicks(PILOT_CLICKS, 500, PILOT_TIMEOUT_MS);
      refuseUnless(pilot?.samples, pilotVerdict);

      const endAt = Date.now() + options.soakSeconds * 1000;
      let settledAt;
      const soak = page.evaluate(
        (s) => window.__gomeMeasure.soak(s),
        options.soakSeconds,
      );
      const settle = () => (settledAt ??= Date.now());
      soak.then(settle, settle);
      await page.waitForTimeout(300); // an immediately failing frame watch shows by now
      let held = false;
      const io = {
        now: () => Date.now(),
        // The page's own report ends a moment around endAt; only an earlier end is a fault.
        state: async () => ({
          ...(await pageState()),
          frameWatching: settledAt === undefined || settledAt >= endAt - 1000,
        }),
        async drag(i) {
          const path = dragPath(i, rect);
          const from = viewportPoint(path.from, geometry.box, geometry.video);
          const to = viewportPoint(path.to, geometry.box, geometry.video);
          await page.mouse.move(from.x, from.y);
          held = true;
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 20 });
          await page.mouse.up();
          held = false;
          await page.mouse.wheel(0, i % 2 ? 300 : -300);
        },
        async check() {
          await page.waitForTimeout(SETTLE_MS); // the last drag's flip has been shown
          const r = await verifyClicks(1, 100, CHECK_TIMEOUT_MS);
          return (
            checkVerdict(r?.samples).length === 0 &&
            suspectSamples(r.samples).length === 0
          );
        },
        async release() {
          if (!held) return;
          held = false;
          await page.mouse.up();
        },
      };
      const run = await runSoakLoop(io, { endAt, verifiedAt });
      if (!run.ok) {
        await page
          .screenshot({ path: `${options.shots}-after.png` })
          .catch(() => {});
        throw new Error(
          `${run.reason}; input stopped after ${run.drags} drags and ${run.checks} checks`,
        );
      }
      result = await withDeadline(
        soak,
        SOAK_GRACE_MS,
        `no frame report ${SOAK_GRACE_MS / 1000} s after the soak ended: the stream stopped (the page saw no frame)`,
      );
      failed = result
        ? verdictSoak(result)
        : ["this tile has no frame report (soak is for the Mac agent)"];
    }
    await page.screenshot({ path: `${options.shots}-after.png` });
    console.log(JSON.stringify(result?.summary ?? result));
    console.log(failed.length ? `FAILED: ${failed.join("; ")}` : "PASSED");
    if (options.mode === "measure" && !result.aborted)
      console.log(
        `Compare the flips counter on the Mac's target page in ${options.shots}-before.png and -after.png: it must have grown by exactly ${options.n + 2} (the 2 pilot clicks count).`,
      );
    if (options.out)
      writeFileSync(
        options.out,
        JSON.stringify({
          options: { ...options, tile: String(options.tile) },
          result,
          failed,
        }),
      );
    if (failed.length) code = 1;
  } catch (error) {
    console.error("FAILED", error.message);
    code = 1;
  } finally {
    await browser.close();
    release();
  }
  return code;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (isMainModule()) process.exitCode = await main();
