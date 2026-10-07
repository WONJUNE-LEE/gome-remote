import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";
import { viewer } from "./helpers/viewer-harness.js";

// Objects from the module under test live in another realm; compare them as data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const flowModule = await loadTs("flow.ts");
const { errorScreen, connectFailure, createSessionFlow } = flowModule;

const FORBIDDEN = "이 기기의 Tailscale 계정으로는 쓸 수 없습니다";
const UNREACHABLE = "서버에 연결할 수 없습니다";
const ENDED = "연결이 끊겼습니다";
const online = {
  id: "linux",
  name: "Linux",
  platform: "linux",
  protocol: "rdp",
  persistent: true,
  online: true,
  ready: true,
};
const response = (status, body) => ({
  status,
  ok: status < 400,
  json: async () => {
    if (body === undefined) throw new Error("not JSON");
    return body;
  },
});

test("a refused login and everything else map to their own screens; the address button follows the app mode", () => {
  for (const appMode of [false, true]) {
    assert.deepEqual(plain(errorScreen("forbidden", appMode)), {
      screen: "forbidden",
      title: FORBIDDEN,
      showAddressButton: false,
    });
    for (const kind of ["unreachable", "failed", undefined, "anything"])
      assert.deepEqual(plain(errorScreen(kind, appMode)), {
        screen: "unreachable",
        title: UNREACHABLE,
        showAddressButton: appMode,
      });
  }
});

test("only a refused login leaves the viewer for the forbidden screen", () => {
  assert.equal(connectFailure("forbidden"), "forbidden");
  for (const kind of ["unreachable", "failed", undefined])
    assert.equal(connectFailure(kind), "ended");
});

function recorder() {
  const log = [];
  const flow = createSessionFlow({
    begin: (input) => log.push(["begin", plain(input)]),
    ended: () => log.push(["ended"]),
  });
  return { flow, log };
}
const input = { targetId: "linux", width: 1920, height: 1080 };

test("a connection starts only from open() and reconnect(); errors, closes and state changes never start one", () => {
  const { flow, log } = recorder();
  flow.open(input);
  assert.deepEqual(log, [["begin", input]]);
  // Every notification a session can produce, in every order, adds no attempt.
  for (const order of [
    ["stopped", "ended", "connected", "ended", "stopped", "discard"],
    ["connected", "connected", "ended", "ended"],
  ]) {
    const attempts = log.filter(([kind]) => kind === "begin").length;
    for (const event of order) flow[event]();
    assert.equal(
      log.filter(([kind]) => kind === "begin").length,
      attempts,
      order.join(","),
    );
    flow.open(input); // the user starts again
  }
});

test("reconnect() needs a finished session and a remembered attempt", () => {
  const { flow, log } = recorder();
  flow.reconnect();
  assert.deepEqual(log, [], "nothing to reconnect to yet");
  flow.open(input);
  flow.connected();
  flow.reconnect();
  assert.equal(log.length, 1, "a live session is not reconnected");
  flow.ended();
  flow.reconnect();
  assert.deepEqual(
    log.map(([kind]) => kind),
    ["begin", "ended", "begin"],
  );
  flow.discard();
  flow.reconnect();
  assert.equal(log.length, 3, "leaving the viewer forgets the attempt");
});

test("the resolution picked later is used by the next reconnect, and attempts get copies", () => {
  const { flow, log } = recorder();
  flow.open(input);
  flow.ended();
  flow.resize(2560, 1440);
  flow.reconnect();
  assert.deepEqual(log.at(-1), [
    "begin",
    { targetId: "linux", width: 2560, height: 1440 },
  ]);
  const own = { ...input };
  flow.open(own);
  own.width = 1; // the caller's object is not the stored one
  flow.ended();
  flow.reconnect();
  assert.equal(log.at(-1)[1].width, 1920);
});

// ---- main.ts itself, with a fake page, fake Guacamole and a fake fetch ----

const endings = {
  "the remote reports an error": (v) => v.clients.at(-1).onerror(),
  "the tunnel reports an error": (v) => v.tunnels.at(-1).onerror(),
  "the connection state becomes disconnected": (v) =>
    v.clients.at(-1).onstatechange(5),
  "the user disconnects from the menu": (v) => v.action("disconnect"),
};

