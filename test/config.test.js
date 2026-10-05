import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateConfig, MAX_SOCKET_PATH_BYTES } from "../server/config.js";

const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const base = {
  socketPath: "/tmp/gome-remote/gateway.sock",
  publicOrigin: "https://gateway.example.ts.net:8450",
  allowedLogins: ["owner@example.com"],
  credentialsFile: "/home/user/.config/gome-remote/credentials.json",
  targets: [target],
};

test("a complete configuration validates and applies only the guacd default", () => {
  const config = validateConfig(base);
  assert.equal(config.guacdPort, 4822);
  assert.deepEqual(config.allowedLogins, ["owner@example.com"]);
  assert.equal(config.devLogin, undefined);
});

test("allowedLogins is required, non-empty and has no default", () => {
  const { allowedLogins: _omitted, ...without } = base;
  for (const bad of [
    without,
    { ...base, allowedLogins: [] },
    { ...base, allowedLogins: "owner@example.com" },
    { ...base, allowedLogins: [""] },
    { ...base, allowedLogins: [42] },
    { ...base, allowedLogins: ["a@example.com, b@example.com"] },
    { ...base, allowedLogins: [" owner@example.com"] },
    { ...base, allowedLogins: Array(33).fill("a@example.com") },
  ])
    assert.throws(() => validateConfig(bad), /allowedLogins/);
});

test("legacy token, port and listenHost fields are refused instead of ignored", () => {
  assert.throws(
    () => validateConfig({ ...base, token: "x".repeat(43) }),
    /token/,
  );
  assert.throws(() => validateConfig({ ...base, port: 38989 }), /port/);
  assert.throws(
    () => validateConfig({ ...base, listenHost: "127.0.0.1" }),
    /listenHost/,
  );
});

test("socketPath must be an absolute file path that fits a unix socket", () => {
  for (const socketPath of [
    undefined,
    "gateway.sock",
    "./gateway.sock",
    "/run/gome/",
    "/tmp/a\0b.sock",
    `/tmp/${"x".repeat(MAX_SOCKET_PATH_BYTES)}.sock`,
    `/tmp/${"가".repeat(40)}.sock`,
  ])
    assert.throws(
      () => validateConfig({ ...base, socketPath }),
      /socketPath/,
      String(socketPath),
    );
  const longest = `/tmp/${"x".repeat(MAX_SOCKET_PATH_BYTES - 5)}`;
  assert.equal(Buffer.byteLength(longest), MAX_SOCKET_PATH_BYTES);
  assert.doesNotThrow(() => validateConfig({ ...base, socketPath: longest }));
});

test("credentialsFile must be an absolute path", () => {
  for (const credentialsFile of [undefined, "credentials.json", "~/c.json", 7])
    assert.throws(
      () => validateConfig({ ...base, credentialsFile }),
      /credentialsFile/,
    );
});

test("publicOrigin is a Tailscale HTTPS origin, or loopback http with a port for development", () => {
  for (const publicOrigin of [
    "https://example.com",
    "https://evil.ts.net.example.com",
    "https://.ts.net",
    "http://gateway.example.ts.net",
    "http://127.0.0.1",
    "http://localhost:38989",
    "https://gateway.example.ts.net:8450/",
    "https://user:pw@gateway.example.ts.net",
    "not a url",
    undefined,
  ])
    assert.throws(
      () => validateConfig({ ...base, publicOrigin }),
      Error,
      String(publicOrigin),
    );
  assert.doesNotThrow(() =>
    validateConfig({ ...base, publicOrigin: "http://127.0.0.1:38989" }),
  );
});

test("devLogin is accepted only with a loopback development origin and must be an allowed login", () => {
  const dev = {
    ...base,
    publicOrigin: "http://127.0.0.1:38989",
    devLogin: "owner@example.com",
  };
  assert.equal(validateConfig(dev).devLogin, "owner@example.com");
  assert.throws(
    () => validateConfig({ ...base, devLogin: "owner@example.com" }),
    /devLogin/,
  );
  assert.throws(
    () => validateConfig({ ...dev, devLogin: "other@example.com" }),
    /devLogin/,
  );
});

test("Remote Login is restricted to the colocated Linux authentication boundary", () => {
  const login = {
    ...target,
    hostname: "127.0.0.1",
    persistent: true,
    profile: "gnome-remote-login",
  };
  assert.equal(
    validateConfig({ ...base, targets: [login] }).targets[0].profile,
    "gnome-remote-login",
  );
  for (const change of [
    { hostname: "100.64.0.10" },
    { protocol: "vnc" },
    { platform: "windows" },
    { persistent: false },
    { persistent: undefined },
    { security: "tls" },
    { security: "any" },
    { profile: "autologin" },
  ]) {
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...login, ...change }] }),
    );
  }
  // Existing direct RDP and VNC profiles remain valid without this opt-in.
  assert.doesNotThrow(() => validateConfig(base));
});

test("configuration rejects arbitrary destinations and embedded credentials", () => {
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
  for (const credential of [{ password: "secret" }, { username: "alice" }])
    assert.throws(
      () =>
        validateConfig({ ...base, targets: [{ ...target, ...credential }] }),
      /credentials file/,
    );
});

test("target IDs are unique slugs", () => {
  for (const id of ["Upper", "has space", "", "a".repeat(65)])
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...target, id }] }),
    );
  assert.throws(() =>
    validateConfig({ ...base, targets: [target, { ...target }] }),
  );
});

test("a target id must be a string slug, not something that stringifies to one", () => {
  for (const id of [
    ["linux"],
    { toString: () => "linux" },
    42,
    null,
    undefined,
  ])
    assert.throws(
      () => validateConfig({ ...base, targets: [{ ...target, id }] }),
      /unique slugs/,
    );
});

test("unknown target keys are rejected by name and never by value", () => {
  for (const key of ["pasword", "token", "secret", "Password", "host"]) {
    const value = "hunter2-do-not-echo";
    assert.throws(
      () => validateConfig({ ...base, targets: [{ ...target, [key]: value }] }),
      (error) => {
        assert.ok(error.message.includes(key), error.message);
        assert.ok(!error.message.includes(value), error.message);
        return true;
      },
    );
  }
  // The explicit credential keys keep their dedicated message.
  assert.throws(
    () => validateConfig({ ...base, targets: [{ ...target, password: "x" }] }),
    /credentials file/,
  );
});

test("persistent must be a boolean when present", () => {
  for (const persistent of ["true", 1, null, {}])
    assert.throws(
      () => validateConfig({ ...base, targets: [{ ...target, persistent }] }),
      /persistent/,
    );
  for (const persistent of [true, false, undefined])
    assert.doesNotThrow(() =>
      validateConfig({ ...base, targets: [{ ...target, persistent }] }),
    );
});

test("the shipped example targets still validate", async () => {
  const targets = JSON.parse(
    await readFile(
      new URL("../deploy/targets.example.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validateConfig({ ...base, targets }).targets.length, 2);
});
