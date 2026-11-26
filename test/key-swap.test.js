import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const { swapCode, swapKeysym } = await loadTs("agent-input.ts");

test("key_swap_tables", () => {
  const codes = {
    AltLeft: "MetaLeft",
    AltRight: "MetaRight",
    MetaLeft: "AltLeft",
    MetaRight: "AltRight",
  };
  for (const [from, to] of Object.entries(codes)) {
    assert.equal(swapCode(from, true), to);
    assert.equal(swapCode(from, false), from);
  }
  assert.equal(swapCode("ControlLeft", true), "ControlLeft");
  const syms = [
    [0xffe9, 0xffe7],
    [0xffea, 0xffe8],
    [0xffe7, 0xffe9],
    [0xffeb, 0xffe9],
    [0xffe8, 0xffea],
    [0xffec, 0xffea],
  ];
  for (const [from, to] of syms) {
    assert.equal(swapKeysym(from, true), to);
    assert.equal(swapKeysym(from, false), from);
  }
  assert.equal(swapKeysym(0xffe3, true), 0xffe3);
});
