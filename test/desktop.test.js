import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../desktop/main.cjs", import.meta.url),
  "utf8",
);
const desktopDir = fileURLToPath(new URL("../desktop/", import.meta.url));
const GATEWAY = "https://gateway.tail123.ts.net:8450";
const SETUP = pathToFileURL(join(desktopDir, "setup.html")).href;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

// Runs desktop/main.cjs against a stand-in for Electron. `loadURL` updates the main
// frame's URL the way a real navigation would, so IPC origin checks see what they would
// see in the app.
async function desktop(
  {
    stored = GATEWAY,
    files = {},
    dirs = [],
    links = {},
    logs = [],
    platform = "win32",
  } = {},
  t,
) {
  const userData = await mkdtemp(join(tmpdir(), "gr-desk-"));
  t?.after(() => rm(userData, { recursive: true, force: true }));
  if (stored)
    await writeFile(
      join(userData, "gateway.json"),
      JSON.stringify({ gateway: stored }),
    );
  for (const [name, content] of Object.entries(files))
    await writeFile(join(userData, name), content);
  for (const name of dirs)
    await mkdir(join(userData, name, "inner"), { recursive: true });
  for (const [name, target] of Object.entries(links))
    await symlink(target, join(userData, name));
  const ready = deferred();
  const handlers = new Map();
  const loads = [];
  const external = [];
  const fullscreenRequests = [];
  const notifications = [];
  let fullscreen = false;
  let window;
  let menu;
  let openHandler;
  let windowOptions;
  const permissions = {};
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      windowOptions = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "about:blank" },
        send: (...args) => notifications.push(args),
        setWindowOpenHandler(handler) {
          openHandler = handler;
        },
        session: {
          setPermissionRequestHandler(handler) {
            permissions.request = handler;
          },
          setPermissionCheckHandler(handler) {
            permissions.check = handler;
          },
        },
      });
    }
    isFullScreen() {
      return fullscreen;
    }
    setFullScreen(value) {
      fullscreenRequests.push(value);
    }
    async loadURL(url) {
      loads.push(url);
      this.webContents.mainFrame.url = url;
      ready.resolve();
    }
  }
  const electron = {
    app: {
      whenReady: async () => {},
      getPath: () => userData,
      on() {},
      quit() {},
      exit() {},
    },
    BrowserWindow,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: async (url) => external.push(url) },
    dialog: {
      showErrorBox: (_title, message) =>
        ready.resolve(Promise.reject(new Error(message))),
    },
    Menu: {
      buildFromTemplate: (template) => {
        const items = new Map();
        function collect(entries) {
          for (const item of entries) {
            if (item.id) items.set(item.id, item);
            if (item.submenu) collect(item.submenu);
          }
        }
        collect(template);
        return { items, template, getMenuItemById: (id) => items.get(id) };
      },
      setApplicationMenu(value) {
        menu = value;
      },
      getApplicationMenu() {
        return menu;
      },
    },
  };
  vm.runInNewContext(source, {
    require: (name) =>
      name === "electron"
        ? electron
        : name.startsWith("./")
          ? require(join(desktopDir, name))
          : require(name),
    __dirname: desktopDir,
    URL,
    console: { ...console, error: (...args) => logs.push(args.join(" ")) },
    Promise,
    process: { argv: [], platform },
  });
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const frame = () => window.webContents.mainFrame;
  const call = (channel, input, event) =>
    handlers.get(channel)(
      event || { sender: window.webContents, senderFrame: frame() },
      input,
    );
  return {
    userData,
    loads,
    external,
    handlers,
    permissions,
    get window() {
      return window;
    },
    get windowOptions() {
      return windowOptions;
    },
    get openHandler() {
      return openHandler;
    },
    call,
    invoke: (name, input, event) => call(`remote:${name}`, input, event),
    // Pretend the window now shows `url` (without a main-process load).
    show(url) {
      frame().url = url;
    },
    menu,
    fullscreenRequests,
    notifications,
    finishFullscreen(value) {
      fullscreen = value;
      window.emit(value ? "enter-full-screen" : "leave-full-screen");
    },
    input(input) {
      let prevented = false;
      window.webContents.emit(
        "before-input-event",
        {
          preventDefault() {
            prevented = true;
          },
        },
        input,
      );
      return prevented;
    },
    navigate(url, event = "will-navigate") {
      let prevented = false;
      window.webContents.emit(
        event,
        {
          preventDefault() {
            prevented = true;
          },
        },
        url,
      );
      return prevented;
    },
  };
}

