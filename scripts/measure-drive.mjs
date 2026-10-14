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
import { createRequire } from "node:module";
import { realpathSync, writeFileSync } from "node:fs";
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
    if (options.mode === "measure") {
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
      failed = verdictClick(result.summary, options.vncMedianMs);
    } else {
      const soak = page.evaluate(
        (s) => window.__gomeMeasure.soak(s),
        options.soakSeconds,
      );
      const end = Date.now() + options.soakSeconds * 1000;
      const { width, height } = options.viewport;
      for (let i = 0; Date.now() < end; i++) {
        await page.mouse.move(
          width * 0.2,
          height * (0.2 + 0.6 * ((i % 10) / 10)),
        );
        await page.mouse.down();
        await page.mouse.move(width * 0.8, height * 0.5, { steps: 20 });
        await page.mouse.up();
        await page.mouse.wheel(0, i % 2 ? 300 : -300);
      }
      result = await soak;
      failed = result
        ? verdictSoak(result)
        : ["this tile has no frame report (soak is for the Mac agent)"];
    }
    await page.screenshot({ path: `${options.shots}-after.png` });
    console.log(JSON.stringify(result?.summary ?? result));
    console.log(failed.length ? `FAILED: ${failed.join("; ")}` : "PASSED");
    if (options.mode === "measure")
      console.log(
        `Compare the flips counter on the Mac's target page in ${options.shots}-before.png and -after.png: it must have grown by exactly ${options.n}.`,
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
