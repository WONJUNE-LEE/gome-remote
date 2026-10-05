import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGateway, Tickets } from "../server/gateway.js";
import { validateConfig } from "../server/config.js";
import { CredentialStore } from "../server/credentials.js";
import { listenOnSocket } from "../server/listen.js";

// The gateway listens on a unix socket, which Windows does not support the same way.
const posix = process.platform !== "win32";
const LOGIN = "owner@example.com";
const ORIGIN = "http://127.0.0.1:38989";
const FORBIDDEN = "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.";
const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const base = {
  socketPath: "/tmp/gr/gateway.sock",
  publicOrigin: ORIGIN,
  allowedLogins: [LOGIN],
  credentialsFile: "/tmp/gr/credentials.json",
  targets: [target],
};

test("connection tickets expire, are single-use, and cap pending credentials", () => {
  let now = 0;
  const tickets = new Tickets(() => now, 20);
  const first = tickets.issue({ secret: "a" });
  assert.deepEqual(tickets.take(first), { secret: "a" });
  assert.equal(tickets.take(first), undefined);
  const second = tickets.issue("b");
  const third = tickets.issue("c");
  now = 19;
  assert.equal(tickets.take(third), "c", "still valid one tick before the ttl");
  now = 20;
  assert.equal(tickets.take(second), undefined);
  for (let i = 0; i < 64; i++) tickets.issue(i);
  assert.throws(() => tickets.issue("overflow"));
  now = 40;
  tickets.issue("after-expiry");
  tickets.clear();
});

// An independent wire fixture: preserve every received instruction and inspect the
// actual TCP handshake, rather than asserting a mock call to the settings builder.
function wire(parts) {
  return (
    parts.map((p) => `${Array.from(String(p)).length}.${p}`).join(",") + ";"
  );
}
function decode(buffer) {
  let offset = 0;
  const parts = [];
  while (offset < buffer.length) {
    const dot = buffer.indexOf(".", offset);
    if (dot < 0) return null;
    const length = Number(buffer.slice(offset, dot));
    if (!Number.isInteger(length) || length < 0)
      throw new Error("Invalid wire input");
    const rest = Array.from(buffer.slice(dot + 1));
    if (rest.length <= length) return null;
    const part = rest.slice(0, length).join("");
    parts.push(part);
    offset = dot + 1 + part.length;
    const delimiter = buffer[offset++];
    if (delimiter === ";") return { parts, rest: buffer.slice(offset) };
    assert.equal(delimiter, ",");
  }
  return null;
}

// A deterministic, order-checkable burst of ~6 MiB of valid instructions.
const FLOOD_BLOBS = 1500;
const floodBlob = (i) => wire(["blob", String(i), String(i % 10).repeat(4096)]);

