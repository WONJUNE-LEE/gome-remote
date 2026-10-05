const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { AddressStore, gatewayOrigin } = require("./address.cjs");
const smokeTest = process.argv.includes("--smoke-test");
let smokeTimer;

// The app is a thin window: it shows the gateway's own web page. The only local page is
// setup.html, where the user types the server address.
const setupPage = pathToFileURL(path.join(__dirname, "setup.html")).href;
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
const pageOf = (url) => String(url).split(/[?#]/)[0];
const ERR_ABORTED = -3;

let window;
let store;
let gateway = ""; // configured gateway origin, "" until the user enters one
let fullscreenTarget = false;
let fullscreenTransition = false;
function applyFullscreenTarget() {
  if (fullscreenTransition || window.isFullScreen() === fullscreenTarget)
    return;
  fullscreenTransition = true;
  window.setFullScreen(fullscreenTarget);
}
function requestFullscreen(enabled) {
  fullscreenTarget = enabled;
  applyFullscreenTarget();
}

// Every IPC call must come from the top frame of this window, and from the page the
// channel is meant for: the gateway origin for bridge calls, the local setup page for
// address changes. Anything else (another origin, a subframe) is refused.
function handle(audience, channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted sender.");
    const url = event.senderFrame.url;
    const allowed =
      audience === "gateway"
        ? !!gateway && originOf(url) === gateway
        : pageOf(url) === setupPage;
    if (!allowed) throw new Error("Untrusted origin.");
    return callback(...args);
  });
}

const resolutions = ["1440x900", "1920x1080", "2560x1440"];
// Enables the Remote menu entries that make sense for what the page shows.
function applyViewerState(state) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of ["back", "disconnect"])
    menu.getMenuItemById(id).enabled = state.open;
  menu.getMenuItemById("reconnect").enabled = state.open && !state.connected;
  menu.getMenuItemById("text-input").enabled = state.open && state.connected;
  menu.getMenuItemById("resolution").enabled =
    state.open && state.connected && state.protocol === "rdp";
  for (const size of resolutions)
    menu.getMenuItemById(`resolution:${size}`).checked =
      size === state.resolution;
}
function showSetup(reason) {
  // The address page has no viewer: close the menu entries and leave fullscreen, or a
  // viewer opened a moment ago would keep them enabled for a page that ignores them.
  applyViewerState({
    open: false,
    connected: false,
    protocol: null,
    resolution: resolutions[0],
  });
  requestFullscreen(false);
  return window
    .loadURL(reason ? `${setupPage}?reason=${reason}` : setupPage)
    .catch(() => {});
}
function openGateway() {
  return window.loadURL(gateway).catch(() => {});
}
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      Promise.resolve(shell.openExternal(parsed.href)).catch(() => {});
  } catch {
    // not a URL; ignore
  }
}

