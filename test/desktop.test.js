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

// What the app uses of electron-updater: settings, events, a check that answers with
// `result` (or rejects with `failure`), and the restart.
function fakeAutoUpdater() {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    restarts: 0,
    result: { isUpdateAvailable: false, updateInfo: { version: "0.3.0" } },
    failure: null,
    async checkForUpdates() {
      updater.checks += 1;
      if (updater.failure) throw updater.failure;
      return updater.result;
    },
    quitAndInstall() {
      updater.restarts += 1;
    },
  });
  return updater;
}

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
    argv = [],
    page, // what executeJavaScript answers in the smoke test; "hang" never answers
    html = "granted", // how the page answers full screen scripts: "granted", "refused", "dead", "hang" or "no-element"
    packaged = false,
    version = "0.3.0",
    updater, // the stand-in electron-updater autoUpdater; one is made when packaged
    updaterModule, // replaces require("electron-updater") entirely (it may throw)
    clipboardText = "", // what the stand-in clipboard's readText answers
    clipboardFormats = {}, // raw formats on the stand-in clipboard: type -> Blob
    clipboardFail = {}, // { readText, write, writeText }: make that call reject
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
  const lifecycle = [];
  const scripts = [];
  const scriptCalls = [];
  const nativeRequests = [];
  const timers = new Map();
  const intervals = new Map();
  const dialogs = [];
  let fullscreen = false;
  let htmlMode = html;
  const lateAnswers = [];
  let window;
  let menu;
  let openHandler;
  let windowOptions;
  const permissions = {};
  let focused = false;
  const clipboardWrites = [];
  // The parts of Electron's async clipboard the app uses. A write is recorded as what a
  // reader would see: its types, the plain text and the size of every other format.
  class ClipboardItem {
    constructor(items) {
      this.items = items;
      this.types = Object.keys(items);
    }
    async getType(type) {
      if (!(type in this.items)) throw new Error(`no ${type}`);
      const value = this.items[type];
      return typeof value === "string" ? new Blob([value]) : value;
    }
  }
  const clipboard = {
    readText: async () => {
      if (clipboardFail.readText) throw new Error("readText failed");
      return clipboardText;
    },
    has: async (type) => type in clipboardFormats,
    read: async () => [new ClipboardItem(clipboardFormats)],
    writeText: async (text) => {
      if (clipboardFail.writeText) throw new Error("writeText failed");
      clipboardWrites.push({ text });
    },
    write: async (items) => {
      if (clipboardFail.write) throw new Error("write failed");
      for (const item of items) {
        const extra = {};
        for (const type of item.types)
          if (type !== "text/plain")
            extra[type] = (await item.getType(type)).size;
        clipboardWrites.push({
          text: item.items["text/plain"],
          types: item.types,
          extra,
        });
      }
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      windowOptions = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "about:blank" },
        send: (...args) => notifications.push(args),
        executeJavaScript: async (script, userGesture) => {
          scriptCalls.push([script, userGesture]);
          // Full screen scripts are answered by the stand-in page and recorded as the
          // boolean they ask for, so they read like setFullScreen in the assertions.
          const enter = /requestFullscreen/.test(script);
          if (enter || /exitFullscreen/.test(script)) {
            fullscreenRequests.push(enter);
            if (htmlMode === "hang") return new Promise(() => {});
            if (htmlMode === "late")
              return new Promise((resolve) => lateAnswers.push(resolve));
            if (htmlMode === "dead") throw new Error("page is gone");
            // (Real Electron 44 never settles a denied requestFullscreen; "hang" is
            // the realistic refusal, "refused" is the rejecting variant.)
            if (enter && htmlMode === "refused")
              throw new TypeError("Permissions check failed");
            // The exit script answers what it did: false when nothing was full screen.
            if (!enter && htmlMode === "no-element") return false;
            return enter ? undefined : true;
          }
          scripts.push(script);
          if (page === "hang") return new Promise(() => {});
          if (page instanceof Error) throw page;
          return page;
        },
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
    isFocused() {
      return focused;
    }
    isDestroyed() {
      return this.destroyed === true;
    }
    setFullScreen(value) {
      nativeRequests.push(value);
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
      isPackaged: packaged,
      getVersion: () => version,
      on() {},
      quit: () => lifecycle.push(["quit"]),
      exit: (code) => lifecycle.push(["exit", code]),
    },
    BrowserWindow,
    clipboard,
    ClipboardItem,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: async (url) => external.push(url) },
    dialog: {
      showMessageBox: async (...args) => {
        // `parent` is the window the dialog was attached to, or null for a free dialog.
        dialogs.push({
          ...(args.length === 2 ? args[1] : args[0]),
          parent: args.length === 2 ? args[0] : null,
        });
        return { response: 0 };
      },
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
  const autoUpdater = updater ?? fakeAutoUpdater();
  vm.runInNewContext(source, {
    require: (name) =>
      name === "electron"
        ? electron
        : name === "electron-updater"
          ? updaterModule
            ? updaterModule()
            : { autoUpdater }
          : name.startsWith("./")
            ? require(join(desktopDir, name))
            : require(name),
    __dirname: desktopDir,
    URL,
    console: { ...console, error: (...args) => logs.push(args.join(" ")) },
    Promise,
    process: { argv, platform },
    // Timers are recorded, never run, so the test decides when the guard fires.
    setTimeout: (callback, ms) => {
      const id = timers.size + 1;
      timers.set(id, { callback, ms, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      if (timers.has(id)) timers.get(id).cleared = true;
    },
    setInterval: (callback, ms) => {
      const id = intervals.size + 1;
      intervals.set(id, { callback, ms });
      return id;
    },
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
    lifecycle,
    scripts,
    scriptCalls,
    nativeRequests,
    // Answers every script a "late" page was holding back.
    answerLate(value) {
      for (const resolve of lateAnswers.splice(0)) resolve(value);
    },
    setHtml(mode) {
      htmlMode = mode;
    },
    timers,
    intervals,
    dialogs,
    autoUpdater,
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
    // clipboard-write takes two arguments, which `invoke` cannot pass.
    writeClipboard: (text, opts) =>
      handlers.get("remote:clipboard-write")(
        { sender: window.webContents, senderFrame: frame() },
        text,
        opts,
      ),
    // Pretend the window now shows `url` (without a main-process load).
    show(url) {
      frame().url = url;
    },
    get menu() {
      return menu;
    },
    fullscreenRequests,
    notifications,
    clipboardWrites,
    setFocused(value) {
      focused = value;
    },
    // With `html`, the page's own full screen state changes around the native event in
    // the order Electron emits them: enter-full-screen before enter-html-full-screen on
    // the way in, leave-html-full-screen before leave-full-screen on the way out.
    finishFullscreen(value, { html: inHtml = false } = {}) {
      fullscreen = value;
      if (inHtml && !value) window.webContents.emit("leave-html-full-screen");
      window.emit(value ? "enter-full-screen" : "leave-full-screen");
      if (inHtml && value) window.webContents.emit("enter-html-full-screen");
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
      ["clipboard-read"],
      ["clipboard-write", "x"],
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

test("clipboard channels answer only while the window is focused, from the gateway origin in the top frame", async (t) => {
  const f = await desktop({ clipboardText: "복사" }, t);
  f.setFocused(true);
  assert.deepEqual(await f.invoke("clipboard-read"), {
    ok: true,
    text: "복사",
    concealed: false,
  });
  f.setFocused(false);
  assert.deepEqual(await f.invoke("clipboard-read"), {
    ok: false,
    reason: "unfocused",
  });
  assert.deepEqual(await f.writeClipboard("x"), {
    ok: false,
    reason: "unfocused",
  });
  assert.deepEqual(f.clipboardWrites, []);
  f.setFocused(true);
  for (const url of ["https://evil.example/", SETUP, "about:blank"]) {
    f.show(url);
    for (const name of ["clipboard-read", "clipboard-write"])
      await assert.rejects(f.invoke(name, "x"), /Untrusted origin/);
  }
  f.show(`${GATEWAY}/`);
  const subframe = { url: `${GATEWAY}/` };
  for (const name of ["clipboard-read", "clipboard-write"]) {
    await assert.rejects(
      f.invoke(name, "x", {
        sender: f.window.webContents,
        senderFrame: subframe,
      }),
      /Untrusted sender/,
    );
    await assert.rejects(
      f.invoke(name, "x", {
        sender: {},
        senderFrame: f.window.webContents.mainFrame,
      }),
      /Untrusted sender/,
    );
  }
  assert.deepEqual(f.clipboardWrites, []);
  f.window.destroyed = true;
  assert.deepEqual(await f.invoke("clipboard-read"), {
    ok: false,
    reason: "unfocused",
  });
});

test("write validates its arguments, caps at 64 KiB of UTF-8 and never logs the text", async (t) => {
  const logs = [];
  const f = await desktop({ logs }, t);
  f.setFocused(true);
  for (const [text, opts] of [
    [undefined],
    [null],
    [5],
    [["a"]],
    [{ toString: () => "a" }],
    ["a", null],
    ["a", "yes"],
    ["a", []],
    ["a", { concealed: "yes" }],
    ["a", { concealed: 1 }],
    ["a", { concealed: true, extra: 1 }],
    ["a", Object.create({ concealed: true })],
  ])
    await assert.rejects(
      f.writeClipboard(text, opts),
      /Invalid clipboard text\./,
      JSON.stringify([text, opts]),
    );
  assert.deepEqual(f.clipboardWrites, []);
  // 21 845 Korean characters are 65 535 bytes; one more is 65 538.
  assert.deepEqual(await f.writeClipboard("가".repeat(21845)), {
    ok: true,
    concealed: false,
  });
  assert.equal(f.clipboardWrites.length, 1);
  assert.deepEqual(await f.writeClipboard("가".repeat(21846)), {
    ok: false,
    reason: "too-large",
  });
  assert.equal(f.clipboardWrites.length, 1, "the clipboard is untouched");
  assert.deepEqual(
    await f.writeClipboard("a".repeat(65536), { concealed: false }),
    { ok: true, concealed: false },
  );
  assert.deepEqual(await f.writeClipboard("a".repeat(65537)), {
    ok: false,
    reason: "too-large",
  });
  assert.ok(logs.some((line) => /too-large/.test(line) && /bytes/.test(line)));
  assert.ok(logs.every((line) => !/[가a]{3}/.test(line)));
});

test("on win32 LF is written as CRLF and a concealed write adds the exclusion format; elsewhere nothing is added", async (t) => {
  const mark =
    'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
  const win = await desktop({}, t);
  win.setFocused(true);
  assert.deepEqual(await win.writeClipboard("a\nb\r\nc\rd"), {
    ok: true,
    concealed: false,
  });
  assert.deepEqual(win.clipboardWrites.pop(), { text: "a\r\nb\r\nc\r\nd" });
  assert.deepEqual(await win.writeClipboard("a\nb", { concealed: true }), {
    ok: true,
    concealed: true,
  });
  assert.deepEqual(win.clipboardWrites.pop(), {
    text: "a\r\nb",
    types: ["text/plain", mark],
    extra: { [mark]: 4 },
  });
  for (const platform of ["darwin", "linux"]) {
    const other = await desktop({ platform }, t);
    other.setFocused(true);
    assert.deepEqual(
      await other.writeClipboard("a\nb", { concealed: true }),
      { ok: true, concealed: false },
      platform,
    );
    assert.deepEqual(other.clipboardWrites, [{ text: "a\nb" }], platform);
  }
});

test("a failing concealed write falls back to plain text and says so", async (t) => {
  const logs = [];
  const f = await desktop({ logs, clipboardFail: { write: true } }, t);
  f.setFocused(true);
  assert.deepEqual(await f.writeClipboard("비밀\n번호", { concealed: true }), {
    ok: true,
    concealed: false,
  });
  assert.deepEqual(f.clipboardWrites, [{ text: "비밀\r\n번호" }]);
  assert.deepEqual(
    logs.filter((line) => line.includes("[clipboard]")),
    ["[clipboard] concealed mark dropped"],
  );
  const broken = await desktop(
    { logs, clipboardFail: { write: true, writeText: true } },
    t,
  );
  broken.setFocused(true);
  assert.deepEqual(await broken.writeClipboard("비밀", { concealed: true }), {
    ok: false,
    reason: "failed",
  });
  assert.ok(logs.every((line) => !line.includes("비밀")));
});

test("read reports concealed when the exclusion format or CanIncludeInClipboardHistory=0 is present", async (t) => {
  const exclude =
    'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
  const history =
    'electron application/osclipboard;format="CanIncludeInClipboardHistory"';
  const dword = (value) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return new Blob([bytes]);
  };
  for (const [formats, concealed] of [
    [{}, false],
    [{ [exclude]: new Blob([new Uint8Array(4)]) }, true],
    [{ [history]: dword(0) }, true],
    [{ [history]: dword(1) }, false],
    [{ [history]: new Blob([new Uint8Array(2)]) }, false],
  ]) {
    const f = await desktop(
      { clipboardText: "pw", clipboardFormats: formats },
      t,
    );
    f.setFocused(true);
    assert.deepEqual(
      await f.invoke("clipboard-read"),
      { ok: true, text: "pw", concealed },
      Object.keys(formats).join(),
    );
  }
  // A format that cannot be read at all counts as not concealed.
  const odd = await desktop(
    { clipboardText: "pw", clipboardFormats: { [history]: "not a blob" } },
    t,
  );
  odd.setFocused(true);
  assert.deepEqual(await odd.invoke("clipboard-read"), {
    ok: true,
    text: "pw",
    concealed: false,
  });
});

test("an empty or non-text clipboard reads as empty text", async (t) => {
  const f = await desktop({ clipboardText: "" }, t);
  f.setFocused(true);
  assert.deepEqual(await f.invoke("clipboard-read"), {
    ok: true,
    text: "",
    concealed: false,
  });
  const logs = [];
  const failing = await desktop({ logs, clipboardFail: { readText: true } }, t);
  failing.setFocused(true);
  assert.deepEqual(await failing.invoke("clipboard-read"), {
    ok: false,
    reason: "failed",
  });
  assert.ok(logs.some((line) => line === "[clipboard] read failed"));
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

test("the resolution menu starts with auto (window size), checked by default, then the fixed sizes", async (t) => {
  const f = await desktop({}, t);
  const group = f.menu.getMenuItemById("resolution").submenu;
  assert.deepEqual(
    [...group.map((item) => [item.id, item.label, item.type])].map((x) => [
      ...x,
    ]),
    [
      ["resolution:auto", "자동 (창 크기)", "radio"],
      ["resolution:1440x900", "1440 × 900", "radio"],
      ["resolution:1920x1080", "1920 × 1080", "radio"],
      ["resolution:2560x1440", "2560 × 1440", "radio"],
    ],
  );
  assert.deepEqual(
    [...group.map((item) => item.checked)],
    [true, false, false, false],
  );
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "2560x1440",
  });
  assert.equal(f.menu.getMenuItemById("resolution:auto").checked, false);
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "auto",
  });
  assert.equal(f.menu.getMenuItemById("resolution:auto").checked, true);
  assert.equal(f.menu.getMenuItemById("resolution:2560x1440").checked, false);
});

test("native remote menu enables valid commands and forwards exact actions", async (t) => {
  const f = await desktop({}, t);
  const item = (id) => f.menu.getMenuItemById(id);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "paste-clipboard",
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
  assert.equal(item("paste-clipboard").enabled, false);
  assert.equal(item("paste-clipboard").label, "클립보드 붙여넣기");
  assert.equal(item("resolution").enabled, false);
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "1920x1080",
  });
  assert.equal(item("reconnect").enabled, false);
  assert.equal(item("text-input").enabled, true);
  assert.equal(item("paste-clipboard").enabled, true);
  assert.equal(item("resolution").enabled, true);
  assert.equal(item("resolution:1920x1080").checked, true);
  assert.equal(item("resolution:1440x900").checked, false);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "paste-clipboard",
    "reconnect",
    "resolution:2560x1440",
    "resolution:auto",
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
  for (const protocol of ["vnc", "rdp", "agent"]) {
    await f.invoke("viewer-state", {
      open: true,
      connected: true,
      protocol,
      resolution: "1920x1080",
    });
    assert.equal(item("paste-clipboard").enabled, true, protocol);
  }
  await f.invoke("viewer-state", {
    open: true,
    connected: false,
    protocol: "agent",
    resolution: "1920x1080",
  });
  assert.equal(item("paste-clipboard").enabled, false, "not connected");
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
    "paste-clipboard",
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

// ---- the address page (desktop/setup.html), running its own inline script ----

const setupHtml = await readFile(
  new URL("../desktop/setup.html", import.meta.url),
  "utf8",
);
const setupScript = setupHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

// Runs the page's script with a fake document. `pageUrl` is the URL the main process
// loaded; `setup` stands in for window.desktopSetup. Errors reach the page the way
// Electron delivers them from ipcMain.handle: prefixed with the channel.
function setupPageRuns(pageUrl, setup) {
  const elements = {};
  for (const id of [
    "title",
    "current",
    "retry",
    "form",
    "address",
    "error",
    "save",
  ])
    elements[id] = {
      id,
      value: "",
      textContent: id === "title" ? "서버 주소" : "",
      hidden: id === "current" || id === "retry",
      disabled: false,
    };
  vm.runInNewContext(setupScript, {
    document: { getElementById: (id) => elements[id] },
    location: new URL(pageUrl),
    window: { desktopSetup: setup },
    URLSearchParams,
    String,
  });
  return elements;
}
const asElectronError = (error) =>
  new Error(`Error invoking remote method 'setup:save': ${error}`);

test("the address page shows the unreachable state for the URL the main process really loads, and retry reaches the main process", async (t) => {
  const f = await desktop({}, t);
  // The URL comes from main.cjs itself: a failed load of the gateway.
  f.window.webContents.emit(
    "did-fail-load",
    {},
    -102,
    "ERR",
    `${GATEWAY}/`,
    true,
  );
  await settle();
  const pageUrl = f.loads.at(-1);
  assert.notEqual(
    pageUrl,
    SETUP,
    "main.cjs adds a reason to the address page URL",
  );
  const calls = [];
  const page = setupPageRuns(pageUrl, {
    current: () => f.call("setup:current"),
    retry: async () => {
      calls.push("retry");
      return f.call("setup:retry");
    },
    save: () => assert.fail("not used"),
  });
  await settle();
  assert.equal(page.title.textContent, "서버에 연결할 수 없습니다");
  assert.equal(page.current.textContent, GATEWAY);
  assert.equal(page.current.hidden, false);
  assert.equal(page.retry.hidden, false);
  assert.equal(page.address.value, GATEWAY);
  const loadsBefore = f.loads.length;
  page.retry.onclick();
  await settle();
  assert.deepEqual(calls, ["retry"]);
  assert.equal(f.loads.length, loadsBefore + 1);
  assert.equal(f.loads.at(-1), GATEWAY, "retry opens the saved gateway again");
  // The same page reached from the menu has no reason and shows only the form.
  f.menu.getMenuItemById("change-server").click();
  await settle();
  const plain = setupPageRuns(f.loads.at(-1), {
    current: () => f.call("setup:current"),
    retry: () => assert.fail("not used"),
    save: () => assert.fail("not used"),
  });
  await settle();
  assert.equal(plain.title.textContent, "서버 주소");
  assert.equal(plain.retry.hidden, true);
  assert.equal(plain.current.hidden, true);
  assert.equal(plain.address.value, GATEWAY);
});

test("the unreachable state needs both the reason and a saved address", async () => {
  const unreachable = `${SETUP}?reason=unreachable`;
  for (const [url, address, shown] of [
    [unreachable, GATEWAY, true],
    [SETUP, GATEWAY, false],
    [`${SETUP}?reason=other`, GATEWAY, false],
    [`${SETUP}?why=unreachable`, GATEWAY, false],
    [unreachable, "", false], // first run: nothing to retry
  ]) {
    const page = setupPageRuns(url, {
      current: async () => address,
      retry: async () => {},
      save: async () => {},
    });
    await settle();
    assert.equal(page.retry.hidden, !shown, `${url} with "${address}"`);
    assert.equal(
      page.title.textContent,
      shown ? "서버에 연결할 수 없습니다" : "서버 주소",
      `${url} with "${address}"`,
    );
  }
});

test("a rejected save shows the readable message without Electron's prefix and enables the button again", async (t) => {
  const f = await desktop({ stored: "" }, t);
  const pending = deferred();
  const page = setupPageRuns(SETUP, {
    current: () => f.call("setup:current"),
    retry: async () => {},
    save: async (address) => {
      if (address === "wait") {
        await pending.promise;
        return;
      }
      try {
        return await f.call("setup:save", address);
      } catch (error) {
        throw asElectronError(error);
      }
    },
  });
  await settle();
  const submit = () => {
    let prevented = false;
    const done = page.form.onsubmit({
      preventDefault: () => (prevented = true),
    });
    assert.equal(prevented, true);
    return done;
  };
  page.address.value = "https://evil.example";
  const rejected = submit();
  assert.equal(page.save.disabled, true, "disabled while saving");
  assert.equal(page.error.textContent, "", "the old message is cleared first");
  await rejected;
  assert.equal(page.save.disabled, false);
  assert.ok(page.error.textContent.length > 0, "a message is shown");
  assert.doesNotMatch(page.error.textContent, /Error invoking remote method/);
  assert.doesNotMatch(page.error.textContent, /^Error: /);
  // A later success clears the message and keeps the button for the new page.
  page.address.value = "gateway.tail123.ts.net:8450";
  await submit();
  assert.equal(page.error.textContent, "");
  assert.equal(f.loads.at(-1), GATEWAY);
  // A plain message and a non-Error rejection are shown as they are.
  const plainPage = setupPageRuns(SETUP, {
    current: async () => "",
    retry: () => Promise.reject("서버 주소를 먼저 입력해주세요."),
    save: () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'setup:save': Error: 주소가 올바르지 않습니다.",
        ),
      ),
  });
  await settle();
  plainPage.retry.onclick();
  await settle();
  assert.equal(plainPage.error.textContent, "서버 주소를 먼저 입력해주세요.");
  await plainPage.form.onsubmit({ preventDefault() {} });
  assert.equal(plainPage.error.textContent, "주소가 올바르지 않습니다.");
  assert.equal(plainPage.save.disabled, false);
});

// ---- leaving the viewer for the address page ----

test("showing the address page closes the Remote menu entries and leaves fullscreen", async (t) => {
  for (const how of ["menu", "unreachable", "bridge"]) {
    const f = await desktop({}, t);
    const item = (id) => f.menu.getMenuItemById(id);
    await f.invoke("viewer-state", {
      open: true,
      connected: true,
      protocol: "rdp",
      resolution: "1920x1080",
    });
    await f.invoke("fullscreen", true);
    f.finishFullscreen(true, { html: true });
    assert.equal(item("back").enabled, true);
    assert.equal(item("resolution").enabled, true);
    assert.deepEqual(f.fullscreenRequests, [true]);
    if (how === "menu") item("change-server").click();
    else if (how === "bridge") await f.invoke("open-setup");
    else f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 502);
    await settle();
    assert.ok(f.loads.at(-1).startsWith(SETUP), how);
    for (const id of [
      "back",
      "disconnect",
      "reconnect",
      "text-input",
      "paste-clipboard",
      "resolution",
    ])
      assert.equal(item(id).enabled, false, `${how}: ${id}`);
    assert.equal(item("resolution:auto").checked, true, how);
    assert.equal(item("resolution:1920x1080").checked, false, how);
    assert.deepEqual(
      f.fullscreenRequests,
      [true, false],
      `${how}: leaves fullscreen`,
    );
    assert.match(f.scriptCalls.at(-1)[0], /exitFullscreen/, how);
    assert.deepEqual(f.nativeRequests, [], `${how}: HTML full screen exit`);
  }
});