// `stats.opened` counts every connection ever accepted, so "no guacd connection was
// opened" cannot be satisfied by a connection that already closed again.
// `mode` makes the fixture fail like a real guacd: "args-error" answers `select` with an
// `error` instruction, "connect-error" answers `connect` with one (a failed login).
// Real guacd closes the connection after an error, and so does the fixture.
function fakeGuacd(received, connections, stats, mode = "ok") {
  return net.createServer((socket) => {
    stats.opened++;
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    // The gateway may hang up while the fixture is still writing (EPIPE/ECONNRESET).
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let stray = false;
    socket.on("data", (chunk) => {
      if (stray) return;
      buffer += chunk;
      for (;;) {
        let decoded;
        try {
          decoded = decode(buffer);
        } catch {
          // Anything that is not Guacamole (for example a port scanner) is dropped, and is
          // not the gateway: a stray probe of this ephemeral port must not count as a dial.
          if (!stray) stats.opened--;
          stray = true;
          return socket.destroy();
        }
        if (!decoded) break;
        buffer = decoded.rest;
        const parts = decoded.parts;
        received.push(parts);
        if (parts[0] === "select" && mode === "args-error") {
          socket.end(wire(["error", "Upstream unavailable", "519"]));
          return;
        }
        if (parts[0] === "select")
          socket.write(
            wire([
              "args",
              "VERSION_1_5_0",
              "hostname",
              "port",
              "username",
              "password",
              "read-only",
              "enable-drive",
              "disable-copy",
              "enable-wallpaper",
              "security",
            ]),
          );
        if (parts[0] === "connect") {
          assert.deepEqual(
            received.find((p) => p[0] === "size"),
            ["size", "1920", "1080", "96"],
          );
          assert.deepEqual(
            received.find((p) => p[0] === "image"),
            ["image", "image/png", "image/jpeg"],
          );
          if (mode === "connect-error") {
            socket.end(wire(["error", "Authentication failed", "769"]));
            return;
          }
          socket.write(wire(["ready", "$test"]));
          // Deliberately split a multibyte name across TCP writes.
          const name = Buffer.from(wire(["name", "원격 🖥️"]));
          const cut = name.indexOf(Buffer.from("원")) + 1;
          socket.write(name.subarray(0, cut));
          setImmediate(() => {
            socket.write(name.subarray(cut));
            // A 4K display: a burst of frame data right after `ready`.
            if (mode === "flood")
              for (let i = 0; i < FLOOD_BLOBS; i++) socket.write(floodBlob(i));
          });
        }
      }
    });
  });
}

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
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: parsed,
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const stub = (entries) => ({
  entries,
  lookup: async (t) => entries[t.id],
});
const defaults = {
  rdp: { linux: { username: "entry-user", password: "entry-password" } },
  vnc: { linux: { username: "", password: "vnc-password" } },
};

// A real gateway on a real unix socket in a short, private temp directory (the
// sun_path limit is about 100 bytes), with an independent guacd fixture behind it.
async function fixture(t, options = {}) {
  const {
    protocol = "rdp",
    clock = Date.now,
    overrides = {},
    config: extra = {},
    credentials = stub({ ...defaults[protocol] }),
    probe = async () => true,
    dist,
    guacd = "ok",
  } = options;
  const received = [];
  const connections = new Set();
  const stats = { opened: 0 };
  const daemon = fakeGuacd(received, connections, stats, guacd);
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const dir = await mkdtemp(join(tmpdir(), "gr-"));
  const socketPath = join(dir, "g.sock");
  const config = validateConfig({
    ...base,
    socketPath,
    guacdPort: daemon.address().port,
    targets: [{ ...target, protocol, ...overrides }],
    ...extra,
  });
  const gateway = createGateway(config, {
    now: clock,
    credentials,
    probe: probe ?? undefined,
    dist,
  });
  await listenOnSocket(gateway.server, socketPath);
  t.after(async () => {
    await gateway.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => daemon.close(resolve));
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
  const post = (input, { headers = {}, ...rest } = {}) =>
    call("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
      ...rest,
    });
  const open = (
    ticket,
    { origin = ORIGIN, query = "", login = LOGIN, headers = {} } = {},
  ) =>
    new WebSocket(
      `ws+unix://${socketPath}:/tunnel?ticket=${ticket}${query}`,
      "guacamole",
      {
        ...(origin ? { origin } : {}),
        headers: {
          ...(login ? { "Tailscale-User-Login": login } : {}),
          ...headers,
        },
      },
    );
  return {
    received,
    connections,
    opened: () => stats.opened,
    call,
    post,
    open,
    socketPath,
    credentials,
  };
}

async function rejected(socket) {
  const [error] = await once(socket, "error");
  assert.match(error.message, /403/);
}

// Resolves once the browser side has seen the remote's name, i.e. the whole
// handshake (select, args, connect, ready) reached the guacd fixture.
function handshake(ws) {
  return new Promise((resolve) =>
    ws.on("message", (data) => {
      if (data.toString().includes("원격")) resolve();
    }),
  );
}

test(
  "the guacd fixture records every connection it accepts (positive control for the no-connection assertions)",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.opened(), 0);
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    // A ticket alone does not touch guacd.
    assert.equal(f.opened(), 0);
    const ws = f.open(json.ticket);
    await handshake(ws);
    assert.equal(f.opened(), 1);
    assert.deepEqual(f.received[0], ["select", "rdp"]);
    ws.close();
    await once(ws, "close");
    // The counter keeps a connection that has already closed again.
    assert.equal(f.opened(), 1);
  },
);

