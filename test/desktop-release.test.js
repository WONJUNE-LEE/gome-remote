import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
// Windows checks files out with CRLF; every pattern below is written for LF.
const read = async (name) =>
  (await readFile(new URL(`../${name}`, import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("package-lock.json"));
const releaseText = await read(".github/workflows/release.yml");
const release = yaml.load(releaseText);
const mac = require("../scripts/mac-sign.cjs");
const { signMac } = mac;

// ---- package.json ----

test("the version, the pinned updater and the lock file agree", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(
    pkg.dependencies["electron-updater"],
    /^\d+\.\d+\.\d+$/,
    "exact",
  );
  assert.equal(
    lock.packages["node_modules/electron-updater"].version,
    pkg.dependencies["electron-updater"],
  );
  assert.equal(pkg.devDependencies["electron-updater"], undefined);
  // js-yaml parses the workflow below; it is already in the lock file as electron-updater's.
  assert.match(pkg.devDependencies["js-yaml"], /^\d+\.\d+\.\d+$/, "exact");
  assert.equal(
    lock.packages["node_modules/js-yaml"].version,
    pkg.devDependencies["js-yaml"],
  );
});

test("releases are published as drafts to this repository's GitHub Releases", () => {
  assert.deepEqual(pkg.build.publish, {
    provider: "github",
    owner: "WONJUNE-LEE",
    repo: "gome-remote",
    releaseType: "draft",
  });
});

test("the Mac build is signed by the hook, not by electron-builder, and makes the zip the updater needs", () => {
  assert.equal(pkg.build.mac.identity, null);
  assert.equal(pkg.build.afterSign, "scripts/mac-sign.cjs");
  assert.ok(pkg.build.mac.target.includes("zip"));
  assert.ok(pkg.build.mac.target.includes("dmg"));
});

// ---- scripts/mac-sign.cjs ----

const outDir = path.join("/out", "mac");
const appPath = path.join(outDir, "Gome Remote.app");
const context = {
  electronPlatformName: "darwin",
  appOutDir: outDir,
  packager: { appInfo: { productFilename: "Gome Remote" } },
};
const recorder = () => {
  const calls = [];
  return {
    calls,
    run: (command, args) => calls.push([command, ...args]),
    log: () => {},
  };
};

test("without the signing variables the hook does nothing", () => {
  const r = recorder();
  assert.equal(signMac(context, { env: {}, ...r }), false);
  assert.deepEqual(r.calls, []);
});

test("the hook never touches a build for another platform", () => {
  const r = recorder();
  const env = { GOME_MAC_SIGN_KEYCHAIN: "k", GOME_MAC_SIGN_IDENTITY: "i" };
  assert.equal(
    signMac({ ...context, electronPlatformName: "win32" }, { env, ...r }),
    false,
  );
  assert.deepEqual(r.calls, []);
});

test("one signing variable without the other fails the build", () => {
  for (const env of [
    { GOME_MAC_SIGN_KEYCHAIN: "k" },
    { GOME_MAC_SIGN_IDENTITY: "i" },
  ])
    assert.throws(() => signMac(context, { env, ...recorder() }), /both/);
});

test("with the variables it signs the app with the keychain and then verifies strictly", () => {
  const r = recorder();
  const env = {
    GOME_MAC_SIGN_KEYCHAIN: "/tmp/k.keychain-db",
    GOME_MAC_SIGN_IDENTITY: "Gome Remote Desktop Signing",
  };
  assert.equal(signMac(context, { env, ...r }), true);
  const app = appPath;
  assert.deepEqual(r.calls[0], [
    "codesign",
    "--force",
    "--deep",
    "--sign",
    "Gome Remote Desktop Signing",
    "--keychain",
    "/tmp/k.keychain-db",
    app,
  ]);
  assert.deepEqual(r.calls[1], [
    "codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  assert.deepEqual(r.calls[2], ["codesign", "-d", "-r-", app]);
  assert.equal(r.calls.length, 3);
});

test("the function electron-builder calls signs, verifies and prints the requirement", async () => {
  const r = recorder();
  const env = {
    GOME_MAC_SIGN_KEYCHAIN: "/tmp/k.keychain-db",
    GOME_MAC_SIGN_IDENTITY: "Gome Remote Desktop Signing",
  };
  await mac(context, { env, ...r });
  assert.deepEqual(
    r.calls.map((call) => call.slice(0, 3)),
    [
      ["codesign", "--force", "--deep"],
      ["codesign", "--verify", "--deep"],
      ["codesign", "-d", "-r-"],
    ],
  );
  assert.deepEqual(r.calls[2], ["codesign", "-d", "-r-", appPath]);
  // And with no variables it is a no-op that still resolves.
  const none = recorder();
  await mac(context, { env: {}, ...none });
  assert.deepEqual(none.calls, []);
});

test("a failing codesign fails the build", () => {
  const env = { GOME_MAC_SIGN_KEYCHAIN: "k", GOME_MAC_SIGN_IDENTITY: "i" };
  assert.throws(() =>
    signMac(context, {
      env,
      log: () => {},
      run: () => {
        throw new Error("codesign failed");
      },
    }),
  );
});

// ---- .github/workflows/release.yml (parsed, not pattern-matched) ----

const jobs = release.jobs;
const steps = (job) => jobs[job].steps;
const stepNamed = (job, name) => {
  const found = steps(job).filter((step) => step.name === name);
  assert.equal(found.length, 1, `exactly one step "${name}" in ${job}`);
  return found[0];
};
const indexOfStep = (job, name) =>
  steps(job).findIndex((step) => step.name === name);
const MAC = "runner.os == 'macOS'";
const IMPORT = "Import the Mac signing certificate";
const UPLOAD = "Build, sign and upload into the draft release";
const ZIP_CHECK = "Check the Mac app inside the zip";
const KEYCHAIN = "Delete the signing keychain";
const PUBLISH_STEP = "Check that every update file is attached, then publish";
// `needs` is a string or a list in a workflow
const needs = (job) => [jobs[job].needs ?? []].flat();

test("the release runs on v* tags and its jobs form one chain", () => {
  assert.deepEqual(release.on, { push: { tags: ["v*"] } });
  assert.deepEqual(Object.keys(jobs), [
    "verify-version",
    "draft",
    "build",
    "publish",
  ]);
  assert.deepEqual(needs("verify-version"), []);
  assert.deepEqual(needs("draft"), ["verify-version"]);
  assert.deepEqual(needs("build"), ["draft"]);
  assert.deepEqual(needs("publish"), ["build"]);
});

test("only the jobs that write to the release have write rights", () => {
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.equal(jobs["verify-version"].permissions, undefined);
  for (const job of ["draft", "build", "publish"])
    assert.deepEqual(jobs[job].permissions, { contents: "write" }, job);
});

test("the version job refuses a tag that is not v plus the package version, in that step", () => {
  const checks = steps("verify-version").filter((step) =>
    step.run?.includes("GITHUB_REF_NAME"),
  );
  assert.equal(checks.length, 1);
  const run = checks[0].run;
  assert.match(
    run,
    /expected="v\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/,
  );
  const compare = run.indexOf('"$GITHUB_REF_NAME" != "$expected"');
  assert.ok(compare >= 0, "compares the tag with the expectation");
  assert.ok(
    run.indexOf("exit 1", compare) > compare,
    "and fails in the same step",
  );
});

test("one job creates the draft release and the platform jobs upload into it", () => {
  const creates = Object.entries(jobs).flatMap(([name, job]) =>
    job.steps
      .filter((s) => s.run?.includes("gh release create"))
      .map(() => name),
  );
  assert.deepEqual(creates, ["draft"], "created in one place only");
  const create = steps("draft")
    .map((step) => step.run)
    .join("\n");
  assert.match(create, /gh release create[\s\S]*--draft/);
  assert.match(create, /isDraft/, "a published release is refused");
  assert.deepEqual([...jobs.build.strategy.matrix.os].sort(), [
    "macos-latest",
    "ubuntu-latest",
    "windows-latest",
  ]);
  assert.equal(jobs.build.strategy["fail-fast"], false);
  const runs = steps("build").map((step) => step.run);
  for (const command of [
    "npm ci",
    "npm test",
    "npm run check",
    "npm run build",
  ])
    assert.ok(runs.includes(command), command);
  assert.ok(runs.indexOf("npm test") < runs.indexOf("npm run build"));
  const upload = stepNamed("build", UPLOAD);
  assert.equal(upload.run, "npx electron-builder --publish always");
  assert.equal(upload.env.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
});

test("a missing Mac signing secret fails the Mac job before anything is built", () => {
  const step = stepNamed("build", IMPORT);
  assert.equal(step.if, MAC);
  assert.equal(
    step.env.MAC_SIGN_P12_BASE64,
    "${{ secrets.MAC_SIGN_P12_BASE64 }}",
  );
  assert.equal(
    step.env.MAC_SIGN_P12_PASSWORD,
    "${{ secrets.MAC_SIGN_P12_PASSWORD }}",
  );
  const missing = step.run.indexOf('[ -z "$MAC_SIGN_P12_BASE64" ]');
  assert.ok(missing >= 0);
  assert.ok(step.run.indexOf("::error::", missing) > missing);
  assert.ok(step.run.indexOf("exit 1", missing) > missing);
  assert.ok(
    step.run.indexOf("exit 1", missing) <
      step.run.indexOf("security create-keychain"),
    "fails before a keychain is made",
  );
  assert.match(step.run, /security import[^\n]*-T \/usr\/bin\/codesign/);
  assert.match(step.run, /security set-key-partition-list/);
  const partition = step.run.indexOf("security set-key-partition-list");
  const searchList = step.run.indexOf("security list-keychains -d user -s");
  const exportKeychain = step.run.indexOf("GOME_MAC_SIGN_KEYCHAIN=");
  assert.ok(
    searchList > partition && searchList < exportKeychain,
    "the keychain joins the user search list after the key partition list and before the env export (--keychain alone left codesign with no identity on the runner)",
  );
  assert.ok(
    searchList < step.run.indexOf("GOME_MAC_SIGN_IDENTITY="),
    "the search list is set before the identity is exported",
  );
  assert.match(step.run, /GOME_MAC_SIGN_KEYCHAIN=[^\n]*GITHUB_ENV/);
  assert.match(step.run, /GOME_MAC_SIGN_IDENTITY=[^\n]*GITHUB_ENV/);
  assert.ok(indexOfStep("build", IMPORT) < indexOfStep("build", UPLOAD));
});

// The search-list block is cut out of the real workflow text by its markers and run with
// bash against a fake `security`, so the test breaks if the block itself breaks.
// Like the other bash tests here, skipped on Windows: the block only runs on the macOS
// runner, and a Windows `bash` (Git Bash or the WSL launcher) ignores the fake's mode bits.
const posix = process.platform !== "win32";
const bashAvailable = posix && spawnSync("bash", ["-c", "true"]).status === 0;

const searchListBlock = () => {
  const lines = stepNamed("build", IMPORT).run.split("\n");
  // From the first of the listing capture or the array start, so a change of how the
  // listing is read stays inside the block that is run.
  const from = lines.findIndex(
    (l) => l.includes("listing=") || l.includes("existing=()"),
  );
  const to = lines.findIndex((l) =>
    l.includes("security list-keychains -d user -s"),
  );
  assert.ok(from >= 0 && to > from, "the search-list block has its markers");
  return lines.slice(from, to + 1).join("\n");
};

// listing: text the fake prints for `list-keychains -d user`, or null to make it exit 1.
const runSearchList = (listing) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gome-searchlist-"));
  try {
    const record = path.join(dir, "set-args");
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "security"),
      [
        "#!/bin/bash",
        'if [ "$1 $2 $3" = "list-keychains -d user" ] && [ "$#" -eq 3 ]; then',
        listing === null
          ? "  exit 1"
          : "  printf '%s' \"$FAKE_LISTING\"; exit 0",
        "fi",
        'if [ "$4" = "-s" ]; then printf \'%s\\n\' "$@" > "$FAKE_RECORD"; exit 0; fi',
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const keychain = path.join(dir, "gome-sign.keychain-db");
    const res = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", searchListBlock()],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          FAKE_LISTING: listing ?? "",
          FAKE_RECORD: record,
          keychain,
        },
      },
    );
    const recorded = existsSync(record)
      ? readFileSync(record, "utf8").split("\n").slice(0, -1)
      : null;
    return { status: res.status, recorded, keychain };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const LOGIN = "/Users/user/Library/Keychains/login.keychain-db";
const SPACED = "/Users/user/Library/Keychains/my keys.keychain-db";

test(
  "the search-list block keeps the existing keychains, spaces included, behind the signing keychain",
  { skip: !bashAvailable && "needs bash on a POSIX system" },
  () => {
    const r = runSearchList(`    "${LOGIN}"\n    "${SPACED}"\n`);
    assert.equal(r.status, 0);
    assert.deepEqual(r.recorded, [
      "list-keychains",
      "-d",
      "user",
      "-s",
      r.keychain,
      LOGIN,
      SPACED,
    ]);
  },
);

test(
  "the search-list block with no existing keychains sets only the signing keychain",
  { skip: !bashAvailable && "needs bash on a POSIX system" },
  () => {
    const r = runSearchList("");
    assert.equal(r.status, 0);
    assert.deepEqual(r.recorded, [
      "list-keychains",
      "-d",
      "user",
      "-s",
      r.keychain,
    ]);
  },
);

test(
  "a failing keychain listing fails the step before the search list is set",
  { skip: !bashAvailable && "needs bash on a POSIX system" },
  () => {
    const r = runSearchList(null);
    assert.notEqual(r.status, 0);
    assert.equal(r.recorded, null);
  },
);

test("the zipped Mac app is checked after the upload, and the keychain is always deleted", () => {
  const check = stepNamed("build", ZIP_CHECK);
  assert.equal(check.if, MAC);
  assert.ok(indexOfStep("build", ZIP_CHECK) > indexOfStep("build", UPLOAD));
  assert.match(check.run, /ditto -x -k release\/\*\.zip/);
  assert.match(check.run, /codesign --verify --deep --strict/);
  assert.match(check.run, /Authority=\$GOME_MAC_SIGN_NAME/);
  assert.match(check.run, /exit 1/);
  assert.equal(release.env.GOME_MAC_SIGN_NAME, "Gome Remote Desktop Signing");
  const clean = stepNamed("build", KEYCHAIN);
  assert.ok(clean.if.includes("always()"));
  assert.ok(clean.if.includes(MAC));
  assert.match(clean.run, /security delete-keychain/);
  assert.equal(indexOfStep("build", KEYCHAIN), steps("build").length - 1);
});

test("the release is published last, only when every update file and installer is attached", () => {
  const run = stepNamed("publish", PUBLISH_STEP).run;
  const names = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
  const list = run.match(/for name in ([^;]*); do/);
  assert.ok(list, "loops over the update files");
  assert.deepEqual(list[1].split(" "), names);
  const loop = run.match(/for pattern in ([^;]*); do/);
  assert.ok(loop, "loops over the installer patterns");
  assert.deepEqual(
    [...loop[1].matchAll(/'([^']*)'/g)].map((m) => m[1]),
    [
      "\\.exe$",
      "\\.exe\\.blockmap$",
      "\\.dmg$",
      "\\.zip$",
      "\\.zip\\.blockmap$",
      "\\.AppImage$",
    ],
  );
  const init = run.indexOf("missing=0");
  assert.ok(
    init >= 0 && init < list.index,
    "missing starts at 0 before the loops",
  );
  const guard = run.indexOf('if [ "$missing" != 0 ]; then');
  assert.ok(guard > loop.index, "the check comes after both loops");
  assert.equal(run.match(/missing=1/g)?.length, 2, "one flag per loop");
  const flagInNames = run.indexOf("missing=1", list.index);
  const flagInPatterns = run.indexOf("missing=1", loop.index);
  assert.ok(
    flagInNames > list.index && flagInNames < loop.index,
    "the update-file loop sets the flag",
  );
  assert.ok(
    flagInPatterns > loop.index && flagInPatterns < guard,
    "the installer loop sets the flag",
  );
  const fail = run.indexOf("exit 1", loop.index);
  const undraft = run.indexOf("gh release edit");
  assert.ok(fail > guard, "fails inside the missing check");
  assert.ok(undraft > fail, "un-drafts only after that");
  assert.ok(undraft > guard, "un-drafts only after the missing check");
  assert.match(run.slice(undraft), /--draft=false --latest/);
  assert.equal(releaseText.match(/--draft=false/g).length, 1);
});

test("no step prints a secret, directly or through its environment variable", () => {
  const secretNames = new Set();
  const envs = [release.env ?? {}];
  for (const job of Object.values(jobs)) {
    envs.push(job.env ?? {});
    for (const step of job.steps) envs.push(step.env ?? {});
  }
  for (const env of envs)
    for (const [name, value] of Object.entries(env))
      if (String(value).includes("secrets.")) secretNames.add(name);
  assert.ok(secretNames.has("MAC_SIGN_P12_PASSWORD"));
  assert.ok(secretNames.has("GH_TOKEN"));
  for (const job of Object.values(jobs))
    for (const step of job.steps) {
      const run = step.run ?? "";
      assert.equal(/\bset -[a-z]*x/.test(run), false, "no shell tracing");
      assert.equal(run.includes("secrets."), false, "secrets only via env");
      for (const line of run.split("\n")) {
        for (const name of secretNames) {
          if (!new RegExp(`\\$\\{?${name}\\b`).test(line)) continue;
          // The one allowed use of printing: the p12 piped into the decoder.
          const decoded =
            /^printf '%s' "\$MAC_SIGN_P12_BASE64" \| openssl base64 -d /.test(
              line,
            );
          assert.ok(
            decoded || !/\b(echo|printf|cat|env|printenv)\b/.test(line),
            `${step.name ?? run}: ${line}`,
          );
        }
      }
    }
});

test("pull request and push builds stay publish-free", async () => {
  const build = await read(".github/workflows/build.yml");
  assert.match(pkg.scripts.dist, /electron-builder --publish never/);
  assert.match(build, /npm run dist/);
  assert.equal(build.includes("--publish always"), false);
});

// ---- scripts/make-mac-signing-cert.sh ----

test("the certificate script makes a 20-year code-signing certificate macOS can import", async () => {
  const script = await read("scripts/make-mac-signing-cert.sh");
  assert.match(script, /CN="Gome Remote Desktop Signing"/);
  assert.match(script, /extendedKeyUsage = critical,codeSigning/);
  assert.match(script, /keyUsage = critical,digitalSignature/);
  assert.match(script, /-days 7305/);
  assert.match(
    script,
    /-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1/,
  );
  assert.equal(script.includes("BEGIN"), false, "no key material in the file");
  // The workflow looks for the very name the script gives the certificate.
  assert.match(
    releaseText,
    /GOME_MAC_SIGN_NAME: Gome Remote Desktop Signing\n/,
  );
});
