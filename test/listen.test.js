import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStaleSocket,
  forwardLoopback,
  listenOnSocket,
  prepareSocketDirectory,
} from "../server/listen.js";

const posix = process.platform !== "win32";

async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-l-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const echoServer = () =>
  http.createServer((req, res) => res.end("hello from the socket"));
const get = (socketPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/" }, async (res) => {
        let text = "";
        for await (const chunk of res) text += chunk;
        resolve(text);
      })
      .on("error", reject);
  });

test(
  "listening creates a 0600 socket inside a freshly created 0700 directory",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "state", "g.sock");
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    t.after(() => server.close());
    assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "a directory open to group or others, or owned by someone else, is refused",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    for (const mode of [0o755, 0o750, 0o770, 0o701]) {
      const open = join(dir, `m${mode.toString(8)}`);
      await mkdir(open);
      await chmod(open, mode);
      await assert.rejects(
        prepareSocketDirectory(join(open, "g.sock")),
        /must not be accessible/,
        mode.toString(8),
      );
    }
    await assert.rejects(
      prepareSocketDirectory(join(dir, "g.sock"), process.getuid() + 1),
      /owned by the gateway user/,
    );
  },
);

test(
  "a regular file at the socket path is never removed",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    await writeFile(socketPath, "precious");
    await assert.rejects(clearStaleSocket(socketPath), /not a socket/);
    assert.ok((await lstat(socketPath)).isFile());
  },
);

test(
  "a live gateway's socket is never taken over",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const first = echoServer();
    await listenOnSocket(first, socketPath);
    t.after(() => first.close());
    await assert.rejects(
      listenOnSocket(echoServer(), socketPath),
      /already listening/,
    );
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "the socket file left behind by SIGKILL is replaced on the next start",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import net from "node:net"; net.createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up")); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.ok(
      (await lstat(socketPath)).isSocket(),
      "the killed process left its socket file",
    );
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    t.after(() => server.close());
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "the development relay forwards bytes between a loopback port and the socket",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const relay = await forwardLoopback(socketPath, port);
    t.after(() => {
      relay.close();
      server.close();
    });
    assert.equal(relay.address().address, "127.0.0.1");
    const text = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, async (res) => {
          let body = "";
          for await (const chunk of res) body += chunk;
          resolve(body);
        })
        .on("error", reject);
    });
    assert.equal(text, "hello from the socket");
  },
);
