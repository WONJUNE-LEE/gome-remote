import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The repository is public. Tracked text may only use placeholders: example.com
// logins, placeholder tailnet names and the tailnet addresses below. The checks are
// shape based, so this file never has to contain a real login, device name, tailnet
// address or home directory.
const root = fileURLToPath(new URL("../", import.meta.url));

// Third-party content that is not ours to rewrite.
const skipped = (name) =>
  name === "package-lock.json" || name.startsWith("vendor/");

const placeholderTailnets = new Set([
  "example",
  "tail123",
  "tailnet",
  "your-tailnet",
  "evil",
]);
// 100.64.0.10 and 100.64.0.20 are the documented placeholders. The rest are the
// range-edge probes the configuration tests use (the tailnet range is 100.64 to 100.127).
const placeholderAddresses = new Set([
  "100.64.0.10",
  "100.64.0.20",
  "100.64.0.1",
  "100.64.0.99",
  "100.127.255.254",
]);
// The tailnet IPv6 prefix is fd7a:115c:a1e0::/48; this is the documented placeholder.
const placeholderAddresses6 = new Set(["fd7a:115c:a1e0::1234"]);
const placeholderHomes = new Set(["user"]);

// What this scan cannot do, by design:
// - A bare MagicDNS device name (for example "laptop" written without ".ts.net") has no
//   shape to match, so only full names ending in .ts.net are caught here.
// - Git history is not scanned. Checking history for identifiers is a separate one-off
//   step (spec D7) that runs over `git log --all -p` before the repository is published.

const emailPattern =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const tailnetHostPattern = /(?:[A-Za-z0-9-]+\.)*([A-Za-z0-9-]+)\.ts\.net\b/gi;
const tailnetAddressPattern =
  /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
// A tailnet IPv6 address: the prefix followed by at least one group, so the bare prefix
// that config.js checks for does not count.
const tailnetAddress6Pattern = /fd7a:115c:a1e0(?::{1,2}[0-9a-f]{1,4})+/gi;
const homePattern = /\/(?:home|Users)\/([A-Za-z0-9._-]+)\//g;

export function findIdentifiers(text) {
  const found = [];
  for (const [email] of text.matchAll(emailPattern)) {
    const [local, domain] = email.toLowerCase().split("@");
    if (domain.endsWith(".ts.net")) continue; // judged by the tailnet name below
    const isPlaceholder =
      domain === "example.com" ||
      domain.endsWith(".example.com") ||
      local === "noreply" ||
      local === "no-reply";
    if (!isPlaceholder) found.push(email);
  }
  for (const [host, label] of text.matchAll(tailnetHostPattern))
    if (!placeholderTailnets.has(label.toLowerCase())) found.push(host);
  for (const [address] of text.matchAll(tailnetAddressPattern))
    if (!placeholderAddresses.has(address)) found.push(address);
  for (const [address] of text.matchAll(tailnetAddress6Pattern))
    if (!placeholderAddresses6.has(address.toLowerCase())) found.push(address);
  for (const [path, name] of text.matchAll(homePattern))
    if (!placeholderHomes.has(name)) found.push(path);
  return found;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((name) => name && !skipped(name));
}

test("tracked text contains only placeholder logins, tailnet names, addresses and home directories", async () => {
  const problems = [];
  for (const name of trackedFiles()) {
    let buffer;
    try {
      buffer = await readFile(new URL(name, `file://${root}`));
    } catch (error) {
      if (error.code === "ENOENT") continue; // tracked but deleted in this checkout
      throw error;
    }
    if (buffer.includes(0)) continue; // binary
    for (const value of findIdentifiers(buffer.toString("utf8")))
      problems.push(`${name}: ${value}`);
  }
  assert.deepEqual(problems, []);
});

test("the scanner flags values that are not placeholders (positive control)", () => {
  // Built at run time so this file stays clean for the scan above.
  const tailnetIp = ["100", "100", "7", "7"].join(".");
  const tailnetHost = ["host", "realnet", "ts", "net"].join(".");
  const login = ["someone", "gmail.com"].join("@");
  const home = ["", "home", "someone", "x"].join("/");
  const tailnetIp6 = ["fd7a", "115c", "a1e0", "ab12", "34", "5678"].join(":");
  assert.deepEqual(
    findIdentifiers(
      `${tailnetIp} ${tailnetHost} ${login} ${home} ${tailnetIp6}`,
    ),
    [login, tailnetHost, tailnetIp, tailnetIp6, home.slice(0, -1)],
  );
  // Case does not hide it, and a compressed form is still an address.
  const prefix = ["fd7a", "115c", "a1e0"].join(":");
  assert.deepEqual(
    findIdentifiers(`${prefix.toUpperCase()}::AB12 ${prefix}::1`),
    [`${prefix.toUpperCase()}::AB12`, `${prefix}::1`],
  );
});

test("the bare tailnet IPv6 prefix, as server/config.js checks it, is not an address", () => {
  assert.deepEqual(findIdentifiers('startsWith("fd7a:115c:a1e0:")'), []);
});

test("the scanner accepts the documented placeholders", () => {
  assert.deepEqual(
    findIdentifiers(
      "owner@example.com noreply@hapi.run 100.64.0.10 100.64.0.20 " +
        "server.example.ts.net box.tail123.ts.net /home/user/remote 100.63.255.255 " +
        "fd7a:115c:a1e0::1234 FD7A:115C:A1E0::1234 fd7a:115c:bad::1",
    ),
    [],
  );
});
