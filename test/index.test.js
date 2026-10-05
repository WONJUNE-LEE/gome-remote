import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const posix = process.platform !== "win32";
const entry = new URL("../server/index.js", import.meta.url).pathname;

async function setup(
  t,
  { config = {}, credentials, credentialsMode = 0o600 } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "gr-i-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "run", "g.sock");
  const credentialsFile = join(dir, "credentials.json");
  const configPath = join(dir, "gateway.json");
  const full = {
    socketPath,
    publicOrigin: "https://gateway.example.ts.net:8450",
    allowedLogins: ["owner@example.com"],
    credentialsFile,
    targets: [
      {
        id: "mac",
        name: "Mac",
        platform: "mac",
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      },
    ],
    ...config,
  };
  await writeFile(configPath, JSON.stringify(full));
  if (credentials !== undefined) {
    await writeFile(credentialsFile, JSON.stringify(credentials));
    await chmod(credentialsFile, credentialsMode);
  }
  return { dir, socketPath, configPath };
}

function launch(configPath) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, GOME_REMOTE_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  return {
    child,
    output: () => ({ out, err }),
    exited: once(child, "exit").then(([code, signal]) => ({ code, signal })),
    async listening() {
      for (let i = 0; i < 100 && !out.includes("listening"); i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(out, /listening/, err);
    },
  };
}
const health = (socketPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/healthz" }, async (res) => {
        let text = "";
        for await (const chunk of res) text += chunk;
        resolve(text);
      })
      .on("error", reject);
  });

// TCP sockets in LISTEN state that belong to `pid`. /proc/net/tcp lists the whole
// network namespace, so match its socket inodes against the process's own descriptors.
async function listeningTcpPorts(pid) {
  const inodes = new Set();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try {
      const link = await readlink(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match) inodes.add(match[1]);
    } catch {
      // descriptor closed meanwhile
    }
  }
  const ports = [];
  for (const table of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/net/${table}`, "utf8")).split("\n");
    for (const line of lines.slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] === "0A" && inodes.has(columns[9]))
        ports.push(parseInt(columns[1].split(":")[1], 16));
    }
  }
  return ports;
}
const linux = process.platform === "linux";

test(
  "startup is refused with a clear reason for a loosened credentials file",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t, {
      credentials: { version: 1, targets: { mac: { password: "pw-secret" } } },
      credentialsMode: 0o644,
    });
    const run = launch(configPath);
    const { code } = await run.exited;
    const { err, out } = run.output();
    assert.equal(code, 1);
    assert.match(err, /refused to start/);
    assert.match(err, /mode 600/);
    assert.ok(!err.includes("pw-secret") && !out.includes("pw-secret"));
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "startup is refused without allowedLogins or with a legacy token",
  { skip: !posix },
  async (t) => {
    for (const [change, expected] of [
      [{ allowedLogins: [] }, /allowedLogins/],
      [{ token: "x".repeat(43) }, /token/],
    ]) {
      const { configPath } = await setup(t, { config: change });
      const run = launch(configPath);
      assert.equal((await run.exited).code, 1);
      assert.match(run.output().err, expected);
    }
  },
);

test(
  "a running gateway answers on its 0600 socket and removes it on SIGTERM",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t);
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(socketPath, ".."))).mode & 0o777, 0o700);
    assert.equal(await health(socketPath), '{"ok":true}');
    run.child.kill("SIGTERM");
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "after SIGKILL the next start replaces the stale socket and serves again",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t);
    const first = launch(configPath);
    await first.listening();
    first.child.kill("SIGKILL");
    await first.exited;
    assert.ok((await lstat(socketPath)).isSocket(), "stale socket remains");
    const second = launch(configPath);
    t.after(() => second.child.kill("SIGKILL"));
    await second.listening();
    assert.equal(await health(socketPath), '{"ok":true}');
  },
);

test(
  "a development configuration also relays its loopback port",
  { skip: !posix },
  async (t) => {
    // An ephemeral port from the OS, released just before the child binds it.
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const { configPath } = await setup(t, {
      config: {
        publicOrigin: `http://127.0.0.1:${port}`,
        devLogin: "owner@example.com",
      },
    });
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    const targets = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/api/targets`, async (res) => {
          let text = "";
          for await (const chunk of res) text += chunk;
          resolve({ status: res.statusCode, text });
        })
        .on("error", reject);
    });
    assert.equal(targets.status, 200);
    assert.match(run.output().err, /Development login/);
  },
);

test(
  "the listening-port inspector sees a development relay (positive control for the production test)",
  { skip: !linux },
  async (t) => {
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const { configPath } = await setup(t, {
      config: {
        publicOrigin: `http://127.0.0.1:${port}`,
        devLogin: "owner@example.com",
      },
    });
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    assert.deepEqual(await listeningTcpPorts(run.child.pid), [port]);
  },
);

test(
  "a production configuration opens no TCP listening socket at all, only the unix socket",
  { skip: !linux },
  async (t) => {
    const { configPath, socketPath } = await setup(t);
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    assert.equal(await health(socketPath), '{"ok":true}');
    assert.deepEqual(await listeningTcpPorts(run.child.pid), []);
    assert.doesNotMatch(run.output().err, /Development login/);
  },
);
