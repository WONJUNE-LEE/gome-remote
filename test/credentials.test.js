import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, symlink, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  CredentialFileError,
  MAX_CREDENTIAL_FILE_BYTES,
  credentialsFor,
  readCredentialFile,
} from "../server/credentials.js";

const posix = process.platform !== "win32";
const rdp = { id: "ubuntu-server", protocol: "rdp" };
const vnc = { id: "mac", protocol: "vnc" };
const valid = {
  version: 1,
  targets: {
    "ubuntu-server": { username: "고매", password: "비밀🔑번호" },
    mac: { password: "vncpass1" },
  },
};

async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(dir, value, mode = 0o600, name = "credentials.json") {
  const file = join(dir, name);
  await writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  await chmod(file, mode);
  return file;
}

test("credentialsFor requires a username for RDP and treats it as optional for VNC", () => {
  const entries = new Map([
    ["ubuntu-server", { username: "u", password: "p" }],
    ["mac", { password: "v" }],
    ["half-rdp", { password: "p" }],
    ["odd-vnc", { username: "u", password: "p" }],
    ["no-password", { username: "u" }],
  ]);
  assert.deepEqual(credentialsFor(entries, rdp), {
    username: "u",
    password: "p",
  });
  assert.deepEqual(credentialsFor(entries, vnc), {
    username: "",
    password: "v",
  });
  assert.equal(
    credentialsFor(entries, { id: "half-rdp", protocol: "rdp" }),
    undefined,
  );
  // Apple Remote Desktop authentication needs an account name; plain VNC does not.
  assert.deepEqual(
    credentialsFor(entries, { id: "odd-vnc", protocol: "vnc" }),
    {
      username: "u",
      password: "p",
    },
  );
  assert.equal(
    credentialsFor(entries, { id: "no-password", protocol: "vnc" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "absent", protocol: "rdp" }),
    undefined,
  );
});

test("a missing credentials file means no credentials, not an error", async (t) => {
  const dir = await workdir(t);
  assert.equal((await readCredentialFile(join(dir, "none.json"))).size, 0);
  const store = new CredentialStore(join(dir, "none.json"), { log: () => {} });
  assert.equal(await store.lookup(rdp), undefined);
});

test(
  "a valid file is read with Unicode preserved",
  { skip: !posix },
  async (t) => {
    const file = await write(await workdir(t), valid);
    const store = new CredentialStore(file);
    assert.deepEqual(await store.lookup(rdp), {
      username: "고매",
      password: "비밀🔑번호",
    });
    assert.deepEqual(await store.lookup(vnc), {
      username: "",
      password: "vncpass1",
    });
  },
);

test(
  "startup refuses a file whose mode is not exactly 600, naming the file but not a value",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    for (const mode of [0o644, 0o640, 0o660, 0o400, 0o700, 0o666]) {
      const file = await write(dir, valid, mode, `c-${mode.toString(8)}.json`);
      await assert.rejects(
        readCredentialFile(file),
        (error) => {
          assert.ok(error instanceof CredentialFileError);
          assert.match(error.message, /mode 600/);
          assert.ok(error.message.includes(file));
          assert.ok(!error.message.includes("비밀"));
          return true;
        },
        mode.toString(8),
      );
    }
  },
);

test(
  "startup refuses a file owned by another uid and a symbolic link",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const file = await write(dir, valid);
    await assert.rejects(
      readCredentialFile(file, process.getuid() + 1),
      /owned by the gateway user/,
    );
    const link = join(dir, "link.json");
    await symlink(file, link);
    await assert.rejects(readCredentialFile(link), /symbolic link/);
  },
);

