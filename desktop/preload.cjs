const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    settings: () => ipcRenderer.invoke("remote:settings"),
    configure: (input) => ipcRenderer.invoke("remote:configure", input),
    targets: () => ipcRenderer.invoke("remote:targets"),
    connect: (input) => ipcRenderer.invoke("remote:connect", input),
    forget: (targetId) => ipcRenderer.invoke("remote:forget", targetId),
    fullscreen: () => ipcRenderer.invoke("remote:fullscreen"),
  }),
);
