import { constants } from "node:fs";
import { open } from "node:fs/promises";

// File format: {"version":1,"targets":{"<id>":{"username":"...","password":"..."}}}
// Values never appear in errors or logs; messages name only the file and target IDs.
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const ID = /^[a-z0-9-]{1,64}$/;

export class CredentialFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialFileError";
  }
}

function parseEntry(id, entry, file) {
  const bad = (why) =>
    new CredentialFileError(`Credentials for "${id}" in ${file} ${why}.`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw bad("must be an object");
  for (const key of Object.keys(entry))
    if (!["username", "password"].includes(key))
      throw bad(`has an unknown field "${key}"`);
  if (
    typeof entry.password !== "string" ||
    !entry.password ||
    entry.password.length > 1024
  )
    throw bad("need a password of 1-1024 characters");
  if (
    entry.username !== undefined &&
    (typeof entry.username !== "string" ||
      !entry.username ||
      entry.username.length > 256)
  )
    throw bad("need a username of 1-256 characters when one is present");
  return Object.freeze({
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    password: entry.password,
  });
}

// Returns Map<targetId, {username?, password}>. A missing file means "no credentials yet".
// The permission checks run on the opened descriptor, so the file cannot change between
// the check and the read, and a symbolic link is never followed.
export async function readCredentialFile(file, uid = process.getuid?.()) {
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer, so it reaches the
    // regular-file check below instead of pinning a thread on every lookup.
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    if (error.code === "ELOOP")
      throw new CredentialFileError(`${file} must not be a symbolic link.`);
    throw new CredentialFileError(`Cannot open ${file}: ${error.code}.`);
  }
  try {
    if (uid === undefined)
      throw new CredentialFileError(
        "Credential files require a POSIX platform (no process uid).",
      );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CredentialFileError(`${file} must be a regular file.`);
    if ((stat.mode & 0o777) !== 0o600)
      throw new CredentialFileError(
        `${file} must have mode 600 (found ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
      );
    if (stat.uid !== uid)
      throw new CredentialFileError(
        `${file} must be owned by the gateway user (uid ${uid}).`,
      );
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES)
      throw new CredentialFileError(`${file} is larger than expected.`);
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new CredentialFileError(`${file} is not valid JSON.`);
    }
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.targets ||
      typeof parsed.targets !== "object" ||
      Array.isArray(parsed.targets)
    )
      throw new CredentialFileError(
        `${file} must be {"version":1,"targets":{...}}.`,
      );
    const entries = new Map();
    for (const [id, entry] of Object.entries(parsed.targets)) {
      if (!ID.test(id))
        throw new CredentialFileError(`${file} has an invalid target ID.`);
      entries.set(id, parseEntry(id, entry, file));
    }
    return entries;
  } finally {
    await handle.close();
  }
}

// What a target needs: RDP a username and password. VNC needs a password; the username
// is optional because macOS Screen Sharing negotiates Apple Remote Desktop authentication
// (account name + password) while a plain VNC host uses the password alone.
export function credentialsFor(entries, target) {
  const entry = entries.get(target.id);
  if (!entry?.password) return undefined;
  if (target.protocol === "rdp")
    return entry.username === undefined
      ? undefined
      : { username: entry.username, password: entry.password };
  return { username: entry.username ?? "", password: entry.password };
}

// The gateway reads the file again on every lookup, so `set-credential` takes effect
// without a restart. load() is strict and is used once at startup; lookup() never
// throws, so a file that is damaged later makes targets "not ready" instead of
// crashing the service. The first failure after startup is logged, not repeated.
export class CredentialStore {
  #lastProblem = "";
  constructor(file, { uid = process.getuid?.(), log = console.error } = {}) {
    this.file = file;
    this.uid = uid;
    this.log = log;
  }
  load() {
    return readCredentialFile(this.file, this.uid);
  }
  async lookup(target) {
    try {
      const entries = await this.load();
      this.#lastProblem = "";
      return credentialsFor(entries, target);
    } catch (error) {
      if (error.message !== this.#lastProblem) {
        this.#lastProblem = error.message;
        this.log(`Credentials unavailable: ${error.message}`);
      }
      return undefined;
    }
  }
}