test("first run shows only the address page; a saved address opens the gateway", async (t) => {
  const first = await desktop({ stored: "" }, t);
  assert.deepEqual(first.loads, [SETUP]);
  const later = await desktop({}, t);
  assert.deepEqual(later.loads, [`${GATEWAY}`]);
  const damaged = await desktop(
    { stored: "", files: { "gateway.json": "{" } },
    t,
  );
  assert.deepEqual(damaged.loads, [SETUP]);
});

test("a vault left by an older version is deleted at startup and nothing else is touched", async (t) => {
  const f = await desktop(
    {
      files: {
        "vault.enc": "old encrypted token and passwords",
        "vault.enc.tmp": "partial write",
        Preferences: "{}",
      },
    },
    t,
  );
  assert.equal(await exists(join(f.userData, "vault.enc")), false);
  assert.equal(await exists(join(f.userData, "vault.enc.tmp")), false);
  assert.equal(await exists(join(f.userData, "Preferences")), true);
  assert.equal(await exists(join(f.userData, "gateway.json")), true);
});

test("a legacy vault that cannot be deleted is logged and ignored; startup carries on", async (t) => {
  const logs = [];
  const f = await desktop(
    { dirs: ["vault.enc"], files: { "vault.enc.tmp": "partial write" }, logs },
    t,
  );
  assert.deepEqual(f.loads, [`${GATEWAY}`], "the gateway still opens");
  assert.equal(await exists(join(f.userData, "vault.enc")), true);
  assert.equal(await exists(join(f.userData, "vault.enc.tmp")), false);
  assert.equal(logs.length, 1, "the failure is logged once");
  assert.match(logs[0], /vault\.enc/);
});

test("a symlinked legacy vault is unlinked without touching what it points to", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "gr-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "keep.txt"), "keep");
  const f = await desktop(
    { links: { "vault.enc": outside, "vault.enc.tmp": outside } },
    t,
  );
  assert.equal(await exists(join(f.userData, "vault.enc")), false);
  assert.equal(await exists(join(outside, "keep.txt")), true);
});

test("the window is sandboxed, isolated and has no Node integration", async (t) => {
  const f = await desktop({}, t);
  const prefs = f.windowOptions.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.match(prefs.preload, /preload\.cjs$/);
  assert.equal(await f.permissions.check(), false);
  await new Promise((resolve) =>
    f.permissions.request({}, "media", (granted) => {
      assert.equal(granted, false);
      resolve();
    }),
  );
});

test("bridge calls work only from the gateway origin in the window's top frame", async (t) => {
  const f = await desktop({}, t);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.fullscreenRequests, [true]);
  for (const url of [
    "https://evil.example/",
    "https://gateway.tail123.ts.net:8451/",
    "https://gateway.tail123.ts.net/",
    "http://gateway.tail123.ts.net:8450/",
    "https://gateway.tail123.ts.net.evil.example:8450/",
    "app://gome-remote/",
    SETUP,
    "about:blank",
    "",
  ]) {
    f.show(url);
    for (const [name, input] of [
      ["fullscreen", false],
      ["fullscreen-state"],
      [
        "viewer-state",
        {
          open: false,
          connected: false,
          protocol: null,
          resolution: "1440x900",
        },
      ],
      ["open-setup"],
    ])
      await assert.rejects(
        f.invoke(name, input),
        /Untrusted origin/,
        `${name} from ${url}`,
      );
  }
  assert.deepEqual(
    f.fullscreenRequests,
    [true],
    "refused calls change nothing",
  );
  const loadsBefore = f.loads.length;
  f.show(`${GATEWAY}/`);
  const subframe = { url: `${GATEWAY}/` };
  await assert.rejects(
    f.invoke("fullscreen", false, {
      sender: f.window.webContents,
      senderFrame: subframe,
    }),
    /Untrusted sender/,
  );
  await assert.rejects(
    f.invoke("fullscreen", false, {
      sender: {},
      senderFrame: f.window.webContents.mainFrame,
    }),
    /Untrusted sender/,
  );
  assert.equal(f.loads.length, loadsBefore);
  await f.invoke("open-setup");
  assert.deepEqual(f.loads.at(-1), SETUP);
});

test("without a configured address no bridge call is accepted from any page", async (t) => {
  const f = await desktop({ stored: "" }, t);
  f.show("https://gateway.tail123.ts.net:8450/");
  await assert.rejects(f.invoke("fullscreen", true), /Untrusted origin/);
  f.show("");
  await assert.rejects(f.invoke("fullscreen", true), /Untrusted origin/);
});