// ---- desktop full screen through HTML full screen ----

test("entering full screen asks the page for HTML full screen with a user gesture; native full screen is not requested", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.scriptCalls.at(-1), [
    "document.documentElement.requestFullscreen()",
    true,
  ]);
  assert.deepEqual(f.nativeRequests, []);
});

test("a refused or failing HTML full screen falls back to native full screen without any dialog", async (t) => {
  for (const html of ["refused", "dead"]) {
    const f = await desktop({ html }, t);
    await f.invoke("fullscreen", true);
    await settle();
    assert.deepEqual(f.nativeRequests, [true], html);
    assert.deepEqual(f.dialogs, [], html);
    // The fallback is plain native full screen: its exit is native too.
    f.finishFullscreen(true);
    await f.invoke("fullscreen", false);
    assert.deepEqual(f.nativeRequests, [true, false], html);
  }
});

test("a refusal that arrives after the user already asked to leave does not enter native full screen", async (t) => {
  const f = await desktop({ html: "refused" }, t);
  // Both requests arrive before the page has answered the first.
  await Promise.all([
    f.invoke("fullscreen", true),
    f.invoke("fullscreen", false), // queued behind the pending entry
  ]);
  await settle();
  assert.deepEqual(f.nativeRequests, []);
  // The transition ended, so a later request is not swallowed.
  await f.invoke("fullscreen", true);
  await settle();
  assert.deepEqual(f.nativeRequests, [true]);
});

