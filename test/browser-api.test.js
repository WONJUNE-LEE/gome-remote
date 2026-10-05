import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

async function browser({ window = {}, fetch, location } = {}) {
  const calls = [];
  let entry;
  const document = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen() {
        calls.push("enter");
        entry = Promise.withResolvers();
        return entry.promise;
      },
    },
    async exitFullscreen() {
      calls.push("exit");
      document.fullscreenElement = null;
    },
  };
  const exports = await loadTs("api.ts", {
    window,
    document,
    fetch,
    location: location || { origin: "https://gateway.example.ts.net:8450" },
    AbortSignal,
    JSON,
  });
  return {
    exports,
    api: exports.api,
    calls,
    document,
    completeEntry() {
      document.fullscreenElement = document.documentElement;
      entry.resolve();
    },
    rejectEntry() {
      entry.reject(new Error("Fullscreen denied"));
    },
  };
}

test("browser windowed intent waits for pending entry and exits exactly once", async () => {
  const f = await browser();
  const entering = f.api.fullscreen(true);
  assert.deepEqual(f.calls, ["enter"], "request starts in the user gesture");
  const exiting = f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter"]);
  f.completeEntry();
  await Promise.all([entering, exiting]);
  assert.deepEqual(f.calls, ["enter", "exit"]);
  assert.equal(f.document.fullscreenElement, null);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit"], "already windowed is a no-op");
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.equal(await f.api.fullscreenState(), true);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit", "enter", "exit"]);
});

test("browser fullscreen rejection allows a later attempt", async () => {
  const f = await browser();
  const denied = f.api.fullscreen(true);
  f.rejectEntry();
  await assert.rejects(denied, /Fullscreen denied/);
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.deepEqual(f.calls, ["enter", "enter"]);
  assert.equal(await f.api.fullscreenState(), true);
});

const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (body === undefined) throw new SyntaxError("not JSON");
    return body;
  },
});

test("requests are same-origin, carry no token and no credentials", async () => {
  const seen = [];
  const f = await browser({
    fetch: async (path, options) => {
      seen.push({ path, options });
      return path === "/api/targets"
        ? reply(200, { targets: [] })
        : reply(201, { ticket: "t1", expiresIn: 20 });
    },
  });
  await f.api.targets();
  const session = await f.api.connect({
    targetId: "ubuntu-server",
    width: 1920,
    height: 1080,
  });
  assert.equal(session.ticket, "t1");
  assert.equal(session.websocket, "wss://gateway.example.ts.net:8450/tunnel");
  assert.deepEqual(
    seen.map((s) => s.path),
    ["/api/targets", "/api/sessions"],
  );
  for (const { options } of seen) {
    assert.equal(options.credentials, "same-origin");
    const headers = options.headers || {};
    assert.equal(
      Object.keys(headers).some((k) => k.toLowerCase() === "authorization"),
      false,
    );
  }
  assert.equal(
    seen[1].options.body,
    '{"targetId":"ubuntu-server","width":1920,"height":1080}',
  );
  for (const key of ["username", "password", "token"])
    assert.equal(seen[1].options.body.includes(key), false, key);
});

test("errors are classified for the screens that show them", async () => {
  const outcomes = {
    "403 with the login code": reply(403, {
      error: "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.",
      code: "login",
    }),
    "403 for another reason": reply(403, {
      error: "Origin rejected.",
      code: "origin",
    }),
    "Serve's 502 page": reply(502, undefined),
    "an HTML 200": reply(200, undefined),
    "a JSON 500": reply(500, { error: "x" }),
    "a refusal with a message": reply(409, {
      error: "이 서버는 아직 설정되지 않았습니다.",
    }),
  };
  const expected = {
    "403 with the login code": "forbidden",
    "403 for another reason": "failed",
    "Serve's 502 page": "unreachable",
    "an HTML 200": "unreachable",
    "a JSON 500": "failed",
    "a refusal with a message": "failed",
  };
  for (const [name, response] of Object.entries(outcomes)) {
    const f = await browser({ fetch: async () => response });
    await assert.rejects(
      f.api.targets(),
      (error) => {
        assert.equal(error.name, "ApiError");
        assert.equal(error.kind, expected[name], name);
        return true;
      },
      name,
    );
  }
  const down = await browser({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(down.api.targets(), (error) => {
    assert.equal(error.kind, "unreachable");
    assert.equal(error.message, "서버에 연결할 수 없습니다");
    return true;
  });
});

test("app mode needs bridge version 1; anything older or absent behaves as a browser", async () => {
  const bridge = (version) => ({
    bridgeVersion: version,
    fullscreen: async (enabled) => `native:${enabled}`,
    fullscreenState: async () => "native-state",
    viewerState: async () => {},
    onViewerAction: () => () => {},
    onFullscreenChange: () => () => {},
    openSetup: async () => "opened",
  });
  const app = await browser({ window: { desktop: bridge(1) } });
  assert.equal(app.exports.appMode, true);
  assert.equal(await app.api.fullscreen(true), "native:true");
  assert.equal(await app.api.fullscreenState(), "native-state");
  assert.equal(await app.api.openSetup(), "opened");
  const later = await browser({ window: { desktop: bridge(2) } });
  assert.equal(later.exports.appMode, true, "newer bridges only add members");
  for (const desktop of [undefined, bridge(0), bridge(undefined)]) {
    const plain = await browser({ window: { desktop } });
    assert.equal(plain.exports.appMode, false);
    assert.equal(await plain.api.fullscreenState(), false);
    assert.equal(await plain.api.openSetup(), undefined);
    assert.deepEqual(plain.calls, []);
  }
});
