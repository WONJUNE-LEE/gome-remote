import test from "node:test";
import assert from "node:assert/strict";
import { viewer } from "./helpers/viewer-harness.js";
import { loadTs } from "./helpers/load-ts.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const ENDED = "연결이 끊겼습니다";
const response = (status, body) => ({
  status,
  ok: status < 400,
  json: async () => {
    if (body === undefined) throw new Error("not JSON");
    return body;
  },
});
const mac = {
  id: "mac",
  name: "Mac (새 방식)",
  platform: "mac",
  protocol: "agent",
  persistent: false,
  online: true,
  ready: true,
  agent: { issue: "none", display: "ok", lastCaptureAt: 1_760_400_000 },
};
const vnc = {
  ...mac,
  id: "mac-vnc",
  name: "Mac (VNC)",
  protocol: "vnc",
  agent: undefined,
};
const linux = {
  id: "linux",
  name: "Linux",
  platform: "linux",
  protocol: "rdp",
  persistent: true,
  online: true,
  ready: true,
};

async function opened(options = {}) {
  const v = await viewer({
    appMode: true,
    targets: [mac, vnc, linux],
    ...options,
  });
  v.tiles()[0].click();
  await v.settle();
  return v;
}

// ---- the tile states ----

const tilesModule = await loadTs("tiles.ts");
const { tileState, tileEnabled, stateText, LOCKED_TILE_ENABLED } = tilesModule;

test("an agent tile shows its own states: 권한 필요, 잠김, 오프라인; the other targets keep their words", () => {
  const word = (t) => stateText(t, tileState(t));
  assert.equal(word(mac), "켜짐");
  assert.equal(
    word({ ...mac, agent: { ...mac.agent, issue: "permission" } }),
    "권한 필요",
  );
  assert.equal(
    word({ ...mac, agent: { ...mac.agent, issue: "locked" } }),
    "잠김",
  );
  assert.equal(
    word({ ...mac, agent: { ...mac.agent, issue: "suspect" } }),
    "권한 필요(의심)",
  );
  assert.equal(word({ ...mac, online: false, agent: undefined }), "오프라인");
  assert.equal(
    word({ ...mac, ready: false, online: false, agent: undefined }),
    "설정 필요",
  );
  assert.equal(word({ ...linux, online: false }), "꺼짐");
  assert.equal(word({ ...vnc, online: false }), "꺼짐", "VNC keeps 꺼짐");
});

test("a Mac that needs permission is not openable; a locked one follows the P1 switch", () => {
  assert.equal(tileEnabled(mac), true);
  assert.equal(
    tileEnabled({ ...mac, agent: { ...mac.agent, issue: "suspect" } }),
    true,
    "a suspected permission problem still lets the owner try",
  );
  assert.equal(
    tileEnabled({ ...mac, agent: { ...mac.agent, issue: "permission" } }),
    false,
  );
  assert.equal(
    tileEnabled({ ...mac, agent: { ...mac.agent, issue: "locked" } }),
    LOCKED_TILE_ENABLED,
  );
  assert.equal(
    LOCKED_TILE_ENABLED,
    false,
    "until P1 shows the lock screen can be controlled",
  );
  assert.equal(tileEnabled({ ...mac, online: false, agent: undefined }), false);
  // A target that is not an agent never gets agent states, whatever the list says.
  assert.equal(
    tileState({ ...linux, agent: { issue: "permission" } }),
    "online",
  );
});

test("the list renders the agent words and disables the tiles that cannot open", async () => {
  const v = await viewer({
    targets: [
      mac,
      { ...mac, id: "a", agent: { ...mac.agent, issue: "permission" } },
      { ...mac, id: "b", agent: { ...mac.agent, issue: "locked" } },
      { ...mac, id: "c", online: false, agent: undefined },
      { ...mac, id: "d", agent: { ...mac.agent, issue: "suspect" } },
    ],
  });
  const words = v
    .tiles()
    .map((t) => t.querySelector(".tile-state").textContent);
  assert.deepEqual(words, [
    "켜짐",
    "권한 필요",
    "잠김",
    "오프라인",
    "권한 필요(의심)",
  ]);
  assert.deepEqual(
    v.tiles().map((t) => t.disabled),
    [false, true, true, true, false],
  );
});

