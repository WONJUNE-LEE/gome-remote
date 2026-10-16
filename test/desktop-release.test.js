import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("package-lock.json"));
const release = await read(".github/workflows/release.yml");
const { signMac } = require("../scripts/mac-sign.cjs");

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

const context = {
  electronPlatformName: "darwin",
  appOutDir: "/out/mac",
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
  const app = "/out/mac/Gome Remote.app";
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

// ---- .github/workflows/release.yml ----

test("the release runs on v* tags and refuses a tag that is not v plus the package version", () => {
  assert.match(release, /tags:\s*\["v\*"\]/);
  assert.match(release, /verify-version:/);
  assert.match(
    release,
    /expected="v\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/,
  );
  assert.match(release, /"\$GITHUB_REF_NAME" != "\$expected"[\s\S]*?exit 1/);
  // every later job waits for the check
  assert.match(release, /draft:\s*\n\s*needs: verify-version/);
});

test("one job creates the draft release and the platform jobs upload into it", () => {
  assert.match(release, /gh release create[^\n]*\\?\n?[^\n]*--draft/);
  assert.match(release, /build:\s*\n\s*needs: draft/);
  assert.match(release, /os: \[windows-latest, macos-latest, ubuntu-latest\]/);
  assert.match(release, /npx electron-builder --publish always/);
  assert.equal((release.match(/gh release create/g) ?? []).length, 1);
  for (const step of ["npm ci", "npm test", "npm run check", "npm run build"])
    assert.ok(release.includes(`- run: ${step}`), step);
});

test("a missing Mac signing secret fails the Mac job, and the keychain is always deleted", () => {
  assert.match(release, /secrets\.MAC_SIGN_P12_BASE64/);
  assert.match(release, /secrets\.MAC_SIGN_P12_PASSWORD/);
  assert.match(
    release,
    /\[ -z "\$MAC_SIGN_P12_BASE64" \][^\n]*\n[\s\S]*?::error::[^\n]*\n\s*exit 1/,
  );
  assert.match(release, /security import[^\n]*-T \/usr\/bin\/codesign/);
  assert.match(release, /security set-key-partition-list/);
  assert.match(release, /GOME_MAC_SIGN_KEYCHAIN=/);
  assert.match(release, /GOME_MAC_SIGN_IDENTITY=/);
  assert.match(
    release,
    /if: always\(\) && runner\.os == 'macOS'\s*\n\s*run: \|\n[^\n]*\n?[^\n]*security delete-keychain/,
  );
});

test("the release is un-drafted only after all platform jobs, and only with every update file", () => {
  assert.match(release, /publish:\s*\n\s*needs: build/);
  for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml"])
    assert.ok(release.includes(name), name);
  const check = release.indexOf("Missing");
  const publish = release.indexOf("--draft=false --latest");
  assert.ok(check > 0 && publish > check, "checked before it is published");
  assert.equal((release.match(/--draft=false/g) ?? []).length, 1);
});

test("no job gets more rights than it needs and no secret is printed", () => {
  assert.match(release, /^permissions:\s*\n\s*contents: read/m);
  assert.equal(/echo[^\n]*\$\{\{ *secrets\./.test(release), false);
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
  assert.match(release, /GOME_MAC_SIGN_NAME: Gome Remote Desktop Signing\n/);
});
