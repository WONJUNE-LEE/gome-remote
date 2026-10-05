import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, defaultPaths } from "../scripts/init-gateway.mjs";
import { loadConfig, validateConfig } from "../server/config.js";

const posix = process.platform !== "win32";
const root = new URL("../", import.meta.url);
const examples = JSON.parse(
  await readFile(new URL("deploy/targets.example.json", root), "utf8"),
);
const script = fileURLToPath(new URL("scripts/init-gateway.mjs", root));

test("the example targets are the two spec targets and carry no secret or real address", () => {
  assert.deepEqual(
    examples.map((t) => t.id),
    ["ubuntu-server", "mac"],
  );
  assert.equal(examples[0].profile, "gnome-remote-login");
  assert.equal(examples[1].protocol, "vnc");
  assert.equal(examples[1].hostname, "100.64.0.20");
  assert.doesNotThrow(() =>
    buildConfig({
      origin: "https://gateway.example.ts.net:8450",
      logins: ["owner@example.com"],
      targets: examples,
      ...defaultPaths("/home/user"),
    }),
  );
});

test("a generated configuration has the new schema and no token", () => {
  const config = buildConfig({
    origin: "https://gateway.example.ts.net:8450",
    logins: ["owner@example.com", "second@example.com"],
    targets: examples,
    ...defaultPaths("/home/user"),
  });
  assert.equal(config.token, undefined);
  assert.deepEqual(config.allowedLogins, [
    "owner@example.com",
    "second@example.com",
  ]);
  assert.equal(
    config.socketPath,
    "/home/user/.local/state/gome-remote/gateway.sock",
  );
  assert.equal(
    config.credentialsFile,
    "/home/user/.config/gome-remote/credentials.json",
  );
  assert.throws(() =>
    buildConfig({
      origin: "https://gateway.example.ts.net:8450",
      logins: [],
      targets: examples,
      ...defaultPaths("/home/user"),
    }),
  );
});

test("the default socket stays out of /tmp, which the unit's PrivateTmp hides, and fits sun_path", async () => {
  const unit = await readFile(
    new URL("deploy/gome-remote-gateway.service", root),
    "utf8",
  );
  assert.match(unit, /^PrivateTmp=true$/m);
  assert.match(
    unit,
    /GOME_REMOTE_CONFIG=%h\/\.config\/gome-remote\/gateway\.json/,
  );
  for (const home of [
    "/home/user",
    "/home/user/a-rather-long-nested-home-directory",
  ]) {
    const { socketPath } = defaultPaths(home);
    assert.ok(!/^\/(var\/)?tmp\//.test(socketPath), socketPath);
    assert.doesNotThrow(() =>
      validateConfig({
        socketPath,
        publicOrigin: "https://gateway.example.ts.net:8450",
        allowedLogins: ["owner@example.com"],
        credentialsFile: defaultPaths(home).credentialsFile,
        targets: examples,
      }),
    );
  }
});

test(
  "the command writes a 0600 file once, never overwrites it, and needs every flag",
  { skip: !posix },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gr-init-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const output = join(dir, "conf", "gateway.json");
    const args = [
      script,
      output,
      "--origin",
      "https://gateway.example.ts.net:8450",
      "--login",
      "owner@example.com",
      "--targets",
      fileURLToPath(new URL("deploy/targets.example.json", root)),
      "--socket",
      join(dir, "run", "g.sock"),
      "--credentials",
      join(dir, "conf", "credentials.json"),
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const config = await loadConfig(output);
    assert.equal(config.socketPath, join(dir, "run", "g.sock"));
    assert.deepEqual(config.allowedLogins, ["owner@example.com"]);
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /refusing to overwrite/);
    const missing = spawnSync(process.execPath, [script, join(dir, "x.json")], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Usage/);
    await writeFile(join(dir, "bad.json"), "[]");
    const bad = spawnSync(
      process.execPath,
      [
        ...args.slice(0, 1),
        join(dir, "y.json"),
        ...args.slice(2, 7),
        join(dir, "bad.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid configuration/);
  },
);

test(
  "without a config path the command writes the default one set-credential reads",
  { skip: !posix },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "gr-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const args = [
      script,
      "--origin",
      "https://gateway.example.ts.net:8450",
      "--login",
      "owner@example.com",
      "--targets",
      fileURLToPath(new URL("deploy/targets.example.json", root)),
    ];
    const env = { ...process.env, HOME: home };
    delete env.GOME_REMOTE_CONFIG;
    const first = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const config = await loadConfig(
      join(home, ".config", "gome-remote", "gateway.json"),
    );
    assert.equal(
      config.socketPath,
      join(home, ".local", "state", "gome-remote", "gateway.sock"),
    );
    const custom = join(home, "elsewhere.json");
    const second = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...env, GOME_REMOTE_CONFIG: custom },
    });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual((await loadConfig(custom)).allowedLogins, [
      "owner@example.com",
    ]);
  },
);
