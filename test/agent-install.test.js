import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh and uninstall.sh run against stand-ins for the macOS tools (security,
// codesign, launchctl, plutil, curl, cargo), in a temporary home directory. What is tested
// is the script's own logic: the layout, the token, the answers it asks for, the
// LaunchAgent it writes, and the rollback when the new program does not answer.
const posix = process.platform !== "win32";
const here = new URL("../agent/mac/", import.meta.url);
const GATEWAY = "100.64.0.10";
const BIND = "100.64.0.20";

const STUBS = {
  // Every call is appended to $STUB_LOG as one line.
  // STUB_CODESIGN_FAIL: a glob; a call whose arguments match it fails.
  codesign: `
echo "codesign $*" >> "$STUB_LOG"
case "$*" in *\${STUB_CODESIGN_FAIL:-@@none@@}*) exit 1 ;; esac
exit 0`,
  launchctl: `echo "launchctl $*" >> "$STUB_LOG"`,
  plutil: `echo "plutil $*" >> "$STUB_LOG"`,
  // A fake clock: sleeping advances it and \`date +%s\` reads it, so the 10 second
  // deadline of the health check runs without waiting.
  sleep: `echo $(($(cat "$STUB_CLOCK") + \${1:-0})) > "$STUB_CLOCK"`,
  date: `[ "$1" = +%s ] && exec cat "$STUB_CLOCK"; PATH="\${PATH#*:}"; exec date "$@"`,
  // STUB_UID stands in for the user id; STUB_OPENSSL_RAND_FAIL makes \`openssl rand\` fail.
  id: `[ "$1" = -u ] && [ -n "\${STUB_UID-}" ] && { echo "$STUB_UID"; exit 0; }; PATH="\${PATH#*:}"; exec id "$@"`,
  openssl: `[ "$1" = rand ] && [ -n "\${STUB_OPENSSL_RAND_FAIL-}" ] && exit 1; PATH="\${PATH#*:}"; exec openssl "$@"`,
  sudo: `echo "sudo $*" >> "$STUB_LOG"; exit 1`,
  // The Mac's own address, when the test wants one to be suggested.
  tailscale: `[ -n "\${STUB_TAILSCALE_IP-}" ] && echo "$STUB_TAILSCALE_IP" || exit 1`,
  security: `
echo "security $1" >> "$STUB_LOG"
case "$1" in
  create-keychain) for last; do :; done; : > "$last" ;;
  find-identity) for last; do :; done; [ -f "$last" ] && echo '  1) AAAA "Gome Remote Agent Signing"' ;;
esac
exit 0`,
  // The HTTP status codes curl "sees", one per call, from $STUB_CODES (the last repeats).
  curl: `
echo "curl $*" >> "$STUB_LOG"
codes=($(cat "$STUB_CODES"))
printf '%s' "\${codes[0]}"
if [ "\${#codes[@]}" -gt 1 ]; then printf '%s\\n' "\${codes[@]:1}" > "$STUB_CODES"; fi`,
};

async function lab(t) {
  const root = await mkdtemp(join(tmpdir(), "gr-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  const agent = join(root, "agent", "mac");
  const prefix = join(root, "prefix");
  await mkdir(home, { recursive: true });
  await mkdir(stubs);
  await mkdir(join(agent, "target", "release"), { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(stubs, name), `#!/bin/bash\n${body}\n`);
    await chmod(join(stubs, name), 0o755);
  }
  for (const script of ["install.sh", "uninstall.sh"]) {
    await copyFile(new URL(script, here), join(agent, script));
    await chmod(join(agent, script), 0o755);
  }
  await writeFile(
    join(agent, "target", "release", "gome-remote-agent"),
    "binary v1",
  );
  await writeFile(join(root, "codes"), "403\n");
  await writeFile(join(root, "clock"), "1000\n");
  const env = (extra = {}) => {
    const full = {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: root,
      STUB_LOG: join(root, "log"),
      STUB_CODES: join(root, "codes"),
      STUB_CLOCK: join(root, "clock"),
      GOME_SKIP_BUILD: "1",
      GOME_SUDO: "",
      GOME_ROOT_OWNER: "",
      GOME_PREFIX: prefix,
      GOME_AGENT_BIND: BIND,
      GOME_AGENT_GATEWAY: GATEWAY,
      ...extra,
    };
    // null removes a variable.
    for (const [key, value] of Object.entries(full))
      if (value === null) delete full[key];
    return full;
  };
  const run = (script, args = [], extra = {}, input = "") =>
    spawnSync("bash", [join(agent, script), ...args], {
      encoding: "utf8",
      env: env(extra),
      input,
    });
  const build = (content) =>
    writeFile(join(agent, "target", "release", "gome-remote-agent"), content);
  const log = async () => readFile(join(root, "log"), "utf8").catch(() => "");
  const codes = (list) =>
    writeFile(join(root, "codes"), `${list.join("\n")}\n`);
  const paths = {
    support: join(home, "Library", "Application Support", "Gome Remote Agent"),
    dev: join(home, "Library", "Application Support", "Gome Remote Agent Dev"),
    bin: join(prefix, "usr", "local", "libexec", "gome-remote-agent"),
    config: join(
      prefix,
      "usr",
      "local",
      "etc",
      "gome-remote-agent",
      "agent.json",
    ),
    plist: join(home, "Library", "LaunchAgents", "net.gome.remote-agent.plist"),
    devPlist: join(
      home,
      "Library",
      "LaunchAgents",
      "net.gome.remote-agent-dev.plist",
    ),
  };
  return { root, home, run, build, log, codes, paths };
}

test(
  "the first operational install lays out the root-owned paths, a token, a LaunchAgent, and tells what is left",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    const r = l.run("install.sh");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(await readFile(l.paths.bin, "utf8"), "binary v1");
    assert.equal((await stat(l.paths.bin)).mode & 0o777, 0o755);
    const config = JSON.parse(await readFile(l.paths.config, "utf8"));
    assert.deepEqual(config, { bind: BIND, port: 18471, gateway: GATEWAY });
    assert.equal((await stat(l.paths.config)).mode & 0o777, 0o644);
    const token = await readFile(join(l.paths.support, "token"), "utf8");
    assert.match(
      token,
      /^[A-Za-z0-9_-]{43}$/,
      "43 base64url characters, no newline",
    );
    assert.equal(
      (await stat(join(l.paths.support, "token"))).mode & 0o777,
      0o600,
    );
    assert.ok(r.stdout.includes(token), "the token is shown once, at the end");
    assert.match(r.stdout, /Screen & System Audio Recording/);
    assert.match(r.stdout, /Accessibility/);
    assert.match(r.stdout, /set-credential\.mjs <target-id> --agent-token/);
    const plist = await readFile(l.paths.plist, "utf8");
    assert.match(
      plist,
      /<key>Label<\/key><string>net\.gome\.remote-agent<\/string>/,
    );
    assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.ok(plist.includes(l.paths.bin), "starts the root-owned program");
    assert.doesNotMatch(
      plist,
      /--|EnvironmentVariables/,
      "no argument or environment variable carries a setting",
    );
    const log = await l.log();
    assert.match(
      log,
      /codesign --force --options runtime --keychain .* -s Gome Remote Agent Signing -i net\.gome\.remote-agent/,
    );
    assert.match(log, /codesign --verify --strict/);
    assert.match(log, /launchctl bootstrap gui\/\d+/);
    assert.match(log, /curl .*http:\/\/100\.64\.0\.20:18471\/v1\/status/);
  },
);

test(
  "an update keeps the token and the settings, keeps the previous program as .prev, and shows no token",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    const token = await readFile(join(l.paths.support, "token"), "utf8");
    await l.build("binary v2");
    const r = l.run(
      "install.sh",
      [],
      { GOME_AGENT_BIND: "", GOME_AGENT_GATEWAY: "" },
      "",
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(await readFile(l.paths.bin, "utf8"), "binary v2");
    assert.equal(await readFile(`${l.paths.bin}.prev`, "utf8"), "binary v1");
    assert.equal(await readFile(join(l.paths.support, "token"), "utf8"), token);
    assert.ok(!r.stdout.includes(token), "the token is never shown again");
    assert.doesNotMatch(r.stdout, /Next steps/);
    assert.equal(
      JSON.parse(await readFile(l.paths.config, "utf8")).gateway,
      GATEWAY,
    );
  },
);

test(
  "a new program that does not answer within 10 seconds is replaced by the previous one",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    await l.build("binary v2");
    // Ten silent polls for the new program, then an answer from the restored one.
    await l.codes([...Array(10).fill("000"), "403"]);
    const r = l.run("install.sh");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /rolled back/);
    assert.equal(
      await readFile(l.paths.bin, "utf8"),
      "binary v1",
      "the previous program is back",
    );
    const bootstraps = (await l.log())
      .split("\n")
      .filter((line) => line.startsWith("launchctl bootstrap"));
    assert.equal(
      bootstraps.length,
      3,
      "first install, the failed update, the rollback",
    );
  },
);

