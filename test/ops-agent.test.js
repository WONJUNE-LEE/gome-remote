import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../server/config.js";
import { buildConfig, defaultPaths } from "../scripts/init-gateway.mjs";

const posix = process.platform !== "win32";
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const script = fileURLToPath(new URL("scripts/init-gateway.mjs", root));
const targetsFile = fileURLToPath(new URL("deploy/targets.example.json", root));

test("the example targets build a configuration whose agent target has its default port and no secret", async () => {
  const examples = JSON.parse(await read("deploy/targets.example.json"));
  const config = buildConfig({
    origin: "https://gateway.example.ts.net:8450",
    logins: ["owner@example.com"],
    targets: examples,
    ...defaultPaths("/home/user"),
  });
  const mac = config.targets.find((t) => t.id === "mac");
  assert.equal(mac.protocol, "agent");
  assert.equal(mac.port, 18471);
  assert.equal(config.targets.find((t) => t.id === "mac-vnc").protocol, "vnc");
  assert.doesNotThrow(() => validateConfig(config));
});

test(
  "init-gateway tells which set-credential command each target needs, with --agent-token only for agents",
  { skip: !posix },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gr-init-agent-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const result = spawnSync(
      process.execPath,
      [
        script,
        join(dir, "gateway.json"),
        "--origin",
        "https://gateway.example.ts.net:8450",
        "--login",
        "owner@example.com",
        "--targets",
        targetsFile,
        "--socket",
        join(dir, "g.sock"),
        "--credentials",
        join(dir, "credentials.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout
      .split("\n")
      .filter((l) => l.includes("set-credential.mjs"));
    assert.equal(lines.length, 3);
    const config = join(dir, "gateway.json");
    assert.ok(
      lines.some((l) => l.endsWith(`${config} ubuntu-server`)),
      lines.join("\n"),
    );
    assert.ok(lines.some((l) => l.endsWith(`${config} mac --agent-token`)));
    assert.ok(lines.some((l) => l.endsWith(`${config} mac-vnc`)));
  },
);

test("the README documents the agent: install, permissions, token, the three set-credential commands, rollback and removal", async () => {
  const readme = await read("README.md");
  for (const needle of [
    "agent/mac",
    "./install.sh",
    "./uninstall.sh",
    "--agent-token",
    "18471",
    "Screen & System Audio Recording",
    "Accessibility",
    "gome-remote-agent.prev",
    "launchctl kickstart",
    "30-day",
    "docs/mac-agent-spec.md",
    "#measure",
    "권한 필요",
    "잠김",
    "오프라인",
  ])
    assert.ok(readme.includes(needle), needle);
  assert.ok(!/legacy-hidden|TODO|TBD/.test(readme));
});

// Final review 5: without a config path the command targets the default (production) config,
// which during the parallel rollout is the wrong file.
test("every --agent-token command in the README and the installer names the config path", async () => {
  for (const file of ["README.md", "agent/mac/install.sh"]) {
    const text = await read(file);
    const commands = text.match(/set-credential[^\n`]*--agent-token/g) ?? [];
    assert.ok(commands.length >= 1, `${file}: ${commands.length} commands`);
    for (const command of commands)
      assert.match(
        command,
        /set-credential(\.mjs)?\s+(<gateway\.json>|\.\/\S+\.json|\S+gateway\.json)\s+\S+\s+--agent-token/,
        `${file}: ${command}`,
      );
  }
  const readme = await read("README.md");
  assert.match(readme, /parallel rollout[^]*candidate[^]*gateway\.json/i);
});

test("verification.md records the automated checks of the agent and the VNC route evidence without identifiers", async () => {
  const text = await read("docs/verification.md");
  for (const needle of [
    "test/agent-relay.test.js",
    "test/agent-session.test.js",
    "test/agent-install.test.js",
    "cargo test --locked",
    "2026-10-14",
    "171 to 182 ms",
  ])
    assert.ok(text.includes(needle), needle);
});