test("leaving ends HTML full screen through document.exitFullscreen, never win.setFullScreen(false) alone", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  f.finishFullscreen(true, { html: true });
  await f.invoke("fullscreen", false);
  assert.match(f.scriptCalls.at(-1)[0], /exitFullscreen/);
  assert.equal(f.scriptCalls.at(-1)[1], true);
  assert.deepEqual(f.nativeRequests, []);
  f.finishFullscreen(false, { html: true });
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
});

test("an exit queued during the entry still goes through the page", async (t) => {
  const f = await desktop({}, t);
  await f.invoke("fullscreen", true);
  await f.invoke("fullscreen", false);
  // enter-full-screen arrives before enter-html-full-screen.
  f.finishFullscreen(true);
  assert.match(f.scriptCalls.at(-1)[0], /exitFullscreen/);
  assert.deepEqual(f.nativeRequests, []);
});

test("hold-Escape (leave-html-full-screen then leave-full-screen) publishes false and the next exit uses the native path", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  f.finishFullscreen(true, { html: true });
  f.finishFullscreen(false, { html: true });
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
  assert.equal(await f.invoke("fullscreen-state"), false);
  // Native full screen later (no page involved), then an exit: native.
  f.finishFullscreen(true);
  await f.invoke("fullscreen", false);
  assert.deepEqual(f.nativeRequests, [false]);
});