// ---- starting a Mac session ----

test("clicking a Mac tile relays an offer to /api/agent-sessions with the window size, and never touches Guacamole", async () => {
  const v = await opened();
  assert.equal(v.agents.length, 1);
  assert.equal(v.clients.length, 0);
  assert.equal(v.tunnels.length, 0);
  assert.equal(v.posts(), 0, "nothing was sent to /api/sessions");
  assert.deepEqual(plain(v.agentRequests()), [
    { targetId: "mac", width: 800, height: 600, sdp: "v=0\r\nfake-offer" },
  ]);
  assert.equal(v.agents[0].answer.sdp, "v=0\r\nanswer");
  assert.equal(v.el("session").hidden, false);
  assert.equal(v.el("session-state").textContent, "연결 중");
  assert.equal(
    v.el("display").children[0],
    v.agents[0].element,
    "the video surface is in the display",
  );
  assert.equal(v.el("display").classes.has("agent-display"), true);
});

test("the resolution picker is available for a Mac agent, and not for a VNC Mac", async () => {
  const agentView = await opened();
  assert.equal(agentView.el("resolution").disabled, false);
  const vncView = await viewer({ appMode: true, targets: [vnc] });
  vncView.tiles()[0].click();
  await vncView.settle();
  assert.equal(vncView.el("resolution").disabled, true);
  assert.equal(vncView.clients.length, 1, "VNC still goes through Guacamole");
  assert.equal(vncView.agents.length, 0);
});

test("the first picture connects: overlay gone, 연결됨, text input and the menu enabled, keyboard focus on the picture", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  assert.equal(v.el("overlay").hidden, true);
  assert.equal(v.el("session-state").textContent, "연결됨");
  assert.equal(v.el("text-input").disabled, false);
  assert.ok(v.agents[0].focused >= 1);
  assert.equal(v.agents[0].element.classes.has("agent-connected"), true);
  const last = plain(v.bridgeCalls.viewerState.at(-1));
  assert.deepEqual(last, {
    open: true,
    connected: true,
    protocol: "agent",
    resolution: "auto",
  });
});

test("a version 3 app is told 'agent'; an older app is told 'rdp' (the same menu); a browser asks nobody", async () => {
  for (const [bridgeVersion, expected] of [
    [3, "agent"],
    [2, "rdp"],
    [1, "rdp"],
  ]) {
    const v = await opened({ bridgeVersion });
    v.agents[0].deps.onFirstFrame();
    assert.ok(v.bridgeCalls.viewerState.length > 0);
    assert.ok(
      v.bridgeCalls.viewerState.every(
        (s) => s.protocol === expected || s.protocol === null,
      ),
      `bridge ${bridgeVersion}`,
    );
    assert.equal(plain(v.bridgeCalls.viewerState.at(-1)).protocol, expected);
  }
  const browser = await opened({ appMode: false });
  browser.agents[0].deps.onFirstFrame();
  assert.deepEqual(browser.bridgeCalls.viewerState, []);
});

// ---- ending ----

test("when the session ends the ended card appears, no new attempt starts, and 다시 연결 makes one new session", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.agents[0].deps.onEnded("disconnected");
  await v.settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    v.agentRequests().length,
    1,
    "no attempt was started by the ending",
  );
  assert.equal(v.el("overlay").hidden, false);
  assert.equal(v.el("overlay-title").textContent, ENDED);
  assert.equal(
    v.el("overlay-detail").textContent,
    "작업은 그대로 남아 있습니다",
  );
  assert.equal(v.el("overlay-actions").hidden, false);
  assert.equal(v.el("text-input").disabled, true);
  v.el("overlay-reconnect").click();
  await v.settle();
  assert.equal(v.agentRequests().length, 2);
  assert.equal(v.agents.length, 2);
  assert.equal(
    v.agents[0].closed,
    1,
    "the old session is closed once (and released its keys)",
  );
  // A live session is not reconnected by the menu.
  v.agents[1].deps.onFirstFrame();
  v.action("reconnect");
  await v.settle();
  assert.equal(v.agentRequests().length, 2);
});

