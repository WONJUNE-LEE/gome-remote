import { loadTs } from "./load-ts.js";

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

export async function viewer({ appMode = false, targets, fetchHandler } = {}) {
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
  };
  const bridgeCalls = { viewerState: [], openSetup: 0 };
  let actionListener;
  const desktop = appMode
    ? {
        bridgeVersion: 1,
        fullscreen: async () => {},
        fullscreenState: async () => false,
        onFullscreenChange: () => () => {},
        viewerState: async (state) => {
          bridgeCalls.viewerState.push(state);
        },
        onViewerAction: (callback) => {
          actionListener = callback;
          return () => {};
        },
        openSetup: async () => {
          bridgeCalls.openSetup++;
        },
      }
    : undefined;
  const window = { desktop, addEventListener() {} };

  const defaultFetch = async (path, init) => {
    if (path === "/api/targets")
      return { status: 200, ok: true, json: async () => ({ targets }) };
    return {
      status: 201,
      ok: true,
      json: async () => ({ ticket: "ticket-1" }),
    };
  };
  const fetch = async (path, init = {}) => {
    fetches.push({ path, method: init.method ?? "GET" });
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
    sendSize() {}
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
  await loadTs(
    "main.ts",
    {
      window,
      document,
      Event,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
    {
      "../vendor/guacamole.js": { __esModule: true, default: Guacamole },
      "./api": api,
      "./tiles": tiles,
      "./flow": flow,
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
    bridgeCalls,
    settle,
    action: (name) => actionListener?.(name),
    posts: () => fetches.filter((f) => f.path === "/api/sessions").length,
    gets: () => fetches.filter((f) => f.path === "/api/targets").length,
    tiles: () => el("tiles").children,
  };
}