test("the exit survives a dead page: executeJavaScript rejects -> setFullScreen(false)", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  f.finishFullscreen(true, { html: true });
  f.setHtml("dead");
  await f.invoke("fullscreen", false);
  await settle();
  assert.deepEqual(f.nativeRequests, [false]);
  f.finishFullscreen(false);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
});

test("an exit script that finds no full screen element ends in the native path and the transition ends", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  await f.invoke("fullscreen", true);
  f.finishFullscreen(true); // native full screen is on, the page has no element
  f.setHtml("no-element");
  await f.invoke("fullscreen", false);
  await settle();
  assert.deepEqual(f.nativeRequests, [false]);
  f.finishFullscreen(false);
  // Not swallowed: F11 enters again.
  assert.equal(
    f.input({ type: "keyDown", key: "F11", isAutoRepeat: false }),
    true,
  );
  assert.match(f.scriptCalls.at(-1)[0], /requestFullscreen/);
});

test("a renderer that never answers falls back to native full screen after 2 s, and a late answer changes nothing", async (t) => {
  for (const enter of [true, false]) {
    const f = await desktop({ html: enter ? "late" : "granted" }, t);
    if (!enter) {
      await f.invoke("fullscreen", true);
      f.finishFullscreen(true, { html: true });
      f.setHtml("late");
    }
    const before = f.timers.size;
    await f.invoke("fullscreen", enter);
    const guard = [...f.timers.values()].at(-1);
    assert.equal(f.timers.size, before + 1);
    assert.equal(guard.ms, 2000);
    assert.deepEqual(f.nativeRequests, [], "nothing before the guard fires");
    guard.callback();
    assert.deepEqual(f.nativeRequests, [enter]);
    // The transition is over: the native event is published and F11 works again.
    f.finishFullscreen(enter);
    assert.deepEqual(f.notifications.at(-1), [
      "remote:fullscreen-state",
      enter,
    ]);
    // The page answers after the guard: no second toggle, whatever it says.
    f.answerLate(false);
    await settle();
    guard.callback(); // firing again does nothing more
    assert.deepEqual(f.nativeRequests, [enter]);
    // And F11 is not swallowed: it toggles back.
    assert.equal(
      f.input({ type: "keyDown", key: "F11", isAutoRepeat: false }),
      true,
    );
    assert.equal(f.fullscreenRequests.at(-1), !enter);
  }
});

