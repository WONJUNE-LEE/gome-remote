import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
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