test(
  "a missing or foreign Tailscale login is refused on every API route, with the exact message",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const login of [
      null,
      "",
      "other@example.com",
      `${LOGIN}, other@example.com`,
      LOGIN.toUpperCase(),
    ]) {
      for (const [path, options] of [
        ["/api/targets", {}],
        [
          "/api/sessions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{"targetId":"linux"}',
          },
        ],
        ["/api/unknown", {}],
      ]) {
        const response = await f.call(path, { login, ...options });
        assert.equal(response.status, 403, `${login} ${path}`);
        assert.deepEqual(response.json, { error: FORBIDDEN, code: "login" });
      }
    }
    assert.equal(f.opened(), 0);
    assert.equal((await f.call("/api/targets")).status, 200);
  },
);

test(
  "the removed bearer-token path grants nothing: `Authorization: Bearer undefined` without a login is refused everywhere",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const headers = { Authorization: "Bearer undefined" };
    const targets = await f.call("/api/targets", { login: null, headers });
    assert.equal(targets.status, 403);
    assert.deepEqual(targets.json, { error: FORBIDDEN, code: "login" });
    const sessions = await f.post(
      { targetId: "linux" },
      { login: null, headers },
    );
    assert.equal(sessions.status, 403);
    assert.deepEqual(sessions.json, { error: FORBIDDEN, code: "login" });
    assert.equal(sessions.json.ticket, undefined);
    // A ticket issued to a real login cannot be used with the bearer header alone.
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    await rejected(f.open(json.ticket, { login: null, headers }));
    await rejected(f.open("undefined", { login: null, headers }));
    assert.equal(f.opened(), 0);
    // The ticket itself was not consumed by the refused attempts.
    const ws = f.open(json.ticket);
    await handshake(ws);
    assert.equal(f.opened(), 1);
    ws.close();
  },
);

test(
  "the health check and static UI need no identity, API and tunnel do",
  { skip: !posix },
  async (t) => {
    const dist = await mkdtemp(join(tmpdir(), "gr-dist-"));
    t.after(() => rm(dist, { recursive: true, force: true }));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>ui</title>",
    );
    const f = await fixture(t, { dist });
    assert.equal((await f.call("/healthz", { login: null })).status, 200);
    const page = await f.call("/", { login: null });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>ui<\/title>/);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(
      (await f.call("/../package.json", { login: null })).status,
      404,
    );
    assert.equal((await f.call("/api/targets", { login: null })).status, 403);
  },
);

test(
  "static files never leave dist: encoded dot segments and absolute paths answer 404",
  { skip: !posix },
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "gr-st-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const dist = join(parent, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.html"), "<title>ui</title>");
    // Sentinels with servable extensions, one above dist and one next to dist.
    await writeFile(join(parent, "outside.html"), "OUTSIDE-SECRET");
    await writeFile(join(parent, "dist-sibling.html"), "SIBLING-SECRET");
    const f = await fixture(t, { dist });
    // Positive control: the same route does serve a file inside dist.
    const inside = await f.call("/index.html", { login: null });
    assert.equal(inside.status, 200);
    assert.match(inside.text, /<title>ui<\/title>/);
    const absolute = join(parent, "outside.html");
    for (const path of [
      "/%2e%2e/outside.html",
      "/%2E%2E/%2e%2e/outside.html",
      "/..%2foutside.html",
      "/..%2Foutside.html",
      "/%2e%2e%2foutside.html",
      "/..%5coutside.html",
      "/../outside.html",
      "/..%2f..%2f..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2fpackage.json",
      "/..%2fdist-sibling.html",
      `/${absolute}`,
      `//${absolute}`,
      `/%2f${encodeURIComponent(absolute).slice(3)}`,
      `/${encodeURIComponent(absolute)}`,
      "//etc/passwd",
      "/%2fetc%2fpasswd",
      "/index.html%00.html",
      "/%00",
    ]) {
      const response = await f.call(path, { login: null });
      assert.equal(response.status, 404, path);
      assert.ok(!response.text.includes("SECRET"), path);
      assert.ok(!response.text.includes("root:"), path);
    }
  },
);

