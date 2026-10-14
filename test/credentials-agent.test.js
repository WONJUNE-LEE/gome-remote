import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  credentialsFor,
  readCredentialFile,
} from "../server/credentials.js";

const posix = process.platform !== "win32";
const TOKEN = "A".repeat(43);
const OTHER = "b-_".repeat(14) + "cd"; // 44 characters, one too many
const protocols = new Map([
  ["ubuntu-server", "rdp"],
  ["mac-vnc", "vnc"],
  ["mac", "agent"],
]);

async function file(t, targets, mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), "gr-cred-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "credentials.json");
  await writeFile(path, JSON.stringify({ version: 1, targets }));
  await chmod(path, mode);
  return path;
}

const mixed = {
  "ubuntu-server": { username: "u", password: "p" },
  "mac-vnc": { username: "owner", password: "macpass" },
  mac: { agentToken: TOKEN },
};

test(
  "each target method has its own entry shape, and the three can live in one file",
  { skip: !posix },
  async (t) => {
    const path = await file(t, mixed);
    const entries = await readCredentialFile(path, process.getuid(), protocols);
    assert.deepEqual(
      credentialsFor(entries, { id: "mac", protocol: "agent" }),
      { agentToken: TOKEN },
    );
    assert.deepEqual(
      credentialsFor(entries, { id: "mac-vnc", protocol: "vnc" }),
      { username: "owner", password: "macpass" },
    );
    assert.deepEqual(
      credentialsFor(entries, { id: "ubuntu-server", protocol: "rdp" }),
      { username: "u", password: "p" },
    );
  },
);

test(
  "an agent entry is exactly {agentToken}: mixing it with a password or user name invalidates the whole file",
  { skip: !posix },
  async (t) => {
    for (const [bad, reason] of [
      [{ agentToken: TOKEN, password: "p" }, /mixes an agent token/],
      [{ agentToken: TOKEN, username: "u" }, /mixes an agent token/],
      [{ agentToken: TOKEN, extra: 1 }, /unknown field "extra"/],
    ]) {
      const path = await file(t, { ...mixed, mac: bad });
      await assert.rejects(
        readCredentialFile(path, process.getuid(), protocols),
        reason,
      );
      // The same file is invalid without the target list too: the shapes never mix.
      await assert.rejects(readCredentialFile(path, process.getuid()), reason);
    }
    // Control: the bare entry is fine without a target list.
    const clean = await file(t, { mac: { agentToken: TOKEN } });
    assert.deepEqual(
      (await readCredentialFile(clean, process.getuid())).get("mac"),
      { agentToken: TOKEN },
    );
  },
);

test(
  "a token is 43 base64url characters; anything else is refused without echoing it",
  { skip: !posix },
  async (t) => {
    // Control: a well-formed token is accepted, so the refusals below are about the value.
    const good = await file(t, { mac: { agentToken: TOKEN } });
    await readCredentialFile(good, process.getuid(), protocols);
    for (const bad of [
      "",
      "short",
      OTHER,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)} `,
      42,
      null,
      ["A".repeat(43)],
    ]) {
      const path = await file(t, { mac: { agentToken: bad } });
      await assert.rejects(
        readCredentialFile(path, process.getuid(), protocols),
        (error) => {
          assert.match(error.message, /"mac".*43 base64url characters/);
          // The message names the (random) temporary file; judge only the rest of it.
          const message = error.message.replaceAll(path, "<file>");
          if (bad !== "") assert.ok(!message.includes(String(bad)), message);
          return true;
        },
      );
    }
  },
);

test(
  "the entry shape must match the configured method of the target, or the whole file is invalid",
  { skip: !posix },
  async (t) => {
    const cases = [
      ["agent target with a password", { mac: { password: "p" } }],
      ["agent target with an empty entry", { mac: {} }],
      [
        "rdp target with an agent token",
        { "ubuntu-server": { agentToken: TOKEN } },
      ],
      ["vnc target with an agent token", { "mac-vnc": { agentToken: TOKEN } }],
    ];
    for (const [what, targets] of cases) {
      const path = await file(t, { ...mixed, ...targets });
      await assert.rejects(
        readCredentialFile(path, process.getuid(), protocols),
        /Credentials for/,
        what,
      );
    }
  },
);

test(
  "an entry for a target that is not configured may have either shape",
  { skip: !posix },
  async (t) => {
    const path = await file(t, {
      ghost: { agentToken: TOKEN },
      "ghost-two": { password: "p" },
    });
    const entries = await readCredentialFile(path, process.getuid(), protocols);
    assert.equal(entries.size, 2);
  },
);

test("credentialsFor never hands a password-shaped entry to an agent target or the reverse", () => {
  const entries = new Map([
    ["mac", { password: "p" }],
    ["ubuntu-server", { agentToken: TOKEN }],
    ["empty", {}],
  ]);
  assert.equal(
    credentialsFor(entries, { id: "mac", protocol: "agent" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "ubuntu-server", protocol: "rdp" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "empty", protocol: "agent" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "absent", protocol: "agent" }),
    undefined,
  );
});

test(
  "the store checks shapes against its targets; a mismatch makes every target not ready, with one log line",
  { skip: !posix },
  async (t) => {
    const path = await file(t, mixed);
    const lines = [];
    const store = new CredentialStore(path, {
      uid: process.getuid(),
      log: (line) => lines.push(line),
      targets: [
        { id: "ubuntu-server", protocol: "rdp" },
        { id: "mac-vnc", protocol: "vnc" },
        { id: "mac", protocol: "agent" },
      ],
    });
    assert.deepEqual(await store.lookup({ id: "mac", protocol: "agent" }), {
      agentToken: TOKEN,
    });
    assert.equal((await store.load()).size, 3);
    // Reconfigure "mac" as VNC while its entry is an agent token.
    const wrong = new CredentialStore(path, {
      uid: process.getuid(),
      log: (line) => lines.push(line),
      targets: [
        { id: "ubuntu-server", protocol: "rdp" },
        { id: "mac-vnc", protocol: "vnc" },
        { id: "mac", protocol: "vnc" },
      ],
    });
    assert.equal(
      await wrong.lookup({ id: "ubuntu-server", protocol: "rdp" }),
      undefined,
    );
    assert.equal(await wrong.lookup({ id: "mac", protocol: "vnc" }), undefined);
    assert.equal(lines.length, 1, "logged once, not per lookup");
    assert.ok(!lines[0].includes(TOKEN), "the token never reaches the log");
    await assert.rejects(wrong.load(), /"mac"/);
  },
);
