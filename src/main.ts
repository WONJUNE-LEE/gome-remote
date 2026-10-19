import Guacamole from "../vendor/guacamole.js";
import { ApiError, api, appMode, autoResolution } from "./api";
import { createAgentSession, type AgentSession } from "./agent";
import { endText, startFailureReason } from "./agent-messages";
import { localClipboardFor } from "./clipboard-local";
import {
  MAX_CLIPBOARD_BYTES,
  NOTICE_TEXT,
  createClipboardSync,
  type ClipboardSync,
  type NoticeKey,
  utf8Length,
} from "./clipboard-sync";
import { connectFailure, createSessionFlow, errorScreen } from "./flow";
import { KEY_LOCK_NOTICE, createKeyLock } from "./keyboard-lock";
import { guacamoleSource, initMeasure, videoSource } from "./measure";
import { createResolution, sizeFor } from "./resolution";
import {
  connectingText,
  platformClass,
  stateText,
  tileEnabled,
  tileState,
} from "./tiles";
import "./style.css";

const monitor =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4"/></svg>';
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <section id="home" class="home" hidden>
    <header class="home-bar">
      <h1>Gome Remote</h1>
      <div class="menu-wrap">
        <button id="menu-button" class="icon-button" aria-label="메뉴" aria-haspopup="menu" aria-expanded="false">⋯</button>
        <div id="menu" class="menu" role="menu" hidden>
          <button id="menu-refresh" role="menuitem">새로고침</button>
          <button id="menu-address" role="menuitem" hidden>서버 주소 바꾸기</button>
        </div>
      </div>
    </header>
    <div id="tiles" class="tiles"></div>
  </section>
  <section id="state" class="state">
    <div id="state-spinner" class="spinner" role="status" aria-label="불러오는 중"></div>
    <h2 id="state-title" hidden></h2>
    <div id="state-actions" class="actions" hidden>
      <button id="state-retry" class="primary">다시 시도</button>
      <button id="state-address" hidden>서버 주소 바꾸기</button>
    </div>
  </section>
  <section id="session" class="session" hidden>
    <div id="session-tools" class="session-toolbar browser-only">
      <button id="back">← 목록</button>
      <span id="session-title" class="session-title"></span>
      <span id="session-state" class="session-state"></span>
      <div class="toolbar-spacer"></div>
      <label class="sr-only" for="resolution">해상도</label>
      <select id="resolution"><option value="auto">자동 (창 크기)</option><option value="1440x900">1440 × 900</option><option value="1920x1080">1920 × 1080</option><option value="2560x1440">2560 × 1440</option></select>
      <button id="paste-remote" disabled>클립보드 붙여넣기</button>
      <button id="text-input" disabled>텍스트 입력</button>
      <button id="fullscreen">전체 화면</button>
      <button id="disconnect" class="danger">연결 종료</button>
    </div>
    <div id="viewport" class="viewport">
      <div id="notice" class="notice" role="status" hidden></div>
      <div id="overlay" class="overlay">
        <div id="overlay-spinner" class="spinner"></div>
        <h2 id="overlay-title"></h2>
        <p id="overlay-detail" hidden>작업은 그대로 남아 있습니다</p>
        <div id="overlay-actions" class="actions" hidden>
          <button id="overlay-reconnect" class="primary">다시 연결</button>
          <button id="overlay-back">목록으로</button>
        </div>
      </div>
      <div id="display" class="display"></div>
    </div>
  </section>
  <dialog id="viewer-error"><p id="viewer-error-text"></p><button data-close="viewer-error">닫기</button></dialog>
  <dialog id="text-dialog"><form id="text-form"><div class="dialog-heading"><h2>원격 화면에 텍스트 입력</h2><button type="button" class="close-button" data-close="text-dialog" aria-label="닫기">×</button></div><p class="muted">원격 앱의 입력 위치를 먼저 선택하세요</p><textarea id="remote-text" rows="5" maxlength="4000" aria-label="보낼 텍스트"></textarea><button class="primary wide" type="submit">입력하기 →</button></form></dialog>