for (const [name, end] of Object.entries(endings))
  for (const connectedFirst of [true, false])
    test(`when ${name}${connectedFirst ? "" : " while still connecting"}, the page shows the ended card and starts no new connection until a click`, async () => {
      const v = await viewer({ appMode: true, targets: [online] });
      assert.equal(v.tiles().length, 1);
      v.tiles()[0].click();
      await v.settle();
      assert.equal(v.posts(), 1);
      assert.equal(v.clients.length, 1);
      if (connectedFirst) v.clients[0].onstatechange(3);
      end(v);
      await v.settle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(v.posts(), 1, "no attempt was started by the ending");
      assert.equal(v.clients.length, 1);
      assert.equal(v.el("overlay").hidden, false);
      assert.equal(v.el("overlay-title").textContent, ENDED);
      assert.equal(v.el("overlay-actions").hidden, false);
      // Only an explicit click (or the menu entry) connects again.
      v.el("overlay-reconnect").click();
      await v.settle();
      assert.equal(v.posts(), 2);
      assert.equal(v.clients.length, 2);
      v.clients[1].onstatechange(3);
      v.el("overlay-reconnect").click();
      v.action("reconnect");
      await v.settle();
      assert.equal(v.posts(), 2, "a live session is not reconnected");
      end(v);
      v.action("reconnect");
      await v.settle();
      assert.equal(v.posts(), 3, "the menu's reconnect works after an end");
    });

test("a failed connection request shows the ended card once and is not retried", async () => {
  for (const answer of [
    () => response(502),
    () => response(500, { error: "boom" }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const v = await viewer({
      targets: [online],
      fetchHandler: (path, init, ok) =>
        path === "/api/sessions" ? answer() : ok(path, init),
    });
    v.tiles()[0].click();
    await v.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(v.posts(), 1);
    assert.equal(v.clients.length, 0);
    assert.equal(v.el("overlay-title").textContent, ENDED);
    assert.equal(v.el("overlay-actions").hidden, false);
  }
});

test("a refused login while connecting leaves for the forbidden screen, keeps 다시 시도 and never retries", async () => {
  const v = await viewer({
    appMode: true,
    targets: [online],
    fetchHandler: (path, init, ok) =>
      path === "/api/sessions"
        ? response(403, { code: "login", error: "x" })
        : ok(path, init),
  });
  v.tiles()[0].click();
  await v.settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(v.posts(), 1);
  assert.equal(v.el("session").hidden, true);
  assert.equal(v.el("state").hidden, false);
  assert.equal(v.el("state-title").textContent, FORBIDDEN);
  assert.equal(v.el("state-actions").hidden, false);
  assert.equal(v.el("state-address").hidden, true);
});

for (const appMode of [false, true])
  test(`the list failure screens (${appMode ? "app" : "browser"}): unreachable and forbidden differ, retry is always offered`, async () => {
    let answer = () => {
      throw new TypeError("fetch failed");
    };
    const v = await viewer({
      appMode,
      targets: [online],
      fetchHandler: (path, init, ok) =>
        path === "/api/targets" ? answer() : ok(path, init),
    });
    const shown = () => ({
      title: v.el("state-title").textContent,
      screen: ["home", "state", "session"].find((n) => !v.el(n).hidden),
      retry: !v.el("state-actions").hidden,
      address: !v.el("state-address").hidden,
    });
    assert.deepEqual(shown(), {
      title: UNREACHABLE,
      screen: "state",
      retry: true,
      address: appMode,
    });
    answer = () => response(403, { code: "login", error: "x" });
    v.el("state-retry").click();
    await v.settle();
    assert.deepEqual(shown(), {
      title: FORBIDDEN,
      screen: "state",
      retry: true,
      address: false,
    });
    answer = () => response(502);
    v.el("menu-refresh").click();
    await v.settle();
    assert.equal(shown().title, UNREACHABLE);
    assert.equal(shown().address, appMode);
    answer = () => response(200, { targets: [online] });
    v.el("state-retry").click();
    await v.settle();
    assert.equal(shown().screen, "home");
    assert.equal(v.tiles().length, 1);
    assert.equal(v.gets(), 4);
    assert.equal(v.posts(), 0, "a list failure never opens a session");
  });