test("the address page may save a validated address and nothing else may", async (t) => {
  const f = await desktop({ stored: "" }, t);
  assert.equal(await f.call("setup:current"), "");
  await assert.rejects(f.call("setup:retry"), /서버 주소를 먼저/);
  for (const bad of [
    "https://evil.example",
    "http://gateway.tail123.ts.net",
    "javascript:alert(1)",
    "",
    42,
  ])
    await assert.rejects(f.call("setup:save", bad), Error, String(bad));
  assert.deepEqual(f.loads, [SETUP], "an invalid address loads nothing");
  assert.equal(
    (await f.call("setup:save", "gateway.tail123.ts.net:8450")).gateway,
    GATEWAY,
  );
  assert.equal(f.loads.at(-1), GATEWAY);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.userData, "gateway.json"), "utf8")),
    {
      gateway: GATEWAY,
    },
  );
  f.show(SETUP);
  assert.equal(await f.call("setup:current"), GATEWAY);
  // The same channels are closed to the gateway page and to other origins.
  for (const url of [GATEWAY + "/", "https://evil.example/"]) {
    f.show(url);
    for (const channel of ["setup:current", "setup:save", "setup:retry"])
      await assert.rejects(f.call(channel, GATEWAY), /Untrusted origin/);
  }
  f.show(`${SETUP}?reason=unreachable`);
  await f.call("setup:retry");
  assert.equal(f.loads.at(-1), GATEWAY);
});

test("navigation away from the gateway is blocked; http(s) targets open in the OS browser and other schemes are dropped", async (t) => {
  const f = await desktop({}, t);
  // will-navigate / will-redirect to another http(s) URL: prevented and handed to the OS browser.
  assert.equal(f.navigate("https://evil.example/"), true);
  assert.equal(f.navigate("http://evil.example/x", "will-redirect"), true);
  assert.equal(
    f.navigate("https://gateway.tail123.ts.net:8451/"),
    true,
    "another port is another origin",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.external, [
    "https://evil.example/",
    "http://evil.example/x",
    "https://gateway.tail123.ts.net:8451/",
  ]);
  // Any other scheme: prevented and dropped, never opened anywhere.
  for (const url of [
    SETUP,
    "file:///etc/passwd",
    "javascript:alert(1)",
    "app://x",
    "ftp://example.org/",
    "not a url",
  ]) {
    assert.equal(f.navigate(url), true, url);
    assert.equal(f.navigate(url, "will-redirect"), true, url);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.external.length, 3, "nothing but http(s) reaches the OS");
  // The gateway origin itself keeps navigating inside the window.
  assert.equal(f.navigate(`${GATEWAY}/other`), false);
  assert.equal(f.navigate(`${GATEWAY}/other`, "will-redirect"), false);
  assert.equal(f.external.length, 3);
  // window.open: http(s) goes to the OS browser, everything else is dropped; always denied in-app.
  f.external.length = 0;
  assert.equal(
    f.openHandler({ url: "https://example.org/docs" }).action,
    "deny",
  );
  assert.equal(f.openHandler({ url: `${GATEWAY}/x` }).action, "deny");
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "app://x",
    "not a url",
  ])
    assert.equal(f.openHandler({ url }).action, "deny");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.external, ["https://example.org/docs", `${GATEWAY}/x`]);
});

test("a gateway that cannot be reached lands on a page where the address can be changed", async (t) => {
  const f = await desktop({}, t);
  const fail = (code, url = `${GATEWAY}/`, main = true) =>
    f.window.webContents.emit("did-fail-load", {}, code, "ERR", url, main);
  fail(-3); // superseded navigation (ERR_ABORTED)
  fail(-102, `${GATEWAY}/`, false); // a subframe
  fail(-102, "https://evil.example/");
  assert.deepEqual(f.loads, [GATEWAY]);
  fail(-102); // ERR_CONNECTION_REFUSED
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), `${SETUP}?reason=unreachable`);
  // The address page works on that error page, and a bad status from Serve gets there too.
  assert.equal(await f.call("setup:current"), GATEWAY);
  const before = f.loads.length;
  f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 200);
  assert.equal(f.loads.length, before);
  f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), `${SETUP}?reason=unreachable`);
  f.window.webContents.emit("did-navigate", {}, "https://evil.example/", 502);
  assert.equal(f.loads.length, before + 1);
});

test("the Remote menu offers 서버 주소 바꾸기 at all times", async (t) => {
  const f = await desktop({}, t);
  const item = f.menu.getMenuItemById("change-server");
  assert.equal(item.label, "서버 주소 바꾸기");
  assert.notEqual(item.enabled, false);
  item.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), SETUP);
  // Still there, and still working, while the gateway is unreachable.
  f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), `${SETUP}?reason=unreachable`);
  assert.notEqual(f.menu.getMenuItemById("change-server").enabled, false);
  f.menu.getMenuItemById("change-server").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), SETUP);
});

