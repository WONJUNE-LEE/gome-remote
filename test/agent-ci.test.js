import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Mac agent cannot be compiled on Linux or Windows, so CI checks it on a macOS runner.
// These tests keep that job (and the files it depends on) from being weakened by accident.
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
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