test("F11 from the menu or before-input-event toggles relative to the pending target (no re-entry after a page-requested exit)", async (t) => {
  const f = await desktop({ html: "granted" }, t);
  const key = { type: "keyDown", key: "F11", isAutoRepeat: false };
  assert.equal(f.input(key), true);
  assert.equal(f.input({ ...key, type: "keyUp" }), true);
  f.finishFullscreen(true, { html: true });
  // The page asked to leave (its F11 while locked) and the same press also reached main.
  await f.invoke("fullscreen", false);
  assert.equal(f.input(key), true); // pending exit: F11 means "enter" again by design
  const entries = f.scriptCalls.filter(([s]) => /requestFullscreen/.test(s));
  assert.equal(entries.length, 1, "no re-entry while the exit is in flight");
  f.finishFullscreen(false, { html: true });
  assert.match(f.scriptCalls.at(-1)[0], /requestFullscreen/);
});

test("the permission handler grants fullscreen and keyboardLock only for the gateway origin's requestingUrl", async (t) => {
  const f = await desktop({}, t);
  const ask = (permission, requestingUrl) =>
    new Promise((r) =>
      f.permissions.request({}, permission, r, { requestingUrl }),
    );
  for (const p of ["fullscreen", "keyboardLock"]) {
    assert.equal(await ask(p, `${GATEWAY}/`), true, p);
    for (const u of [
      "https://evil.example/",
      "https://gateway.tail123.ts.net:8451/",
      SETUP,
      "",
      undefined,
    ])
      assert.equal(await ask(p, u), false, `${p} ${u}`);
  }
  for (const p of [
    "media",
    "clipboard-read",
    "notifications",
    "geolocation",
    "pointerLock",
  ])
    assert.equal(await ask(p, `${GATEWAY}/`), false, p);
  assert.equal(f.permissions.check({}, "fullscreen", GATEWAY), false);
  assert.equal(f.permissions.check({}, "automatic-fullscreen", GATEWAY), false);
});