`;
function el<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
let targets: Target[] = [];
let listGeneration = 0;
let selected: Target | undefined;
let generation = 0;
let client: any;
// The Mac (agent) session, when the open target is one; it replaces `client` for that target.
let agent: AgentSession | undefined;
let keyboard: any;
// The clipboard sync of the open Mac session (a new one for every session), and whether the
// remote view counted as focused when it was last evaluated.
let sync: ClipboardSync | undefined;
let syncFocused = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let resizeObserver: ResizeObserver | undefined;
let releaseMouse: (() => void) | undefined;
// When a connection may start, and what the session knows about its last attempt.
const flow = createSessionFlow({
  begin: (input) => void connect(input),
  ended: (reason) => sessionEnded(reason),
});
// What size the remote gets: the picker's choice, or the window's size for "auto".
const resolution = createResolution({
  send: (size) => {
    client?.sendSize(size.width, size.height);
    agent?.sendSize(size.width, size.height);
  },
  viewport: () => ({
    width: el("viewport").clientWidth,
    height: el("viewport").clientHeight,
    ratio: window.devicePixelRatio,
  }),
});
let fullscreen = false;
document.body.classList.toggle("app-mode", appMode);
// Apps with bridge version 1 reject "auto" in viewerState. Without it the select starts
// on 1440x900, as it did before "auto" existed.
if (!autoResolution) {
  const select = el<HTMLSelectElement>("resolution");
  select.remove(
    Array.from(select.options).findIndex((o) => o.value === "auto"),
  );
}
el("menu-address").hidden = !appMode;
el("state-address").hidden = !appMode;

type Screen = "home" | "state" | "session";
function showScreen(screen: Screen) {
  for (const name of ["home", "state", "session"] as Screen[])
    el(name).hidden = name !== screen;
}
function showLoading() {
  showScreen("state");
  el("state-spinner").hidden = false;
  el("state-title").hidden = true;
  el("state-actions").hidden = true;
}
// The screens for a failure are decided in flow.ts. "다시 시도" is shown on both: a
// refused login can be fixed by switching the Tailscale account on this device.
function showFailure(kind: string | undefined) {
  const screen = errorScreen(kind, appMode);
  showScreen("state");
  el("state-spinner").hidden = true;
  el("state-title").hidden = false;
  el("state-actions").hidden = false;
  el("state-title").textContent = screen.title;
  el("state-address").hidden = !screen.showAddressButton;
}

function syncViewerMenu() {
  void api
    .viewerState({
      open: !el("session").hidden,
      connected: flow.active,
      protocol: selected?.protocol || null,
      resolution: el<HTMLSelectElement>("resolution").value,
    })
    .catch(() =>
      showViewerError("원격 메뉴를 갱신하지 못했습니다. 앱을 다시 열어주세요."),
    );
}
function showViewerError(message: string) {
  releaseInput();
  el("viewer-error-text").textContent = message;
  const dialog = el<HTMLDialogElement>("viewer-error");
  if (!dialog.open) dialog.showModal();
}
function fullscreenChanged(enabled: boolean) {
  releaseInput();
  fullscreen = enabled;
  el("fullscreen").textContent = enabled
    ? "전체화면 나가기 · F11"
    : "전체 화면 · F11";
}
async function setFullscreen(enabled: boolean) {
  releaseInput();
  el<HTMLDialogElement>("viewer-error").close();
  try {
    await api.fullscreen(enabled);
  } catch {
    showViewerError("전체화면을 변경하지 못했습니다. 다시 시도해주세요.");
  }
}
api.onFullscreenChange(fullscreenChanged);
void api.fullscreenState().then(fullscreenChanged);
// The Windows key lock exists only in the Windows desktop app (the bridge says so); other
// apps and browsers never create it and keep today's F11 and keys.
const keyLock = api.keyLockSupported
  ? createKeyLock({
      supported: true,
      enterHtml: () => api.keyLock(true),
      exitHtml: () => api.keyLock(false),
      lock: () =>
        navigator.keyboard ? navigator.keyboard.lock() : Promise.reject(),
      unlock: () => navigator.keyboard?.unlock(),
      isHtmlFullscreen: () => !!document.fullscreenElement,
      notify: (key) => showNoticeText(KEY_LOCK_NOTICE[key]),
      log: (reason) => console.warn(`key lock: ${reason}`),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (id) => clearTimeout(id as number),
    })
  : undefined;
// The lock is wanted while a session is shown and this window has the focus.
function updateKeyLock() {
  keyLock?.update({ session: flow.active, focused: document.hasFocus() });
}
if (keyLock) {
  document.addEventListener("fullscreenchange", () =>
    keyLock.fullscreenChanged(),
  );
  // A click on the remote view takes the lock again after hold-Escape.
  el("display").addEventListener("mousedown", () => keyLock.click(), true);
  // While the lock is held the page, not the app's main process, receives F11, and it
  // toggles the window's native full screen; the remote never sees the key.
  const heldF11 = (event: KeyboardEvent) => {
    if (!keyLock.held || event.key !== "F11") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat)
      void setFullscreen(!fullscreen);
  };
  window.addEventListener("keydown", heldF11, true);
  window.addEventListener("keyup", heldF11, true);
}
// Browser fallback: the desktop app reserves F11 in its main process instead.
if (!appMode) {
  const localShortcut = (event: KeyboardEvent) => {
    if (event.key !== "F11") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat)
      void setFullscreen(!document.fullscreenElement);
  };
  window.addEventListener("keydown", localShortcut, true);
  window.addEventListener("keyup", localShortcut, true);
}

async function refresh() {
  const current = ++listGeneration;
  closeMenu();
  showLoading();
  try {
    const result = await api.targets();
    if (current !== listGeneration) return;
    targets = result.targets;
    renderTargets();
    showScreen("home");
  } catch (error) {
    if (current !== listGeneration) return;
    targets = [];
    showFailure(error instanceof ApiError ? error.kind : undefined);
  }
}
function renderTargets() {
  const grid = el("tiles");
  grid.replaceChildren();
  for (const target of targets) {
    const state = tileState(target);
    const tile = document.createElement("button");
    tile.className = `tile is-${state}`;
    tile.disabled = !tileEnabled(target);
    tile.innerHTML = `<span class="tile-art platform-${platformClass(target.platform)}">${monitor}</span><span class="tile-meta"><span class="dot"></span><span class="tile-name"></span></span><span class="tile-state"></span>`;
    tile.querySelector(".tile-name")!.textContent = target.name;
    tile.querySelector(".tile-state")!.textContent = stateText(target, state);
    tile.onclick = () => openTarget(target);
    grid.append(tile);
  }
}
function openTarget(target: Target) {
  if (!targets.includes(target) || !tileEnabled(target)) return;
  selected = target;
  // The session screen is still hidden, so "auto" is measured again when the session starts.
  const { width, height } = sizeFor(el<HTMLSelectElement>("resolution").value, {
    width: 0,
    height: 0,
    ratio: 1,
  });
  flow.open({ targetId: target.id, width, height });
}
// A short, non-blocking message about the clipboard. Only the fixed text of the notice
// is shown: never the clipboard's own text.
const NOTICE_MS = 4000;
function hideNotice() {
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  noticeTimer = undefined;
  el("notice").hidden = true;
  el("notice").textContent = "";
}
function showNotice(key: NoticeKey) {
  showNoticeText(NOTICE_TEXT[key]);
}
function showNoticeText(text: string | undefined) {
  if (!text) return;
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  el("notice").textContent = text;
  el("notice").hidden = false;
  noticeTimer = setTimeout(hideNotice, NOTICE_MS);
}
// The remote view is focused while this window has the focus and the session shows a picture.
function updateSyncFocus(opts?: { read?: boolean }) {
  syncFocused = !!sync && document.hasFocus() && flow.active;
  sync?.setViewFocused(syncFocused, opts);
}
function releaseInput() {
  agent?.release();
  keyboard?.reset();
  releaseMouse?.();
  el("display")
    .querySelector(".remote-surface")
    ?.classList.remove("remote-pointer-active");
}
function stop() {
  generation++;
  releaseInput();
  // Guacamole: keys and mouse held behind a paste go out (in order, before the connection
  // closes) so the remote is not left with a key down. The Mac channel drops them instead.
  if (client) sync?.flush();
  flow.stopped();
  keyLock?.end();
  resolution.stopped();
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  if (client) {
    client.onstatechange = null;
    client.onerror = null;
    client.disconnect();
  }
  client = undefined;
  agent?.close();
  agent = undefined;
  // After the session is closed: keys still held for a paste are dropped with the channel.
  sync?.end();
  sync = undefined;
  syncFocused = false;
  hideNotice();
  keyboard = undefined;
  releaseMouse = undefined;
  el("display").classList.remove("agent-display");
  el("display").replaceChildren();
  el<HTMLButtonElement>("text-input").disabled = true;
  el<HTMLButtonElement>("paste-remote").disabled = true;
}
function showOverlay(
  kind: "connecting" | "ended",
  text?: { title: string; detail: string },
) {
  const ended = kind === "ended";
  el("overlay").hidden = false;
  el("overlay-spinner").hidden = ended;
  el("overlay-title").textContent = ended
    ? (text?.title ?? "연결이 끊겼습니다")
    : connectingText(selected?.name || "원격 데스크톱");
  el("overlay-detail").textContent =
    text?.detail ?? "작업은 그대로 남아 있습니다";
  el("overlay-detail").hidden = !ended;
  el("overlay-actions").hidden = !ended;
}
function sessionEnded(reason?: string) {
  releaseInput();
  flow.stopped();
  sync?.end();
  sync = undefined;
  syncFocused = false;
  keyLock?.end();
  resolution.stopped();
  el("session-state").textContent = "연결 종료";
  showOverlay("ended", endText(reason));
  el("display")
    .querySelector(".remote-surface")
    ?.classList.remove("remote-connected");
  syncViewerMenu();
  el<HTMLButtonElement>("text-input").disabled = true;
  el<HTMLButtonElement>("paste-remote").disabled = true;
}
async function connect(input: ConnectInput) {
  stop();
  const current = generation;
  document.body.classList.add("viewing");
  el<HTMLDialogElement>("viewer-error").close();
  el("session-title").textContent = selected?.name || "원격 데스크톱";
  showScreen("session");
  syncViewerMenu();
  el("session-state").textContent = "연결 중";
  showOverlay("connecting");
  // Both RDP and the Mac agent can follow the window size; macOS VNC cannot.
  const resizable =
    selected?.protocol === "rdp" || selected?.protocol === "agent";
  el<HTMLSelectElement>("resolution").disabled = !resizable;
  // The screen is visible now, so "auto" can be measured: the window, in device pixels.
  const size = resolution.choose(el<HTMLSelectElement>("resolution").value);
  flow.resize(size.width, size.height);
  resolution.begin(size, resizable);
  if (selected?.protocol === "agent") {
    await connectAgent(input, size, current);
    return;
  }
  try {
    const result = await api.connect({ ...input, ...size });
    if (current !== generation) return;
    const tunnel = new Guacamole.WebSocketTunnel(result.websocket);
    const connection = new Guacamole.Client(tunnel);
    client = connection;
    const display = connection.getDisplay();
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    surface.className = "remote-surface";
    surface.setAttribute("aria-label", "원격 데스크톱 화면");
    // Incoming server mouse instructions can reattach the cursor layer. CSS owns
    // final visibility so delayed messages cannot steal local cursor ownership.
    display.getCursorLayer().getElement().classList.add("remote-cursor");
    surface.append(display.getElement());
    el("display").append(surface);
    const fit = () => {
      if (!display.getWidth() || !display.getHeight()) return;
      display.scale(
        Math.min(
          el("viewport").clientWidth / display.getWidth(),
          el("viewport").clientHeight / display.getHeight(),
        ),
      );
    };
    display.onresize = fit;
    resizeObserver = new ResizeObserver(() => {
      fit();
      resolution.viewportChanged();
    });
    resizeObserver.observe(el("viewport"));
    // Only where there is a local clipboard to sync (the app with bridge 4 or later, or a
    // browser with navigator.clipboard).
    const local = localClipboardFor();
    let thisSync: ClipboardSync | undefined;
    if (local) {
      thisSync = sync = createClipboardSync({
        local,
        remote: {
          sendClipboard: (text) => {
            if (current !== generation || client !== connection)
              return "closed";
            try {
              return sendRemoteClipboard(text);
            } catch {
              return "closed";
            }
          },
        },
        target: selected?.platform === "mac" ? "mac" : "other",
        notify: (key) => {
          if (current === generation) showNotice(key);
        },
        setTimeout: ((callback: () => void, ms?: number) =>
          setTimeout(callback, ms)) as typeof setTimeout,
        clearTimeout: ((id?: ReturnType<typeof setTimeout>) =>
          clearTimeout(id)) as typeof clearTimeout,
      });
    }
    // Everything sent to the remote waits behind a paste in progress (the paste barrier).
    const gated = (run: () => void) => (thisSync ? thisSync.gate(run) : run());
    // The remote computer's clipboard text, written to the local clipboard once complete.
    // Without a local clipboard (old app, no permission) the remote clipboard is not handled.
    if (thisSync)
      connection.onclipboard = (stream: any, mimetype: string) => {
        if (mimetype !== "text/plain") return;
        const reader = new Guacamole.StringReader(stream);
        let text = "";
        let tooLarge = false;
        reader.ontext = (chunk: string) => {
          // 64 KiB of UTF-8 is at most that many UTF-16 units: beyond it, stop collecting.
          if (tooLarge) return;
          text += chunk;
          if (text.length > MAX_CLIPBOARD_BYTES) {
            tooLarge = true;
            text = "";
          }
        };
        reader.onend = () => {
          if (current !== generation || !thisSync) return;
          if (tooLarge || utf8Length(text) > MAX_CLIPBOARD_BYTES)
            thisSync.remoteSkipped("too-large");
          else thisSync.remoteClipboard(text, false);
        };
      };
    const mouse = new Guacamole.Mouse(display.getElement());
    let mouseState: any;
    mouse.onmousedown =
      mouse.onmouseup =
      mouse.onmousemove =
        (state: any) => {
          if (!flow.active) return;
          surface.classList.add("remote-pointer-active");
          mouseState = state;
          surface.focus({ preventScroll: true });
          // Guacamole.Mouse reuses and mutates one state object (a wheel step presses and
          // releases in one go): a held event must keep the state it had.
          const snapshot = { ...state };
          gated(() => {
            if (flow.active) connection.sendMouseState(snapshot, true);
          });
        };
    mouse.onmouseout = () => surface.classList.remove("remote-pointer-active");
    // Guacamole deduplicates moves to the last coordinate, including re-entry.
    surface.addEventListener("mouseenter", () => {
      if (flow.active) surface.classList.add("remote-pointer-active");
    });
    releaseMouse = () => {
      if (flow.active && mouseState)
        gated(() => {
          if (flow.active)
            connection.sendMouseState(
              {
                ...mouseState,
                left: false,
                middle: false,
                right: false,
                up: false,
                down: false,
              },
              true,
            );
        });
    };
    // Registered before the Guacamole keyboard's own listener: the paste barrier is open
    // when that listener sends the V.
    surface.addEventListener("keydown", (event: KeyboardEvent) => {
      try {
        thisSync?.pasteShortcut(event);
      } catch {
        // the paste decision failing must not lose the key
      }
    });
    keyboard = new Guacamole.Keyboard(surface);
    keyboard.onkeydown = (keysym: number) => {
      gated(() => {
        if (flow.active) connection.sendKeyEvent(1, keysym);
      });
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      gated(() => {
        if (flow.active) connection.sendKeyEvent(0, keysym);
      });
    };
    surface.addEventListener("blur", releaseInput);
    connection.onerror = () => {
      if (current === generation) flow.ended();
    };
    tunnel.onerror = () => {
      if (current === generation) flow.ended();
    };
    connection.onstatechange = (state: number) => {
      if (current !== generation) return;
      if (state === 3) {
        flow.connected();
        updateKeyLock();
        resolution.connected();
        surface.classList.add("remote-connected");
        syncViewerMenu();
        el("session-state").textContent = "연결됨";
        el("overlay").hidden = true;
        el<HTMLButtonElement>("text-input").disabled = false;
        el<HTMLButtonElement>("paste-remote").disabled = !thisSync;
        surface.focus();
        fit();
        // Session start pushes nothing: the clipboard is not read.
        updateSyncFocus({ read: false });
      } else if (state === 5) flow.ended();
    };
    connection.connect(`ticket=${encodeURIComponent(result.ticket)}`);
  } catch (error) {
    if (current !== generation) return;
    const kind = error instanceof ApiError ? error.kind : undefined;
    if (connectFailure(kind) === "forbidden") {
      back(false);
      showFailure(kind);
    } else flow.ended();
  }
}
// Puts text on the remote computer's clipboard (the Guacamole clipboard stream).
function sendRemoteClipboard(text: string): "sent" {
  const writer = new Guacamole.StringWriter(
    client.createClipboardStream("text/plain"),
  );
  writer.sendText(text);
  writer.sendEnd();
  return "sent";
}
// The keys that paste on the remote computer: Command (Meta) on a Mac, Control elsewhere,
// then V.
function pasteKeysFor(platform: string | undefined): [number, number] {
  return [platform === "mac" ? 0xffe7 : 0xffe3, 0x76];
}
// A Mac (agent) session: WebRTC video and input straight to the Mac, set up through the
// gateway (src/agent.ts). The flow, the overlay, the menu and the fullscreen handling are
// the ones the Guacamole path uses.
async function connectAgent(
  input: ConnectInput,
  size: { width: number; height: number },
  current: number,
) {
  // Only where there is a local clipboard to sync (the app with bridge 4 or later, or a
  // browser with navigator.clipboard).
  const local = localClipboardFor();
  let thisSync: ClipboardSync | undefined;
  const session = createAgentSession({
    signal: (sdp) =>
      api.agentSession({
        targetId: input.targetId,
        width: size.width,
        height: size.height,
        sdp,
      }),
    onFirstFrame: () => {
      if (current !== generation) return;
      flow.connected();
      updateKeyLock();
      resolution.connected();
      session.element.classList.add("agent-connected");
      syncViewerMenu();
      el("session-state").textContent = "연결됨";
      el("overlay").hidden = true;
      el<HTMLButtonElement>("text-input").disabled = false;
      el<HTMLButtonElement>("paste-remote").disabled = !thisSync;
      session.focus();
      // Session start pushes nothing: the watch goes on, the clipboard is not read.
      updateSyncFocus({ read: false });
    },
    onEnded: (reason) => {
      if (current === generation) flow.ended(reason);
    },
    gate: (run) => (thisSync ? thisSync.gate(run) : run()),
    onPasteKey: (event) => thisSync?.pasteShortcut(event),
    // A watch switched on before the channel was open went nowhere: say it again.
    onChannelOpen: () => {
      if (current === generation && syncFocused) session.sendWatch(true);
    },
    onAgentMessage: (m) => {
      if (current !== generation || !thisSync) return;
      if (m.type === "lock") thisSync.setRemoteLocked(m.locked);
      else if (m.type === "clipboard")
        thisSync.remoteClipboard(m.text, m.concealed);
      else thisSync.remoteSkipped(m.reason);
    },
  });
  if (local) {
    thisSync = sync = createClipboardSync({
      local,
      remote: session,
      target: "mac",
      notify: (key) => {
        if (current === generation) showNotice(key);
      },
      setTimeout: ((callback: () => void, ms?: number) =>
        setTimeout(callback, ms)) as typeof setTimeout,
      clearTimeout: ((id?: ReturnType<typeof setTimeout>) =>
        clearTimeout(id)) as typeof clearTimeout,
    });
  }
  agent = session;
  el("display").classList.add("agent-display");
  el("display").append(session.element);
  resizeObserver = new ResizeObserver(() => resolution.viewportChanged());
  resizeObserver.observe(el("viewport"));
  try {
    await session.start();
  } catch (error) {
    if (current !== generation) return;
    const kind = error instanceof ApiError ? error.kind : undefined;
    if (connectFailure(kind) === "forbidden") {
      back(false);
      showFailure(kind);
    } else flow.ended(startFailureReason(error));
  }
}
function back(reload = true) {
  stop();
  document.body.classList.remove("viewing");
  el<HTMLDialogElement>("viewer-error").close();
  void setFullscreen(false);
  flow.discard();
  el<HTMLSelectElement>("resolution").disabled = false;
  showScreen("home");
  syncViewerMenu();
  if (reload) void refresh();
}
function disconnect() {
  stop();
  flow.ended();
}
// The 클립보드 붙여넣기 menu item and bar button: the paste barrier sends the changed local
// clipboard, then the paste keys go out behind it. Called straight from the click or the
// menu action (nothing awaited before it) so the window is still focused for the read.
function pasteClipboard() {
  if (!flow.active || !sync) return;
  if (agent) {
    const session = agent;
    sync.pasteFromMenu(() => session.pasteShortcut());
    return;
  }
  const connection = client;
  if (!connection) return;
  const [modifier, v] = pasteKeysFor(selected?.platform);
  sync.pasteFromMenu(() => {
    connection.sendKeyEvent(1, modifier);
    connection.sendKeyEvent(1, v);
    connection.sendKeyEvent(0, v);
    connection.sendKeyEvent(0, modifier);
  });
}
function openTextDialog() {
  if (!flow.active) return;
  releaseInput();
  el<HTMLDialogElement>("text-dialog").showModal();
  el("remote-text").focus();
}

function closeMenu() {
  el("menu").hidden = true;
  el("menu-button").setAttribute("aria-expanded", "false");
}
el("menu-button").onclick = (event) => {
  event.stopPropagation();
  const open = el("menu").hidden;
  el("menu").hidden = !open;
  el("menu-button").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
el("menu-refresh").onclick = () => void refresh();
el("menu-address").onclick = el("state-address").onclick = () => {
  closeMenu();
  void api.openSetup();
};
el("state-retry").onclick = () => void refresh();
el("back").onclick = el("overlay-back").onclick = () => back();
el("disconnect").onclick = disconnect;
el("overlay-reconnect").onclick = () => flow.reconnect();
el("fullscreen").onclick = () => {
  void setFullscreen(!fullscreen);
};
el<HTMLSelectElement>("resolution").onchange = () => {
  releaseInput();
  syncViewerMenu();
  const size = resolution.choose(el<HTMLSelectElement>("resolution").value);
  flow.resize(size.width, size.height);
};
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach((button) => {
    button.onclick = () => el<HTMLDialogElement>(button.dataset.close!).close();
  });
el("text-input").onclick = openTextDialog;
el("paste-remote").onclick = () => {
  pasteClipboard();
  // Typing goes to the remote screen again, and Space/Enter do not press the button twice.
  if (agent) agent.focus();
  else
    el("display")
      .querySelector<HTMLElement>(".remote-surface")
      ?.focus({ preventScroll: true });
};
el<HTMLFormElement>("text-form").onsubmit = (event) => {
  event.preventDefault();
  if (flow.active) {
    const text = el<HTMLTextAreaElement>("remote-text").value;
    if (text && agent) {
      // The agent types the characters itself; the Mac clipboard is never touched.
      agent.sendText(text);
    } else if (text) {
      sendRemoteClipboard(text);
      // The remote clipboard now holds this text, not what the sync last sent. It is the
      // baseline: the remote announcing it back (it may be a password) is not written to
      // the local clipboard, and a different local clipboard is still sent at the next paste.
      sync?.markSynced(text);
      // Clipboard transfer supports characters absent from the remote keyboard layout.
      const [modifier, v] = pasteKeysFor(selected?.platform);
      client.sendKeyEvent(1, modifier);
      client.sendKeyEvent(1, v);
      client.sendKeyEvent(0, v);
      client.sendKeyEvent(0, modifier);
    }
  }
  el<HTMLTextAreaElement>("remote-text").value = "";
  el<HTMLDialogElement>("text-dialog").close();
};
api.onViewerAction((action) => {
  if (el("session").hidden) return;
  releaseInput();
  if (action.startsWith("resolution:")) {
    if (
      !flow.active ||
      (selected?.protocol !== "rdp" && selected?.protocol !== "agent")
    )
      return;
    const select = el<HTMLSelectElement>("resolution");
    const size = action.slice("resolution:".length);
    if (!Array.from(select.options).some((option) => option.value === size))
      return;
    select.value = size;
    select.dispatchEvent(new Event("change"));
  } else if (action === "back") back();
  else if (action === "disconnect") disconnect();
  else if (action === "reconnect") flow.reconnect();
  else if (action === "text-input") openTextDialog();
  else if (action === "paste-clipboard") pasteClipboard();
});
window.addEventListener("blur", releaseInput);
window.addEventListener("focus", () => updateSyncFocus());
window.addEventListener("blur", () => updateSyncFocus());
window.addEventListener("focus", updateKeyLock);
window.addEventListener("blur", updateKeyLock);
window.addEventListener("beforeunload", stop);
// Measurement mode: does nothing unless the address has #measure (src/measure.ts).
initMeasure({
  hash: location.hash,
  source: () =>
    agent
      ? videoSource(agent.video, (fx, fy) => agent?.clickAt(fx, fy))
      : client
        ? guacamoleSource(client, el("display"))
        : undefined,
  soak: (ms) => agent?.watchFrames(ms),
});
void refresh();