test(
  "startup refuses malformed content without echoing it",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const secret = "never-print-this";
    for (const content of [
      "{not json " + secret,
      { version: 2, targets: {} },
      { version: 1 },
      { version: 1, targets: [] },
      { version: 1, targets: { "Bad ID": { password: secret } } },
      { version: 1, targets: { mac: { password: "" } } },
      { version: 1, targets: { mac: { password: 7 } } },
      { version: 1, targets: { mac: { password: secret, token: secret } } },
      { version: 1, targets: { mac: { password: secret, username: "" } } },
      { version: 1, targets: { mac: { password: "x".repeat(1025) } } },
      { version: 1, targets: { mac: secret } },
    ]) {
      const file = await write(dir, content);
      await assert.rejects(
        readCredentialFile(file),
        (error) => {
          assert.ok(error instanceof CredentialFileError);
          assert.ok(!error.message.includes(secret), error.message);
          return true;
        },
        JSON.stringify(content).slice(0, 60),
      );
    }
  },
);

test(
  "lookup picks up a rewritten file without a restart and degrades instead of throwing",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const logged = [];
    const file = join(dir, "credentials.json");
    const store = new CredentialStore(file, { log: (m) => logged.push(m) });
    assert.equal(await store.lookup(vnc), undefined);
    assert.deepEqual(
      logged,
      [],
      "a missing file is the normal first-run state",
    );
    await write(dir, valid);
    assert.equal((await store.lookup(vnc)).password, "vncpass1");
    await chmod(file, 0o644);
    assert.equal(await store.lookup(vnc), undefined);
    assert.equal(await store.lookup(vnc), undefined);
    assert.equal(logged.length, 1, "the same problem is logged once");
    assert.match(logged[0], /mode 600/);
    assert.ok(!logged[0].includes("vncpass1"));
    await chmod(file, 0o600);
    assert.equal((await store.lookup(vnc)).password, "vncpass1");
  },
);

test(
  "a FIFO at the credentials path is refused promptly instead of blocking",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const file = join(dir, "credentials.json");
    const made = spawnSync("mkfifo", ["-m", "600", file]);
    assert.equal(made.status, 0, "mkfifo is required for this test");
    // If the reader does block, opening the FIFO ourselves releases its thread.
    t.after(() =>
      open(file, "r+").then(
        (handle) => handle.close(),
        () => {},
      ),
    );
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("blocked"), 2000);
    });
    const outcome = await Promise.race([
      readCredentialFile(file).then(
        () => "resolved",
        (error) => error,
      ),
      timeout,
    ]);
    clearTimeout(timer);
    assert.notEqual(outcome, "blocked", "the open must not wait for a writer");
    assert.ok(outcome instanceof CredentialFileError);
    assert.match(outcome.message, /regular file/);
    assert.ok(outcome.message.includes(file));
  },
);

test(
  "value limits are inclusive: 1024 character passwords and 256 character usernames are accepted, one more is not",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const entry = (username, password) => ({
      version: 1,
      targets: {
        mac: { ...(username === undefined ? {} : { username }), password },
      },
    });
    const accepted = await readCredentialFile(
      await write(
        dir,
        entry("u".repeat(256), "p".repeat(1024)),
        0o600,
        "ok.json",
      ),
    );
    assert.equal(accepted.get("mac").password.length, 1024);
    assert.equal(accepted.get("mac").username.length, 256);
    await assert.rejects(
      readCredentialFile(
        await write(dir, entry(undefined, "p".repeat(1025)), 0o600, "pw.json"),
      ),
      /password of 1-1024/,
    );
    await assert.rejects(
      readCredentialFile(
        await write(dir, entry("u".repeat(257), "p"), 0o600, "user.json"),
      ),
      /username of 1-256/,
    );
  },
);

test(
  "the credentials file size limit is inclusive and refuses the byte after it",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const body = JSON.stringify(valid);
    const padded = (size) => body + " ".repeat(size - Buffer.byteLength(body));
    const atLimit = await write(
      dir,
      padded(MAX_CREDENTIAL_FILE_BYTES),
      0o600,
      "at.json",
    );
    assert.equal((await readCredentialFile(atLimit)).size, 2);
    const over = await write(
      dir,
      padded(MAX_CREDENTIAL_FILE_BYTES + 1),
      0o600,
      "over.json",
    );
    await assert.rejects(readCredentialFile(over), /larger than expected/);
  },
);
