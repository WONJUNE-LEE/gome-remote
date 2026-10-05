import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main, writeCredentialFile } from "../scripts/set-credential.mjs";
import { readCredentialFile } from "../server/credentials.js";

const posix = process.platform !== "win32";
const script = new URL("../scripts/set-credential.mjs", import.meta.url);

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-setcred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsFile = join(dir, "state", "credentials.json");
  const configPath = join(dir, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({
      socketPath: join(dir, "g.sock"),
      publicOrigin: "http://127.0.0.1:38991",
      allowedLogins: ["owner@example.com"],
      credentialsFile,
      targets: [
        {
          id: "ubuntu-server",
          name: "Ubuntu 서버",
          platform: "linux",
          protocol: "rdp",
          profile: "gnome-remote-login",
          hostname: "127.0.0.1",
          port: 3389,
          persistent: true,
        },
        {
          id: "mac",
          name: "Mac",
          platform: "mac",
          protocol: "vnc",
          hostname: "100.64.0.20",
          port: 5900,
        },
      ],
    }),
  );
  return { dir, configPath, credentialsFile };
}

// Feeds scripted keystrokes and records everything the program prints.
async function run(argv, keystrokes, options = {}) {
  const stdin = new PassThrough();
  const out = [];
  const err = [];
  const stdout = new PassThrough().on("data", (c) => out.push(String(c)));
  const stderr = new PassThrough().on("data", (c) => err.push(String(c)));
  const done = main({
    argv,
    stdin,
    stdout,
    stderr,
    requireTty: false,
    ...options,
  });
  for (const chunk of keystrokes) {
    stdin.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stdin.end();
  const code = await done;
  return { code, out: out.join(""), err: err.join("") };
}

test(
  "RDP target prompts for username and password, stores UTF-8 atomically with mode 600",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    // Split the Korean/emoji bytes mid-codepoint to exercise the UTF-8 decoder.
    const bytes = Buffer.from("고매\n비밀🔑번호\n비밀🔑번호\n");
    const cut = bytes.indexOf(Buffer.from("🔑")) + 2;
    const result = await run(
      [configPath, "ubuntu-server"],
      [bytes.subarray(0, cut), bytes.subarray(cut)],
    );
    assert.equal(result.code, 0, result.err);
    assert.ok(
      !result.out.includes("비밀🔑번호"),
      "the password is never echoed",
    );
    assert.match(result.out, /저장했습니다: ubuntu-server/);
    assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "state")), ["credentials.json"]);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("ubuntu-server"), {
      username: "고매",
      password: "비밀🔑번호",
    });
  },
);

test(
  "VNC target accepts a username and password and keeps other targets",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    await run([configPath, "ubuntu-server"], ["u\n", "p1\n", "p1\n"]);
    const result = await run(
      [configPath, "mac"],
      ["macuser\n", "longer-than-8\r\n", "longer-than-8\r\n"],
    );
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /사용자 이름/, "every target asks for a username");
    assert.doesNotMatch(
      result.out,
      /8자/,
      "account-name authentication has no 8 character limit",
    );
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("mac"), {
      username: "macuser",
      password: "longer-than-8",
    });
    assert.deepEqual(entries.get("ubuntu-server"), {
      username: "u",
      password: "p1",
    });
  },
);

test(
  "VNC target accepts an empty username and stores the password only",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    for (const blank of ["\n", "   \n"]) {
      const result = await run(
        [configPath, "mac"],
        [blank, "vncpass1\n", "vncpass1\n"],
      );
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /사용자 이름/);
      assert.doesNotMatch(result.out, /8자/);
      const entries = await readCredentialFile(credentialsFile);
      assert.deepEqual(entries.get("mac"), { password: "vncpass1" });
    }
  },
);

test(
  "a long password without a username gets Apple's 8 character note",
  { skip: !posix },
  async (t) => {
    const { configPath } = await setup(t);
    const result = await run(
      [configPath, "mac"],
      ["\n", "longer-than-8\n", "longer-than-8\n"],
    );
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /8자/);
  },
);

test(
  "an existing VNC username is replaced when the new answer is empty",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    await run(
      [configPath, "mac"],
      ["macuser\n", "pw12345678\n", "pw12345678\n"],
    );
    await run([configPath, "mac"], ["\n", "pw12345678\n", "pw12345678\n"]);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("mac"), { password: "pw12345678" });
  },
);

test(
  "a mismatched confirmation, empty value, or early EOF writes nothing",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    for (const keys of [
      ["u\n", "one\n", "two\n"],
      ["  \n", "pw\n", "pw\n"],
      ["u\n", "\n", "\n"],
      ["u\n"],
    ]) {
      const result = await run([configPath, "ubuntu-server"], keys);
      assert.notEqual(result.code, 0, JSON.stringify(keys));
      await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
    }
    for (const keys of [
      ["\n", "one\n", "two\n"],
      ["me\n", "\n", "\n"],
    ]) {
      const result = await run([configPath, "mac"], keys);
      assert.notEqual(result.code, 0, JSON.stringify(keys));
      await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
    }
  },
);

