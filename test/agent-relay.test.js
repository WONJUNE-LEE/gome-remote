import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, AGENT_MESSAGES } from "../server/gateway.js";
import { createAgentClient, normaliseStatus } from "../server/agent-client.js";
import { validateConfig } from "../server/config.js";
import { listenOnSocket } from "../server/listen.js";

// The gateway runs on a real unix socket; the Mac agent is a fake HTTP server on loopback
// that records what it receives. Nothing here knows the gateway's internals.
const posix = process.platform !== "win32";
const LOGIN = "owner@example.com";
const ORIGIN = "http://127.0.0.1:38989";
const TOKEN = "T".repeat(43);
const OFFER =
  "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\n";
const HEALTHY = {
  version: "0.1.0",
  screen: "granted",
  accessibility: "granted",
  display: "ok",
  locked: false,
  lastCaptureAt: 1_760_400_000,
};
const rdp = {
  id: "ubuntu",
  name: "Ubuntu",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const macAgent = {
  id: "mac",
  name: "Mac (새 방식)",
  protocol: "agent",
  platform: "mac",
  hostname: "100.64.0.20",
};

function request(
  socketPath,
  path,
  { method = "GET", headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method, headers },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, json });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, { token = TOKEN, wrapAgent } = {}) {
  const seen = []; // what the fake agent received
  const agentBehaviour = {
    status: (_req, res) => reply(res, 200, HEALTHY),
    session: (req, res, body) => reply(res, 200, { sdp: "v=0\r\nanswer" }),
  };
  const sockets = new Set();
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        host: req.headers.host,
        body,
      });
      if (req.url === "/v1/status") agentBehaviour.status(req, res);
      else if (req.url === "/v1/sessions")
        agentBehaviour.session(req, res, body ? JSON.parse(body) : undefined);
      else reply(res, 404, {});
    });
  });
  fake.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const agentPort = fake.address().port;

  let clock = 1_000_000;
  const logs = [];
  const gatewayLogs = []; // the gateway's own lines
  const entries = { mac: token ? { agentToken: token } : undefined };
  const credentials = {
    entries,
    lookup: async (target) => entries[target.id],
  };
  const agent = createAgentClient({
    address: () => ({ host: "127.0.0.1", port: agentPort }),
    now: () => clock,
    log: (line) => logs.push(line),
    statusTimeoutMs: 150,
    sessionTimeoutMs: 300,
  });
  const dir = await mkdtemp(join(tmpdir(), "gr-agent-"));
  const socketPath = join(dir, "g.sock");
  const config = validateConfig({
    socketPath,
    publicOrigin: ORIGIN,
    allowedLogins: [LOGIN],
    credentialsFile: join(dir, "credentials.json"),
    targets: [rdp, macAgent],
  });
  const gateway = createGateway(config, {
    credentials,
    probe: async () => true,
    agent: wrapAgent ? wrapAgent(agent) : agent,
    log: (line) => gatewayLogs.push(line),
    now: () => clock,
  });
  await listenOnSocket(gateway.server, socketPath);
  t.after(async () => {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => fake.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, { login = LOGIN, headers = {}, ...rest } = {}) =>
    request(socketPath, path, {
      ...rest,
      headers: {
        ...(login ? { "Tailscale-User-Login": login } : {}),
        ...headers,
      },
    });
  const post = (input, { headers = {}, raw, ...rest } = {}) =>
    call("/api/agent-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw ?? JSON.stringify(input),
      ...rest,
    });
  return {
    seen,
    logs,
    gatewayLogs,
    agentBehaviour,
    call,
    post,
    entries,
    advance: (ms) => (clock += ms),
    stopAgent: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => fake.close(resolve));
    },
  };
}

function reply(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof value === "string" ? value : JSON.stringify(value));
}

const good = { targetId: "mac", width: 2560, height: 1440, sdp: OFFER };
const tile = async (f) =>
  (await f.call("/api/targets")).json.targets.find((t) => t.id === "mac");

// ---- /api/targets ----

