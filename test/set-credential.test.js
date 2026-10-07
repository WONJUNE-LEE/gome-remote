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
  // The gateway is Linux-only and its config accepts POSIX paths only, so the
  // fixture never builds a config path with the host's separators on Windows.
  const credentialsFile = posix
    ? join(dir, "state", "credentials.json")
    : "/home/user/.config/gome-remote/credentials.json";
  const configPath = join(dir, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({
      socketPath: "/home/user/.local/state/gome-remote/gateway.sock",
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

// A fake terminal: isTTY, a setRawMode spy, and one timeline for what the program
// prints and when it switches raw mode, so the order can be asserted.
async function runTty(argv, keystrokes) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const timeline = [];
  stdin.setRawMode = (on) => {
    timeline.push(`raw:${on}`);
    return stdin;
  };
  const stdout = new PassThrough().on("data", (c) =>
    timeline.push(`out:${String(c)}`),
  );
  const err = [];
  const stderr = new PassThrough().on("data", (c) => err.push(String(c)));
  const done = main({ argv, stdin, stdout, stderr, requireTty: true });
  for (const chunk of keystrokes) {
    stdin.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stdin.end();
  const code = await done;
  return { code, timeline, err: err.join("") };
}

test(
  "on a terminal raw mode wraps exactly the password and confirmation prompts, never the username",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    const result = await runTty(
      [configPath, "ubuntu-server"],
      ["me\n", "pw-secret\r", "pw-secret\r"],
    );
    assert.equal(result.code, 0, result.err);
    const at = (text) =>
      result.timeline.findIndex(
        (e) => e.startsWith("out:") && e.includes(text),
      );
    const user = at("사용자 이름");
    const password = at("비밀번호: ");
    const confirm = at("비밀번호 확인");
    assert.ok(user >= 0 && user < password && password < confirm);
    assert.deepEqual(
      result.timeline.filter((e) => e.startsWith("raw:")),
      ["raw:true", "raw:false", "raw:true", "raw:false"],
    );
    assert.ok(
      !result.timeline.slice(0, password).some((e) => e.startsWith("raw:")),
      "the username is typed in the normal, echoing mode",
    );
    // Each raw:true follows its own prompt and is restored before the next output.
    assert.equal(result.timeline[password + 1], "raw:true");
    assert.equal(result.timeline[password + 2], "raw:false");
    assert.equal(result.timeline[password + 3], "out:\n");
    assert.equal(result.timeline[confirm + 1], "raw:true");
    assert.equal(result.timeline[confirm + 2], "raw:false");
    assert.ok(
      !result.timeline.join("").includes("pw-secret"),
      "the password is never written back",
    );
    assert.equal(
      (await readCredentialFile(credentialsFile)).get("ubuntu-server").password,
      "pw-secret",
    );
  },
);

test(
  "in raw mode backspace and delete remove the last character and arrow-key sequences are ignored",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    const result = await runTty(
      [configPath, "ubuntu-server"],
      [
        "me\n",
        // abc, delete c, d => abd; the arrow keys must not leave "[A" or "[1;5D" behind
        "abc\x7fd\x1b[A\x1b[B\x1b[1;5D\x1bOP\r",
        "abXX\b\x7fd\x1b[C\r",
      ],
    );
    assert.equal(result.code, 0, result.err);
    assert.equal(
      (await readCredentialFile(credentialsFile)).get("ubuntu-server").password,
      "abd",
    );
  },
);

test(
  "Ctrl-C and Ctrl-D cancel at any prompt with a failure status, restore the terminal and write nothing",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    for (const key of ["\x03", "\x04"]) {
      for (const keys of [
        [`me${key}`],
        ["me\n", `pass${key}`],
        ["me\n", "pass\n", `pass${key}`],
      ]) {
        const result = await runTty([configPath, "ubuntu-server"], keys);
        const label = JSON.stringify(keys);
        assert.notEqual(result.code, 0, label);
        assert.match(result.err, /Cancelled/, label);
        const raws = result.timeline.filter((e) => e.startsWith("raw:"));
        assert.equal(raws.length % 2, 0, `raw mode is left restored: ${label}`);
        assert.ok(raws.length === 0 || raws.at(-1) === "raw:false", label);
        assert.ok(!result.timeline.join("").includes("pass"), label);
        await assert.rejects(stat(credentialsFile), { code: "ENOENT" }, label);
      }
    }
  },
);

test(
  "the username is trimmed and the copy says only the password is hidden",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    const result = await run(
      [configPath, "ubuntu-server"],
      ["  gome \n", "pw\n", "pw\n"],
    );
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /비밀번호는 화면에 표시되지 않고/);
    assert.deepEqual(
      (await readCredentialFile(credentialsFile)).get("ubuntu-server"),
      { username: "gome", password: "pw" },
    );
  },
);

test(
  "length limits are inclusive: 1024/256 characters are stored, 1025/257 are refused",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    const store = async () =>
      (await readCredentialFile(credentialsFile)).get("ubuntu-server");
    const pw = (n) => `${"p".repeat(n)}\n`;
    const ok = await run(
      [configPath, "ubuntu-server"],
      [`${"u".repeat(256)}\n`, pw(1024), pw(1024)],
    );
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await store()).password.length, 1024);
    assert.equal((await store()).username.length, 256);

    const longPassword = await run(
      [configPath, "ubuntu-server"],
      ["other\n", pw(1025), pw(1025)],
    );
    assert.notEqual(longPassword.code, 0);
    assert.match(longPassword.err, /1-1024/);
    const longUser = await run(
      [configPath, "ubuntu-server"],
      [`${"u".repeat(257)}\n`, "pw\n", "pw\n"],
    );
    assert.notEqual(longUser.code, 0);
    assert.match(longUser.err, /256/);
    assert.equal(
      (await store()).username,
      "u".repeat(256),
      "kept the old entry",
    );
    assert.equal((await store()).password.length, 1024);
  },
);

test(
  "Apple's 8 character note appears from the ninth character on",
  { skip: !posix },
  async (t) => {
    const { configPath } = await setup(t);
    const eight = await run(
      [configPath, "mac"],
      ["\n", "12345678\n", "12345678\n"],
    );
    assert.equal(eight.code, 0, eight.err);
    assert.doesNotMatch(eight.out, /8자/);
    const nine = await run(
      [configPath, "mac"],
      ["\n", "123456789\n", "123456789\n"],
    );
    assert.equal(nine.code, 0, nine.err);
    assert.match(nine.out, /8자/);
  },
);
