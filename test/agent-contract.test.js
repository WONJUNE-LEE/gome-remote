import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTs } from "./helpers/load-ts.js";
import { normaliseStatus } from "../server/agent-client.js";

// agent/mac/tests/fixtures/contract.json is the one description of what crosses the wire
// between the page, the gateway and the agent. The Rust tests (agent/mac/tests/contract.rs)
// check that the agent parses every input message and writes exactly these status
// documents; these tests check the other two ends against the same file.
const fixture = JSON.parse(
  await readFile(
    new URL("../agent/mac/tests/fixtures/contract.json", import.meta.url),
    "utf8",
  ),
);
const input = await loadTs("agent-input.ts");
const { message } = input;

// How the page builds each message from the values the fixture carries.
const build = {
  pointer: (m) => message.pointer({ x: m.x, y: m.y }),
  button: (m) => message.button(m.b, m.down, { x: m.x, y: m.y }),
  wheel: (m) => message.wheel({ x: m.dx, y: m.dy }),
  key: (m) => message.key(m.code, m.down),
  text: (m) => message.text(m.s),
  release: () => message.release(),
  size: (m) => message.size(m.w, m.h),
};

test("the page's message builders produce exactly the contract's input messages", () => {
  for (const sample of fixture.input) {
    assert.ok(build[sample.type], `no builder for ${sample.type}`);
    assert.equal(
      build[sample.type](sample),
      JSON.stringify(sample),
      JSON.stringify(sample),
    );
  }
});

test("the contract covers every message the page can send, and the page can send nothing the contract lacks", () => {
  assert.deepEqual(Object.keys(build).sort(), Object.keys(message).sort());
  const types = new Set(fixture.input.map((m) => m.type));
  assert.deepEqual([...types].sort(), Object.keys(message).sort());
  const buttons = fixture.input
    .filter((m) => m.type === "button")
    .map((m) => m.b);
  assert.deepEqual([...new Set(buttons)].sort(), [0, 1, 2]);
});

test("the page understands exactly the agent's notices of the contract", () => {
  const { parseNotice } = input;
  assert.ok(fixture.notice.length >= 1);
  for (const sample of fixture.notice)
    assert.equal(parseNotice(JSON.stringify(sample)), sample.type);
  assert.deepEqual(
    fixture.notice.map((n) => n.type),
    ["replaced"],
  );
  // An input message is not a notice.
  for (const sample of fixture.input)
    assert.equal(parseNotice(JSON.stringify(sample)), undefined);
  // The agent sends it as a text frame (the Rust peer test checks that); a binary frame
  // of the same bytes reaches the page as an ArrayBuffer and is ignored.
  assert.equal(fixture.noticeFrame, "text");
  for (const sample of fixture.notice) {
    const bytes = new TextEncoder().encode(JSON.stringify(sample));
    assert.equal(parseNotice(bytes), undefined);
    assert.equal(parseNotice(bytes.buffer), undefined);
  }
  // A notice padded beyond 256 characters is not one.
  const padded = JSON.stringify(fixture.notice[0]) + " ".repeat(256);
  assert.ok(padded.length > 256);
  assert.equal(parseNotice(padded), undefined);
  assert.equal(parseNotice(padded.slice(0, 256)), fixture.notice[0].type);
});

test("the gateway accepts every status document of the contract and reduces it as the contract says", () => {
  assert.ok(fixture.status.length >= 2);
  for (const sample of fixture.status)
    assert.deepEqual(normaliseStatus(sample.json), sample.page);
  // The fixture is the whole document: a key the agent stopped writing breaks the gateway.
  for (const sample of fixture.status) {
    assert.deepEqual(Object.keys(sample.json).sort(), [
      "accessibility",
      "display",
      "lastCaptureAt",
      "locked",
      "screen",
      "version",
    ]);
    for (const key of ["screen", "accessibility", "display", "locked"]) {
      const { [key]: _gone, ...without } = sample.json;
      assert.equal(normaliseStatus(without), undefined, `without ${key}`);
    }
  }
});
