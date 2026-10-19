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
    true,
    "P1 (2026-10-16): the lock screen can be controlled through the agent",
  );
  // Both values of the switch, whatever it is set to today.
  const locked = { ...mac, agent: { ...mac.agent, issue: "locked" } };
  assert.equal(tileEnabled(locked, true), true, "P1 allows the lock screen");
  assert.equal(tileEnabled(locked, false), false, "P1 does not");
  assert.equal(
    tileEnabled({ ...mac, agent: { ...mac.agent, issue: "permission" } }, true),
    false,
    "a missing permission is never overridden by the lock switch",
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
    [false, true, false, true, false],
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

test("a session another device took over shows its own words and keeps 다시 연결", async () => {
  const v = await opened();
  v.agents[0].deps.onFirstFrame();
  v.agents[0].deps.onEnded("replaced");
  await v.settle();
  assert.equal(v.el("overlay").hidden, false);
  assert.equal(v.el("overlay-title").textContent, "다른 기기에서 연결했습니다");
  assert.equal(v.el("overlay-actions").hidden, false);
  assert.equal(v.agentRequests().length, 1, "no automatic reconnect");
  v.el("overlay-reconnect").click();
  await v.settle();
  assert.equal(v.agentRequests().length, 2);
  v.agents[1].deps.onFirstFrame();
  v.agents[1].deps.onEnded("disconnected");
  assert.equal(
    v.el("overlay-title").textContent,
    ENDED,
    "the usual words come back for the next ending",
  );
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

test("a Mac session that ends by itself really sends the release on its channel before the channel closes", async () => {
  // The real src/agent.ts under main.ts, on a fake connection: the recorder above only
  // counts calls, which a release sent after the channel was torn down would also satisfy.
  const v = await opened({ realAgent: true });
  const pc = v.rig.peers.at(-1);
  const channel = pc.channels[0];
  channel.open();
  pc.setState("connected");
  await v.settle();
  const surface = v.el("display").children.at(-1);
  surface.fire("keydown", { code: "KeyA", key: "a" });
  let closedWhenSent;
  const send = channel.send.bind(channel);
  channel.send = (text) => {
    closedWhenSent = channel.closed;
    send(text);
  };
  pc.setState("failed");
  await v.settle();
  assert.equal(
    v.el("overlay-title").textContent,
    ENDED,
    "the viewer shows the end",
  );
  assert.deepEqual(
    channel.messages().map((m) => m.type),
    ["key", "release"],
  );
  assert.equal(
    closedWhenSent,
    0,
    "the release was sent while the channel was open",
  );
  assert.equal(channel.closed, 1);
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

// ---- the Windows key lock (Windows app, bridge 4 with keyLockSupported) ----

const WIN_APP = { bridgeVersion: 4, keyLockSupported: true };
const lockCalls = (v) => [
  v.bridgeCalls.keyLock.join(","),
  v.keyboardCalls.lock.length,
  v.keyboardCalls.unlock,
];
const noticeText = (v) =>
  v.el("notice").hidden ? "" : v.el("notice").textContent;
const ON_NOTICE = "Windows 키가 Mac으로 갑니다 · Esc를 길게 누르면 풀립니다";
const RELEASED_NOTICE = "키 잡기를 풀었습니다 · 화면을 클릭하면 다시 잡습니다";

test("the first picture takes HTML full screen and the lock in the focused Windows app, and says so once", async () => {
  const v = await opened(WIN_APP);
  assert.deepEqual(
    lockCalls(v),
    ["", 0, 0],
    "no lock before the session is up",
  );
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true", 1, 0]);
  assert.equal(noticeText(v), ON_NOTICE);
  assert.equal(v.window.__gomeFsLock, undefined, "no page marker any more");
});

test("a Guacamole session takes the lock when it connects", async () => {
  const v = await viewer({
    appMode: true,
    ...WIN_APP,
    targets: [mac, vnc, linux],
  });
  v.tiles()[2].click();
  await v.settle();
  assert.deepEqual(lockCalls(v), ["", 0, 0]);
  v.clients[0].onstatechange(3);
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true", 1, 0]);
});

test("a window that is not focused when the picture arrives takes the lock when it gains the focus", async () => {
  const v = await opened({ ...WIN_APP, windowFocused: false });
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  assert.deepEqual(lockCalls(v), ["", 0, 0]);
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true", 1, 0]);
});

test("window blur releases the lock and focus takes it again", async () => {
  const v = await opened(WIN_APP);
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  v.setWindowFocus(false);
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true,false", 1, 1]);
  assert.equal(v.window.desktop.keyLockSupported, true);
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true,false,true", 2, 1]);
});

test("every end of the session releases the lock: the connection ending, 연결 종료, and back", async () => {
  for (const end of ["ended", "disconnect", "back"]) {
    const v = await opened(WIN_APP);
    v.agents[0].deps.onFirstFrame();
    await v.settle();
    assert.deepEqual(lockCalls(v), ["true", 1, 0], end);
    if (end === "ended") v.agents[0].deps.onEnded("disconnected");
    else if (end === "disconnect") v.el("disconnect").click();
    else v.el("back").click();
    await v.settle();
    assert.deepEqual(lockCalls(v), ["true,false", 1, 1], end);
  }
});

test("hold-Escape (the full screen ends by itself) releases the lock with a notice; a click on the remote view takes it again", async () => {
  const v = await opened(WIN_APP);
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  v.setHtmlFullscreen(false); // Chromium's hold-Escape
  await v.settle();
  assert.deepEqual(
    lockCalls(v),
    ["true", 1, 1],
    "unlocked, full screen already gone",
  );
  assert.equal(noticeText(v), RELEASED_NOTICE);
  // Nothing re-takes it on its own.
  v.setWindowFocus(true);
  v.windowEvent("focus");
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true", 1, 1]);
  v.el("display").dispatchEvent({ type: "mousedown" });
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true,true", 2, 1]);
  assert.equal(
    noticeText(v),
    RELEASED_NOTICE,
    "no second 'on' notice in this session",
  );
});

test("the page's own exit is not taken for hold-Escape", async () => {
  const v = await opened(WIN_APP);
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  v.setWindowFocus(false); // the harness bridge fires fullscreenchange on our exit
  await v.settle();
  assert.notEqual(noticeText(v), RELEASED_NOTICE);
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(lockCalls(v), ["true,false,true", 2, 1]);
});

test("F11 while the lock is held toggles native full screen from the page: once for down, repeat and up, and the Mac never sees it", async () => {
  const v = await opened(WIN_APP);
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  const down = v.windowKey("keydown");
  const repeat = v.windowKey("keydown", { repeat: true });
  const up = v.windowKey("keyup");
  await v.settle();
  for (const event of [down, repeat, up]) {
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
  }
  assert.deepEqual(
    v.bridgeCalls.fullscreen,
    [true],
    "native toggle, not exitFullscreen",
  );
  assert.deepEqual(lockCalls(v), ["true", 1, 0], "the lock is untouched");
  const other = v.windowKey("keydown", { key: "F1" });
  assert.equal(other.defaultPrevented, false);
  assert.deepEqual(v.bridgeCalls.fullscreen, [true]);
  // Main reports the new native state; the next F11 leaves full screen.
  v.setNativeFullscreen(true);
  await v.settle();
  v.windowKey("keydown");
  await v.settle();
  assert.deepEqual(v.bridgeCalls.fullscreen, [true, false]);
  v.setNativeFullscreen(false);
  await v.settle();
  v.windowKey("keydown");
  await v.settle();
  assert.deepEqual(v.bridgeCalls.fullscreen, [true, false, true]);
  assert.deepEqual(lockCalls(v), ["true", 1, 0], "the lock stays untouched");
});

test("F11 is not the page's business while the lock is not held", async () => {
  const v = await opened({ ...WIN_APP, windowFocused: false });
  v.agents[0].deps.onFirstFrame(); // connected, window unfocused: no lock
  await v.settle();
  const event = v.windowKey("keydown");
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(v.bridgeCalls.fullscreen, []);
});

test("a refused or missing lock leaves the session as it was, silently, and gives full screen back", async () => {
  for (const [options, reason] of [
    [{ keyboardLock: "refused" }, "key-lock-refused"],
    [{ keyboardLock: "absent" }, "key-lock-refused"],
    [{ keyLockAnswer: "refused" }, "html-full-screen-refused"],
  ]) {
    const v = await opened({ ...WIN_APP, ...options });
    v.agents[0].deps.onFirstFrame();
    await v.settle();
    const name = JSON.stringify(options);
    assert.equal(v.el("viewer-error").open, false, name);
    assert.equal(noticeText(v), "", name);
    assert.deepEqual(v.warnings, [[`key lock: ${reason}`]], name);
    const event = v.windowKey("keydown");
    assert.equal(event.defaultPrevented, false, name);
    // It left HTML full screen at once (a second bridge call, false) unless it never got in.
    const calls = v.bridgeCalls.keyLock;
    assert.equal(calls[0], true, name);
    if (options.keyLockAnswer !== "refused")
      assert.equal(calls[1], false, name);
  }
});

test("a lock that never resolves is given up after 2 s", async () => {
  const v = await opened({ ...WIN_APP, keyboardLock: "hang" });
  v.agents[0].deps.onFirstFrame();
  await v.settle();
  v.advance(2000);
  await v.settle();
  assert.deepEqual(v.bridgeCalls.keyLock, [true, false]);
  assert.equal(noticeText(v), "");
  assert.equal(v.el("viewer-error").open, false);
  assert.deepEqual(v.warnings, [["key lock: key-lock-timeout"]]);
});

test("a Mac or Linux app (keyLockSupported false), bridge 3 and a browser never lock, and F11 stays main's", async () => {
  for (const options of [
    { appMode: true, bridgeVersion: 4, keyLockSupported: false },
    { appMode: true, bridgeVersion: 3 },
    { appMode: false },
  ]) {
    const v = await viewer({ targets: [mac, vnc, linux], ...options });
    v.tiles()[0].click();
    await v.settle();
    v.agents[0].deps.onFirstFrame();
    await v.settle();
    v.setWindowFocus(false);
    v.setWindowFocus(true);
    v.el("display").dispatchEvent({ type: "mousedown" });
    await v.settle();
    const name = JSON.stringify(options);
    assert.deepEqual(lockCalls(v), ["", 0, 0], name);
    assert.equal(noticeText(v), "", name);
    if (options.appMode) {
      const event = v.windowKey("keydown");
      assert.equal(event.defaultPrevented, false, name);
      assert.deepEqual(v.bridgeCalls.fullscreen, [], name);
    }
  }
});

// ---- clipboard sync over the Mac session (the real src/agent.ts on a fake connection) ----

const NOTICES = (
  await loadTs(
    "clipboard-sync.ts",
    {},
    { "./agent-input": await loadTs("agent-input.ts") },
  )
).NOTICE_TEXT;
const types = (channel) => channel.messages().map((m) => m.type);
const keyEvent = (code, extra = {}) => ({
  code,
  key: code === "KeyV" ? "v" : code.replace(/Left$/, ""),
  ...extra,
});

// The session is up with its channel open and the first picture shown; `surface` is the
// element the real agent put on the page.
async function syncing(options = {}) {
  const v = await opened({ realAgent: true, ...options });
  const pc = v.rig.peers.at(-1);
  const channel = pc.channels[0];
  channel.open();
  pc.setState("connected");
  await v.settle();
  const surface = v.el("display").children.at(-1);
  pc.track({ id: "stream" });
  surface.children[0].showFrame(1);
  await v.settle();
  return { v, pc, channel, surface };
}
// Cmd+V as a keyboard sends it.
const cmdV = (surface) => {
  surface.fire("keydown", keyEvent("MetaLeft", { metaKey: true }));
  surface.fire("keydown", keyEvent("KeyV", { metaKey: true }));
  surface.fire("keyup", keyEvent("KeyV", { metaKey: true }));
  surface.fire("keyup", keyEvent("MetaLeft"));
};
const keysOf = (channel) =>
  channel
    .messages()
    .filter((m) => m.type === "key")
    .map((m) => `${m.code}:${m.down ? "down" : "up"}`);

test("a watch asked for before the channel opened goes out once, when it opens", async () => {
  const v = await opened({ realAgent: true, clipboardText: "" });
  const pc = v.rig.peers.at(-1);
  const channel = pc.channels[0];
  pc.setState("connected");
  await v.settle();
  const surface = v.el("display").children.at(-1);
  pc.track({ id: "stream" });
  surface.children[0].showFrame(1); // the first picture, with the channel still closed
  await v.settle();
  assert.equal(channel.readyState, "connecting");
  assert.deepEqual(
    channel.sent,
    [],
    "nothing can be sent before the channel is open",
  );
  channel.open();
  await v.settle();
  assert.deepEqual(
    channel.messages().filter((m) => m.type.startsWith("clipboard")),
    [{ type: "clipboard-watch", on: true }],
    "the watch is said again on open, exactly once",
  );
});

test("copy then Cmd+V reaches the channel in order: the text first, then the held keys", async () => {
  const { v, channel, surface } = await syncing({ clipboardText: "" });
  assert.deepEqual(
    channel.messages().filter((m) => m.type.startsWith("clipboard")),
    [{ type: "clipboard-watch", on: true }],
    "watch goes on when the view is focused and nothing is pushed for an empty clipboard",
  );
  v.clipboard.text = "새 텍스트";
  v.clipboard.hold = true;
  const before = channel.sent.length;
  cmdV(surface);
  await v.settle();
  assert.deepEqual(
    channel.messages().slice(before),
    [{ type: "key", code: "MetaLeft", down: true }],
    "only the Command key-down so far: V and everything after it are held",
  );
  v.clipboard.hold = false;
  v.clipboard.resolve();
  await v.settle();
  assert.deepEqual(channel.messages().slice(before), [
    { type: "key", code: "MetaLeft", down: true },
    { type: "clipboard", text: "새 텍스트", concealed: false },
    { type: "key", code: "KeyV", down: true },
    { type: "key", code: "KeyV", down: false },
    { type: "key", code: "MetaLeft", down: false },
  ]);
});

test("a paste read slower than 500 ms releases the held keys and tells the user, and the late text is never sent", async () => {
  const { v, channel, surface } = await syncing();
  v.clipboard.text = "늦은 텍스트";
  v.clipboard.hold = true;
  cmdV(surface);
  await v.settle();
  v.advance(499);
  assert.deepEqual(keysOf(channel), ["MetaLeft:down"]);
  v.advance(1);
  assert.deepEqual(keysOf(channel), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  assert.equal(v.el("notice").hidden, false);
  assert.equal(v.el("notice").textContent, NOTICES["read-timeout"]);
  v.clipboard.resolve();
  await v.settle();
  assert.equal(types(channel).includes("clipboard"), false, "no stale send");
});

test("window blur sends watch off and the release, and focus sends watch on again", async () => {
  const { v, channel } = await syncing();
  const at = channel.sent.length;
  v.setWindowFocus(false);
  await v.settle();
  const after = channel.messages().slice(at);
  assert.deepEqual(
    after.map((m) => m.type),
    ["release", "clipboard-watch"],
  );
  assert.deepEqual(after[1], { type: "clipboard-watch", on: false });
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(channel.messages().at(-1), {
    type: "clipboard-watch",
    on: true,
  });
});

test("a window that opens a session without the focus sends no watch until it gets it", async () => {
  const { v, channel } = await syncing({ windowFocused: false });
  assert.equal(types(channel).includes("clipboard-watch"), false);
  assert.equal(v.clipboard.reads, 0, "the clipboard is not read unfocused");
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(channel.messages().at(-1), {
    type: "clipboard-watch",
    on: true,
  });
});

test("a lock message resets the baseline: the same text is sent again", async () => {
  const { v, channel, surface } = await syncing();
  v.clipboard.text = "같은 글";
  cmdV(surface);
  await v.settle();
  cmdV(surface);
  await v.settle();
  const sent = () => types(channel).filter((t) => t === "clipboard").length;
  assert.equal(sent(), 1, "an unchanged text is not sent twice");
  channel.receive(JSON.stringify({ type: "lock", locked: true }));
  cmdV(surface);
  await v.settle();
  assert.equal(sent(), 2, "after the lock message the text goes again");
});

test("clipboard text from the Mac is written through the bridge, concealed as flagged, and only while focused", async () => {
  const { v, channel } = await syncing();
  channel.receive(
    JSON.stringify({ type: "clipboard", text: "x", concealed: true }),
  );
  await v.settle();
  assert.deepEqual(plain(v.clipboard.writes), [["x", { concealed: true }]]);
  v.setWindowFocus(false);
  channel.receive(
    JSON.stringify({ type: "clipboard", text: "y", concealed: false }),
  );
  await v.settle();
  assert.equal(v.clipboard.writes.length, 1, "nothing written while blurred");
});

test("skip notices and a too-large clipboard show the notice text, which hides after 4 seconds", async () => {
  const { v, channel, surface } = await syncing();
  const notice = v.el("notice");
  assert.equal(notice.hidden, true, "hidden by default");
  channel.receive(
    JSON.stringify({ type: "clipboard-skipped", reason: "read-denied" }),
  );
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, NOTICES["read-denied"]);
  v.advance(3999);
  assert.equal(notice.hidden, false);
  v.advance(1);
  assert.equal(notice.hidden, true);

  v.clipboard.text = "가".repeat(21846); // 65 538 bytes
  cmdV(surface);
  await v.settle();
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, NOTICES["too-large"]);
  assert.equal(types(channel).includes("clipboard"), false, "never truncated");
  assert.deepEqual(keysOf(channel).slice(-4), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  // A second notice restarts the 4 seconds instead of being cut short by the first.
  v.advance(2000);
  channel.receive(
    JSON.stringify({ type: "clipboard-skipped", reason: "locked-empty" }),
  );
  assert.equal(notice.textContent, NOTICES["locked-empty"]);
  v.advance(3999);
  assert.equal(notice.hidden, false);
  v.advance(1);
  assert.equal(notice.hidden, true);
  assert.ok(!JSON.stringify(notice).includes("가가가"), "no clipboard text");
});

test("an old agent session works exactly as before: Cmd+V reaches the channel and no notice appears", async () => {
  const { v, channel, surface } = await syncing({ clipboardText: "문장" });
  // The old agent never answers: no lock, no clipboard, no watch reply.
  cmdV(surface);
  await v.settle();
  assert.deepEqual(keysOf(channel), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  assert.equal(v.el("notice").hidden, true);
  // A read that never answers still lets the keys through within 500 ms.
  v.clipboard.hold = true;
  v.clipboard.text = "다른 문장";
  const before = keysOf(channel).length;
  cmdV(surface);
  await v.settle();
  v.advance(500);
  assert.equal(keysOf(channel).length - before, 4);
});

test("an old app (bridge 3) creates no sync and sends no watch", async () => {
  const { v, channel, surface } = await syncing({ bridgeVersion: 3 });
  cmdV(surface);
  v.setWindowFocus(false);
  v.setWindowFocus(true);
  await v.settle();
  assert.deepEqual(keysOf(channel), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  assert.equal(
    types(channel).some((t) => t.startsWith("clipboard")),
    false,
  );
  assert.equal(v.el("notice").hidden, true);
});

test("a browser uses navigator.clipboard, and a denied read is silent", async () => {
  const reads = [];
  const writes = [];
  let deny = false;
  const { v, channel, surface } = await syncing({
    appMode: false,
    browserClipboard: {
      readText: async () => {
        reads.push(1);
        if (deny) throw new Error("NotAllowedError");
        return "브라우저 글";
      },
      writeText: async (text) => writes.push(text),
    },
  });
  assert.deepEqual(
    channel.messages().filter((m) => m.type.startsWith("clipboard")),
    [{ type: "clipboard-watch", on: true }],
    "the session start pushes nothing",
  );
  assert.deepEqual(reads, [], "and does not even read");
  cmdV(surface);
  await v.settle();
  assert.deepEqual(
    channel.messages().filter((m) => m.type === "clipboard"),
    [{ type: "clipboard", text: "브라우저 글", concealed: false }],
    "the first paste reads the browser's text and sends it",
  );
  channel.receive(
    JSON.stringify({ type: "clipboard", text: "맥에서", concealed: false }),
  );
  await v.settle();
  assert.deepEqual(writes, ["맥에서"]);
  deny = true;
  cmdV(surface);
  await v.settle();
  assert.equal(v.el("notice").hidden, true, "denied is not an error notice");
  assert.deepEqual(keysOf(channel).slice(-4), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
});

test("a paste held at the end of the session is dropped, and the next session starts fresh with watch on", async () => {
  const first = await syncing();
  first.v.clipboard.hold = true;
  first.v.clipboard.text = "붙일 글";
  cmdV(first.surface);
  await first.v.settle();
  assert.deepEqual(keysOf(first.channel), ["MetaLeft:down"]);
  // The connection fails with the V still held.
  first.pc.setState("failed");
  await first.v.settle();
  assert.equal(first.v.el("overlay-title").textContent, ENDED);
  first.v.clipboard.hold = false;
  first.v.clipboard.resolve();
  await first.v.settle();
  assert.deepEqual(
    keysOf(first.channel),
    ["MetaLeft:down"],
    "the held V and what followed never went out",
  );
  assert.equal(types(first.channel).includes("clipboard"), false);
  // 다시 연결: a new session, a new channel.
  first.v.el("overlay-reconnect").click();
  await first.v.settle();
  const pc = first.v.rig.peers.at(-1);
  assert.notEqual(pc, first.pc);
  const channel = pc.channels[0];
  channel.open();
  pc.setState("connected");
  await first.v.settle();
  const surface = first.v.el("display").children.at(-1);
  pc.track({ id: "stream" });
  surface.children[0].showFrame(1);
  await first.v.settle();
  assert.deepEqual(
    channel.messages().filter((m) => m.type.startsWith("clipboard")),
    [{ type: "clipboard-watch", on: true }],
    "the new session turns the watch on and pushes nothing by itself",
  );
  assert.deepEqual(keysOf(channel), []);
  cmdV(surface);
  await first.v.settle();
  assert.deepEqual(
    channel.messages().filter((m) => m.type === "clipboard"),
    [{ type: "clipboard", text: "붙일 글", concealed: false }],
    "a fresh baseline: the first paste sends the text the old session had",
  );
});

test("leaving the viewer with a paste held sends no held key afterwards", async () => {
  const { v, channel, surface } = await syncing();
  v.clipboard.hold = true;
  v.clipboard.text = "글";
  cmdV(surface);
  await v.settle();
  v.el("disconnect").click();
  v.clipboard.hold = false;
  v.clipboard.resolve();
  await v.settle();
  v.advance(1000);
  assert.deepEqual(keysOf(channel), ["MetaLeft:down"]);
  assert.equal(types(channel).at(-1), "release");
  assert.equal(types(channel).includes("clipboard"), false);
});

test("the session start does not read the clipboard, a later focus gain does", async () => {
  const { v, channel } = await syncing({ clipboardText: "처음 글" });
  assert.equal(v.clipboard.reads, 0, "no read at the first picture");
  assert.equal(types(channel).includes("clipboard"), false);
  v.setWindowFocus(false);
  v.setWindowFocus(true);
  await v.settle();
  assert.equal(v.clipboard.reads, 1, "a genuine focus gain reads");
  assert.deepEqual(channel.messages().at(-1), {
    type: "clipboard",
    text: "처음 글",
    concealed: false,
  });
});

test("the 클립보드 붙여넣기 action sends the changed text, then Command+V, in that order", async () => {
  const { v, channel, surface } = await syncing({ clipboardText: "메뉴 글" });
  const focusedBefore = surface.focused;
  const before = channel.sent.length;
  v.action("paste-clipboard");
  await v.settle();
  assert.equal(surface.focused, focusedBefore, "the menu path moves no focus");
  const sent = channel
    .messages()
    .slice(before)
    .filter((m) => m.type !== "release") // the action first lets go of held input
    .map((m) =>
      m.type === "key" ? `${m.code}:${m.down ? "down" : "up"}` : m.type,
    );
  assert.deepEqual(sent, [
    "clipboard",
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  // The same text is not sent twice; the keys still go.
  const again = channel.sent.length;
  v.action("paste-clipboard");
  await v.settle();
  assert.equal(
    channel
      .messages()
      .slice(again)
      .filter((m) => m.type === "clipboard").length,
    0,
  );
  assert.equal(keysOf(channel).length, 8);
});

test("the #paste-remote button is disabled until the first frame, does the same as the action, and is disabled when the session ends", async () => {
  const v = await opened({ realAgent: true, clipboardText: "버튼 글" });
  assert.equal(v.el("paste-remote").disabled, true, "not connected yet");
  const pc = v.rig.peers.at(-1);
  const channel = pc.channels[0];
  channel.open();
  pc.setState("connected");
  await v.settle();
  assert.equal(v.el("paste-remote").disabled, true, "no frame yet");
  const surface = v.el("display").children.at(-1);
  pc.track({ id: "stream" });
  surface.children[0].showFrame(1);
  await v.settle();
  assert.equal(v.el("paste-remote").disabled, false);
  const focusedBefore = surface.focused;
  v.el("paste-remote").click();
  await v.settle();
  assert.equal(
    surface.focused,
    focusedBefore + 1,
    "typing goes back to the remote screen after the button",
  );
  assert.deepEqual(
    types(channel).filter((t) => t === "clipboard" || t === "key"),
    ["clipboard", "key", "key", "key", "key"],
  );
  assert.deepEqual(keysOf(channel), [
    "MetaLeft:down",
    "KeyV:down",
    "KeyV:up",
    "MetaLeft:up",
  ]);
  v.el("disconnect").click();
  await v.settle();
  assert.equal(v.el("paste-remote").disabled, true);
  const after = channel.messages().length;
  v.action("paste-clipboard");
  v.el("paste-remote").click();
  await v.settle();
  assert.deepEqual(
    channel
      .messages()
      .slice(after)
      .filter((m) => m.type !== "release"),
    [],
    "nothing after the session ended",
  );
});

test("with no local clipboard (bridge 3) the button stays disabled and the action does nothing", async () => {
  const { v, channel } = await syncing({ bridgeVersion: 3 });
  assert.equal(v.el("paste-remote").disabled, true);
  const before = channel.messages().length;
  v.action("paste-clipboard");
  v.el("paste-remote").click();
  await v.settle();
  assert.deepEqual(
    channel
      .messages()
      .slice(before)
      .filter((m) => m.type !== "release"),
    [],
  );
});