test("F11 is intercepted before the remote keyboard and both exit controls use native fullscreen state", async (t) => {
  const f = await desktop({}, t);
  assert.equal(await f.invoke("fullscreen-state"), false);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.fullscreenRequests, [true]);
  assert.equal(
    await f.invoke("fullscreen-state"),
    false,
    "OS transition is asynchronous",
  );
  f.finishFullscreen(true);
  assert.equal(await f.invoke("fullscreen-state"), true);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", true]);
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
    true,
  );
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: true }),
    true,
  );
  assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  assert.equal(
    f.fullscreenRequests.length,
    2,
    "repeat and keyup must not toggle again",
  );
  f.finishFullscreen(false);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
  assert.equal(
    f.input({ key: "Escape", type: "keyDown" }),
    false,
    "remote Escape remains available",
  );
  assert.equal(f.input({ key: "a", type: "keyDown" }), false);
  // F11 must also enter from windowed mode, with exactly one request.
  const beforeEntry = f.fullscreenRequests.length;
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
    true,
  );
  assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  assert.deepEqual(f.fullscreenRequests.slice(beforeEntry), [true]);
  f.finishFullscreen(true);
  const beforeExit = f.fullscreenRequests.length;
  await f.invoke("fullscreen", false);
  assert.deepEqual(f.fullscreenRequests.slice(beforeExit), [false]);
  f.finishFullscreen(false);
  await f.invoke("fullscreen", false);
  assert.equal(
    f.fullscreenRequests.length,
    beforeExit + 1,
    "exit while windowed never enters fullscreen",
  );
  await assert.rejects(
    f.invoke("fullscreen", "false"),
    /Invalid fullscreen state/,
  );
});

test("windowed intent during a native entry is applied after that entry completes", async (t) => {
  const f = await desktop({}, t);
  await f.invoke("fullscreen", true);
  await f.invoke("fullscreen", false);
  assert.deepEqual(
    f.fullscreenRequests,
    [true],
    "serialize transitions instead of losing the exit",
  );
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
  // OS/menu transitions remain authoritative when no app request is pending.
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  assert.equal(await f.invoke("fullscreen-state"), true);
});

test("a second F11 during entry queues exit instead of repeating entry", async (t) => {
  const f = await desktop({}, t);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
      true,
    );
    assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  }
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
});

test("native remote menu enables valid commands and forwards exact actions", async (t) => {
  const f = await desktop({}, t);
  const item = (id) => f.menu.getMenuItemById(id);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution",
  ])
    assert.equal(item(id).enabled, false, `home: ${id}`);
  await f.invoke("viewer-state", {
    open: true,
    connected: false,
    protocol: "rdp",
    resolution: "1440x900",
  });
  assert.equal(item("back").enabled, true);
  assert.equal(item("disconnect").enabled, true);
  assert.equal(item("reconnect").enabled, true);
  assert.equal(item("text-input").enabled, false);
  assert.equal(item("resolution").enabled, false);
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "1920x1080",
  });
  assert.equal(item("reconnect").enabled, false);
  assert.equal(item("text-input").enabled, true);
  assert.equal(item("resolution").enabled, true);
  assert.equal(item("resolution:1920x1080").checked, true);
  assert.equal(item("resolution:1440x900").checked, false);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution:2560x1440",
  ]) {
    const before = f.notifications.length;
    item(id).click();
    assert.deepEqual(f.notifications.slice(before), [
      ["remote:viewer-action", id],
    ]);
  }
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "vnc",
    resolution: "1920x1080",
  });
  assert.equal(item("resolution").enabled, false);
  assert.equal(item("text-input").enabled, true);
  await f.invoke("viewer-state", {
    open: false,
    connected: false,
    protocol: null,
    resolution: "1920x1080",
  });
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution",
  ])
    assert.equal(item(id).enabled, false, `returned home: ${id}`);
  await assert.rejects(
    f.invoke("viewer-state", { open: true }),
    /Invalid viewer state/,
  );
  const view = f.menu.template.find((item) => item.label === "View");
  view.submenu[0].click();
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  view.submenu[0].click();
  assert.deepEqual(f.fullscreenRequests, [true, false]);
});

test("native fullscreen menu preserves a second click during entry", async (t) => {
  const f = await desktop({}, t);
  const fullscreen = f.menu.template.find((item) => item.label === "View")
    .submenu[0];
  fullscreen.click();
  fullscreen.click();
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
});
