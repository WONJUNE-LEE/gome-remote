import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

const source = await readFile(
  new URL("../desktop/preload.cjs", import.meta.url),
  "utf8",
);

function load(protocol = "https:", platform = "win32") {
  const ipc = new EventEmitter();
  const calls = [];
  const exposed = {};
  ipc.invoke = async (...args) => {
    calls.push(args);
  };
  vm.runInNewContext(source, {
    location: { protocol },
    process: { platform },
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          assert.ok(!(name in exposed), `${name} exposed twice`);
          exposed[name] = api;
        },
      },
    }),
  });
  return { ipc, calls, exposed };
}

test("the bridge announces version 4 and exposes only the viewer, fullscreen, clipboard and address-page functions", () => {
  const { exposed } = load();
  assert.deepEqual([...Object.keys(exposed)], ["desktop"]);
  assert.equal(exposed.desktop.bridgeVersion, 4);
  assert.deepEqual([...Object.keys(exposed.desktop)].sort(), [
    "bridgeVersion",
    "fullscreen",
    "fullscreenState",
    "keyLock",
    "keyLockSupported",
    "onFullscreenChange",
    "onViewerAction",
    "openSetup",
    "readClipboard",
    "viewerState",
    "writeClipboard",
  ]);
  for (const removed of [
    "settings",
    "configure",
    "targets",
    "connect",
    "forget",
  ])
    assert.equal(exposed.desktop[removed], undefined, removed);
  assert.ok(Object.isFrozen(exposed.desktop));
});

test("keyLockSupported is true on Windows only, and the bridge stays version 4", () => {
  for (const [platform, expected] of [
    ["win32", true],
    ["darwin", false],
    ["linux", false],
  ]) {
    const { exposed } = load("https:", platform);
    assert.strictEqual(exposed.desktop.keyLockSupported, expected, platform);
    assert.equal(exposed.desktop.bridgeVersion, 4, platform);
    assert.equal(typeof exposed.desktop.keyLock, "function", platform);
  }
});

test("preload forwards native menu actions without exposing Electron events", async () => {
  const { ipc, calls, exposed } = load();
  const desktop = exposed.desktop;
  const received = [];
  const remove = desktop.onViewerAction((...args) => received.push(args));
  const privilegedEvent = { sender: "must-not-cross-bridge" };
  ipc.emit("remote:viewer-action", privilegedEvent, "text-input");
  assert.deepEqual(received, [["text-input"]]);
  const state = {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "1920x1080",
  };
  await desktop.viewerState(state);
  await desktop.fullscreen(true);
  await desktop.fullscreenState();
  await desktop.openSetup();
  await desktop.readClipboard();
  await desktop.writeClipboard("a", { concealed: true });
  await desktop.keyLock(true);
  await desktop.keyLock(false);
  assert.deepEqual(calls, [
    ["remote:viewer-state", state],
    ["remote:fullscreen", true],
    ["remote:fullscreen-state"],
    ["remote:open-setup"],
    ["remote:clipboard-read"],
    ["remote:clipboard-write", "a", { concealed: true }],
    ["remote:key-lock", true],
    ["remote:key-lock", false],
  ]);
  const fullscreen = [];
  const removeFullscreen = desktop.onFullscreenChange((...args) =>
    fullscreen.push(args),
  );
  ipc.emit("remote:fullscreen-state", privilegedEvent, true);
  assert.deepEqual(fullscreen, [[true]]);
  removeFullscreen();
  remove();
  ipc.emit("remote:viewer-action", privilegedEvent, "disconnect");
  ipc.emit("remote:fullscreen-state", privilegedEvent, false);
  assert.equal(received.length, 1);
  assert.equal(fullscreen.length, 1);
});

test("address-page functions exist only on the local file page", async () => {
  assert.equal(load("https:").exposed.desktopSetup, undefined);
  assert.equal(load("http:").exposed.desktopSetup, undefined);
  const { exposed, calls } = load("file:");
  assert.deepEqual([...Object.keys(exposed.desktopSetup)].sort(), [
    "current",
    "retry",
    "save",
  ]);
  await exposed.desktopSetup.current();
  await exposed.desktopSetup.save("server.example.ts.net");
  await exposed.desktopSetup.retry();
  assert.deepEqual(calls, [
    ["setup:current"],
    ["setup:save", "server.example.ts.net"],
    ["setup:retry"],
  ]);
});
