import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, writeCredentialFile } from "../scripts/set-credential.mjs";
import { readCredentialFile } from "../server/credentials.js";

const posix = process.platform !== "win32";
const TOKEN = "Zx9_-".repeat(8) + "abc"; // 43 characters

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-setcred-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
          hostname: "127.0.0.1",
          port: 3389,
        },
        {
          id: "mac-vnc",
          name: "Mac (VNC)",
          platform: "mac",
          protocol: "vnc",
          hostname: "100.64.0.20",
          port: 5900,
        },
        {
          id: "mac",
          name: "Mac (새 방식)",
          platform: "mac",
          protocol: "agent",
          hostname: "100.64.0.20",
        },
      ],
    }),
  );
  return { dir, configPath, credentialsFile };
}

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
  "--agent-token stores {agentToken} atomically with mode 600, never echoes it, and keeps the other entries",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    await run([configPath, "ubuntu-server"], ["u\n", "p1\n", "p1\n"]);
    for (const argv of [
      [configPath, "mac", "--agent-token"],
      ["--agent-token", configPath, "mac"],
    ]) {
      const result = await run(argv, [`${TOKEN}\n`]);
      assert.equal(result.code, 0, result.err);
      assert.ok(!result.out.includes(TOKEN), "the token is never echoed");
      assert.ok(!result.err.includes(TOKEN));
      assert.match(result.out, /저장했습니다: mac/);
      assert.match(result.out, /토큰/, "the prompt says it asks for a token");
      assert.doesNotMatch(result.out, /VNC 비밀번호|사용자 이름/);
    }
    assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "state")), ["credentials.json"]);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("mac"), { agentToken: TOKEN });
    assert.deepEqual(entries.get("ubuntu-server"), {
      username: "u",
      password: "p1",
    });
  },
);

// Review Focus 5: a token is pasted, rotated, and the tile must follow at once.
test(
  "a token pasted with surrounding spaces or CRLF is accepted; the stored value is trimmed",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    const result = await run(
      [configPath, "mac", "--agent-token"],
      [`  ${TOKEN}  \r\n`],
    );
    assert.equal(result.code, 0, result.err);
    assert.deepEqual((await readCredentialFile(credentialsFile)).get("mac"), {
      agentToken: TOKEN,
    });
  },
);

test(
  "a malformed token, an empty answer or an early EOF writes nothing and does not print the value",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    for (const keys of [
      ["short\n"],
      [`${TOKEN}X\n`],
      [`${TOKEN.slice(1)}\n`],
      [`${TOKEN.slice(0, 42)}+\n`],
      [`${TOKEN.slice(0, 20)} ${TOKEN.slice(21)}\n`],
      ["\n"],
      [],
    ]) {
      const result = await run([configPath, "mac", "--agent-token"], keys);
      assert.equal(result.code, 1, JSON.stringify(keys));
      assert.match(result.err, /저장하지 않았습니다|Input ended/);
      for (const key of keys)
        if (key.trim().length > 3)
          assert.ok(
            !(result.out + result.err).includes(key.trim()),
            "value echoed",
          );
    }
    await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
  },
);

test("an agent target needs --agent-token, and the flag is refused on RDP and VNC targets; nothing is prompted", async (t) => {
  const { configPath, dir } = await setup(t);
  const env = {};
  const needsFlag = await run([configPath, "mac"], [], { env, home: dir });
  assert.equal(needsFlag.code, 2);
  assert.match(needsFlag.err, /--agent-token/);
  assert.equal(needsFlag.out, "");
  for (const id of ["ubuntu-server", "mac-vnc"]) {
    const refused = await run([configPath, id, "--agent-token"], [], {
      env,
      home: dir,
    });
    assert.equal(refused.code, 2, id);
    assert.match(refused.err, /--agent-token/);
    assert.equal(refused.out, "");
  }
});

test("a token can never be passed as an argument, and unknown or repeated flags are usage errors", async (t) => {
  const { configPath, dir } = await setup(t);
  const env = {};
  if (posix) {
    // Control: the bare flag is a valid invocation, so the refusals below are about the extras.
    const ok = await run([configPath, "mac", "--agent-token"], [`${TOKEN}\n`]);
    assert.equal(ok.code, 0, ok.err);
  }
  for (const argv of [
    [configPath, "mac", `--agent-token=${TOKEN}`],
    [configPath, "mac", "--agent-token", TOKEN],
    [configPath, "mac", "--agent-token", "--agent-token"],
    [configPath, "mac", "--token"],
    [configPath, "mac", "-t"],
  ]) {
    const result = await run(argv, [], { env, home: dir });
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, /Usage/);
    assert.ok(!result.err.includes(TOKEN) && !result.out.includes(TOKEN));
    assert.equal(result.out, "");
  }
});