test("an ending reported by a replaced session cannot end the new one", async () => {
  const v = await opened();
  v.el("overlay-back").click();
  v.tiles()[0].click();
  await v.settle();
  v.agents[1].deps.onFirstFrame();
  v.agents[0].deps.onEnded("disconnected");
  v.agents[0].deps.onFirstFrame();
  assert.equal(v.el("session-state").textContent, "연결됨");
  assert.equal(v.el("overlay").hidden, true);
});

const refusals = {
  permission: [
    409,
    { code: "permission", error: "x" },
    "Mac에서 화면 기록·손쉬운 사용 권한이 필요합니다",
    "Mac (VNC)로 들어가 허용할 수 있습니다",
  ],
  locked: [
    409,
    { code: "locked", error: "x" },
    "Mac이 잠겨 있습니다",
    "Mac (VNC)로 잠금을 해제하세요",
  ],
  setup: [
    409,
    { code: "setup", error: "x" },
    "연결할 수 없습니다",
    "서버에서 에이전트 토큰을 설정해야 합니다",
  ],
  unavailable: [
    424,
    { code: "unavailable", error: "x" },
    "연결할 수 없습니다",
    "Mac이 꺼져 있거나 에이전트가 멈췄을 수 있습니다",
  ],
  "a stopped gateway (502)": [
    502,
    undefined,
    "연결할 수 없습니다",
    "Mac이 꺼져 있거나 에이전트가 멈췄을 수 있습니다",
  ],
  "a server error": [
    500,
    { error: "boom" },
    "연결할 수 없습니다",
    "Mac이 꺼져 있거나 에이전트가 멈췄을 수 있습니다",
  ],
};
for (const [name, [status, body, title, detail]] of Object.entries(refusals))
  test(`a refusal (${name}) shows its own card, once, and starts no retry`, async () => {
    const v = await opened({
      fetchHandler: (path, init, ok) =>
        path === "/api/agent-sessions"
          ? response(status, body)
          : ok(path, init),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(v.agentRequests().length, 1);
    assert.equal(v.el("overlay-title").textContent, title);
    assert.equal(v.el("overlay-detail").textContent, detail);
    assert.equal(v.el("overlay-actions").hidden, false);
    assert.equal(v.el("overlay-detail").hidden, false);
    assert.equal(v.agents.length, 1, "no second session was created");
    assert.equal(v.el("overlay").hidden, false);
    // The card's button is the way out: it makes a fresh session and closes the old one.
    v.el("overlay-reconnect").click();
    await v.settle();
    assert.equal(v.agents.length, 2);
    assert.equal(v.agentRequests().length, 2);
    assert.equal(v.agents[0].closed, 1, "the refused session was closed once");
  });

test("a refused login while connecting leaves for the forbidden screen, as it does for Guacamole", async () => {
  const v = await opened({
    fetchHandler: (path, init, ok) =>
      path === "/api/agent-sessions"
        ? response(403, { code: "login", error: "x" })
        : ok(path, init),
  });
  assert.equal(v.el("session").hidden, true);
  assert.equal(
    v.el("state-title").textContent,
    "이 기기의 Tailscale 계정으로는 쓸 수 없습니다",
  );
  assert.equal(v.agentRequests().length, 1);
});

test("the ended card goes back to its usual words after an agent refusal", async () => {
  let refuse = true;
  const v = await opened({
    fetchHandler: (path, init, ok) =>
      path === "/api/agent-sessions" && refuse
        ? response(409, { code: "locked", error: "x" })
        : ok(path, init),
  });
  assert.equal(v.el("overlay-title").textContent, "Mac이 잠겨 있습니다");
  refuse = false;
  v.el("overlay-reconnect").click();
  await v.settle();
  v.agents[1].deps.onFirstFrame();
  v.agents[1].deps.onEnded("disconnected");
  assert.equal(
    v.el("overlay-title").textContent,
    ENDED,
    "no leftover text from the earlier refusal",
  );
  assert.equal(
    v.el("overlay-detail").textContent,
    "작업은 그대로 남아 있습니다",
  );
});

// ---- input hand-over, size, text ----

test("fullscreen changes, dialogs and window blur release the Mac's keys, and disconnect closes the session", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  const before = v.agents[0].releases;
  v.action("text-input"); // opens the text dialog
  assert.ok(v.agents[0].releases > before, "text dialog");
  const afterDialog = v.agents[0].releases;
  v.el("fullscreen").click();
  await v.settle();
  assert.ok(v.agents[0].releases > afterDialog, "fullscreen switch");
  const afterFullscreen = v.agents[0].releases;
  v.windowEvent("blur");
  assert.ok(v.agents[0].releases > afterFullscreen, "window blur");
  v.el("disconnect").click();
  assert.equal(v.agents[0].closed, 1, "disconnect closes the session once");
});

test("the end of a Mac session releases the Mac's keys", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  const before = v.agents[0].releases;
  v.agents[0].deps.onEnded("disconnected");
  assert.ok(v.agents[0].releases > before, "ended");
});