test(
  "API Origin must be absent or the public origin; the old app origin is refused",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const origin of [
      "https://evil.example",
      "app://gome-remote",
      "null",
      ORIGIN + ".evil.example",
    ]) {
      const response = await f.call("/api/targets", {
        headers: { Origin: origin },
      });
      assert.equal(response.status, 403, origin);
      assert.equal(response.json.code, "origin");
    }
    assert.equal(
      (await f.call("/api/targets", { headers: { Origin: ORIGIN } })).status,
      200,
    );
    assert.equal((await f.call("/api/targets")).status, 200);
  },
);

test(
  "a 0.1.3 client that sends a bearer token and credentials is refused before any ticket or guacd contact",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const old = {
      Authorization: `Bearer ${"x".repeat(43)}`,
      "Content-Type": "application/json",
    };
    const response = await f.post(
      {
        targetId: "linux",
        username: "old-user",
        password: "old-secret",
        width: 1920,
        height: 1080,
      },
      { headers: old },
    );
    assert.equal(response.status, 400);
    assert.ok(!response.text.includes("old-secret"));
    assert.ok(!response.text.includes("old-user"));
    assert.equal(response.json.ticket, undefined);
    // Even an empty string counts as "sent credentials".
    assert.equal(
      (await f.post({ targetId: "linux", password: "" })).status,
      400,
    );
    assert.equal(
      (await f.post({ targetId: "linux", username: "" })).status,
      400,
    );
    // Its Electron-hosted origin is not the public origin.
    const app = await f.post(
      { targetId: "linux" },
      { headers: { Origin: "app://gome-remote" } },
    );
    assert.equal(app.status, 403);
    // The Authorization header neither helps nor hurts a request that passes the real checks.
    assert.equal(
      (
        await f.post(
          { targetId: "linux", width: 1920, height: 1080 },
          { headers: old },
        )
      ).status,
      201,
    );
    assert.equal(f.opened(), 0);
  },
);

test(
  "the target list carries state but no address and no secret",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      overrides: {
        profile: "gnome-remote-login",
        hostname: "127.0.0.1",
        persistent: true,
      },
    });
    const response = await f.call("/api/targets");
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.json.targets[0]).sort(), [
      "id",
      "name",
      "online",
      "persistent",
      "platform",
      "profile",
      "protocol",
      "ready",
    ]);
    assert.equal(response.json.targets[0].profile, "gnome-remote-login");
    assert.equal(response.json.targets[0].ready, true);
    for (const secret of ["entry-user", "entry-password", "127.0.0.1", "3390"])
      assert.ok(!response.text.includes(secret), secret);
  },
);

test(
  "online reflects a real TCP probe of the target",
  { skip: !posix },
  async (t) => {
    const listener = net.createServer().listen(0, "127.0.0.1");
    await once(listener, "listening");
    t.after(() => listener.close());
    const open = { hostname: "127.0.0.1", port: listener.address().port };
    const f = await fixture(t, { overrides: open, probe: null });
    assert.equal((await f.call("/api/targets")).json.targets[0].online, true);
    const closed = net.createServer().listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const g = await fixture(t, {
      overrides: { hostname: "127.0.0.1", port },
      probe: null,
    });
    assert.equal((await g.call("/api/targets")).json.targets[0].online, false);
  },
);

test(
  "a target without stored credentials is not ready and cannot start a session",
  { skip: !posix },
  async (t) => {
    const credentials = stub({});
    const f = await fixture(t, { credentials });
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, false);
    const response = await f.post({ targetId: "linux" });
    assert.equal(response.status, 409);
    assert.equal(f.opened(), 0);
    credentials.entries.linux = { username: "u", password: "p" };
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, true);
    assert.equal((await f.post({ targetId: "linux" })).status, 201);
  },
);

