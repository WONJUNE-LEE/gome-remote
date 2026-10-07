import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path/posix";

// sockaddr_un.sun_path is 108 bytes on Linux (104 on macOS); stay well below both.
export const MAX_SOCKET_PATH_BYTES = 100;

export function isTailnetAddress(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function absolutePath(value, field) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.endsWith("/")
  )
    throw new Error(`${field} must be an absolute file path.`);
  return value;
}

function validateLogins(config, local) {
  const logins = config.allowedLogins;
  if (
    !Array.isArray(logins) ||
    logins.length < 1 ||
    logins.length > 32 ||
    logins.some(
      (login) =>
        typeof login !== "string" ||
        !login ||
        login.length > 254 ||
        /[\s,\x00-\x1f]/.test(login),
    )
  )
    throw new Error(
      "allowedLogins must list 1-32 Tailscale login names; there is no default.",
    );
  if (config.devLogin === undefined) return;
  if (!local)
    throw new Error(
      "devLogin is only allowed when publicOrigin is http://127.0.0.1:<port>.",
    );
  if (!logins.includes(config.devLogin))
    throw new Error("devLogin must also appear in allowedLogins.");
}

const TARGET_KEYS = new Set([
  "id",
  "name",
  "platform",
  "protocol",
  "profile",
  "hostname",
  "port",
  "security",
  "ignoreCertificate",
  "persistent",
]);

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Gateway configuration must be a JSON object.");
  const config = { guacdPort: 4822, ...value };
  if (Object.hasOwn(config, "token"))
    throw new Error(
      "Gateway tokens are no longer used. Remove `token` and list allowedLogins.",
    );
  for (const legacy of ["port", "listenHost"])
    if (Object.hasOwn(config, legacy))
      throw new Error(
        `\`${legacy}\` is no longer used. The gateway listens on socketPath.`,
      );
  if (
    !Number.isInteger(config.guacdPort) ||
    config.guacdPort < 1 ||
    config.guacdPort > 65535
  )
    throw new Error("Invalid guacdPort.");
  absolutePath(config.socketPath, "socketPath");
  if (Buffer.byteLength(config.socketPath) > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `socketPath must be at most ${MAX_SOCKET_PATH_BYTES} bytes (unix socket limit).`,
    );
  absolutePath(config.credentialsFile, "credentialsFile");
  if (typeof config.publicOrigin !== "string")
    throw new Error("publicOrigin is required.");
  let origin;
  try {
    origin = new URL(config.publicOrigin);
  } catch {
    throw new Error("publicOrigin must be an origin.");
  }
  const local =
    origin.protocol === "http:" &&
    origin.hostname === "127.0.0.1" &&
    origin.port !== "";
  if (
    !(
      origin.protocol === "https:" &&
      origin.hostname.endsWith(".ts.net") &&
      origin.hostname.length > ".ts.net".length
    ) &&
    !local
  )
    throw new Error("Use a Tailscale HTTPS origin.");
  if (
    origin.origin !== config.publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("publicOrigin must be an origin without a path.");
  validateLogins(config, local);
  if (
    !Array.isArray(config.targets) ||
    config.targets.length < 1 ||
    config.targets.length > 100
  )
    throw new Error("Configure 1–100 targets.");
  const ids = new Set();
  for (const target of config.targets) {
    if (!target || typeof target !== "object")
      throw new Error("Invalid target.");
    if (Array.isArray(target)) throw new Error("Invalid target.");
    if (target.password !== undefined || target.username !== undefined)
      throw new Error(
        "Target credentials belong in the credentials file (scripts/set-credential.mjs), not in gateway configuration.",
      );
    // Name the key, never its value: a misspelled secret key must not end up in a log.
    for (const key of Object.keys(target))
      if (!TARGET_KEYS.has(key))
        throw new Error(
          `Unknown target setting ${JSON.stringify(key.slice(0, 40))}.`,
        );
    if (
      typeof target.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(target.id) ||
      ids.has(target.id)
    )
      throw new Error("Target IDs must be unique slugs.");
    ids.add(target.id);
    if (!["rdp", "vnc"].includes(target.protocol))
      throw new Error("Only RDP and VNC are supported.");
    if (
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.length > 100
    )
      throw new Error("Invalid target name.");
    if (!["linux", "mac", "windows"].includes(target.platform))
      throw new Error("Invalid target platform.");
    if (target.profile !== undefined && target.profile !== "gnome-remote-login")
      throw new Error("Invalid desktop profile.");
    if (
      target.profile === "gnome-remote-login" &&
      (target.protocol !== "rdp" ||
        target.platform !== "linux" ||
        target.hostname !== "127.0.0.1" ||
        target.persistent !== true ||
        (target.security !== undefined && target.security !== "nla"))
    )
      throw new Error(
        "GNOME Remote Login requires local Linux RDP with NLA and session persistence.",
      );
    if (target.hostname !== "127.0.0.1" && !isTailnetAddress(target.hostname))
      throw new Error("Targets must use a Tailscale IP or loopback.");
    if (
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65535
    )
      throw new Error("Invalid target port.");
    if (
      target.security !== undefined &&
      !["nla", "tls", "any"].includes(target.security)
    )
      throw new Error("Invalid RDP security mode.");
    if (
      target.ignoreCertificate !== undefined &&
      typeof target.ignoreCertificate !== "boolean"
    )
      throw new Error("Invalid certificate policy.");
    if (
      target.persistent !== undefined &&
      typeof target.persistent !== "boolean"
    )
      throw new Error("persistent must be true or false.");
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