test(
  "an agent tile is online with the agent's state, and the other targets are unchanged",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const { status, json } = await f.call("/api/targets");
    assert.equal(status, 200);
    const mac = json.targets.find((x) => x.id === "mac");
    assert.deepEqual(mac, {
      id: "mac",
      name: "Mac (새 방식)",
      platform: "mac",
      protocol: "agent",
      persistent: false,
      online: true,
      ready: true,
      agent: { issue: "none", display: "ok", lastCaptureAt: 1_760_400_000 },
    });
    const ubuntu = json.targets.find((x) => x.id === "ubuntu");
    assert.equal(ubuntu.online, true);
    assert.equal(ubuntu.agent, undefined);
    // The status request carried the token and nothing else of the gateway's.
    assert.equal(f.seen[0].path, "/v1/status");
    assert.equal(f.seen[0].authorization, `Bearer ${TOKEN}`);
  },
);

test(
  "the tile carries enumerations only: no token, no address, no agent text",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    f.agentBehaviour.status = (_req, res) =>
      reply(res, 200, {
        ...HEALTHY,
        note: "secret detail",
        hostname: "evil.example",
      });
    const { text } = await f.call("/api/targets");
    for (const leak of [
      TOKEN,
      "100.64.0.20",
      "18471",
      "secret detail",
      "evil.example",
      "0.1.0",
    ])
      assert.ok(!text.includes(leak), leak);
  },
);

test("the agent's state becomes issue permission, suspect, locked or none", () => {
  const cases = [
    [{}, "none"],
    [{ screen: "denied" }, "permission"],
    // A black-frame suspicion is shown but does not close the tile: a new session re-checks.
    [{ screen: "suspect" }, "suspect"],
    [{ accessibility: "denied" }, "permission"],
    [{ locked: true }, "locked"],
    [{ locked: true, screen: "denied" }, "permission"],
    // Black frames are expected on a lock screen, so locked wins over suspect.
    [{ locked: true, screen: "suspect" }, "locked"],
    [{ screen: "suspect", accessibility: "denied" }, "permission"],
  ];
  for (const [change, issue] of cases)
    assert.equal(
      normaliseStatus({ ...HEALTHY, ...change }).issue,
      issue,
      JSON.stringify(change),
    );
  assert.equal(
    normaliseStatus({ ...HEALTHY, lastCaptureAt: null }).lastCaptureAt,
    null,
  );
  assert.equal(
    normaliseStatus({ ...HEALTHY, display: "asleep" }).display,
    "asleep",
  );
});

test("a status the gateway does not understand makes the agent look offline", () => {
  for (const bad of [
    undefined,
    null,
    [],
    "ok",
    {},
    { ...HEALTHY, screen: "yes" },
    { ...HEALTHY, accessibility: undefined },
    { ...HEALTHY, display: "ON" },
    { ...HEALTHY, locked: "false" },
    { ...HEALTHY, lastCaptureAt: -1 },
    { ...HEALTHY, lastCaptureAt: 1.5 },
    { ...HEALTHY, lastCaptureAt: "now" },
    { ...HEALTHY, lastCaptureAt: undefined },
  ])
    assert.equal(normaliseStatus(bad), undefined, JSON.stringify(bad));
});

test(
  "without a token the tile needs setup and the agent is never asked",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, { token: null });
    const mac = await tile(f);
    assert.equal(mac.ready, false);
    assert.equal(mac.online, false);
    assert.equal(mac.agent, undefined);
    assert.equal(f.seen.length, 0);
  },
);

test(
  "a suspect screen is reported on the tile but the tile stays online and ready, and a session still opens",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    f.agentBehaviour.status = (_req, res) =>
      reply(res, 200, { ...HEALTHY, screen: "suspect" });
    const mac = await tile(f);
    assert.equal(mac.online, true);
    assert.equal(mac.ready, true);
    assert.equal(mac.agent.issue, "suspect");
    const { status, json } = await f.post(good);
    assert.equal(status, 200);
    assert.deepEqual(json, { sdp: "v=0\r\nanswer" });
  },
);

