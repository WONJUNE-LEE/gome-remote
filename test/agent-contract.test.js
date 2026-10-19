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
const { message, parseAgentMessage, parseNotice } = input;

// How the page builds each message from the values the fixture carries.
const build = {
  pointer: (m) => message.pointer({ x: m.x, y: m.y }),
  button: (m) => message.button(m.b, m.down, { x: m.x, y: m.y }),
  wheel: (m) => message.wheel({ x: m.dx, y: m.dy }),
  key: (m) => message.key(m.code, m.down),
  text: (m) => message.text(m.s),
  release: () => message.release(),
  size: (m) => message.size(m.w, m.h),
  clipboard: (m) => message.clipboard(m.text, m.concealed),
  "clipboard-watch": (m) => message.clipboardWatch(m.on),
};
// `message` names its builders in camelCase, the wire in kebab-case.
// The page code runs in its own realm; compare by value across it.
const plain = (value) => JSON.parse(JSON.stringify(value));
const wireType = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

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
  const builders = Object.keys(message).map(wireType).sort();
  assert.deepEqual(Object.keys(build).sort(), builders);
  const types = new Set(fixture.input.map((m) => m.type));
  assert.deepEqual([...types].sort(), builders);
  const buttons = fixture.input
    .filter((m) => m.type === "button")
    .map((m) => m.b);
  assert.deepEqual([...new Set(buttons)].sort(), [0, 1, 2]);
});

test("the page understands exactly the agent's notices of the contract", () => {
  assert.ok(fixture.notice.length >= 1);
  for (const sample of fixture.notice)
    assert.deepEqual(plain(parseAgentMessage(JSON.stringify(sample))), sample);
  assert.deepEqual([...new Set(fixture.notice.map((n) => n.type))].sort(), [
    "clipboard",
    "clipboard-skipped",
    "lock",
    "replaced",
  ]);
  assert.deepEqual(
    fixture.notice
      .filter((n) => n.type === "clipboard-skipped")
      .map((n) => n.reason)
      .sort(),
    ["locked-empty", "locked-multiline", "read-denied", "too-large"],
  );
  // `parseNotice` still reads only `replaced`.
  for (const sample of fixture.notice)
    assert.equal(
      parseNotice(JSON.stringify(sample)),
      sample.type === "replaced" ? "replaced" : undefined,
    );
  // An input message is not an agent message, except `clipboard`, which has the same shape
  // in both directions (the agent never receives its own notices, nor the page its own).
  for (const sample of fixture.input) {
    assert.equal(parseNotice(JSON.stringify(sample)), undefined);
    if (sample.type !== "clipboard")
      assert.equal(parseAgentMessage(JSON.stringify(sample)), undefined);
  }
  // The agent sends text frames (the Rust peer test checks that); a binary frame of the
  // same bytes reaches the page as an ArrayBuffer and is ignored.
  assert.equal(fixture.noticeFrame, "text");
  for (const sample of fixture.notice) {
    const bytes = new TextEncoder().encode(JSON.stringify(sample));
    assert.equal(parseNotice(bytes), undefined);
    assert.equal(parseNotice(bytes.buffer), undefined);
    assert.equal(parseAgentMessage(bytes), undefined);
    assert.equal(parseAgentMessage(bytes.buffer), undefined);
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
