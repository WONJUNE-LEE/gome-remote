import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const tiles = await loadTs("tiles.ts");
const target = (change) => ({
  id: "ubuntu-server",
  name: "Ubuntu 서버",
  platform: "linux",
  protocol: "rdp",
  persistent: true,
  online: true,
  ready: true,
  ...change,
});

test("a tile is usable only when the machine answers and its credentials are set", () => {
  const cases = [
    [{}, "online", "켜짐", true],
    [{ online: false }, "offline", "꺼짐", false],
    [{ ready: false }, "setup", "설정 필요", false],
    [{ ready: false, online: false }, "setup", "설정 필요", false],
  ];
  for (const [change, state, label, enabled] of cases) {
    const t = target(change);
    assert.equal(tiles.tileState(t), state, JSON.stringify(change));
    assert.equal(tiles.stateLabel[tiles.tileState(t)], label);
    assert.equal(tiles.tileEnabled(t), enabled);
  }
});

test("platform colours and the connecting text follow the design", () => {
  assert.equal(tiles.platformClass("linux"), "ubuntu");
  assert.equal(tiles.platformClass("mac"), "mac");
  assert.equal(tiles.platformClass("windows"), "windows");
  assert.equal(
    tiles.connectingText("Ubuntu 서버"),
    "Ubuntu 서버에 연결하는 중",
  );
});