test(
  "an unreachable, slow or confused agent is offline, within the time limit",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    f.agentBehaviour.status = () => {}; // never answers
    const started = Date.now();
    const slow = await tile(f);
    assert.equal(slow.online, false);
    assert.equal(slow.ready, true);
    assert.ok(
      Date.now() - started < 1500,
      "bounded by the 2 s status limit (150 ms here)",
    );
    f.advance(11_000);
    f.agentBehaviour.status = (_req, res) =>
      reply(res, 200, "<html>not json</html>");
    assert.equal((await tile(f)).online, false);
    f.advance(11_000);
    f.agentBehaviour.status = (_req, res) => reply(res, 500, { error: "boom" });
    assert.equal((await tile(f)).online, false);
    f.advance(11_000);
    await f.stopAgent();
    assert.equal((await tile(f)).online, false, "connection refused");
  },
);

// Review Focus 5: a token is pasted, rotated, and the tile must follow at once.
test(
  "status answers are cached for 10 seconds, requests share one query, and a new token is a new question",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    let answered = 0;
    f.agentBehaviour.status = (_req, res) => {
      answered++;
      setTimeout(() => reply(res, 200, HEALTHY), 30);
    };
    await Promise.all(Array.from({ length: 6 }, () => f.call("/api/targets")));
    assert.equal(answered, 1, "six simultaneous page loads, one query");
    f.advance(9_999);
    await f.call("/api/targets");
    assert.equal(answered, 1, "still cached one millisecond before expiry");
    f.advance(1);
    await f.call("/api/targets");
    assert.equal(answered, 2, "expired at 10 s");
    f.entries.mac = { agentToken: "N".repeat(43) };
    await f.call("/api/targets");
    assert.equal(
      answered,
      3,
      "set-credential takes effect without waiting for the cache",
    );
    assert.equal(f.seen.at(-1).authorization, `Bearer ${"N".repeat(43)}`);
  },
);

test(
  "an offline answer is cached too, so a dead agent is probed once per 10 seconds",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    f.agentBehaviour.status = (_req, res) => reply(res, 503, {});
    await f.call("/api/targets");
    await f.call("/api/targets");
    await f.call("/api/targets");
    assert.equal(f.seen.filter((s) => s.path === "/v1/status").length, 1);
  },
);

// ---- the token ----

test(
  "a rejected token is logged once with the target ID and never with the token, and looks offline",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    f.agentBehaviour.status = (_req, res) =>
      reply(res, 401, { error: "unauthorized" });
    assert.equal((await tile(f)).online, false);
    f.advance(11_000);
    assert.equal((await tile(f)).online, false);
    assert.equal(f.logs.length, 1, "logged once, not at every probe");
    assert.match(f.logs[0], /"mac".*token/);
    assert.ok(!f.logs.join("\n").includes(TOKEN));
    // Recovery re-arms the log line.
    f.advance(11_000);
    f.agentBehaviour.status = (_req, res) => reply(res, 200, HEALTHY);
    assert.equal((await tile(f)).online, true);
    f.advance(11_000);
    f.agentBehaviour.status = (_req, res) => reply(res, 401, {});
    await tile(f);
    assert.equal(f.logs.length, 2);
  },
);

// ---- POST /api/agent-sessions ----

test(
  "an offer is relayed with the token, the size and the SDP, and the answer comes back",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const { status, json } = await f.post(good);
    assert.equal(status, 200);
    assert.deepEqual(json, { sdp: "v=0\r\nanswer" });
    const relayed = f.seen.find((s) => s.path === "/v1/sessions");
    assert.equal(relayed.method, "POST");
    assert.equal(relayed.authorization, `Bearer ${TOKEN}`);
    assert.match(relayed.contentType, /^application\/json/);
    assert.deepEqual(JSON.parse(relayed.body), {
      width: 2560,
      height: 1440,
      sdp: OFFER,
    });
  },
);

test(
  "every /api route refuses a missing or foreign login and a foreign Origin, before the agent is contacted",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const login of [null, "", "other@example.com", LOGIN.toUpperCase()]) {
      const refused = await f.post(good, { login });
      assert.equal(refused.status, 403, String(login));
      assert.equal(refused.json.code, "login");
    }
    const origin = await f.post(good, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(origin.status, 403);
    assert.equal(origin.json.code, "origin");
    const same = await f.post(good, { headers: { Origin: ORIGIN } });
    assert.equal(same.status, 200);
    assert.equal(f.seen.filter((s) => s.path === "/v1/sessions").length, 1);
  },
);

