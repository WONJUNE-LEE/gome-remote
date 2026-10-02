import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import vaultModule from "../desktop/vault.cjs";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../desktop/main.cjs", import.meta.url),
  "utf8",
);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function desktop() {
  const ready = deferred();
  const handlers = new Map();
  const requests = [];
  const writes = [];
  let window, vault;
  let availability = async () => true;
  let response = async () => ({
    ticket: "test-ticket",
    targets: [{ id: "ubuntu" }],
  });
  class Vault {
    constructor() {
      vault = this;
      this.value = { gateway: "", token: "", credentials: {} };
    }
    async load() {}
    available() {
      return availability();
    }
    async save() {
      writes.push(JSON.parse(JSON.stringify(this.value)));
    }
  }
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = {
        mainFrame: { url: "app://gome-remote/" },
        on() {},
        setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {} },
      };
    }
    async loadURL() {
      ready.resolve();
    }
  }
  const electron = {
    app: {
      whenReady: async () => {},
      getPath: () => "/unused-test-vault",
      on() {},
      quit() {},
      exit() {},
    },
    BrowserWindow,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    safeStorage: {},
    net: {},
    dialog: {
      showErrorBox: (_title, message) =>
        ready.resolve(Promise.reject(new Error(message))),
    },
    Menu: {
      buildFromTemplate: (template) => template,
      setApplicationMenu() {},
    },
  };
  vm.runInNewContext(source, {
    require: (name) =>
      name === "electron"
        ? electron
        : name === "./vault.cjs"
          ? { Vault, gatewayOrigin: vaultModule.gatewayOrigin }
          : require(name),
    __dirname: "/test/desktop",
    URL,
    Response,
    AbortSignal,
    console,
    process: { argv: [], platform: "win32" },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const value = await response(url);
      return { ok: true, json: async () => value };
    },
  });
  await ready.promise;
  const invoke = (name, input) =>
    handlers.get(`remote:${name}`)(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      input,
    );
  return {
    invoke,
    requests,
    writes,
    vault,
    setAvailability: (f) => (availability = f),
    setResponse: (f) => (response = f),
  };
}
const configure = (f, host) =>
  f.invoke("configure", {
    gateway: `https://${host}.tail123.ts.net`,
    token: "x".repeat(43),
  });
const input = (revision) => ({
  revision,
  targetId: "ubuntu",
  username: "alice",
  password: "original-secret",
  remember: true,
  useSaved: false,
  width: 1920,
  height: 1080,
});

test("gateway switch during OS storage check cannot move credentials to the new gateway", async () => {
  const f = await desktop();
  await configure(f, "a");
  const settings = await f.invoke("settings");
  const storageStarted = deferred();
  const storageReady = deferred();
  f.setAvailability(() => {
    storageStarted.resolve();
    return storageReady.promise;
  });
  const pending = f.invoke("connect", input(settings.revision));
  const rejected = assert.rejects(pending, /연결 설정이 변경/);
  await storageStarted.promise;
  f.setAvailability(async () => true);
  await configure(f, "b");
  storageReady.resolve(true);
  await rejected;
  assert.equal(f.vault.value.gateway, "https://b.tail123.ts.net");
  assert.deepEqual(Object.keys(f.vault.value.credentials), []);
  assert.equal(
    f.writes
      .filter((w) => w.gateway.includes("//b."))
      .some((w) => JSON.stringify(w).includes("original-secret")),
    false,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "https://a.tail123.ts.net/api/sessions");
});

test("stale server lists and connection requests are rejected across gateway changes", async () => {
  const f = await desktop();
  await configure(f, "a");
  const old = await f.invoke("settings");
  const targetsReady = deferred();
  f.setResponse(() => targetsReady.promise);
  const pending = f.invoke("targets");
  const rejected = assert.rejects(pending, /연결 설정이 변경/);
  await configure(f, "b");
  targetsReady.resolve({ targets: [{ id: "ubuntu", name: "A's server" }] });
  await rejected;
  const count = f.requests.length;
  await assert.rejects(
    f.invoke("connect", input(old.revision)),
    /연결 설정이 변경/,
  );
  assert.equal(
    f.requests.length,
    count,
    "stale credentials must not leave the client",
  );
  const current = await f.invoke("settings");
  f.setResponse(async () => ({ ticket: "current-ticket" }));
  const result = await f.invoke("connect", input(current.revision));
  assert.equal(result.ticket, "current-ticket");
  assert.equal(result.websocket, "wss://b.tail123.ts.net/tunnel");
  assert.equal(f.vault.value.credentials.ubuntu.password, "original-secret");
});
