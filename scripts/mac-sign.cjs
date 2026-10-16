// electron-builder `afterSign` hook for the macOS build (mac.identity is null, so
// electron-builder itself signs nothing). With GOME_MAC_SIGN_KEYCHAIN and
// GOME_MAC_SIGN_IDENTITY set it signs the .app with the stable self-signed certificate of
// this project, before the dmg and the zip are made from it. Squirrel.Mac accepts an
// update only if it is signed by the same certificate as the running app, so every
// release must use the same one. Without the variables (local and pull request builds)
// it does nothing. Only one of the two is a configuration mistake and fails the build.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

function signMac(
  context,
  { env = process.env, run = execFileSync, log = console.log } = {},
) {
  if (context.electronPlatformName !== "darwin") return false;
  const keychain = env.GOME_MAC_SIGN_KEYCHAIN;
  const identity = env.GOME_MAC_SIGN_IDENTITY;
  if (!keychain && !identity) {
    log(
      "mac-sign: GOME_MAC_SIGN_KEYCHAIN/GOME_MAC_SIGN_IDENTITY not set; the app is left unsigned",
    );
    return false;
  }
  if (!keychain || !identity)
    throw new Error(
      "mac-sign: set both GOME_MAC_SIGN_KEYCHAIN and GOME_MAC_SIGN_IDENTITY, or neither",
    );
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  // --deep signs the nested helpers and frameworks first and the app last; the strict
  // verification right after fails the build if anything inside is left unsigned or altered.
  run(
    "codesign",
    ["--force", "--deep", "--sign", identity, "--keychain", keychain, app],
    { stdio: "inherit" },
  );
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  // The requirement an update must meet; printed so a release log shows it stays the same.
  run("codesign", ["-d", "-r-", app], { stdio: "inherit" });
  log(`mac-sign: signed ${app}`);
  return true;
}

module.exports = async function afterSign(context) {
  signMac(context);
};
module.exports.signMac = signMac;
