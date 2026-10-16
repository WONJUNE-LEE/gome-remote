import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Mac agent cannot be compiled on Linux or Windows, so CI checks it on a macOS runner.
// These tests keep that job (and the files it depends on) from being weakened by accident.
const root = new URL("../", import.meta.url);
// Windows checks files out with CRLF; every pattern below is written for LF.
const read = async (path) =>
  (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
const workflow = await read(".github/workflows/build.yml");
const job = workflow.slice(workflow.indexOf("  agent-mac:"));

test("the agent job runs on macOS from agent/mac with every check of the spec", () => {
  assert.ok(workflow.includes("  agent-mac:"), "a job for the agent exists");
  assert.match(job, /runs-on: macos-latest/);
  assert.match(job, /working-directory: agent\/mac/);
  assert.match(job, /cargo fmt --check/);
  assert.match(job, /cargo clippy --locked --all-targets -- -D warnings/);
  assert.match(job, /cargo test --locked\n/);
  assert.match(job, /cargo test --locked --features dev-install/);
  assert.match(job, /cargo deny check/);
  assert.match(job, /\/bin\/bash -n install\.sh uninstall\.sh/);
});

// What install.sh looks for in the program to tell a development build from the real one.
const installSource = await read("agent/mac/install.sh");
const refusal = installSource.match(
  /\[ "\$DEV" = 0 \] && grep -aq "([^"]+)" "\$BUILT"/,
);
const marker = refusal?.[1];

test("install.sh refuses a program that holds the development directory's name, and that name is in the dev-install path", async () => {
  assert.ok(marker, "install.sh checks the built program for a marker");
  const paths = await read("agent/mac/src/paths.rs");
  const dev = paths.slice(paths.indexOf('#[cfg(feature = "dev-install")]'));
  const literal = dev.match(/home\.join\("([^"]+)"\)/)?.[1];
  assert.ok(literal, "the dev-install paths are built from one literal");
  assert.ok(
    literal.includes(marker),
    `the install check ${JSON.stringify(marker)} must be part of ${JSON.stringify(literal)}`,
  );
  // And the operational build's paths do not contain it.
  const operational = paths.slice(
    paths.indexOf('#[cfg(not(feature = "dev-install"))]'),
    paths.indexOf('#[cfg(feature = "dev-install")]'),
  );
  assert.ok(!operational.includes(marker));
  // The refusal happens before anything is signed or installed.
  assert.ok(
    installSource.indexOf(refusal[0]) < installSource.indexOf("# ---- 3. sign"),
  );
});

test("CI builds both ways and looks for the same marker in the real binaries", () => {
  assert.ok(marker);
  const steps = job.split("\n").map((line) => line.trim());
  const dev = steps.indexOf(
    "- run: cargo build --release --locked --features dev-install",
  );
  const found = steps.indexOf(
    `- run: grep -aq '${marker}' target/release/gome-remote-agent`,
  );
  const plain = steps.indexOf("- run: cargo build --release --locked");
  const absent = steps.indexOf(
    `- run: "! grep -aq '${marker}' target/release/gome-remote-agent"`,
  );
  assert.ok(dev >= 0 && found > dev, "a dev-install build contains the marker");
  assert.ok(plain > found && absent > plain, "a plain build does not");
});

test("no cargo command in the job can change Cargo.lock", () => {
  const commands = job
    .split("\n")
    .filter((line) => /run: cargo (build|test|clippy|check)/.test(line));
  assert.ok(commands.length >= 3);
  for (const command of commands) assert.match(command, /--locked/, command);
});

test("the agent job is part of the same workflow as the Node checks, on the same triggers", () => {
  assert.match(workflow, /pull_request:/);
  assert.ok(workflow.indexOf("agent-mac:") > workflow.indexOf("package:"));
});

test("Cargo.lock is committed and pins the WebRTC stack; deny.toml allows permissive licences only", async () => {
  const lock = await read("agent/mac/Cargo.lock");
  assert.match(lock, /name = "str0m"\nversion = "0\.24\./);
  assert.match(lock, /name = "tiny_http"/);
  const deny = await read("agent/mac/deny.toml");
  assert.match(deny, /unknown-registry = "deny"/);
  assert.match(deny, /unknown-git = "deny"/);
  assert.match(deny, /yanked = "deny"/);
  // The exact allow-list: adding a licence (copyleft or not) is a decision that changes this test.
  const allow = deny
    .match(/^allow = \[([^\]]*)\]/m)[1]
    .match(/"[^"]+"/g)
    .map((s) => s.slice(1, -1));
  assert.deepEqual(allow, [
    "MIT",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Unicode-3.0",
    "Zlib",
    "OpenSSL",
    "CC0-1.0",
  ]);
  assert.doesNotMatch(
    deny,
    /^\s*exceptions\s*=/m,
    "no per-crate licence exceptions",
  );
});

test("cargo-deny is installed at the version deny.toml was validated with, from its lock file", () => {
  assert.match(
    job,
    /run: cargo install cargo-deny --version 0\.20\.2 --locked\n/,
  );
  assert.doesNotMatch(job, /cargo install cargo-deny(?!.*--version 0\.20\.2)/);
});

test("the crate takes no dependency from a git repository or a path outside itself", async () => {
  const manifest = await read("agent/mac/Cargo.toml");
  assert.doesNotMatch(manifest, /git\s*=/);
  assert.doesNotMatch(manifest, /path\s*=\s*"\.\./);
  assert.match(manifest, /dev-install = \[\]/);
  const lock = await read("agent/mac/Cargo.lock");
  assert.doesNotMatch(lock, /source = "git\+/);
});

test("build output of the agent is never committed", async () => {
  assert.match(await read(".gitignore"), /^agent\/mac\/target\/$/m);
});
