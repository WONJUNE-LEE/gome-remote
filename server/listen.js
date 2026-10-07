import net from "node:net";
import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

// The socket's directory is the real access boundary: mode 700, owned by the gateway
// user. Refuse to start rather than quietly tighten a directory someone else owns.
export async function prepareSocketDirectory(
  socketPath,
  uid = process.getuid?.(),
) {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory.`);
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${directory} must be owned by the gateway user.`);
  if (info.mode & 0o077)
    throw new Error(
      `${directory} must not be accessible by group or others; run: chmod 700 ${directory}`,
    );
}

function probe(socketPath) {
  return new Promise((resolveProbe) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe("live");
    });
    socket.once("error", (error) =>
      resolveProbe(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? "stale"
          : error.code,
      ),
    );
  });
}

// SIGKILL and power loss leave the socket file behind. Remove it only when it is a
// socket nobody is listening on; never a regular file and never a live gateway.
export async function clearStaleSocket(socketPath) {
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket())
    throw new Error(
      `${socketPath} exists and is not a socket; not removing it.`,
    );
  const state = await probe(socketPath);
  if (state === "live")
    throw new Error(`Another gateway is already listening on ${socketPath}.`);
  if (state !== "stale")
    throw new Error(`Cannot inspect ${socketPath}: ${state}.`);
  await rm(socketPath);
}

export async function listenOnSocket(server, socketPath) {
  await prepareSocketDirectory(socketPath);
  await clearStaleSocket(socketPath);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  // Safe even before this runs: the 700 directory already keeps other users out.
  await chmod(socketPath, 0o600);
}

// net.Server unlinks the socket when it closes; this covers the case where close()
// raced with an error, and never touches anything that is not a socket.
export async function removeSocket(socketPath) {
  try {
    if ((await lstat(socketPath)).isSocket()) await rm(socketPath);
  } catch {
    // already gone
  }
}

// Development only (devLogin + http://127.0.0.1:<port>): a browser or the desktop app
// cannot reach a unix socket, so relay a loopback TCP port to it byte for byte. The
// gateway still sees one HTTP server and applies the same identity and Origin rules.
export function forwardLoopback(socketPath, port) {
  const relay = net.createServer((client) => {
    const upstream = net.connect(socketPath);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolveListen, rejectListen) => {
    relay.once("error", rejectListen);
    relay.listen(port, "127.0.0.1", () => resolveListen(relay));
  });
}