test(
  "a first install that does not answer says there is nothing to go back to",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    await l.codes(["000"]);
    const r = l.run("install.sh");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no previous version/);
  },
);

test(
  "any HTTP answer from the agent counts: 401 and 403 mean it is up, a server error or silence do not",
  { skip: !posix },
  async (t) => {
    for (const [code, ok] of [
      ["403", true],
      ["401", true],
      ["200", true],
      ["500", false],
      ["000", false],
    ]) {
      const l = await lab(t);
      await l.codes([code]);
      assert.equal(l.run("install.sh").status === 0, ok, code);
    }
  },
);

test(
  "addresses are checked before anything is installed: only tailnet IPv4 addresses are accepted",
  { skip: !posix },
  async (t) => {
    for (const [bind, gateway] of [
      ["192.168.0.5", GATEWAY],
      [BIND, "127.0.0.1"],
      [BIND, "100.63.255.255"],
      [BIND, "100.128.0.1"],
      [BIND, "gateway.example"],
      ["", GATEWAY], // nothing typed, and the Mac has no address to suggest
    ]) {
      const l = await lab(t);
      const r = l.run(
        "install.sh",
        [],
        { GOME_AGENT_BIND: bind, GOME_AGENT_GATEWAY: gateway },
        "\n",
      );
      assert.notEqual(r.status, 0, `${bind} / ${gateway}`);
      await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
      await assert.rejects(stat(l.paths.config), { code: "ENOENT" });
      assert.equal((await l.log()).includes("launchctl bootstrap"), false);
    }
    const edge = await lab(t);
    assert.equal(
      edge.run("install.sh", [], {
        GOME_AGENT_BIND: "100.64.0.1",
        GOME_AGENT_GATEWAY: "100.127.255.254",
      }).status,
      0,
    );
  },
);