test("showing the address page while windowed does not touch fullscreen", async (t) => {
  const f = await desktop({}, t);
  f.menu.getMenuItemById("change-server").click();
  await settle();
  assert.deepEqual(f.fullscreenRequests, []);
});

// ---- the smoke test the CI runs on a real Electron ----

const goodPage = {
  page: SETUP,
  title: "Gome Remote",
  bridgeVersion: 4,
  read: "function",
  setup: "function",
};
test("--smoke-test shows only the address page, never the saved gateway, and quits with success", async (t) => {
  const f = await desktop({ argv: ["--smoke-test"], page: goodPage }, t);
  await settle();
  assert.deepEqual(
    f.loads,
    [SETUP],
    "no network: the saved gateway is not opened",
  );
  assert.equal(f.windowOptions.show, false);
  assert.equal(f.scripts.length, 1);
  assert.deepEqual(f.lifecycle, [["quit"]]);
});

test("--smoke-test exits 1 when the page or the bridge is not what the app promises, or the check itself fails", async (t) => {
  for (const page of [
    { ...goodPage, bridgeVersion: 1 },
    { ...goodPage, bridgeVersion: 2 },
    { ...goodPage, bridgeVersion: 3 },
    { ...goodPage, read: "undefined" },
    { ...goodPage, bridgeVersion: undefined },
    { ...goodPage, setup: "undefined" },
    { ...goodPage, title: "" },
    { ...goodPage, page: "about:blank" },
    new Error("Cannot read properties of undefined"),
  ]) {
    const f = await desktop({ argv: ["--smoke-test"], page }, t);
    await settle();
    assert.deepEqual(f.lifecycle, [["exit", 1]], JSON.stringify(page));
  }
});

test("--smoke-test cannot hang: a 60 s guard exits 1 and the guard is cleared when the check ends", async (t) => {
  const hung = await desktop({ argv: ["--smoke-test"], page: "hang" }, t);
  await settle();
  assert.deepEqual(hung.lifecycle, []);
  const [guard] = hung.timers.values();
  assert.equal(hung.timers.size, 1);
  assert.equal(guard.ms, 60_000);
  guard.callback();
  assert.deepEqual(hung.lifecycle, [["exit", 1]]);
  for (const page of [goodPage, new Error("boom")]) {
    const done = await desktop({ argv: ["--smoke-test"], page }, t);
    await settle();
    assert.equal(
      [...done.timers.values()].every((timer) => timer.cleared),
      true,
      "no timer is left to keep the process alive",
    );
  }
});

test("a normal start never runs the smoke check", async (t) => {
  const f = await desktop({ page: goodPage }, t);
  await settle();
  assert.deepEqual(f.scripts, []);
  assert.deepEqual(f.lifecycle, []);
});

// ---- boundaries: each validation clause alone, and the exact setup page ----

test("each clause of the viewer-state check refuses on its own", async (t) => {
  const f = await desktop({}, t);
  const good = {
    open: true,
    connected: false,
    protocol: "rdp",
    resolution: "1440x900",
  };
  await f.invoke("viewer-state", good);
  for (const protocol of [null, "rdp", "vnc", "agent"])
    await f.invoke("viewer-state", { ...good, protocol });
  for (const resolution of ["auto", "1440x900", "1920x1080", "2560x1440"])
    await f.invoke("viewer-state", { ...good, resolution });
  for (const [what, bad] of [
    ["open", { ...good, open: "yes" }],
    ["connected", { ...good, connected: 1 }],
    ["protocol", { ...good, protocol: "ssh" }],
    ["protocol undefined", { ...good, protocol: undefined }],
    ["resolution", { ...good, resolution: "800x600" }],
    ["resolution missing", { ...good, resolution: undefined }],
    ["null", null],
    ["empty", undefined],
  ])
    await assert.rejects(
      f.invoke("viewer-state", bad),
      /Invalid viewer state/,
      what,
    );
});

