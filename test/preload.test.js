import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

test("preload forwards native menu actions without exposing Electron events", async () => {
  const ipc = new EventEmitter();
  const calls = [];
  let desktop;
  ipc.invoke = async (...args) => {
    calls.push(args);
  };
  vm.runInNewContext(
    await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    {
      require: () => ({
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            assert.equal(name, "desktop");
            desktop = api;
          },
        },
      }),
    },
  );
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
  assert.deepEqual(calls, [["remote:viewer-state", state]]);
  remove();
  ipc.emit("remote:viewer-action", privilegedEvent, "disconnect");
  assert.equal(received.length, 1);
});
