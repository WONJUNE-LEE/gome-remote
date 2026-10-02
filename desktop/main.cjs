const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  safeStorage,
  dialog,
  Menu,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Vault, gatewayOrigin } = require("./vault.cjs");
const smokeTest = process.argv.includes("--smoke-test");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
let window;
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
let vault;
let revision = 0;
function assertCurrent(expected) {
  if (expected !== revision)
    throw new Error("연결 설정이 변경되었습니다. 다시 연결해주세요.");
}

function handle(name, callback) {
  ipcMain.handle(`remote:${name}`, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error("Untrusted sender.");
    }
    if (!event.senderFrame.url.startsWith("app://gome-remote/"))
      throw new Error("Untrusted origin.");
    return callback(...args);
  });
}

async function request(route, payload, context = vault.value) {
  if (!context.gateway || !context.token)
    throw new Error("먼저 게이트웨이에 연결해주세요.");
  let response;
  try {
    response = await fetch(`${gatewayOrigin(context.gateway)}${route}`, {
      method: payload ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${context.token}`,
        "Content-Type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch {
    throw new Error(
      "서버에 연결할 수 없습니다. Tailscale 연결과 주소를 확인해주세요.",
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "연결 요청이 실패했습니다.");
  return result;
}

app
  .whenReady()
  .then(async () => {
    vault = new Vault(
      path.join(app.getPath("userData"), "vault.enc"),
      safeStorage,
    );
    try {
      await vault.load();
    } catch (error) {
      dialog.showErrorBox("보안 저장소를 열 수 없습니다", error.message);
      app.quit();
      return;
    }
    protocol.handle("app", (request) => {
      const url = new URL(request.url);
      const root = path.resolve(__dirname, "../dist");
      const file = path.resolve(
        root,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
      if (url.host !== "gome-remote" || !file.startsWith(`${root}${path.sep}`))
        return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    handle("settings", async () => {
      const current = revision;
      const context = vault.value;
      const secureStorage = await vault.available();
      assertCurrent(current);
      return {
        gateway: context.gateway,
        configured: !!context.token,
        secureStorage,
        remembered: Object.keys(context.credentials),
        revision: current,
      };
    });
    handle("configure", async (input) => {
      if (
        !input ||
        typeof input.gateway !== "string" ||
        typeof input.token !== "string"
      )
        throw new Error("Invalid settings.");
      const gateway = gatewayOrigin(input.gateway);
      const changed = gateway !== vault.value.gateway;
      const token = input.token || (!changed ? vault.value.token : "");
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
        throw new Error("올바른 접속 키를 입력해주세요.");
      const current = ++revision;
      vault.value = {
        gateway,
        token,
        credentials: changed ? {} : vault.value.credentials,
      };
      await vault.save();
      const secureStorage = await vault.available();
      assertCurrent(current);
      return { gateway, secureStorage };
    });
    handle("targets", async () => {
      const current = revision;
      const result = await request("/api/targets");
      assertCurrent(current);
      return { ...result, revision: current };
    });
    handle("connect", async (input) => {
      if (
        !input ||
        typeof input.targetId !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(input.targetId)
      )
        throw new Error("Invalid target.");
      assertCurrent(input.revision);
      const current = revision;
      const context = vault.value;
      const saved = input.useSaved
        ? context.credentials[input.targetId]
        : undefined;
      const gateway = context.gateway;
      const username = saved?.username ?? input.username;
      const password = saved?.password ?? input.password;
      if (typeof username !== "string" || typeof password !== "string")
        throw new Error("로그인 정보를 입력해주세요.");
      const result = await request(
        "/api/sessions",
        {
          targetId: input.targetId,
          username,
          password,
          width: input.width,
          height: input.height,
        },
        context,
      );
      assertCurrent(current);
      if (input.remember) {
        if (!(await vault.available()))
          throw new Error(
            "OS 보안 저장소를 사용할 수 없어 암호를 저장할 수 없습니다.",
          );
        assertCurrent(current);
        context.credentials[input.targetId] = { username, password };
        await vault.save();
      }
      assertCurrent(current);
      return {
        ...result,
        websocket: gateway.replace(/^http/, "ws") + "/tunnel",
      };
    });
    handle("forget", async (targetId) => {
      if (typeof targetId !== "string") throw new Error("Invalid target.");
      delete vault.value.credentials[targetId];
      await vault.save();
    });
    handle("fullscreen", (enabled) => {
      if (typeof enabled !== "boolean")
        throw new Error("Invalid fullscreen state.");
      requestFullscreen(enabled);
    });
    handle("fullscreen-state", () => window.isFullScreen());
    const resolutions = ["1440x900", "1920x1080", "2560x1440"];
    const command = (id, label) => ({
      id,
      label,
      enabled: false,
      click: () => window.webContents.send("remote:viewer-action", id),
    });
    handle("viewer-state", (state) => {
      if (
        !state ||
        typeof state.open !== "boolean" ||
        typeof state.connected !== "boolean" ||
        ![null, "rdp", "vnc"].includes(state.protocol) ||
        !resolutions.includes(state.resolution)
      )
        throw new Error("Invalid viewer state.");
      const menu = Menu.getApplicationMenu();
      for (const id of ["back", "disconnect"])
        menu.getMenuItemById(id).enabled = state.open;
      menu.getMenuItemById("reconnect").enabled =
        state.open && !state.connected;
      menu.getMenuItemById("text-input").enabled =
        state.open && state.connected;
      menu.getMenuItemById("resolution").enabled =
        state.open && state.connected && state.protocol === "rdp";
      for (const size of resolutions)
        menu.getMenuItemById(`resolution:${size}`).checked =
          size === state.resolution;
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
      backgroundColor: "#101212",
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
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    await window.loadURL("app://gome-remote/");
    if (smokeTest) {
      const state = await window.webContents.executeJavaScript(
        "window.desktop.settings().then(s => ({title: document.title, secureStorage: s.secureStorage, bridge: true}))",
      );
      console.log(JSON.stringify(state));
      app.quit();
    }
  })
  .catch((error) => {
    if (smokeTest) {
      console.error("Desktop smoke test failed:", error.message);
      app.exit(1);
      return;
    }
    dialog.showErrorBox("Gome Remote", error.message);
    app.quit();
  });

app.on("window-all-closed", () => app.quit());