test("the address page channels accept exactly the page the app loads, in the top frame", async (t) => {
  const f = await desktop({ stored: "" }, t);
  assert.equal(await f.call("setup:current"), "");
  const refused = [
    pathToFileURL(join(desktopDir, "other.html")).href,
    pathToFileURL(join(desktopDir, "setup.html.bak")).href,
    pathToFileURL(join(desktopDir, "..", "package.json")).href,
    `${SETUP}x`,
    "file:///etc/passwd",
    "about:blank",
    "",
  ];
  for (const url of refused) {
    f.show(url);
    for (const channel of ["setup:current", "setup:retry"])
      await assert.rejects(
        f.call(channel),
        /Untrusted origin/,
        `${channel} ${url}`,
      );
  }
  // The exact page is fine with a query or a fragment, but not from a subframe.
  for (const url of [SETUP, `${SETUP}?reason=unreachable`, `${SETUP}#x`]) {
    f.show(url);
    assert.equal(await f.call("setup:current"), "");
  }
  await assert.rejects(
    f.call("setup:current", undefined, {
      sender: f.window.webContents,
      senderFrame: { url: SETUP },
    }),
    /Untrusted sender/,
  );
});

// ---- bridge version 3: the Mac agent ----

test("a Mac agent session enables the resolution menu like RDP, and VNC still does not", async (t) => {
  const f = await desktop({}, t);
  const item = (id) => f.menu.getMenuItemById(id);
  const state = (protocol, connected = true) => ({
    open: true,
    connected,
    protocol,
    resolution: "auto",
  });
  await f.invoke("viewer-state", state("agent"));
  assert.equal(item("resolution").enabled, true);
  assert.equal(item("text-input").enabled, true);
  assert.equal(item("reconnect").enabled, false);
  await f.invoke("viewer-state", state("agent", false));
  assert.equal(item("resolution").enabled, false, "not while connecting");
  assert.equal(item("reconnect").enabled, true);
  await f.invoke("viewer-state", state("vnc"));
  assert.equal(item("resolution").enabled, false);
  await f.invoke("viewer-state", state("rdp"));
  assert.equal(item("resolution").enabled, true);
});

test("protocols other than the four it knows are still refused", async (t) => {
  const f = await desktop({}, t);
  for (const protocol of ["Agent", "ssh", "", 0, undefined])
    await assert.rejects(
      f.invoke("viewer-state", {
        open: true,
        connected: true,
        protocol,
        resolution: "auto",
      }),
      /Invalid viewer state/,
      String(protocol),
    );
});

// ---- auto-update (desktop/updater.cjs, electron-updater) ----

const remoteMenu = (f) =>
  f.menu.template.find((entry) => entry.label === "원격").submenu;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const visible = (item) => item.visible !== false;

test("the updater is not started in an unpackaged app or in the smoke test", async (t) => {
  for (const options of [
    { packaged: false },
    { packaged: true, argv: ["--smoke-test"], page: goodPage },
  ]) {
    const f = await desktop(options, t);
    await settle();
    assert.equal(f.autoUpdater.checks, 0);
    assert.equal(f.autoUpdater.autoDownload, false, "settings untouched");
    assert.equal(f.autoUpdater.listenerCount("error"), 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(
      [...f.timers.values()].some((timer) => timer.ms === 30_000),
      false,
    );
    assert.equal(f.menu.getMenuItemById("check-update"), undefined);
    assert.equal(f.menu.getMenuItemById("restart-update"), undefined);
  }
});

test("a packaged app downloads and installs on quit, checks shortly after start and every 6 hours", async (t) => {
  const f = await desktop({ packaged: true }, t);
  await settle();
  assert.equal(f.autoUpdater.autoDownload, true);
  assert.equal(f.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(f.autoUpdater.checks, 0, "not before the delay");
  const first = [...f.timers.values()].find((timer) => timer.ms === 30_000);
  assert.ok(first, "one check shortly after ready");
  assert.deepEqual(
    [...f.intervals.values()].map((i) => i.ms),
    [SIX_HOURS],
  );
  await first.callback();
  assert.equal(f.autoUpdater.checks, 1);
  await [...f.intervals.values()][0].callback();
  assert.equal(f.autoUpdater.checks, 2);
  assert.deepEqual(f.dialogs, []);
});

test("errors in a background check are logged and never shown", async (t) => {
  const logs = [];
  const f = await desktop({ packaged: true, logs }, t);
  await settle();
  f.autoUpdater.failure = new Error("net::ERR_INTERNET_DISCONNECTED\nstack");
  const first = [...f.timers.values()].find((timer) => timer.ms === 30_000);
  await first.callback();
  await [...f.intervals.values()][0].callback();
  // electron-updater also emits 'error'; without a listener that would throw.
  assert.doesNotThrow(() => f.autoUpdater.emit("error", new Error("late")));
  assert.deepEqual(f.dialogs, []);
  assert.equal(
    logs.filter((line) => line.includes("ERR_INTERNET_DISCONNECTED")).length,
    2,
  );
  assert.equal(
    logs.some((line) => line.includes("stack")),
    false,
    "one line per error",
  );
  assert.deepEqual(f.lifecycle, []);
});

test("an updater whose start() fails never keeps the app from starting", async (t) => {
  const logs = [];
  const f = await desktop(
    {
      packaged: true,
      logs,
      updater: new Proxy(new EventEmitter(), {
        set() {
          throw new Error("broken");
        },
      }),
    },
    t,
  );
  await settle();
  assert.deepEqual(f.loads, [GATEWAY]);
  assert.deepEqual(f.lifecycle, []);
  assert.equal(
    logs.some((line) => line.includes("Updater not started")),
    true,
  );
});

test("a missing or broken electron-updater never keeps the app from starting", async (t) => {
  const broken = {
    "require throws": () => {
      throw new Error("Cannot find module 'electron-updater'");
    },
    "autoUpdater getter throws": () => ({
      get autoUpdater() {
        throw new Error("app is undefined");
      },
    }),
  };
  for (const [name, updaterModule] of Object.entries(broken)) {
    const logs = [];
    const f = await desktop({ packaged: true, logs, updaterModule }, t);
    await settle();
    assert.deepEqual(f.loads, [GATEWAY], name);
    assert.deepEqual(f.lifecycle, [], name);
    assert.deepEqual(f.dialogs, [], name);
    assert.equal(
      logs.some((line) => line.includes("Updater unavailable")),
      true,
      name,
    );
    assert.equal(f.intervals.size, 0, name);
    assert.equal(f.menu.getMenuItemById("check-update"), undefined, name);
    assert.equal(
      f.menu.getMenuItemById("change-server").label,
      "서버 주소 바꾸기",
    );
  }
});

test("the Remote menu ends with a manual check and a hidden restart entry", async (t) => {
  const f = await desktop({ packaged: true }, t);
  const items = remoteMenu(f);
  assert.deepEqual(
    [...items.slice(-3)].map((item) => item.type ?? item.id),
    ["separator", "check-update", "restart-update"],
  );
  assert.equal(items.at(-3 - 1).id, "change-server");
  const check = f.menu.getMenuItemById("check-update");
  assert.equal(check.label, "업데이트 확인");
  assert.equal(visible(f.menu.getMenuItemById("restart-update")), false);
});

test("the manual check reports up to date, a download in progress, and an error", async (t) => {
  const f = await desktop({ packaged: true, version: "0.3.0" }, t);
  const click = () => f.menu.getMenuItemById("check-update").click();
  await click();
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].message, /최신 버전입니다 \(v0\.3\.0\)/);
  f.autoUpdater.result = {
    isUpdateAvailable: true,
    updateInfo: { version: "0.3.1" },
  };
  await click();
  assert.match(f.dialogs[1].message, /v0\.3\.1/);
  assert.match(f.dialogs[1].message, /내려받는 중/);
  f.autoUpdater.failure = new Error("offline");
  await click();
  assert.equal(f.dialogs[2].type, "error");
  assert.equal(f.dialogs[2].detail, "offline");
  assert.equal(f.autoUpdater.checks, 3);
  assert.deepEqual(f.lifecycle, []);
});