test(
  "HTTP rejects unregistered targets, bad bodies and bad sizes before dialing guacd",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.post({ targetId: "other", hostname: "8.8.8.8" })).status,
      404,
    );
    assert.equal(
      (await f.post({ targetId: "linux", width: 999999 })).status,
      400,
    );
    assert.equal((await f.post([])).status, 400);
    assert.equal(
      (
        await f.call("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await f.call("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(f.opened(), 0);
  },
);

test(
  "Remote Login ignores caller routing overrides and uses only the stored credentials",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      overrides: {
        profile: "gnome-remote-login",
        hostname: "127.0.0.1",
        persistent: true,
      },
    });
    const { json: ticket } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
      profile: "direct",
      hostname: "100.64.0.99",
      port: 22,
      security: "tls",
    });
    const ws = f.open(ticket.ticket);
    await handshake(ws);
    assert.deepEqual(f.received.find((p) => p[0] === "connect").slice(2, 6), [
      "127.0.0.1",
      "3390",
      "entry-user",
      "entry-password",
    ]);
    assert.equal(f.received.find((p) => p[0] === "connect").at(-1), "nla");
    ws.close();
    await once(ws, "close");
  },
);

for (const protocol of ["rdp", "vnc"])
  test(
    `${protocol} tunnel injects the stored credentials and preserves Unicode`,
    { skip: !posix },
    async (t) => {
      const credentials = stub({
        linux:
          protocol === "rdp"
            ? { username: "고매🖥", password: "암호🔑" }
            : { username: "", password: "암호🔑" },
      });
      const f = await fixture(t, { protocol, credentials });
      const response = await f.post({
        targetId: "linux",
        hostname: "8.8.8.8",
        port: 22,
        width: 1920,
        height: 1080,
      });
      assert.equal(response.status, 201);
      const result = response.json;
      assert.deepEqual(Object.keys(result).sort(), ["expiresIn", "ticket"]);
      const ws = f.open(result.ticket);
      const messages = [];
      const gotName = new Promise((resolve) =>
        ws.on("message", (data) => {
          messages.push(data.toString());
          if (data.toString().includes("원격")) resolve();
        }),
      );
      await gotName;
      assert.deepEqual(f.received[0], ["select", protocol]);
      assert.deepEqual(
        f.received.find((p) => p[0] === "connect"),
        [
          "connect",
          "VERSION_1_1_0",
          "100.64.0.10",
          "3390",
          protocol === "rdp" ? "고매🖥" : "",
          "암호🔑",
          "false",
          protocol === "rdp" ? "false" : "",
          "true",
          protocol === "rdp" ? "true" : "",
          protocol === "rdp" ? "nla" : "",
        ],
      );
      assert.ok(messages.includes("0.,5.$test;"));
      assert.ok(messages.includes(wire(["name", "원격 🖥️"])));
      ws.send("3.key,2.65,1.1;");
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (f.received.some((p) => p[0] === "key")) {
            clearInterval(interval);
            resolve();
          }
        }, 5);
        interval.unref();
      });
      assert.deepEqual(
        f.received.find((p) => p[0] === "key"),
        ["key", "65", "1"],
      );
      ws.close();
      await once(ws, "close");
      const replay = f.open(result.ticket);
      await rejected(replay);
    },
  );

test(
  "a Mac (VNC) target passes its stored account name and password to guacd for Apple Remote Desktop",
  { skip: !posix },
  async (t) => {
    const credentials = stub({
      linux: { username: "mac-user", password: "mac-secret" },
    });
    const f = await fixture(t, { protocol: "vnc", credentials });
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    const ws = f.open(json.ticket);
    await handshake(ws);
    const connect = f.received.find((p) => p[0] === "connect");
    // args order: version, hostname, port, username, password.
    assert.deepEqual(connect.slice(1, 6), [
      "VERSION_1_1_0",
      "100.64.0.10",
      "3390",
      "mac-user",
      "mac-secret",
    ]);
    ws.close();
    await once(ws, "close");
  },
);

