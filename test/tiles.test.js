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

test("the row's second line names the system and how it is reached, and the connecting text", () => {
  for (const [change, meta] of [
    [{ profile: "gnome-remote-login" }, "Ubuntu · 원격 로그인"],
    [{}, "Linux · 원격 데스크톱(RDP)"],
    [{ platform: "mac", protocol: "agent" }, "Mac · Gome 에이전트"],
    [{ platform: "mac", protocol: "vnc" }, "Mac · 화면 공유(VNC)"],
    [{ platform: "windows", protocol: "vnc" }, "Windows · VNC"],
    [{ platform: "windows" }, "Windows · 원격 데스크톱(RDP)"],
  ])
    assert.equal(tiles.metaText(target(change)), meta, JSON.stringify(change));
  assert.equal(
    tiles.connectingText("Ubuntu 서버"),
    "Ubuntu 서버에 연결하는 중",
  );
});
