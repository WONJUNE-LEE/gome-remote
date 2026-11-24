import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export async function syncDirectory(directory) {
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

// Temp file (given mode, same directory) -> fsync -> rename -> fsync directory.
export async function writeFileAtomic(file, body, mode) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temp, "wx", mode);
    await handle.chmod(mode); // the umask can only remove bits, but be explicit
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