test(
  "a Mac (VNC) target with only a stored password sends an empty username",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      protocol: "vnc",
      credentials: stub({ linux: { username: "", password: "mac-secret" } }),
    });
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    const ws = f.open(json.ticket);
    await handshake(ws);
    assert.deepEqual(f.received.find((p) => p[0] === "connect").slice(4, 6), [
      "",
      "mac-secret",
    ]);
    ws.close();
    await once(ws, "close");
  },
);

// What the browser sees on the tunnel until the gateway closes it. Bounded, so a
// gateway that swallows the error (and waits for its 15 s handshake timeout) fails here.
async function drain(ws, ms = 3000) {
  const messages = [];
  ws.on("message", (data) => messages.push(data.toString()));
  ws.on("error", () => {});
  let timer;
  const outcome = await Promise.race([
    once(ws, "close").then(() => "closed"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("still open"), ms);
    }),
  ]);
  clearTimeout(timer);
  return { messages, outcome };
}

for (const [mode, text, code] of [
  ["connect-error", "Authentication failed", "769"],
  ["args-error", "Upstream unavailable", "519"],
]) {
  test(
    `a guacd ${mode} reaches the browser, ends the tunnel and is never retried by the gateway`,
    { skip: !posix },
    async (t) => {
      const f = await fixture(t, { guacd: mode });
      const { json } = await f.post({
        targetId: "linux",
        width: 1920,
        height: 1080,
      });
      const ws = f.open(json.ticket);
      const { messages, outcome } = await drain(ws);
      assert.equal(outcome, "closed", "the tunnel is closed after the error");
      assert.deepEqual(
        messages,
        [wire(["error", text, code])],
        "the browser receives guacd's error instruction unchanged, and nothing else",
      );
      assert.equal(f.opened(), 1);
      // The gateway must not dial guacd again by itself (an account-lockout risk on
      // the remote machine): wait, then check there was still exactly one attempt.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(f.opened(), 1, "no reconnection by the gateway");
      assert.ok(f.received.every((p) => p[0] !== "autoretry"));
      assert.equal(
        f.received.filter((p) => p[0] === "select").length,
        1,
        "one select for the one ticket",
      );
      // The ticket is spent; another attempt needs a new, explicit request.
      await rejected(f.open(json.ticket));
      assert.equal(f.opened(), 1);
    },
  );
}

test(
  "a slow browser does not kill the tunnel: a ~6 MiB burst from guacd is held back and delivered in order",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, { guacd: "flood" });
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    const ws = f.open(json.ticket);
    let closed = false;
    ws.on("close", () => (closed = true));
    ws.on("error", () => {});
    const blobs = [];
    ws.on("message", (data) => {
      const text = data.toString();
      if (text.startsWith("4.blob")) blobs.push(text);
    });
    await once(ws, "open");
    // The browser reads nothing for a while, as when the app is busy decoding.
    ws.pause();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(closed, false, "the tunnel survives a slow reader");
    ws.resume();
    const deadline = Date.now() + 15_000;
    while (blobs.length < FLOOD_BLOBS && !closed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false, "the tunnel is still open after the burst");
    assert.equal(blobs.length, FLOOD_BLOBS);
    for (let i = 0; i < FLOOD_BLOBS; i++)
      assert.equal(
        blobs[i],
        floodBlob(i),
        `instruction ${i} arrives intact and in order`,
      );
    ws.close();
    await once(ws, "close");
  },
);

test(
  "a finished session is not reopened by the gateway: the ticket is spent and nothing is redialed",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const { json } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
    });
    const ws = f.open(json.ticket);
    await handshake(ws);
    ws.close();
    await once(ws, "close");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rejected(f.open(json.ticket));
    assert.equal(f.opened(), 1);
  },
);

test(
  "session sizes are inclusive at 640x480 and 3840x2160 and refused one pixel beyond",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const [width, height] of [
      [640, 480],
      [3840, 2160],
      [640, 2160],
      [3840, 480],
    ])
      assert.equal(
        (await f.post({ targetId: "linux", width, height })).status,
        201,
        `${width}x${height}`,
      );
    for (const [width, height] of [
      [639, 1080],
      [3841, 1080],
      [1920, 479],
      [1920, 2161],
      [1920.5, 1080],
    ])
      assert.equal(
        (await f.post({ targetId: "linux", width, height })).status,
        400,
        `${width}x${height}`,
      );
    assert.equal(f.opened(), 0);
  },
);