test("leaving the viewer closes the Mac session", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.el("back").click();
  await v.settle();
  assert.equal(v.agents[0].closed, 1);
  assert.equal(v.el("display").classes.has("agent-display"), false);
});

test("window and picker size changes are sent to the Mac as size messages after the same delay as for RDP", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.resizeViewport(1280, 720);
  v.advance(299);
  assert.deepEqual(v.agents[0].sizes, []);
  v.advance(1);
  assert.deepEqual(v.agents[0].sizes, [[1280, 720]]);
  v.setPixelRatio(2);
  v.resizeViewport(1000, 700);
  v.advance(300);
  assert.deepEqual(v.agents[0].sizes.at(-1), [2000, 1400]);
  const select = v.el("resolution");
  select.value = "1920x1080";
  select.dispatchEvent({ type: "change" });
  assert.deepEqual(v.agents[0].sizes.at(-1), [1920, 1080]);
  assert.equal(v.clients.length, 0);
});

test("the app menu's resolution entries work for a Mac agent", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.action("resolution:2560x1440");
  assert.equal(v.el("resolution").value, "2560x1440");
  assert.deepEqual(v.agents[0].sizes.at(-1), [2560, 1440]);
});

test("the text dialog types through the agent and never uses the clipboard path", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.action("text-input");
  v.el("remote-text").value = "안녕하세요 😀";
  v.el("text-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(v.agents[0].texts, ["안녕하세요 😀"]);
  assert.equal(v.el("remote-text").value, "");
  assert.equal(v.el("text-dialog").open, false);
  v.el("text-form").onsubmit({ preventDefault() {} });
  assert.equal(v.agents[0].texts.length, 1, "an empty text sends nothing");
});

test("the measurement panel is added to the page only when the address asks for it", async () => {
  for (const hash of ["", "#", "#something", "#measured"]) {
    const plainPage = await viewer({ targets: [mac], hash });
    assert.deepEqual(plainPage.body.children, [], hash);
    assert.deepEqual(
      plainPage.measureUse,
      [],
      `${hash}: the measurement module touched no document, timer or message port`,
    );
  }
  const measuring = await viewer({ targets: [mac], hash: "#measure" });
  assert.equal(measuring.body.children.length, 1);
  assert.equal(measuring.body.children[0].id, "measure-panel");
  assert.notDeepEqual(
    measuring.measureUse,
    [],
    "the same recorder does see the panel",
  );
});
