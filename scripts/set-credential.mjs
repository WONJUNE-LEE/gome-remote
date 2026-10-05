import { constants, realpathSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { loadConfig } from "../server/config.js";
import { readCredentialFile } from "../server/credentials.js";

// Secrets are read from the terminal only: never from argv, the environment, or a file
// named on the command line, so they cannot appear in `ps`, shell history, or logs.

class Prompter {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #waiting;
  #ended = false;
  #skipLineFeed = false;
  constructor(input, output) {
    this.input = input;
    this.output = output;
    input.on("data", (chunk) => {
      this.#buffer += this.#decoder.write(chunk);
      this.#wake();
    });
    input.on("end", () => {
      this.#buffer += this.#decoder.end();
      this.#ended = true;
      this.#wake();
    });
    input.on("error", () => {
      this.#ended = true;
      this.#wake();
    });
  }
  #wake() {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.();
  }
  async #next() {
    while (!this.#buffer) {
      if (this.#ended) return undefined;
      await new Promise((resolve) => {
        this.#waiting = resolve;
      });
    }
    const [char] = this.#buffer; // one code point, so Korean and emoji stay intact
    this.#buffer = this.#buffer.slice(char.length);
    return char;
  }
  async ask(label, { secret }) {
    const raw = secret && this.input.isTTY;
    this.output.write(label);
    if (raw) this.input.setRawMode(true);
    this.input.resume();
    const typed = [];
    // In raw mode the terminal sends escape sequences for keys such as the arrows
    // ("\x1b[A"); they are skipped as a whole instead of leaving "[A" in the password.
    let escape; // undefined | "start" | "csi" | "ss3"
    try {
      for (;;) {
        const char = await this.#next();
        if (char === undefined) {
          if (typed.length) break; // final line without a newline
          throw new Error("Input ended before a value was entered.");
        }
        if (raw && escape) {
          if (escape === "start") {
            escape = char === "[" ? "csi" : char === "O" ? "ss3" : undefined;
            if (escape) continue;
          } else if (escape === "csi") {
            // Parameter and intermediate bytes continue the sequence; a final byte ends it.
            if (char >= " " && char <= "?") continue;
            escape = undefined;
            if (char >= "@" && char <= "~") continue;
          } else {
            escape = undefined; // SS3 carries exactly one more character
            continue;
          }
        }
        if (raw && char === "\x1b") {
          escape = "start";
          continue;
        }
        if (char === "\n" && this.#skipLineFeed) {
          this.#skipLineFeed = false;
          continue;
        }
        this.#skipLineFeed = false;
        if (char === "\r" || char === "\n") {
          this.#skipLineFeed = char === "\r";
          break;
        }
        if (char === "\x03" || char === "\x04") throw new Error("Cancelled.");
        if (raw && (char === "\x7f" || char === "\b")) {
          typed.pop();
          continue;
        }
        if (raw && char < " ") continue; // ignore other control keys
        typed.push(char);
      }
    } finally {
      if (raw) {
        this.input.setRawMode(false);
        this.output.write("\n"); // raw mode does not echo Enter
      }
      this.input.pause();
    }
    return typed.join("");
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows cannot open or fsync a directory; every POSIX system can.
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

// Temp file (mode 600, same directory) -> fsync -> rename -> fsync directory.
export async function writeCredentialFile(file, entries) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const body = `${JSON.stringify(
    { version: 1, targets: Object.fromEntries(entries) },
    null,
    2,
  )}\n`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.chmod(0o600); // the umask can only remove bits, but be explicit
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

const usage =
  "Usage: node scripts/set-credential.mjs [<gateway-config.json>] <target-id>\n" +
  "Without a config path, GOME_REMOTE_CONFIG or ~/.config/gome-remote/gateway.json is used.";

// One argument is the target ID and the config path is implied; two arguments name both.
function resolveArguments(argv, env, home) {
  if (argv.length === 2) return argv;
  if (argv.length === 1)
    return [
      env.GOME_REMOTE_CONFIG ||
        join(home, ".config", "gome-remote", "gateway.json"),
      argv[0],
    ];
  return undefined;
}

export async function main({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  requireTty = true,
  uid = process.getuid?.(),
  env = process.env,
  home = homedir(),
} = {}) {
  const fail = (message, code = 1) => {
    stderr.write(`${message}\n`);
    return code;
  };
  const resolved = resolveArguments(argv, env, home);
  if (!resolved) return fail(usage, 2);
  const [configPath, targetId] = resolved;
  if (requireTty && !stdin.isTTY)
    return fail("Run this in an interactive terminal; do not pipe secrets.", 2);
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    return fail(`Cannot use ${configPath}: ${error.message}`);
  }
  const target = config.targets.find((t) => t.id === targetId);
  if (!target)
    return fail(
      `Unknown target "${targetId}". Configured targets: ${config.targets.map((t) => t.id).join(", ")}`,
    );
  let entries;
  try {
    entries = await readCredentialFile(config.credentialsFile, uid);
  } catch (error) {
    return fail(`Refusing to modify the credentials file: ${error.message}`);
  }
  const prompter = new Prompter(stdin, stdout);
  try {
    stdout.write(
      `${target.name} (${target.id}): 비밀번호는 화면에 표시되지 않고 ${config.credentialsFile} 에만 저장됩니다.\n`,
    );
    // RDP needs an account name. VNC takes one when the server uses Apple Remote
    // Desktop authentication (macOS Screen Sharing); empty means password only.
    const answer = await prompter.ask(
      target.protocol === "rdp"
        ? "사용자 이름: "
        : "사용자 이름 (macOS 계정 이름, 비밀번호만 쓰면 비워 두세요): ",
      { secret: false },
    );
    const username = answer.trim() ? answer.trim() : undefined;
    if (username === undefined && target.protocol === "rdp")
      return fail("사용자 이름이 비어 있어 저장하지 않았습니다.");
    const password = await prompter.ask(
      target.protocol === "rdp" ? "비밀번호: " : "VNC 비밀번호: ",
      { secret: true },
    );
    const again = await prompter.ask("비밀번호 확인: ", { secret: true });
    if (password !== again)
      return fail("두 비밀번호가 달라 저장하지 않았습니다.");
    if (!password || password.length > 1024)
      return fail("비밀번호는 1-1024자여야 합니다. 저장하지 않았습니다.");
    if (username !== undefined && username.length > 256)
      return fail("사용자 이름은 256자 이하여야 합니다. 저장하지 않았습니다.");
    if (
      target.protocol === "vnc" &&
      target.platform === "mac" &&
      username === undefined && // account-name authentication has no 8 character limit
      password.length > 8
    )
      stdout.write(
        "참고: Apple 화면 공유는 VNC 비밀번호를 앞 8자까지만 사용합니다.\n",
      );
    entries.set(target.id, {
      ...(username !== undefined ? { username } : {}),
      password,
    });
    await writeCredentialFile(config.credentialsFile, entries);
    stdout.write(`저장했습니다: ${target.id}\n`);
    return 0;
  } catch (error) {
    return fail(`저장하지 않았습니다: ${error.message}`);
  }
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
