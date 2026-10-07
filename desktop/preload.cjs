const { contextBridge, ipcRenderer } = require("electron");

// Contract for pages served by the gateway. It only ever grows: existing functions keep
// their meaning, and a page that needs a newer bridge falls back to browser mode.
// Version 2 adds "auto" as a viewerState resolution and the resolution:auto menu action;
// a version 1 app rejects any resolution but the three fixed sizes, so the page offers
// "auto" only to version 2 or later.
// The main process answers these calls only while the window shows the configured
// gateway origin, so exposing them here grants nothing to any other page.
const bridge = {
  bridgeVersion: 2,
  fullscreen: (enabled) => ipcRenderer.invoke("remote:fullscreen", enabled),
  fullscreenState: () => ipcRenderer.invoke("remote:fullscreen-state"),
  viewerState: (state) => ipcRenderer.invoke("remote:viewer-state", state),
  openSetup: () => ipcRenderer.invoke("remote:open-setup"),
  onViewerAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("remote:viewer-action", listener);
    return () => ipcRenderer.removeListener("remote:viewer-action", listener);
  },
  onFullscreenChange: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on("remote:fullscreen-state", listener);
    return () =>
      ipcRenderer.removeListener("remote:fullscreen-state", listener);
  },
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));

// The local address page is the only file: page the app ever shows. The main process
// also checks the sender, so a gateway page gains nothing even if this object leaked.
if (location.protocol === "file:")
  contextBridge.exposeInMainWorld(
    "desktopSetup",
    Object.freeze({
      current: () => ipcRenderer.invoke("setup:current"),
      save: (address) => ipcRenderer.invoke("setup:save", address),
      retry: () => ipcRenderer.invoke("setup:retry"),
    }),
  );
