const { contextBridge, ipcRenderer } = require("electron");

// Contract for pages served by the gateway. It only ever grows: existing functions keep
// their meaning, and a page that needs a newer bridge falls back to browser mode.
// Version 2 adds "auto" as a viewerState resolution and the resolution:auto menu action;
// a version 1 app rejects any resolution but the three fixed sizes, so the page offers
// "auto" only to version 2 or later.
// Version 3 adds the protocol "agent" (the Mac agent) to viewerState; its menu behaves like
// RDP's (the resolution can be changed). A page talking to an older app sends "rdp" instead.
// Version 4 adds readClipboard and writeClipboard. Both are refused (as a result, not a
// throw) unless the window has focus, and the text never reaches a log.
// keyLockSupported and keyLock(on) (still version 4, unreleased) serve the Windows key
// lock: keyLockSupported is true only on Windows; keyLock(true) asks main to put the page
// into in-window HTML full screen, keyLock(false) to leave it, and both answer whether it
// worked. The page takes navigator.keyboard.lock() itself.
// Version 5 adds the updater for the page's settings menu: updateState() answers
// { supported, ready }, checkUpdate() runs the manual check (its answer is a native
// dialog), restartUpdate() installs a downloaded update, and onUpdateReady(callback) is
// called with the version once one is downloaded. On Windows and Linux the window has no
// menu bar and no OS title bar any more: the page's top bar replaces both.
// The main process answers these calls only while the window shows the configured
// gateway origin, so exposing them here grants nothing to any other page.
const bridge = {
  bridgeVersion: 5,
  fullscreen: (enabled) => ipcRenderer.invoke("remote:fullscreen", enabled),
  fullscreenState: () => ipcRenderer.invoke("remote:fullscreen-state"),
  viewerState: (state) => ipcRenderer.invoke("remote:viewer-state", state),
  readClipboard: () => ipcRenderer.invoke("remote:clipboard-read"),
  writeClipboard: (text, opts) =>
    ipcRenderer.invoke("remote:clipboard-write", text, opts),
  keyLockSupported: process.platform === "win32",
  keyLock: (on) => ipcRenderer.invoke("remote:key-lock", on),
  openSetup: () => ipcRenderer.invoke("remote:open-setup"),
  updateState: () => ipcRenderer.invoke("remote:update-state"),
  checkUpdate: () => ipcRenderer.invoke("remote:check-update"),
  restartUpdate: () => ipcRenderer.invoke("remote:restart-update"),
  onUpdateReady: (callback) => {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on("remote:update-ready", listener);
    return () => ipcRenderer.removeListener("remote:update-ready", listener);
  },
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