test(
  "WebSocket upgrades need the exact public Origin, a permitted login and the same login's ticket",
  { skip: !posix },
  async (t) => {
    let now = 0;
    const f = await fixture(t, {
      clock: () => now,
      config: { allowedLogins: [LOGIN, "second@example.com"] },
    });
    const fresh = async (login = LOGIN) =>
      (
        await f.post(
          { targetId: "linux", width: 1920, height: 1080 },
          { login },
        )
      ).json.ticket;
    for (const options of [
      { origin: "https://evil.example" },
      { origin: "app://gome-remote" },
      { origin: null },
      { origin: ORIGIN + "/" },
      { query: "&hostname=8.8.8.8" },
      { login: null },
      { login: "stranger@example.com" },
      { login: "second@example.com" },
    ])
      await rejected(f.open(await fresh(), options));
    const ticket = await fresh();
    const lastMoment = await fresh();
    now = 19_999;
    const early = f.open(lastMoment);
    await once(early, "open");
    early.close();
    now = 20_000;
    await rejected(f.open(ticket));
    assert.equal(
      f.opened(),
      1,
      "only the ticket one millisecond before expiry opened",
    );
    // A ticket survives a refused attempt only if the refusal happened before it was taken.
    now = 0;
    const good = f.open(await fresh());
    await once(good, "open");
    good.close();
  },
);

test(
  "a development login stands in for a missing header only when configured",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, { config: { devLogin: LOGIN } });
    assert.equal((await f.call("/api/targets", { login: null })).status, 200);
    assert.equal(
      (await f.call("/api/targets", { login: "other@example.com" })).status,
      403,
    );
    const production = await fixture(t);
    assert.equal(
      (await production.call("/api/targets", { login: null })).status,
      403,
    );
  },
);

test(
  "the gateway itself ignores devLogin unless publicOrigin is a loopback http origin",
  { skip: !posix },
  async (t) => {
    const received = [];
    // createGateway is called directly with an unvalidated configuration, as a
    // caller that skipped validateConfig would.
    const dir = await mkdtemp(join(tmpdir(), "gr-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "g.sock");
    for (const publicOrigin of [
      "https://gateway.example.ts.net",
      "http://127.0.0.1",
      "http://localhost:38989",
      "http://127.0.0.1.example.com:1234",
    ]) {
      const gateway = createGateway(
        {
          ...base,
          socketPath,
          publicOrigin,
          devLogin: LOGIN,
          guacdPort: 4822,
        },
        { credentials: stub(defaults.rdp), probe: async () => true },
      );
      await listenOnSocket(gateway.server, socketPath);
      const response = await request(socketPath, "/api/targets");
      received.push([publicOrigin, response.status, response.json]);
      await gateway.close();
    }
    for (const [origin, status, json] of received) {
      assert.equal(status, 403, origin);
      assert.deepEqual(json, { error: FORBIDDEN, code: "login" }, origin);
    }
    // Positive control: the same direct construction with a loopback origin honours it.
    const gateway = createGateway(
      {
        ...base,
        socketPath,
        publicOrigin: "http://127.0.0.1:38989",
        devLogin: LOGIN,
        guacdPort: 4822,
      },
      { credentials: stub(defaults.rdp), probe: async () => true },
    );
    await listenOnSocket(gateway.server, socketPath);
    t.after(() => gateway.close());
    assert.equal((await request(socketPath, "/api/targets")).status, 200);
  },
);

test(
  "the file-backed credential store plugs in and degrades when its mode is loosened",
  { skip: !posix },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gr-cs-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "credentials.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        targets: { linux: { username: "u", password: "p" } },
      }),
    );
    await chmod(file, 0o600);
    const store = new CredentialStore(file, { log: () => {} });
    const f = await fixture(t, { credentials: store });
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, true);
    await chmod(file, 0o644);
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, false);
    assert.equal((await f.post({ targetId: "linux" })).status, 409);
  },
);