// Final review 4: only the exact flag is a flag, and a pasted token is never echoed back.
test("a token pasted after the flag is never echoed in an error, wherever it lands", async (t) => {
  const { configPath, dir } = await setup(t);
  const env = {};
  for (const argv of [
    [configPath, "--agent-token", TOKEN], // the token becomes the target id
    ["--agent-token", TOKEN], // ... with the config implied
    ["--agent-token", TOKEN, "mac"], // ... or the config path
    [TOKEN, "mac"],
    [configPath, "mac", TOKEN], // too many positionals
    [configPath, "mac", "extra", "--agent-token"],
  ]) {
    const result = await run(argv, [], { env, home: dir });
    assert.notEqual(result.code, 0, argv.join(" "));
    assert.ok(
      !result.err.includes(TOKEN) && !result.out.includes(TOKEN),
      `echoed the token for: ${argv.map((a) => (a === TOKEN ? "<token>" : a)).join(" ")}`,
    );
  }
  // A target id that does not look like a token is still named, so a typo is easy to find.
  const typo = await run([configPath, "mca", "--agent-token"], [], {
    env,
    home: dir,
  });
  assert.equal(typo.code, 1);
  assert.match(typo.err, /Unknown target "mca"/);
  // A token-shaped unknown id says so without the value, and still lists the real targets.
  const shaped = await run([configPath, "--agent-token", TOKEN], [], {
    env,
    home: dir,
  });
  assert.equal(shaped.code, 1);
  assert.match(shaped.err, /Unknown target\b/);
  assert.match(shaped.err, /ubuntu-server, mac-vnc, mac/);
  assert.doesNotMatch(shaped.err, /Unknown target "/);
});

// Re-review of item 4: the token can also arrive glued to an option or to other text.
test("an option other than the exact --agent-token is a usage error, and no argument holding a token is echoed", async (t) => {
  const { configPath, dir } = await setup(t);
  const env = {};
  for (const argv of [
    [configPath, `--agent-token=${TOKEN}`],
    [`--agent-token=${TOKEN}`, "mac"],
    [configPath, "mac", `--agent-token=${TOKEN}`],
    [configPath, `--foo=${TOKEN}`],
    [`--foo=${TOKEN}`, "mac"],
    [configPath, "--foo", TOKEN],
  ]) {
    const result = await run(argv, [], { env, home: dir });
    assert.equal(result.code, 2, argv.join(" ").replace(TOKEN, "<token>"));
    assert.match(result.err, /Usage/);
    assert.ok(!result.err.includes(TOKEN), "stderr holds the token");
    assert.ok(!result.out.includes(TOKEN), "stdout holds the token");
  }
  // A token inside a longer, non-option argument: unknown target / unusable path, not echoed.
  for (const argv of [
    [configPath, `x${TOKEN}`],
    [configPath, `${TOKEN}-more`],
    [join(dir, TOKEN, "gateway.json"), "mac"],
    [`/nope/${TOKEN}`, "mac"],
  ]) {
    const result = await run(argv, [], { env, home: dir });
    assert.equal(result.code, 1, argv.join(" ").replace(TOKEN, "<token>"));
    assert.ok(!result.err.includes(TOKEN), "stderr holds the token");
  }
});

test("more positional arguments than expected is a usage error that echoes no value", async (t) => {
  const { configPath, dir } = await setup(t);
  const result = await run([configPath, "mac", "secret-looking-extra"], [], {
    env: {},
    home: dir,
  });
  assert.equal(result.code, 2);
  assert.match(result.err, /Usage/);
  assert.ok(!result.err.includes("secret-looking-extra"));
});

test(
  "a target id that starts with a dash is a positional argument, not a flag",
  { skip: !posix },
  async (t) => {
    const { dir } = await setup(t);
    const configPath = join(dir, "dash.json");
    await writeFile(
      configPath,
      JSON.stringify({
        socketPath: "/home/user/.local/state/gome-remote/gateway.sock",
        publicOrigin: "http://127.0.0.1:38991",
        allowedLogins: ["owner@example.com"],
        credentialsFile: join(dir, "state", "credentials.json"),
        targets: [
          {
            id: "-mac",
            name: "Mac (대시)",
            platform: "mac",
            protocol: "agent",
            hostname: "100.64.0.20",
          },
        ],
      }),
    );
    const result = await run(
      [configPath, "-mac", "--agent-token"],
      [`${TOKEN}\n`],
    );
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /저장했습니다: -mac/);
  },
);

test(
  "with one positional argument the config comes from GOME_REMOTE_CONFIG, as for the other targets",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    const result = await run(["mac", "--agent-token"], [`${TOKEN}\n`], {
      env: { GOME_REMOTE_CONFIG: configPath },
      home: join(dir, "unused-home"),
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(
      (await readCredentialFile(credentialsFile)).get("mac").agentToken,
      TOKEN,
    );
  },
);

test(
  "replacing a target's old password entry with a token works even though the shapes differ",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    await writeCredentialFile(
      credentialsFile,
      new Map([
        ["mac", { username: "owner", password: "oldpass" }],
        ["mac-vnc", { username: "owner", password: "macpass" }],
      ]),
    );
    const result = await run(
      [configPath, "mac", "--agent-token"],
      [`${TOKEN}\n`],
    );
    assert.equal(result.code, 0, result.err);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(
      entries.get("mac"),
      { agentToken: TOKEN },
      "no password is kept next to the token",
    );
    assert.deepEqual(entries.get("mac-vnc"), {
      username: "owner",
      password: "macpass",
    });
  },
);

test(
  "a file in which another target has the wrong shape is refused untouched",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    await writeCredentialFile(
      credentialsFile,
      new Map([["mac-vnc", { agentToken: TOKEN }]]),
    );
    const before = await stat(credentialsFile);
    const result = await run(
      [configPath, "mac", "--agent-token"],
      [`${TOKEN}\n`],
    );
    assert.equal(result.code, 1);
    assert.match(result.err, /Refusing to modify/);
    assert.equal((await stat(credentialsFile)).mtimeMs, before.mtimeMs);
  },
);

test(
  "the RDP and VNC prompts are labelled for what they ask for",
  { skip: !posix },
  async (t) => {
    const { configPath } = await setup(t);
    const rdp = await run([configPath, "ubuntu-server"], ["u\n", "p\n", "p\n"]);
    assert.match(rdp.out, /사용자 이름: /);
    assert.match(rdp.out, /비밀번호: /);
    const vnc = await run(
      [configPath, "mac-vnc"],
      ["owner\n", "macpass\n", "macpass\n"],
    );
    assert.match(vnc.out, /macOS 계정/);
    assert.doesNotMatch(vnc.out, /토큰/);
  },
);