test(
  "the request is validated before the agent hears of it",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const expectations = [
      [
        "not json content type",
        () => f.post(good, { headers: { "Content-Type": "text/plain" } }),
        415,
      ],
      [
        "no content type",
        () =>
          f.call("/api/agent-sessions", {
            method: "POST",
            body: JSON.stringify(good),
          }),
        415,
      ],
      ["body is not JSON", () => f.post(null, { raw: "{nope" }), 400],
      ["body is an array", () => f.post([good]), 400],
      ["sdp missing", () => f.post({ ...good, sdp: undefined }), 400],
      ["sdp is a number", () => f.post({ ...good, sdp: 7 }), 400],
      [
        "sdp does not start with v=0",
        () => f.post({ ...good, sdp: "hello" }),
        400,
      ],
      ["width too small", () => f.post({ ...good, width: 639 }), 400],
      ["height too small", () => f.post({ ...good, height: 479 }), 400],
      ["width too large", () => f.post({ ...good, width: 3841 }), 400],
      ["height too large", () => f.post({ ...good, height: 2161 }), 400],
      ["width fractional", () => f.post({ ...good, width: 1920.5 }), 400],
      ["width a string", () => f.post({ ...good, width: "1920" }), 400],
      ["size missing", () => f.post({ targetId: "mac", sdp: OFFER }), 400],
      ["unknown target", () => f.post({ ...good, targetId: "nope" }), 404],
      [
        "a target that is not an agent",
        () => f.post({ ...good, targetId: "ubuntu" }),
        400,
      ],
      [
        "a client-supplied token",
        () => f.post({ ...good, agentToken: TOKEN }),
        400,
      ],
      [
        "a client-supplied password",
        () => f.post({ ...good, password: "x" }),
        400,
      ],
    ];
    for (const [what, send, status] of expectations)
      assert.equal((await send()).status, status, what);
    assert.equal(f.seen.length, 0, "the agent was never contacted");
    // The limits are inclusive.
    for (const [width, height] of [
      [640, 480],
      [3840, 2160],
    ])
      assert.equal((await f.post({ ...good, width, height })).status, 200);
  },
);

test(
  "the body limit is 64 KiB: one byte over is 413, exactly at the limit is relayed",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const make = (bytes) => {
      const shell = JSON.stringify({ ...good, sdp: "v=0\r\n" });
      const pad = bytes - Buffer.byteLength(shell);
      return JSON.stringify({ ...good, sdp: `v=0\r\n${"a".repeat(pad)}` });
    };
    const atLimit = make(64 * 1024);
    assert.equal(Buffer.byteLength(atLimit), 64 * 1024);
    assert.equal((await f.post(null, { raw: atLimit })).status, 200);
    const over = make(64 * 1024 + 1);
    assert.equal((await f.post(null, { raw: over })).status, 413);
    assert.equal(f.seen.filter((s) => s.path === "/v1/sessions").length, 1);
  },
);

test(
  "a target without a token answers 409 setup and the agent is not asked",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, { token: null });
    const { status, json } = await f.post(good);
    assert.equal(status, 409);
    assert.equal(json.code, "setup");
    assert.equal(f.seen.length, 0);
  },
);

test(
  "a refusal for a state reason reaches the page with its code and the gateway's own text",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const [agentStatus, code] of [
      [403, "permission"],
      [423, "locked"],
    ]) {
      f.agentBehaviour.session = (_req, res) =>
        reply(res, agentStatus, {
          error: "text the page must never see",
          code,
        });
      const { status, json } = await f.post(good);
      assert.equal(status, 409, code);
      assert.deepEqual(json, { error: AGENT_MESSAGES[code], code });
    }
  },
);