test(
  "the addresses are asked for when they are not given, and the Mac's own address is suggested",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    const r = l.run(
      "install.sh",
      [],
      { GOME_AGENT_BIND: "", GOME_AGENT_GATEWAY: "" },
      `${BIND}\n${GATEWAY}\n`,
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(await readFile(l.paths.config, "utf8")).bind, BIND);
    assert.equal(
      JSON.parse(await readFile(l.paths.config, "utf8")).gateway,
      GATEWAY,
    );
    // An empty answer takes the address Tailscale reports for this Mac.
    const suggested = await lab(t);
    const s = suggested.run(
      "install.sh",
      [],
      { GOME_AGENT_BIND: "", GOME_AGENT_GATEWAY: "", STUB_TAILSCALE_IP: BIND },
      `\n${GATEWAY}\n`,
    );
    assert.equal(s.status, 0, s.stderr);
    assert.equal(
      JSON.parse(await readFile(suggested.paths.config, "utf8")).bind,
      BIND,
    );
  },
);

test(
  "--dev installs everything under the home directory, on its own port, label and token",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    const r = l.run("install.sh", ["--dev"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const config = JSON.parse(
      await readFile(join(l.paths.dev, "agent.json"), "utf8"),
    );
    assert.deepEqual(config, { bind: BIND, port: 18472, gateway: GATEWAY });
    assert.equal(
      await readFile(join(l.paths.dev, "bin", "gome-remote-agent"), "utf8"),
      "binary v1",
    );
    assert.match(
      await readFile(join(l.paths.dev, "token"), "utf8"),
      /^[A-Za-z0-9_-]{43}$/,
    );
    assert.match(
      await readFile(l.paths.devPlist, "utf8"),
      /net\.gome\.remote-agent-dev/,
    );
    await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
    await assert.rejects(stat(l.paths.plist), { code: "ENOENT" });
  },
);

test(
  "the signing identity is made once and reused",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    assert.equal(l.run("install.sh").status, 0);
    const creates = (await l.log())
      .split("\n")
      .filter((line) => line === "security create-keychain");
    assert.equal(creates.length, 1);
  },
);

test(
  "a bad option is a usage error and installs nothing",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    for (const args of [["--prod"], ["--dev", "--dev"], ["-x"]]) {
      const r = l.run("install.sh", args);
      assert.equal(r.status, 2, args.join(" "));
    }
    await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
  },
);

