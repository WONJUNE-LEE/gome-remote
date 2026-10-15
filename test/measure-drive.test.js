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
  suspectSamples,
  readOptions,
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

test("the pilot refuses a page that answers no click, and impossibly fast samples are named", () => {
  assert.equal(pilotVerdict([null, null]).length, 1);
  assert.match(pilotVerdict([null, null])[0], /in front/);
  assert.deepEqual(pilotVerdict([null, 90]), []);
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
