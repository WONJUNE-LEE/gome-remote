import { open } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.js";
import { validateConfig } from "./config.js";
import {
  CredentialFileError,
  credentialEntry,
  readCredentialFile,
  writeCredentialFile,
} from "./credentials.js";
import {
  ManageError,
  applyTargetOp,
  koreanConfigError,
  newTargetId,
  targetForKind,
} from "./targets.js";

const SAVE_FAILED = "서버에 저장하지 못했습니다.";
const ADDED_WITHOUT_KEY =
  "기기는 추가했지만 로그인 정보를 저장하지 못했습니다. 기기 관리에서 다시 입력하세요.";
const ID = /^[a-z0-9-]{1,64}$/;

// Why a write failed, for the log: an OS error code, or a message that never holds a
// value (credential file errors name only the file and IDs), or just the error's name.
function reason(error) {
  if (error.code) return error.code;
  if (error instanceof CredentialFileError) return error.message;
  return error.name;
}

// Writes gateway.json and the credential file for in-app device management. Every call
// runs after the previous one settles, so two requests never interleave their writes.
export function createManager({
  configPath,
  config,
  credentials,
  log = console.error,
  random,
}) {
  let tail = Promise.resolve();

  // One call: queued, logged in one line, errors mapped to ManageError.
  function run(action, login, id, body) {
    const result = tail.then(async () => {
      const step = { id, at: "config", failure: SAVE_FAILED };
      const prefix = () =>
        `manage ${action} ${ID.test(step.id) ? step.id : "-"} by ${login}`;
      try {
        const value = await body(step);
        log(`${prefix()}: ok`);
        return value;
      } catch (error) {
        if (error instanceof ManageError && error.status < 500) {
          log(`${prefix()}: refused (${error.status})`);
          throw error;
        }
        log(`${prefix()}: failed at ${step.at} (${reason(error)})`);
        throw error instanceof ManageError
          ? error
          : new ManageError(500, step.failure);
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  // The file as it is now (hand edits included), with its mode.
  async function readConfig() {
    const handle = await open(configPath, "r");
    try {
      const mode = (await handle.stat()).mode & 0o777;
      const bytes = await handle.readFile();
      return { bytes, mode, raw: JSON.parse(bytes.toString("utf8")) };
    } finally {
      await handle.close();
    }
  }

  // Applies one operation to the file's targets and validates the whole result; writes
  // nothing, so a refused operation changes nothing.
  function stage(file, op) {
    const targets = applyTargetOp(file.raw.targets, op);
    let validated;
    try {
      validated = validateConfig({ ...file.raw, targets });
    } catch (error) {
      throw koreanConfigError(error);
    }
    return { ...file, targets, validated };
  }

  // Backup, then the file's own content with only `targets` replaced (not the defaults
  // validateConfig fills in), then the in-memory list.
  async function commit({ bytes, mode, raw, targets, validated }) {
    await writeFileAtomic(`${configPath}.prev`, bytes, mode);
    await writeFileAtomic(
      configPath,
      `${JSON.stringify({ ...raw, targets }, null, 2)}\n`,
      mode,
    );
    config.targets = validated.targets;
    credentials.setTargets(config.targets);
  }

  // The entry of `id` is about to be replaced or removed, so it is read without a
  // shape check (as scripts/set-credential.mjs does).
  function readEntries(id) {
    const protocols = new Map(
      config.targets.filter((t) => t.id !== id).map((t) => [t.id, t.protocol]),
    );
    return readCredentialFile(credentials.file, credentials.uid, protocols);
  }

  const find = (id) => config.targets.find((t) => t.id === id);

  return {
    add(login, { name, kind, hostname, credential } = {}) {
      return run("add", login, "-", async (step) => {
        step.at = "credential";
        const entries = await readEntries();
        step.at = "config";
        const file = await readConfig();
        const id = newTargetId(
          new Set([...entries.keys(), ...file.raw.targets.map((t) => t.id)]),
          random,
        );
        step.id = id;
        const target = targetForKind(kind, { name, hostname }, id);
        const entry =
          credential == null ? undefined : credentialEntry(target, credential);
        await commit(stage(file, { type: "add", target }));
        if (entry) {
          step.at = "credential";
          step.failure = ADDED_WITHOUT_KEY;
          entries.set(id, entry);
          await writeCredentialFile(credentials.file, entries);
        }
        return find(id);
      });
    },

    rename(login, id, name) {
      return run("rename", login, id, async () => {
        const op = {
          type: "rename",
          id,
          name: typeof name === "string" ? name.trim() : name,
        };
        await commit(stage(await readConfig(), op));
        return find(id);
      });
    },

    setCredential(login, id, input) {
      return run("credential", login, id, async (step) => {
        const target = find(id);
        if (!target) throw new ManageError(404, "기기를 찾을 수 없습니다.");
        const entry = credentialEntry(target, input);
        step.at = "credential";
        const entries = await readEntries(id);
        entries.set(id, entry);
        await writeCredentialFile(credentials.file, entries);
      });
    },

    // The key goes first: if the target write then fails, the target shows "설정 필요"
    // and the delete can be retried.
    remove(login, id) {
      return run("delete", login, id, async (step) => {
        const staged = stage(await readConfig(), { type: "delete", id });
        step.at = "credential";
        const entries = await readEntries(id);
        if (entries.delete(id))
          await writeCredentialFile(credentials.file, entries);
        step.at = "config";
        await commit(staged);
      });
    },
  };
}
