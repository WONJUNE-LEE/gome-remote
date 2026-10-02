import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createGateway, Tickets } from "../server/gateway.js";
import { validateConfig } from "../server/config.js";

const TOKEN = "x".repeat(43);
const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const base = {
  publicOrigin: "http://127.0.0.1:38989",
  token: TOKEN,
  targets: [target],
};

test("configuration rejects public network exposure and arbitrary destinations", () => {
  for (const hostname of [
    "192.168.1.1",
    "example.com",
    "100.63.255.255",
    "100.128.0.0",
    "::1",
    "fd7a:115c:bad::1",
  ]) {
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...target, hostname }] }),
    );
  }
  for (const hostname of [
    "127.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "fd7a:115c:a1e0::1234",
  ]) {
    assert.equal(
      validateConfig({ ...base, targets: [{ ...target, hostname }] }).targets[0]
        .hostname,
      hostname,
    );
  }
  assert.throws(() => validateConfig({ ...base, listenHost: "0.0.0.0" }));
  assert.throws(() =>
    validateConfig({ ...base, publicOrigin: "https://example.com" }),
  );
  assert.throws(() => validateConfig({ ...base, token: "password" }));
  assert.throws(() =>
    validateConfig({ ...base, targets: [{ ...target, password: "secret" }] }),
  );
});

test("connection tickets expire, are single-use, and cap pending credentials", () => {
  let now = 0;
  const tickets = new Tickets(() => now, 20);
  const first = tickets.issue({ secret: "a" });
  assert.deepEqual(tickets.take(first), { secret: "a" });
  assert.equal(tickets.take(first), undefined);
  const second = tickets.issue("b");
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

async function fixture(t, protocol = "rdp", clock = Date.now) {
  const received = [];
  const connections = new Set();
  const daemon = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let decoded;
      while ((decoded = decode(buffer))) {
        buffer = decoded.rest;
        const parts = decoded.parts;
        received.push(parts);
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
          assert.ok(
            received.findIndex((p) => p[0] === "size") < received.length - 1,
          );
          assert.ok(
            received.findIndex((p) => p[0] === "image") < received.length - 1,
          );
          socket.write(wire(["ready", "$test"]));
          // Deliberately split a multibyte name across TCP writes.
          const name = Buffer.from(wire(["name", "원격 🖥️"]));
          const cut = name.indexOf(Buffer.from("원")) + 1;
          socket.write(name.subarray(0, cut));
          setImmediate(() => socket.write(name.subarray(cut)));
        }
      }
    });
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const config = validateConfig({
    ...base,
    guacdPort: daemon.address().port,
    targets: [{ ...target, protocol }],
  });
  const gateway = createGateway(config, { now: clock });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async () => {
    await gateway.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => daemon.close(resolve));
  });
  const post = (input, token = TOKEN) =>
    fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  const open = (ticket, options = {}) =>
    new WebSocket(
      `${origin.replace("http", "ws")}/tunnel?ticket=${ticket}${options.query || ""}`,
      "guacamole",
      { origin: options.origin || base.publicOrigin },
    );
  return { received, connections, post, open, origin };
}

test("HTTP rejects missing authorization and unregistered targets before dialing guacd", async (t) => {
  const f = await fixture(t);
  for (const token of ["wrong", "y".repeat(43)]) {
    assert.equal((await f.post({ targetId: "linux" }, token)).status, 401);
    assert.equal(
      (
        await fetch(`${f.origin}/api/targets`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (await f.post({ targetId: "other", hostname: "8.8.8.8" })).status,
    404,
  );
  assert.equal(
    (await f.post({ targetId: "linux", width: 999999 })).status,
    400,
  );
  assert.equal((await fetch(`${f.origin}/api/targets`)).status, 401);
  assert.equal(f.connections.size, 0);
});

for (const protocol of ["rdp", "vnc"])
  test(`${protocol} tunnel authenticates only to the configured target and preserves Unicode`, async (t) => {
    const f = await fixture(t, protocol);
    const response = await f.post({
      targetId: "linux",
      username: "고매🖥",
      password: "암호🔑",
      hostname: "8.8.8.8",
      port: 22,
      width: 1920,
      height: 1080,
    });
    assert.equal(response.status, 201);
    const result = await response.json();
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
        "고매🖥",
        "암호🔑",
        "false",
        protocol === "rdp" ? "false" : "",
        "true",
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
    const [error] = await once(replay, "error");
    assert.match(error.message, /403/);
  });

test("WebSocket rejects wrong origin, extra settings, and expired tickets", async (t) => {
  let now = 0;
  const f = await fixture(t, "rdp", () => now);
  for (const options of [
    { origin: "https://evil.example" },
    { query: "&hostname=8.8.8.8" },
  ]) {
    const { ticket } = await (await f.post({ targetId: "linux" })).json();
    const socket = f.open(ticket, options);
    const [error] = await once(socket, "error");
    assert.match(error.message, /403/);
  }
  const { ticket } = await (await f.post({ targetId: "linux" })).json();
  now = 20_000;
  const socket = f.open(ticket);
  const [error] = await once(socket, "error");
  assert.match(error.message, /403/);
  assert.equal(f.connections.size, 0);
});