test("argument errors never prompt, and secrets cannot be passed as arguments", async (t) => {
  const { configPath, dir } = await setup(t);
  const env = {};
  for (const argv of [[], [configPath, "mac", "hunter2"]]) {
    const result = await run(argv, [], { env, home: dir });
    assert.equal(result.code, 2);
    assert.match(result.err, /Usage/);
    assert.equal(result.out, "");
  }
  const unknown = await run([configPath, "nope"], [], { env, home: dir });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /ubuntu-server, mac/);
  assert.equal(
    (await run(["/nonexistent.json", "mac"], [], { env, home: dir })).code,
    1,
  );
});

test(
  "with one argument the config comes from GOME_REMOTE_CONFIG",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    const result = await run(["mac"], ["\n", "vncpass1\n", "vncpass1\n"], {
      env: { GOME_REMOTE_CONFIG: configPath },
      home: join(dir, "unused-home"),
    });
    assert.equal(result.code, 0, result.err);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("mac"), { password: "vncpass1" });
  },
);

test(
  "with one argument and no environment the config is ~/.config/gome-remote/gateway.json",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    const home = join(dir, "home");
    const defaultConfig = join(home, ".config", "gome-remote", "gateway.json");
    await mkdir(dirname(defaultConfig), { recursive: true });
    await copyFile(configPath, defaultConfig);
    const result = await run(["mac"], ["\n", "vncpass1\n", "vncpass1\n"], {
      env: {},
      home,
    });
    assert.equal(result.code, 0, result.err);
    assert.ok((await readCredentialFile(credentialsFile)).has("mac"));

    // The environment wins over the default location.
    const other = await run(["mac"], [], {
      env: { GOME_REMOTE_CONFIG: join(dir, "missing.json") },
      home,
    });
    assert.equal(other.code, 1);
    assert.ok(other.err.includes(join(dir, "missing.json")));

    // No config at the default location is a clear failure, not a prompt.
    const none = await run(["mac"], [], { env: {}, home: join(dir, "empty") });
    assert.equal(none.code, 1);
    assert.equal(none.out, "");
    assert.ok(
      none.err.includes(
        join(dir, "empty", ".config", "gome-remote", "gateway.json"),
      ),
    );
  },
);

test(
  "the two-argument form ignores GOME_REMOTE_CONFIG",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    const result = await run(
      [configPath, "mac"],
      ["\n", "vncpass1\n", "vncpass1\n"],
      { env: { GOME_REMOTE_CONFIG: join(dir, "missing.json") }, home: dir },
    );
    assert.equal(result.code, 0, result.err);
    assert.ok((await readCredentialFile(credentialsFile)).has("mac"));
  },
);

test("the real command refuses piped input", { skip: !posix }, async (t) => {
  const { configPath, credentialsFile } = await setup(t);
  const result = spawnSync(
    process.execPath,
    [script.pathname, configPath, "mac"],
    { input: "secret\nsecret\n", encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive terminal/);
  assert.ok(!result.stdout.includes("secret"));
  await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
});

test(
  "a credentials file with the wrong mode is refused and left untouched",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    await mkdir(join(dir, "state"), { recursive: true });
    const original = '{"version":1,"targets":{}}';
    await writeFile(credentialsFile, original);
    await chmod(credentialsFile, 0o644);
    const result = await run([configPath, "mac"], ["pw\n", "pw\n"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /mode 600/);
    assert.equal(await readFile(credentialsFile, "utf8"), original);
  },
);

test(
  "a failed replacement keeps the old file and leaves no temporary file",
  { skip: !posix },
  async (t) => {
    const { dir } = await setup(t);
    const target = join(dir, "state", "credentials.json");
    await mkdir(join(target, "occupied"), { recursive: true });
    await assert.rejects(
      writeCredentialFile(target, new Map([["mac", { password: "pw" }]])),
    );
    assert.deepEqual(await readdir(join(dir, "state")), ["credentials.json"]);
    assert.deepEqual(await readdir(target), ["occupied"]);
  },
);

test(
  "running the command through a symbolic link still runs it",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    const link = join(dir, "set-credential-link.mjs");
    await symlink(script.pathname, link);
    const result = spawnSync(process.execPath, [link, configPath, "mac"], {
      input: "secret\nsecret\n",
      encoding: "utf8",
    });
    assert.equal(result.status, 2, "must not exit 0 without doing anything");
    assert.match(result.stderr, /interactive terminal/);
    await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
  },
);