test("a manual check that answers null says it cannot check, and dialogs are attached to the window", async (t) => {
  const f = await desktop({ packaged: true }, t);
  f.autoUpdater.result = null;
  await f.menu.getMenuItemById("check-update").click();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].type, "warning");
  assert.equal(f.dialogs[0].message, "업데이트를 확인할 수 없습니다.");
  assert.equal(f.dialogs[0].parent, f.window);
  // Without a usable window the dialog is free-standing instead of failing.
  f.window.destroyed = true;
  await f.menu.getMenuItemById("check-update").click();
  assert.equal(f.dialogs[1].parent, null);
});

test("a second click during a running manual check does not start another one", async (t) => {
  const f = await desktop({ packaged: true }, t);
  const gate = deferred();
  f.autoUpdater.checkForUpdates = async () => {
    f.autoUpdater.checks += 1;
    await gate.promise;
    return f.autoUpdater.result;
  };
  const click = () => f.menu.getMenuItemById("check-update").click();
  const one = click();
  const two = click();
  gate.resolve();
  await Promise.all([one, two]);
  assert.equal(f.autoUpdater.checks, 1);
  assert.equal(f.dialogs.length, 1);
});

test("the restart entry appears only after the download and then calls quitAndInstall", async (t) => {
  const f = await desktop({ packaged: true }, t);
  const before = f.menu;
  assert.equal(visible(before.getMenuItemById("restart-update")), false);
  // A click on the hidden entry (a stale menu) does nothing.
  before.getMenuItemById("restart-update").click();
  assert.equal(f.autoUpdater.restarts, 0);
  f.autoUpdater.emit("update-downloaded", { version: "0.3.1" });
  assert.notEqual(f.menu, before, "the menu is rebuilt, not patched");
  const entry = f.menu.getMenuItemById("restart-update");
  assert.equal(visible(entry), true);
  assert.equal(entry.label, "다시 시작해서 업데이트 (v0.3.1)");
  assert.equal(f.autoUpdater.restarts, 0, "never restarts by itself");
  assert.deepEqual(f.lifecycle, []);
  entry.click();
  assert.equal(f.autoUpdater.restarts, 1);
});

test("rebuilding the menu for an update keeps the viewer state and the other entries", async (t) => {
  const f = await desktop({ packaged: true }, t);
  f.show(GATEWAY);
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "agent",
    resolution: "1920x1080",
  });
  f.autoUpdater.emit("update-downloaded", { version: "0.3.1" });
  const menu = f.menu;
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "paste-clipboard",
    "resolution",
  ])
    assert.equal(menu.getMenuItemById(id).enabled, true, id);
  assert.equal(menu.getMenuItemById("reconnect").enabled, false);
  assert.equal(menu.getMenuItemById("resolution:1920x1080").checked, true);
  assert.equal(menu.getMenuItemById("resolution:auto").checked, false);
  assert.equal(menu.getMenuItemById("change-server").label, "서버 주소 바꾸기");
  // New viewer states reach the rebuilt menu.
  await f.invoke("viewer-state", {
    open: false,
    connected: false,
    protocol: null,
    resolution: "auto",
  });
  assert.equal(f.menu.getMenuItemById("back").enabled, false);
});

test("a manual check after the download says it is ready instead of downloading again", async (t) => {
  const f = await desktop({ packaged: true }, t);
  f.autoUpdater.emit("update-downloaded", { version: "0.3.1" });
  f.autoUpdater.result = {
    isUpdateAvailable: true,
    updateInfo: { version: "0.3.1" },
  };
  await f.menu.getMenuItemById("check-update").click();
  assert.match(f.dialogs[0].message, /v0\.3\.1.*이미 받았습니다/);
  // And the background check stops asking while a restart is pending.
  const first = [...f.timers.values()].find((timer) => timer.ms === 30_000);
  const checks = f.autoUpdater.checks;
  await first.callback();
  assert.equal(f.autoUpdater.checks, checks);
});

test("the updater adds no IPC channel", async (t) => {
  const plain = await desktop({}, t);
  const packaged = await desktop({ packaged: true }, t);
  assert.deepEqual([...packaged.handlers.keys()], [...plain.handlers.keys()]);
});