test(
  "uninstall removes the program, settings, token, log and keychain, and tells the owner about System Settings",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    const declined = l.run("uninstall.sh", [], {}, "n\n");
    assert.equal(declined.status, 0);
    assert.equal(
      await readFile(l.paths.bin, "utf8"),
      "binary v1",
      "nothing is removed without a yes",
    );
    const r = l.run("uninstall.sh", ["--yes"]);
    assert.equal(r.status, 0, r.stderr);
    for (const gone of [
      l.paths.bin,
      `${l.paths.bin}.prev`,
      l.paths.config,
      l.paths.plist,
      join(l.paths.support, "token"),
      join(l.paths.support, "sign"),
    ])
      await assert.rejects(stat(gone), { code: "ENOENT" }, gone);
    assert.match(r.stdout, /System Settings/);
    assert.match(await l.log(), /launchctl bootout/);
  },
);

test("the scripts keep their safety properties", async () => {
  const install = await readFile(new URL("install.sh", here), "utf8");
  const uninstall = await readFile(new URL("uninstall.sh", here), "utf8");
  for (const script of [install, uninstall]) {
    assert.match(script, /^set -euo pipefail$/m);
    assert.doesNotMatch(
      script,
      /chmod\s+(?:-R\s+)?(?:777|666|a\+w|o\+w|go\+w)/,
    );
    assert.doesNotMatch(
      script,
      /\|\s*(ba)?sh\b/,
      "nothing is piped into a shell",
    );
  }
  assert.match(install, /--options runtime/, "hardened runtime");
  assert.match(install, /\/usr\/local\/libexec/);
  assert.match(
    install,
    /\/usr\/local\/etc\/gome-remote-agent|CONFIG_DIR="\$PREFIX\/usr\/local\/etc\/gome-remote-agent"/,
  );
  assert.match(install, /ProcessType<\/key><string>Interactive/);
  assert.match(install, /cargo build --release --locked/);
  assert.match(install, /\.prev/);
});

test(
  "an address with an octet over 255 is not an address",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    const r = l.run("install.sh", [], {
      GOME_AGENT_GATEWAY: `${GATEWAY.slice(0, -2)}999`,
    });
    assert.notEqual(r.status, 0);
    await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
  },
);

test(
  "after a first install that failed, the next run is a fresh install: the token is shown and the failed program is gone",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    await l.codes(["000"]);
    const failed = l.run("install.sh");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /run install\.sh again/);
    for (const gone of [l.paths.bin, l.paths.plist, l.paths.config])
      await assert.rejects(stat(gone), { code: "ENOENT" }, gone);
    const polls = (await l.log())
      .split("\n")
      .filter((line) => line.startsWith("curl "));
    assert.equal(polls.length, 10, "ten polls fill the 10 second deadline");
    const token = await readFile(join(l.paths.support, "token"), "utf8");
    await l.codes(["403"]);
    const r = l.run("install.sh");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(token), "the token has not been shown yet");
  },
);

test("the program is written beside the old one and renamed over it, never rewritten in place", async () => {
  const install = await readFile(new URL("install.sh", here), "utf8");
  assert.match(install, /mv -f "\$BIN\.new" "\$BIN"/);
});

test(
  "uninstall --dev removes the development install and, when nothing else uses it, the signing keychain",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh", ["--dev"]).status, 0);
    const r = l.run("uninstall.sh", ["--dev", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    for (const gone of [
      l.paths.dev,
      l.paths.devPlist,
      join(l.paths.support, "sign"),
    ])
      await assert.rejects(stat(gone), { code: "ENOENT" }, gone);
    assert.match(await l.log(), /launchctl bootout/);
    assert.match(r.stdout, /System Settings/);
  },
);

test(
  "uninstall --dev leaves the operational install and the shared signing keychain alone",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    assert.equal(l.run("install.sh", ["--dev"]).status, 0);
    assert.equal(l.run("uninstall.sh", ["--dev", "--yes"]).status, 0);
    assert.equal(await readFile(l.paths.bin, "utf8"), "binary v1");
    await stat(l.paths.plist);
    await stat(join(l.paths.support, "token"));
    await stat(join(l.paths.support, "sign"));
  },
);