test(
  "every other agent failure is 'unavailable', in the gateway's words, and a bad token is logged apart",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const unavailable = {
      error: AGENT_MESSAGES.unavailable,
      code: "unavailable",
    };
    const failures = {
      "401 bad token": (_req, res) =>
        reply(res, 401, { error: "unauthorized" }),
      "403 with an unknown code": (_req, res) =>
        reply(res, 403, { code: "mystery" }),
      "403 without a code": (_req, res) => reply(res, 403, {}),
      "423 without a code": (_req, res) => reply(res, 423, {}),
      400: (_req, res) => reply(res, 400, { error: "offer rejected" }),
      500: (_req, res) => reply(res, 500, { error: "session failed" }),
      "503 busy": (_req, res) => reply(res, 503, "busy"),
      "200 not JSON": (_req, res) => reply(res, 200, "<html>"),
      "200 without sdp": (_req, res) => reply(res, 200, {}),
      "200 sdp not an SDP": (_req, res) => reply(res, 200, { sdp: "hello" }),
      hangs: () => {},
      "closes the connection": (req) => req.destroy(),
    };
    for (const [what, behaviour] of Object.entries(failures)) {
      f.agentBehaviour.session = behaviour;
      const { status, json, text } = await f.post(good);
      assert.equal(status, 424, what);
      assert.deepEqual(json, unavailable, what);
      assert.ok(
        !text.includes("session failed") && !text.includes("offer rejected"),
        what,
      );
    }
    assert.equal(
      f.logs.filter((l) => /token/.test(l)).length,
      1,
      "only the 401 mentions the token",
    );
    assert.ok(!f.logs.join("\n").includes(TOKEN));
  },
);

test(
  "a refusal drops the cached status so the tile shows the new state at once",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await tile(f)).agent.issue, "none");
    f.agentBehaviour.session = (_req, res) =>
      reply(res, 423, { code: "locked" });
    f.agentBehaviour.status = (_req, res) =>
      reply(res, 200, { ...HEALTHY, locked: true });
    assert.equal((await f.post(good)).status, 409);
    assert.equal((await tile(f)).agent.issue, "locked");
  },
);

test(
  "the Guacamole route refuses an agent target instead of building a connection for it",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const { status, json } = await f.call("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: "mac", width: 1920, height: 1080 }),
    });
    assert.equal(status, 400);
    assert.equal(json.ticket, undefined);
    assert.match(json.error, /agent-sessions/);
    assert.equal(f.seen.length, 0, "the agent was not contacted either");
  },
);

test(
  "a second offer while the first is waiting is relayed independently (the agent decides about takeover)",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const answers = ["v=0\r\nfirst", "v=0\r\nsecond"];
    let n = 0;
    f.agentBehaviour.session = (_req, res) =>
      reply(res, 200, { sdp: answers[n++] });
    const [a, b] = await Promise.all([f.post(good), f.post(good)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(new Set([a.json.sdp, b.json.sdp]), new Set(answers));
  },
);

// Final review 7: an error that is not the agent client's own is a bug in the gateway; the
// page still only learns "unavailable", but the log must say that something broke.
test(
  "an unexpected error while opening a session is logged once, without secrets, and answers 424",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      wrapAgent: (agent) => ({
        ...agent,
        createSession: async (_target, token) => {
          throw new TypeError(
            `cannot read properties (token ${token})\n    at secret/stack/line`,
          );
        },
      }),
    });
    const { status, json, text } = await f.post(good);
    assert.equal(status, 424);
    assert.deepEqual(json, {
      error: AGENT_MESSAGES.unavailable,
      code: "unavailable",
    });
    assert.ok(!text.includes("TypeError") && !text.includes(TOKEN));
    assert.equal(f.gatewayLogs.length, 1, f.gatewayLogs.join("\n"));
    const [line] = f.gatewayLogs;
    assert.ok(!line.includes("\n"), "one line");
    assert.ok(!line.includes(TOKEN), "no token");
    assert.match(line, /TypeError/);
    assert.match(line, /mac/, "names the target");
    // The client's own failures are not double-reported by the gateway.
    const g = await fixture(t);
    g.agentBehaviour.session = (_req, res) => reply(res, 500, {});
    assert.equal((await g.post(good)).status, 424);
    assert.deepEqual(g.gatewayLogs, []);
  },
);
