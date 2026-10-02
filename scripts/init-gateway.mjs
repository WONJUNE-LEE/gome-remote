import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { validateConfig } from "../server/config.js";

const [output, origin, targetsFile] = process.argv.slice(2);
if (!output || !origin || !targetsFile) {
  console.error(
    "Usage: node scripts/init-gateway.mjs <private-config-path> <https://host.tailnet.ts.net:8449> <targets.json>",
  );
  process.exit(1);
}
const config = validateConfig({
  publicOrigin: origin,
  token: randomBytes(32).toString("base64url"),
  targets: JSON.parse(await readFile(targetsFile, "utf8")),
});
const file = resolve(output);
await mkdir(dirname(file), { recursive: true, mode: 0o700 });
await writeFile(file, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  `Created ${file}. The gateway token is stored there; it was not printed.`,
);