test(
  "an operational install refuses the test-only overrides, as root, and a prefix outside the temporary directory",
  { skip: !posix },
  async (t) => {
    const none = {
      GOME_PREFIX: "",
      GOME_SUDO: null,
      GOME_ROOT_OWNER: null,
      GOME_SKIP_BUILD: null,
    };
    const cases = [
      [{ GOME_SUDO: "" }, /GOME_SUDO is only for the test suite/],
      [{ GOME_ROOT_OWNER: "" }, /GOME_ROOT_OWNER is only for the test suite/],
      [{ GOME_SKIP_BUILD: "1" }, /GOME_SKIP_BUILD is only for the test suite/],
      [{ STUB_UID: "0" }, /not with sudo/],
      [{ GOME_PREFIX: "/usr/local" }, /GOME_PREFIX is for the test suite/],
      [{ GOME_PREFIX: tmpdir() }, /GOME_PREFIX is for the test suite/],
    ];
    for (const [extra, message] of cases) {
      for (const args of [[], ["--dev"]]) {
        const l = await lab(t);
        const r = l.run("install.sh", args, { ...none, ...extra });
        assert.notEqual(r.status, 0, JSON.stringify(extra));
        assert.match(r.stderr, message);
        const log = await l.log();
        assert.doesNotMatch(log, /sudo|security|codesign|launchctl|curl/);
        await assert.rejects(stat(join(l.home, "Library")), { code: "ENOENT" });
      }
    }
    for (const [extra, message] of [
      [{ GOME_SUDO: "" }, /GOME_SUDO is only for the test suite/],
      [{ STUB_UID: "0" }, /not with sudo/],
      [{ GOME_PREFIX: "/usr/local" }, /GOME_PREFIX is for the test suite/],
    ]) {
      const l = await lab(t);
      const r = l.run("uninstall.sh", ["--yes"], {
        GOME_PREFIX: "",
        GOME_SUDO: null,
        ...extra,
      });
      assert.notEqual(r.status, 0, JSON.stringify(extra));
      assert.match(r.stderr, message);
      assert.doesNotMatch(await l.log(), /sudo|launchctl|security/);
    }
  },
);

test(
  "a program built with the dev-install feature is never installed as the operational agent",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    await l.build("binary with Gome Remote Agent Dev paths");
    const r = l.run("install.sh");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /dev-install feature/);
    await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
    assert.equal(l.run("install.sh", ["--dev"]).status, 0, "fine for --dev");
  },
);

test(
  "the staged program's signature is checked before it replaces the running one",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    assert.match(
      await l.log(),
      /codesign --verify --strict .*gome-remote-agent\.new/,
    );
    await l.build("binary v2");
    const r = l.run("install.sh", [], { STUB_CODESIGN_FAIL: ".new" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /signature/);
    assert.equal(await readFile(l.paths.bin, "utf8"), "binary v1");
    await assert.rejects(stat(`${l.paths.bin}.new`), { code: "ENOENT" });
  },
);

test(
  "an empty token file counts as missing, and a failed token creation leaves no file behind",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    await mkdir(l.paths.support, { recursive: true });
    await writeFile(join(l.paths.support, "token"), "");
    const r = l.run("install.sh");
    assert.equal(r.status, 0, r.stderr);
    const token = await readFile(join(l.paths.support, "token"), "utf8");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(r.stdout.includes(token));
    assert.equal(
      (await stat(join(l.paths.support, "token"))).mode & 0o777,
      0o600,
    );

    const failing = await lab(t);
    const f = failing.run("install.sh", [], { STUB_OPENSSL_RAND_FAIL: "1" });
    assert.notEqual(f.status, 0);
    assert.match(f.stderr, /token/);
    await assert.rejects(stat(join(failing.paths.support, "token")), {
      code: "ENOENT",
    });
    const leftovers = (await readdir(failing.paths.support)).filter((name) =>
      name.startsWith("token"),
    );
    assert.deepEqual(leftovers, []);
  },
);

test(
  "characters that mean something in the LaunchAgent's XML in the home directory stop the install before anything is replaced",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    const home = join(l.root, "a&b");
    await mkdir(home);
    const r = l.run("install.sh", [], { HOME: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /LaunchAgent file cannot hold/);
    await assert.rejects(stat(l.paths.bin), { code: "ENOENT" });
    await assert.rejects(stat(join(home, "Library")), { code: "ENOENT" });
  },
);

test(
  "uninstall also removes a staged program left behind by an interrupted update",
  { skip: !posix },
  async (t) => {
    const l = await lab(t);
    assert.equal(l.run("install.sh").status, 0);
    await writeFile(`${l.paths.bin}.new`, "half");
    assert.equal(l.run("uninstall.sh", ["--yes"]).status, 0);
    await assert.rejects(stat(`${l.paths.bin}.new`), { code: "ENOENT" });
  },
);
