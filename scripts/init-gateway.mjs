import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../server/config.js";

const usage = `Usage: node scripts/init-gateway.mjs [<private-config-path>] \\
  --origin https://host.tailnet.ts.net:8450 \\
  --login owner@example.com [--login second@example.com ...] \\
  --targets deploy/targets.example.json \\
  [--socket <path>] [--credentials <path>]

Creates the gateway configuration. It contains no secrets: desktop passwords go into the
credentials file with scripts/set-credential.mjs, and access is decided by the Tailscale
login names given with --login. Without a config path, GOME_REMOTE_CONFIG or
~/.config/gome-remote/gateway.json is used, the same file set-credential.mjs reads.`;

export function defaultPaths(home = homedir()) {
  return {
    // Not under /tmp: the unit sets PrivateTmp=true, which would hide the socket from Serve.
    socketPath: posix.join(
      home,
      ".local",
      "state",
      "gome-remote",
      "gateway.sock",
    ),
    credentialsFile: posix.join(
      home,
      ".config",
      "gome-remote",
      "credentials.json",
    ),
  };
}

export function defaultConfigPath(env = process.env, home = homedir()) {
  return (
    env.GOME_REMOTE_CONFIG ||
    posix.join(home, ".config", "gome-remote", "gateway.json")
  );
}

export function buildConfig({
  origin,
  logins,
  targets,
  socketPath = defaultPaths().socketPath,
  credentialsFile = defaultPaths().credentialsFile,
}) {
  return validateConfig({
    socketPath,
    publicOrigin: origin,
    allowedLogins: logins,
    credentialsFile,
    targets,
  });
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        origin: { type: "string" },
        login: { type: "string", multiple: true },
        targets: { type: "string" },
        socket: { type: "string" },
        credentials: { type: "string" },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (
    positionals.length > 1 ||
    !values.origin ||
    !values.login?.length ||
    !values.targets
  ) {
    console.error(usage);
    return 2;
  }
  let config;
  try {
    config = buildConfig({
      origin: values.origin,
      logins: values.login,
      targets: JSON.parse(await readFile(values.targets, "utf8")),
      ...(values.socket ? { socketPath: resolve(values.socket) } : {}),
      ...(values.credentials
        ? { credentialsFile: resolve(values.credentials) }
        : {}),
    });
  } catch (error) {
    console.error(`Invalid configuration: ${error.message}`);
    return 1;
  }
  const file = resolve(positionals[0] ?? defaultConfigPath());
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.error(`${file} already exists; refusing to overwrite it.`);
    return 1;
  }
  console.log(
    `Created ${file}. Next: node scripts/set-credential.mjs ${positionals[0] === undefined ? "" : `${file} `}<target-id> for each target.`,
  );
  return 0;
}

// Run only when invoked as the program, also through a symbolic link.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await main();
