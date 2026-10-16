import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../server/config.js";

const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const agent = {
  id: "mac",
  name: "Mac (새 방식)",
  platform: "mac",
  protocol: "agent",
  hostname: "100.64.0.20",
};
const base = {
  socketPath: "/tmp/gome-remote/gateway.sock",
  publicOrigin: "https://gateway.example.ts.net:8450",
  allowedLogins: ["owner@example.com"],
  credentialsFile: "/home/user/.config/gome-remote/credentials.json",
  targets: [target, agent],
};
const withTargets = (...targets) => ({ ...base, targets });

test("an agent target needs only an id, a name, the mac platform and a tailnet address; the port defaults to 18471", () => {
  const config = validateConfig(base);
  assert.equal(config.targets[1].port, 18471);
  assert.equal(config.targets[0].port, 3390, "other targets are left alone");
  assert.equal(
    validateConfig(withTargets({ ...agent, port: 19000 })).targets[0].port,
    19000,
  );
  assert.doesNotThrow(() =>
    validateConfig(withTargets({ ...agent, hostname: "fd7a:115c:a1e0::1234" })),
  );
  assert.equal(agent.port, undefined, "the caller's object is not modified");
});

test("an agent target refuses a platform other than mac, a non-tailnet address and a bad port, each for its own reason", () => {
  for (const [what, bad, reason] of [
    ["linux", { ...agent, platform: "linux" }, /must have platform mac/],
    ["windows", { ...agent, platform: "windows" }, /must have platform mac/],
    ["loopback", { ...agent, hostname: "127.0.0.1" }, /Tailscale IP/],
    ["lan", { ...agent, hostname: "192.168.0.5" }, /Tailscale IP/],
    ["name", { ...agent, hostname: "mac.example.ts.net" }, /Tailscale IP/],
    ["port 0", { ...agent, port: 0 }, /Invalid target port/],
    ["port 70000", { ...agent, port: 70000 }, /Invalid target port/],
    ["port text", { ...agent, port: "18471" }, /Invalid target port/],
  ])
    assert.throws(() => validateConfig(withTargets(bad)), reason, what);
});

test("platform mac is the only one an agent accepts, with a message that says why", () => {
  assert.throws(
    () => validateConfig(withTargets({ ...agent, platform: "linux" })),
    /agent.*mac/i,
  );
});

test("settings that only mean something for RDP or VNC are refused on an agent target", () => {
  for (const extra of [
    { security: "nla" },
    { ignoreCertificate: true },
    { profile: "gnome-remote-login" },
    { persistent: true },
  ])
    assert.throws(
      () => validateConfig(withTargets({ ...agent, ...extra })),
      /agent/i,
      JSON.stringify(extra),
    );
  assert.doesNotThrow(() =>
    validateConfig(withTargets({ ...agent, persistent: false })),
  );
});

test("rdp and vnc targets still need an explicit port, and unknown protocols are still refused", () => {
  assert.throws(
    () => validateConfig(withTargets({ ...target, port: undefined })),
    /port/i,
  );
  assert.throws(
    () => validateConfig(withTargets({ ...target, protocol: "ssh" })),
    /RDP, VNC/,
  );
});
