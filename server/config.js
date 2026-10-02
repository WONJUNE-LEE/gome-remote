import { isIP } from "node:net";
import { readFile } from "node:fs/promises";

export function isTailnetAddress(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function validateConfig(value) {
  const config = {
    listenHost: "127.0.0.1",
    port: 38989,
    guacdPort: 4822,
    ...value,
  };
  if (config.listenHost !== "127.0.0.1")
    throw new Error(
      "The gateway must listen on loopback behind Tailscale Serve.",
    );
  for (const field of ["port", "guacdPort"]) {
    if (
      !Number.isInteger(config[field]) ||
      config[field] < 1 ||
      config[field] > 65535
    )
      throw new Error(`Invalid ${field}.`);
  }
  const origin = new URL(config.publicOrigin);
  const local = origin.protocol === "http:" && origin.hostname === "127.0.0.1";
  if (
    !(origin.protocol === "https:" && origin.hostname.endsWith(".ts.net")) &&
    !local
  )
    throw new Error("Use a Tailscale HTTPS origin.");
  if (
    origin.origin !== config.publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("publicOrigin must be an origin without a path.");
  if (
    typeof config.token !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(config.token)
  )
    throw new Error(
      "Use a randomly generated gateway token (at least 32 bytes).",
    );
  if (
    !Array.isArray(config.targets) ||
    config.targets.length < 1 ||
    config.targets.length > 100
  )
    throw new Error("Configure 1–100 targets.");
  const ids = new Set();
  for (const target of config.targets) {
    if (!/^[a-z0-9-]{1,64}$/.test(target.id) || ids.has(target.id))
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
    if (target.password !== undefined)
      throw new Error(
        "Desktop passwords belong in the client vault, not gateway configuration.",
      );
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
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
