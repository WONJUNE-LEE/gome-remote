const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    settings: () => ipcRenderer.invoke("remote:settings"),
    configure: (input) => ipcRenderer.invoke("remote:configure", input),
    targets: () => ipcRenderer.invoke("remote:targets"),
    connect: (input) => ipcRenderer.invoke("remote:connect", input),
    forget: (targetId) => ipcRenderer.invoke("remote:forget", targetId),
    fullscreen: (enabled) => ipcRenderer.invoke("remote:fullscreen", enabled),
    fullscreenState: () => ipcRenderer.invoke("remote:fullscreen-state"),
    onFullscreenChange: (callback) => {
      const listener = (_event, enabled) => callback(enabled);
      ipcRenderer.on("remote:fullscreen-state", listener);
      return () =>
        ipcRenderer.removeListener("remote:fullscreen-state", listener);
    },
  }),
);
