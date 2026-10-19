import { loadTs } from "./load-ts.js";
import { agentHarness } from "./agent-harness.js";

// A just-enough browser for src/main.ts: elements are created from the ids in the page
// template, and Guacamole and fetch are fakes the test drives. Nothing here knows the
// rules under test; it only records what main.ts does (fetch calls, screens shown).
class FakeElement {
  constructor(
    tag = "div",
    { id, hidden = false, classes = [], dataset = {} } = {},
  ) {
    this.tag = tag;
    this.id = id;
    this.hidden = hidden;
    this.textContent = "";
    this.style = {};
    this.disabled = false;
    this.value = "";
    this.open = false;
    this.tabIndex = 0;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.children = [];
    this.attributes = {};
    this.dataset = dataset;
    this.options = [];
    this.listeners = {};
    const set = new Set(classes);
    this.classes = set;
    this.classList = {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      toggle: (name, force) =>
        (force ?? !set.has(name)) ? set.add(name) : set.delete(name),
      contains: (name) => set.has(name),
    };
  }
  set className(value) {
    this.classes.clear();
    for (const name of String(value).split(/\s+/).filter(Boolean))
      this.classes.add(name);
  }
  // HTMLSelectElement.remove(index): the select falls back to its first option.
  remove(index) {
    const [gone] = this.options.splice(index, 1);
    if (gone?.value === this.value) this.value = this.options[0]?.value ?? "";
  }
  set innerHTML(html) {
    this.children = [];
    for (const match of String(html).matchAll(/class="([^"]+)"/g))
      this.children.push(
        new FakeElement("span", { classes: match[1].split(/\s+/) }),
      );
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  querySelector(selector) {
    const wanted = selector.replace(/^\./, "");
    const walk = (node) => {
      for (const child of node.children) {
        if (child.classes?.has(wanted)) return child;
        const deeper = child.children && walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    return walk(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatchEvent(event) {
    this[`on${event.type}`]?.(event);
    for (const listener of this.listeners[event.type] ?? []) listener(event);
  }
  click() {
    this.onclick?.({ stopPropagation() {} });
  }
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  getElement() {
    return this;
  }
}

// What a version 1 app accepts in viewerState (desktop/main.cjs of that release).
const BRIDGE_1_RESOLUTIONS = ["1440x900", "1920x1080", "2560x1440"];

// `bridgeVersion` only matters in app mode. Version 1 mirrors the old app: it throws
// on any resolution but the fixed sizes.
export async function viewer({
  appMode = false,
  bridgeVersion = 4,
  targets,
  fetchHandler,
  hash = "",
  agentStart,
  // Use the real src/agent.ts (on the agent harness's fake RTCPeerConnection) instead of the
  // recorder, for tests about what the page really sends the Mac.
  realAgent = false,
  // navigator.keyboard.lock() answers like Chromium in full screen: "granted" resolves,
  // "refused" rejects, "absent" leaves navigator.keyboard undefined.
  keyboardLock = "granted",
  // What the local clipboard holds (the bridge's readClipboard answers it). The page's
  // window has the focus unless `windowFocused` says otherwise.
  clipboardText = "",
  windowFocused = true,
  // A browser's navigator.clipboard, for the page outside the app.
  browserClipboard,
} = {}) {
  const rig = realAgent ? await agentHarness() : undefined;
  const fetches = [];
  const elements = new Map();
  const dataClose = [];
  const app = new FakeElement("div", { id: "app" });
  Object.defineProperty(app, "innerHTML", {
    set(html) {
      for (const match of String(html).matchAll(
        /<(\w+)\s+id="([^"]+)"([^>]*)>/g,
      )) {
        const [, tag, id, rest] = match;
        elements.set(
          id,
          new FakeElement(tag, {
            id,
            hidden: /(^|\s)hidden(\s|$|>)/.test(rest),
          }),
        );
      }
      for (const match of String(html).matchAll(/data-close="([^"]+)"/g))
        dataClose.push(match[1]);
      // A select starts on its first option, as in a browser.
      const select = elements.get("resolution");
      select.options = Array.from(
        String(html).matchAll(/<option value="([^"]+)"/g),
        (m) => ({ value: m[1] }),
      );
      select.value = select.options[0].value;
    },
  });
  const body = new FakeElement("body");
  const documentListeners = {};
  const document = {
    fullscreenElement: null,
    body,
    documentElement: new FakeElement("html"),
    querySelector: (selector) => (selector === "#app" ? app : null),
    getElementById: (id) => {
      if (!elements.has(id)) throw new Error(`the page has no #${id}`);
      return elements.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (selector) =>
      selector === "[data-close]"
        ? dataClose.map(
            (close) => new FakeElement("button", { dataset: { close } }),
          )
        : [],
    addEventListener: (type, listener) =>
      (documentListeners[type] ??= []).push(listener),
    removeEventListener() {},
    async exitFullscreen() {},
    hasFocus: () => windowFocus,
  };
  let windowFocus = windowFocused;
  const bridgeCalls = { viewerState: [], openSetup: 0, fullscreen: [] };
  const keyboardCalls = { lock: [], unlock: 0 };
  // The local clipboard the bridge reads and writes. `hold` keeps reads pending until
  // `resolve()`; `fail` makes them answer that failure instead of the text.
  const clipboard = {
    text: clipboardText,
    concealed: false,
    reads: 0,
    writes: [],
    hold: false,
    fail: undefined,
    held: [],
    resolve() {
      for (const release of clipboard.held.splice(0)) release();
    },
  };
  const navigator = {
    ...(browserClipboard ? { clipboard: browserClipboard } : {}),
    ...(keyboardLock === "absent"
      ? {}
      : {
          keyboard: {
            lock: async (...args) => {
              keyboardCalls.lock.push(args);
              if (keyboardLock === "refused")
                throw new Error("NotAllowedError");
            },
            unlock: () => {
              keyboardCalls.unlock++;
            },
          },
        }),
  };
  let actionListener;
  const desktop = appMode
    ? {
        bridgeVersion,
        fullscreen: async (enabled) => {
          bridgeCalls.fullscreen.push(enabled);
        },
        fullscreenState: async () => false,
        onFullscreenChange: () => () => {},
        viewerState: async (state) => {
          bridgeCalls.viewerState.push(state);
          if (
            bridgeVersion < 2 &&
            !BRIDGE_1_RESOLUTIONS.includes(state.resolution)
          )
            throw new Error("Invalid viewer state.");
        },
        onViewerAction: (callback) => {
          actionListener = callback;
          return () => {};
        },
        openSetup: async () => {
          bridgeCalls.openSetup++;
        },
        ...(bridgeVersion >= 4
          ? {
              readClipboard: async () => {
                clipboard.reads++;
                if (clipboard.hold)
                  await new Promise((resolve) => clipboard.held.push(resolve));
                return (
                  clipboard.fail ?? {
                    ok: true,
                    text: clipboard.text,
                    concealed: clipboard.concealed,
                  }
                );
              },
              writeClipboard: async (text, options) => {
                clipboard.writes.push([text, options]);
                return { ok: true };
              },
            }
          : {}),
      }
    : undefined;
  // devicePixelRatio is read from the window each time, as in a browser.
  const windowListeners = {};
  const window = {
    desktop,
    devicePixelRatio: 1,
    addEventListener(type, listener) {
      (windowListeners[type] ??= []).push(listener);
    },
  };

  // Timers the test advances by hand, so a debounce is tested without waiting.
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const fakeSetTimeout = (callback, ms) => {
    timers.set(nextTimer, { callback, at: now + ms });
    return nextTimer++;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end);
      if (!due.length) break;
      const [id, timer] = due.sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  };
  const observers = [];

  const defaultFetch = async (path, init) => {
    if (path === "/api/targets")
      return { status: 200, ok: true, json: async () => ({ targets }) };
    if (path === "/api/agent-sessions")
      return {
        status: 200,
        ok: true,
        json: async () => ({ sdp: "v=0\r\nanswer" }),
      };
    return {
      status: 201,
      ok: true,
      json: async () => ({ ticket: "ticket-1" }),
    };
  };
  const fetch = async (path, init = {}) => {
    fetches.push({
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    // A page that keeps reconnecting by itself would loop here for ever: stop it
    // after a generous number of requests so the test fails instead of hanging.
    if (fetches.length > 40) return new Promise(() => {});
    return (fetchHandler ?? defaultFetch)(path, init, defaultFetch);
  };

  // Guacamole: every client and tunnel the page creates is kept so a test can fire its callbacks.
  const clients = [];
  const tunnels = [];
  class Tunnel {
    constructor(url) {
      this.url = url;
      tunnels.push(this);
    }
  }
  class Client {
    constructor(tunnel) {
      this.tunnel = tunnel;
      this.connected = [];
      this.disconnected = 0;
      this.sizes = [];
      this.display = {
        getCursorLayer: () => new FakeElement("canvas"),
        getElement: () => new FakeElement("div"),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale() {},
      };
      clients.push(this);
    }
    getDisplay() {
      return this.display;
    }
    connect(params) {
      this.connected.push(params);
    }
    disconnect() {
      this.disconnected++;
    }
    sendMouseState() {}
    sendKeyEvent() {}
    sendSize(width, height) {
      this.sizes.push([width, height]);
    }
  }
  // The Mac (agent) session is replaced by a recorder: src/agent.ts has its own tests with
  // a fake RTCPeerConnection. Here only main.ts's wiring is under test. By default `start`
  // relays a fake offer through the page's own signalling function, as the real one does.
  const agents = [];
  class FakeAgent {
    constructor(deps) {
      this.deps = deps;
      this.element = new FakeElement("div");
      this.video = new FakeElement("video");
      this.sizes = [];
      this.texts = [];
      this.clipboards = [];
      this.watches = [];
      this.pasteShortcuts = 0;
      this.releases = 0;
      this.closed = 0;
      this.focused = 0;
      this.answer = undefined;
      agents.push(this);
    }
    async start() {
      if (agentStart) return agentStart(this);
      this.answer = await this.deps.signal("v=0\r\nfake-offer");
    }
    sendSize(width, height) {
      this.sizes.push([width, height]);
    }
    sendText(text) {
      this.texts.push(text);
      return true;
    }
    sendClipboard(text, concealed) {
      this.clipboards.push([text, concealed]);
      return "sent";
    }
    sendWatch(on) {
      this.watches.push(on);
    }
    pasteShortcut() {
      this.pasteShortcuts++;
    }
    release() {
      this.releases++;
    }
    focus() {
      this.focused++;
    }
    close() {
      this.closed++;
    }
    clickAt() {}
    watchFrames() {}
  }
  const Guacamole = {
    WebSocketTunnel: Tunnel,
    Client,
    Mouse: class {},
    Keyboard: class {
      reset() {}
    },
    StringWriter: class {},
  };

  const tiles = await loadTs("tiles.ts");
  const api = await loadTs("api.ts", {
    window,
    document,
    fetch,
    location: { origin: "https://gateway.example.ts.net:8450" },
    AbortSignal,
    JSON,
  });
  const flow = await loadTs("flow.ts");
  const keyboardLockModule = await loadTs("keyboard-lock.ts");
  const agentMessages = await loadTs("agent-messages.ts");
  const agentInput = await loadTs("agent-input.ts");
  const clipboardSync = await loadTs(
    "clipboard-sync.ts",
    {},
    { "./agent-input": agentInput },
  );
  const clipboardLocal = await loadTs(
    "clipboard-local.ts",
    { window, navigator },
    { "./api": api },
  );
  // The measurement module is given recording stand-ins: a page without #measure must
  // leave `measureUse` empty (no document access, no timer, no message port).
  const measureUse = [];
  const measure = await loadTs("measure.ts", {
    document: new Proxy(document, {
      get(target, name) {
        measureUse.push(`document.${String(name)}`);
        return target[name];
      },
    }),
    MessageChannel: class extends MessageChannel {
      constructor() {
        super();
        measureUse.push("MessageChannel");
      }
    },
    performance,
    setTimeout: (...args) => {
      measureUse.push("setTimeout");
      return setTimeout(...args);
    },
  });
  const resolution = await loadTs("resolution.ts", {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  await loadTs(
    "main.ts",
    {
      window,
      document,
      navigator,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      location: { hash },
      Event,
      ResizeObserver: class {
        constructor(callback) {
          this.callback = callback;
          this.active = false;
        }
        observe() {
          this.active = true;
          observers.push(this);
        }
        disconnect() {
          this.active = false;
        }
      },
    },
    {
      "../vendor/guacamole.js": { __esModule: true, default: Guacamole },
      "./api": api,
      "./tiles": tiles,
      "./flow": flow,
      "./keyboard-lock": keyboardLockModule,
      "./clipboard-sync": clipboardSync,
      "./clipboard-local": clipboardLocal,
      "./agent": rig
        ? { createAgentSession: (deps) => rig.mod.createAgentSession(deps) }
        : { createAgentSession: (deps) => new FakeAgent(deps) },
      "./agent-messages": agentMessages,
      "./measure": measure,
      "./resolution": resolution,
      "./style.css": {},
    },
  );
  const el = (id) => document.getElementById(id);
  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();
  return {
    el,
    fetches,
    clients,
    tunnels,
    agents,
    rig,
    body,
    measureUse,
    bridgeCalls,
    keyboardCalls,
    clipboard,
    settle,
    // The window gains or loses the focus: document.hasFocus() answers, then the
    // window's own event fires.
    setWindowFocus: (on) => {
      windowFocus = on;
      (windowListeners[on ? "focus" : "blur"] ?? []).forEach((l) =>
        l({ type: on ? "focus" : "blur" }),
      );
    },
    // The page enters or leaves HTML full screen (the document's own state).
    setHtmlFullscreen: (on) => {
      document.fullscreenElement = on ? document.documentElement : null;
      (documentListeners.fullscreenchange ?? []).forEach((l) =>
        l({ type: "fullscreenchange" }),
      );
    },
    // A key event for the page's window listeners, in listener order; a listener that
    // calls stopImmediatePropagation ends the delivery, as in a browser.
    windowKey: (type, init = {}) => {
      const event = {
        type,
        key: "F11",
        repeat: false,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          event.stopped = true;
        },
        ...init,
      };
      for (const listener of windowListeners[type] ?? []) {
        if (event.stopped) break;
        listener(event);
      }
      return event;
    },
    // The viewer element changes size (CSS pixels): every live observer is told.
    resizeViewport: (width, height) => {
      el("viewport").clientWidth = width;
      el("viewport").clientHeight = height;
      for (const observer of observers)
        if (observer.active) observer.callback();
    },
    setPixelRatio: (ratio) => {
      window.devicePixelRatio = ratio;
    },
    advance,
    pendingTimers: () => timers.size,
    sessionRequests: () =>
      fetches.filter((f) => f.path === "/api/sessions").map((f) => f.body),
    action: (name) => actionListener?.(name),
    // Delivers an event to the listeners the page registered on the window (blur).
    windowEvent: (type) =>
      (windowListeners[type] ?? []).forEach((l) => l({ type })),
    posts: () => fetches.filter((f) => f.path === "/api/sessions").length,
    agentRequests: () =>
      fetches
        .filter((f) => f.path === "/api/agent-sessions")
        .map((f) => f.body),
    gets: () => fetches.filter((f) => f.path === "/api/targets").length,
    tiles: () => el("tiles").children,
  };
}