app
  .whenReady()
  .then(async () => {
    // The smoke test must end by itself, with 0 or 1, whatever the page does.
    if (smokeTest)
      smokeTimer = setTimeout(() => {
        console.error("Desktop smoke test timed out.");
        app.exit(1);
      }, 60_000);
    const userData = app.getPath("userData");
    // Versions before 0.2 kept the gateway token and desktop passwords here. The new
    // design never reads them, so remove the only remaining copy.
    // Only these two fixed names are touched; rm without `recursive` unlinks a symlink
    // and never follows it. A failure (a directory of that name, EPERM, a lock) is
    // logged and ignored so it cannot keep the app from starting.
    await Promise.all(
      ["vault.enc", "vault.enc.tmp"].map((name) =>
        fs.rm(path.join(userData, name), { force: true }).catch((error) => {
          console.error(
            `Could not remove old ${name}: ${error.code || "error"}`,
          );
        }),
      ),
    );
    store = new AddressStore(path.join(userData, "gateway.json"));
    gateway = await store.load();

    handle("setup", "setup:current", () => gateway);
    handle("setup", "setup:save", async (address) => {
      const saved = await store.save(gatewayOrigin(address));
      gateway = saved;
      void openGateway();
      return { gateway: saved };
    });
    handle("setup", "setup:retry", () => {
      if (!gateway) throw new Error("서버 주소를 먼저 입력해주세요.");
      void openGateway();
    });
    handle("gateway", "remote:open-setup", () => {
      void showSetup();
    });
    handle("gateway", "remote:fullscreen", (enabled) => {
      if (typeof enabled !== "boolean")
        throw new Error("Invalid fullscreen state.");
      requestFullscreen(enabled);
    });
    handle("gateway", "remote:fullscreen-state", () => window.isFullScreen());
    const command = (id, label) => ({
      id,
      label,
      enabled: false,
      click: () => window.webContents.send("remote:viewer-action", id),
    });
    handle("gateway", "remote:viewer-state", (state) => {
      if (
        !state ||
        typeof state.open !== "boolean" ||
        typeof state.connected !== "boolean" ||
        ![null, "rdp", "vnc"].includes(state.protocol) ||
        !resolutions.includes(state.resolution)
      )
        throw new Error("Invalid viewer state.");
      applyViewerState(state);
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        {
          label: "View",
          submenu: [
            {
              label: "전체 화면",
              accelerator: "F11",
              click: () =>
                requestFullscreen(
                  fullscreenTransition
                    ? !fullscreenTarget
                    : !window.isFullScreen(),
                ),
            },
            { role: "resetZoom" },
          ],
        },
        {
          label: "원격",
          submenu: [
            command("back", "서버 목록"),
            { type: "separator" },
            {
              id: "resolution",
              label: "해상도",
              enabled: false,
              submenu: resolutions.map((size) => ({
                id: `resolution:${size}`,
                label: size.replace("x", " × "),
                type: "radio",
                checked: size === resolutions[0],
                click: () =>
                  window.webContents.send(
                    "remote:viewer-action",
                    `resolution:${size}`,
                  ),
              })),
            },
            command("text-input", "텍스트 입력"),
            command("reconnect", "다시 연결"),
            command("disconnect", "연결 종료"),
            { type: "separator" },
            {
              id: "change-server",
              label: "서버 주소 바꾸기",
              click: () => void showSetup(),
            },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    window = new BrowserWindow({
      show: !smokeTest,
      width: 1420,
      height: 940,
      minWidth: 900,
      minHeight: 620,
      title: "Gome Remote",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#22201e" : "#f6f3ee",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    const publishFullscreen = () => {
      const requested = fullscreenTransition;
      fullscreenTransition = false;
      if (!requested) fullscreenTarget = window.isFullScreen();
      window.webContents.send("remote:fullscreen-state", window.isFullScreen());
      // Serialize OS transitions so a pending entry cannot swallow an exit request.
      applyFullscreenTarget();
    };
    window.on("enter-full-screen", publishFullscreen);
    window.on("leave-full-screen", publishFullscreen);
    window.webContents.on("before-input-event", (event, input) => {
      if (input.key !== "F11") return;
      // Intercept both edges before Guacamole or a menu accelerator can receive F11.
      event.preventDefault();
      if (input.type === "keyDown" && !input.isAutoRepeat)
        requestFullscreen(
          fullscreenTransition ? !fullscreenTarget : !window.isFullScreen(),
        );
    });
    // The window may only ever show the gateway origin (and the local address page,
    // which the main process loads itself). Links elsewhere go to the OS browser when they are http(s) and are dropped otherwise.
    const stay = (event, url) => {
      if (originOf(url) === gateway) return;
      event.preventDefault();
      openExternal(url);
    };
    window.webContents.on("will-navigate", stay);
    window.webContents.on("will-redirect", stay);
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    // A gateway that is down shows as a failed load, or as an error status from
    // Tailscale Serve. Either way the user lands on a page where the address can change.
    window.webContents.on(
      "did-fail-load",
      (_event, code, _description, url, isMainFrame) => {
        if (isMainFrame && code !== ERR_ABORTED && originOf(url) === gateway)
          void showSetup("unreachable");
      },
    );
    window.webContents.on("did-navigate", (_event, url, status) => {
      if (originOf(url) === gateway && status >= 400)
        void showSetup("unreachable");
    });
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    if (smokeTest || !gateway) await showSetup();
    else void openGateway();
    if (smokeTest) {
      // Run with a throwaway --user-data-dir: with no saved address it only shows the
      // local address page, so there is no network and no real settings are touched.
      const state = await window.webContents.executeJavaScript(
        "({page: location.href.split(/[?#]/)[0], title: document.title, bridgeVersion: window.desktop.bridgeVersion, setup: typeof window.desktopSetup.save})",
      );
      console.log(JSON.stringify(state));
      if (
        state.page !== setupPage ||
        state.title !== "Gome Remote" ||
        state.bridgeVersion !== 1 ||
        state.setup !== "function"
      )
        throw new Error("The address page or the bridge is not as expected.");
      clearTimeout(smokeTimer);
      app.quit();
    }
  })
  .catch((error) => {
    clearTimeout(smokeTimer);
    if (smokeTest) {
      console.error("Desktop smoke test failed:", error.message);
      app.exit(1);
      return;
    }
    dialog.showErrorBox("Gome Remote", error.message);
    app.quit();
  });

app.on("window-all-closed", () => app.quit());
