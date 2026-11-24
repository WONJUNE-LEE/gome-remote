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
  metaText,
  stateText,
  tileEnabled,
  tileState,
} from "./tiles";
import "./style.css";

// Inline stroke icons (currentColor), one per platform and one per bar tool.
const svg = (body: string, size = 22, width = 1.6) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const platformIcon: Record<Target["platform"], string> = {
  linux: svg(
    '<rect x="4" y="3.5" width="16" height="7" rx="2"/><rect x="4" y="13.5" width="16" height="7" rx="2"/><path d="M8 7h.01M8 17h.01"/>',
  ),
  mac: svg(
    '<rect x="5" y="5" width="14" height="10" rx="2"/><path d="M3 19h18"/>',
  ),
  windows: svg(
    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  ),
};
const appMark = `<span class="app-mark">${svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>', 12, 2.4)}</span>`;
const settingsIcon = svg(
  '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  18,
);
const pasteIcon = svg(
  '<rect x="7" y="4" width="10" height="4" rx="1"/><path d="M7 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1"/>',
  15,
  1.7,
);
const keyboardIcon = svg(
  '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  15,
  1.7,
);
const fullscreenIcon = svg(
  '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  15,
  1.7,
);
const plusIcon = svg('<path d="M12 5v14M5 12h14"/>', 16, 1.8);
const moreIcon = svg(
  '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  18,
);
const backIcon = svg('<path d="M15 6l-6 6 6 6"/>', 16, 1.8);
// The Mac agent's install guide, opened in the OS browser (the app sends links there).
const INSTALL_GUIDE =
  "https://github.com/WONJUNE-LEE/gome-remote#the-mac-agent";
const KEY_HELP =
  "설치 마지막에 한 번 표시된 43자 키를 붙여 넣으세요. 키는 서버에만 저장되고 다시 보여 주지 않습니다.";
const LOGIN_HELP =
  "시스템 원격 로그인 값입니다(데스크톱 계정 비밀번호가 아닙니다).";
const powerIcon = svg(
  '<path d="M12 3v9"/><path d="M6.3 7.5a8 8 0 1 0 11.4 0"/>',
  14,
  2,
);
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header id="topbar" class="topbar">
    <div id="bar-home" class="bar-home">${appMark}<span class="bar-app">Gome Remote</span></div>
    <div id="bar-session" class="bar-session" hidden>
      <div class="bar-target"><span class="dot"></span><span id="session-title" class="session-title"></span><span id="session-state" class="session-state"></span></div>
      <nav class="bar-tools" aria-label="원격 도구">
        <button id="paste-remote" class="bar-button" disabled>${pasteIcon}<span>붙여넣기</span></button>
        <button id="text-input" class="bar-button" disabled>${keyboardIcon}<span>텍스트 입력</span></button>
        <label class="bar-select"><span>해상도</span><select id="resolution"><option value="auto">자동 (창 크기)</option><option value="1440x900">1440 × 900</option><option value="1920x1080">1920 × 1080</option><option value="2560x1440">2560 × 1440</option></select></label>
        <button id="fullscreen" class="bar-button" title="F11">${fullscreenIcon}<span id="fullscreen-label">전체 화면</span></button>
        <span class="bar-separator" aria-hidden="true"></span>
        <button id="disconnect" class="bar-danger">${powerIcon}<span>연결 끊기</span></button>
      </nav>
    </div>
  </header>
  <section id="home" class="home" hidden>
    <div class="home-inner">
      <div class="home-head">
        <div class="home-heading">
          <h1>기기</h1>
          <p class="muted">한 번에 한 기기에만 연결됩니다. 다른 기기로 가려면 먼저 연결을 끊으세요.</p>
        </div>
        <div class="home-tools">
        <button id="add-device" class="add-button">${plusIcon}<span>기기 추가</span></button>
        <div class="menu-wrap">
          <button id="menu-button" class="icon-button" aria-label="설정" aria-haspopup="menu" aria-expanded="false">${settingsIcon}</button>
          <div id="menu" class="menu" role="menu" hidden>
            <button id="menu-refresh" role="menuitem">새로고침</button>
            <button id="menu-address" role="menuitem" hidden>서버 주소 바꾸기</button>
            <button id="menu-update" role="menuitem" hidden>업데이트 확인</button>
            <button id="menu-restart" role="menuitem" hidden></button>
          </div>
        </div>
        </div>
      </div>
      <div id="devices" class="device-list"></div>
    </div>
  </section>
  <section id="device" class="device-page" hidden>
    <div class="device-page-inner">
      <button id="device-back" class="back-link">${backIcon}<span>기기</span></button>
      <div id="device-head" class="device-head">
        <span id="device-icon" class="device-icon page-icon"></span>
        <div class="device-heading"><h1 id="device-title"></h1><span class="device-state"><span class="dot"></span><span id="device-word"></span></span></div>
      </div>
      <form id="device-form" class="device-form">
        <section class="panel" aria-label="기본 정보">
          <div class="field-row"><label for="device-name">이름</label><input id="device-name" type="text" maxlength="100" required autocomplete="off" /></div>
          <div class="field-row"><span>종류</span><span id="device-kind" class="muted"></span></div>
          <div class="field-row"><span>주소</span><span class="field-value"><span id="device-address" class="muted"></span><span class="help">주소가 바뀌었으면 기기를 지우고 다시 추가하세요.</span></span></div>
        </section>
        <section class="panel action-row" aria-label="로그인 정보">
          <div class="action-text"><span id="credential-title" class="action-title"></span><span id="credential-note" class="help"></span></div>
          <button id="credential-change" type="button">바꾸기</button>
        </section>
        <section class="panel action-row" aria-label="기기 삭제">
          <div class="action-text"><span class="action-title">기기 삭제</span><span class="help">목록과 저장된 로그인 정보를 지웁니다. 기기 자체는 건드리지 않습니다.</span></div>
          <button id="device-delete" type="button" class="danger-outline">삭제</button>
        </section>
        <p id="device-error" class="form-error" role="alert" hidden></p>
        <div class="page-actions"><button id="device-save" class="primary" type="submit">저장</button></div>
      </form>
    </div>
  </section>
  <section id="state" class="state">
    <div class="state-card">
      <div id="state-spinner" class="spinner" role="status" aria-label="불러오는 중"></div>
      <h2 id="state-title" hidden></h2>
      <div id="state-actions" class="actions" hidden>
        <button id="state-address" hidden>서버 주소 바꾸기</button>
        <button id="state-retry" class="primary">다시 시도</button>
      </div>
    </div>
  </section>
  <section id="session" class="session" hidden>
    <div id="viewport" class="viewport">
      <div id="notice" class="notice" role="status" hidden></div>
      <div id="overlay" class="overlay">
        <div class="overlay-head">
          <span id="overlay-icon" class="device-icon"></span>
          <div class="overlay-heading"><h2 id="overlay-title"></h2><span id="overlay-meta" class="muted"></span></div>
        </div>
        <div id="overlay-spinner" class="overlay-progress" role="status"><span class="spinner small"></span><span>원격 화면을 여는 중입니다</span></div>
        <p id="overlay-detail" hidden>작업은 그대로 남아 있습니다</p>
        <p id="overlay-note" class="note" hidden>다음 화면에서 Ubuntu 계정 비밀번호를 입력합니다. 열어 둔 창은 연결을 끊어도 그대로 남습니다.</p>
        <div id="overlay-cancel-row" class="actions">
          <button id="overlay-cancel">취소</button>
        </div>
        <div id="overlay-actions" class="actions" hidden>
          <button id="overlay-back">목록으로</button>
          <button id="overlay-reconnect" class="primary">다시 연결</button>
        </div>
      </div>
      <div id="display" class="display"></div>
    </div>
  </section>
  <div id="toast" class="toast" role="status" hidden><span id="toast-text"></span><button id="toast-reconnect">다시 연결</button></div>
  <dialog id="viewer-error"><p id="viewer-error-text"></p><button data-close="viewer-error">닫기</button></dialog>
  <dialog id="add-dialog" class="sheet" aria-labelledby="add-title"><form id="add-form">
    <div class="sheet-head"><h2 id="add-title">기기 추가</h2><span id="add-step" class="muted">1 / 2</span></div>
    <div id="add-kind" class="sheet-body">
      <div class="field"><label for="add-name">이름</label><input id="add-name" type="text" maxlength="100" required placeholder="예: 사무실 Mac" autocomplete="off" /></div>
      <fieldset class="kinds"><legend>종류</legend>
        <label id="kind-ubuntu" class="kind-card"><input id="kind-ubuntu-radio" type="radio" name="kind" value="ubuntu-local" /><span class="kind-text"><span class="kind-name">Ubuntu / Linux</span><span class="muted">원격 로그인(RDP)으로 연결합니다. 로그인 화면부터 원격으로 다룰 수 있습니다.</span></span></label>
        <label class="kind-card"><input id="kind-mac-radio" type="radio" name="kind" value="mac-agent" checked /><span class="kind-text"><span class="kind-name">Mac</span><span class="muted">Mac에 Gome 에이전트를 설치하고, 설치 때 나온 연결 키를 붙여 넣습니다.</span></span></label>
      </fieldset>
    </div>
    <fieldset id="add-mac" class="sheet-body" hidden disabled><ol class="steps">
      <li><span class="step-number">1</span><div class="field"><label for="add-address">Mac의 Tailscale 주소</label><input id="add-address" type="text" required placeholder="예: 100.64.0.20" autocomplete="off" spellcheck="false" /></div></li>
      <li><span class="step-number">2</span><div class="field"><span class="field-label">Mac에 에이전트 설치</span><span class="help">Mac의 터미널에서 설치하고, 화면 기록과 손쉬운 사용 권한을 허용합니다. <a href="${INSTALL_GUIDE}" target="_blank" rel="noopener noreferrer">설치 안내 보기</a></span></div></li>
      <li><span class="step-number">3</span><div class="field"><label for="add-key">연결 키</label><span class="help">${KEY_HELP}</span><input id="add-key" type="password" required autocomplete="off" spellcheck="false" /></div></li>
    </ol></fieldset>
    <fieldset id="add-ubuntu" class="sheet-body" hidden disabled>
      <div class="field"><label for="add-username">사용자 이름</label><input id="add-username" type="text" required autocomplete="off" spellcheck="false" /></div>
      <div class="field"><label for="add-password">비밀번호</label><span class="help">${LOGIN_HELP}</span><input id="add-password" type="password" required autocomplete="new-password" /></div>
    </fieldset>
    <p id="add-error" class="form-error" role="alert" hidden></p>
    <div id="add-footer" class="sheet-foot"><button id="add-back" type="button">취소</button><button id="add-submit" class="primary" type="submit">다음</button></div>
  </form></dialog>
  <dialog id="credential-dialog" class="sheet" aria-labelledby="credential-heading"><form id="credential-form">
    <div class="sheet-head"><h2 id="credential-heading"></h2></div>
    <fieldset id="credential-key" class="sheet-body">
      <div class="field"><label for="credential-key-input">연결 키</label><span class="help">${KEY_HELP}</span><input id="credential-key-input" type="password" required autocomplete="off" spellcheck="false" /></div>
    </fieldset>
    <fieldset id="credential-login" class="sheet-body">
      <div class="field"><label for="credential-username">사용자 이름</label><input id="credential-username" type="text" autocomplete="off" spellcheck="false" /></div>
      <div class="field"><label for="credential-password">비밀번호</label><span id="credential-help" class="help">${LOGIN_HELP}</span><input id="credential-password" type="password" required autocomplete="new-password" /></div>
    </fieldset>
    <p id="credential-error" class="form-error" role="alert" hidden></p>
    <div class="sheet-foot"><button type="button" data-close="credential-dialog">취소</button><button id="credential-submit" class="primary" type="submit">저장</button></div>
  </form></dialog>
  <dialog id="delete-dialog" class="sheet" aria-labelledby="delete-heading">
    <div class="sheet-head"><h2 id="delete-heading"></h2></div>
    <div class="sheet-body"><p>목록과 저장된 로그인 정보를 지웁니다. 기기 자체는 건드리지 않습니다.</p></div>
    <p id="delete-error" class="form-error" role="alert" hidden></p>
    <div class="sheet-foot"><button type="button" data-close="delete-dialog">취소</button><button id="delete-confirm" class="danger">삭제</button></div>
  </dialog>
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
// The Windows and Linux app draws no title bar: the OS caption buttons sit over the top
// right of the page (the window controls overlay), and the top bar is the window's drag
// region. A browser and the Mac app have no overlay, so there the bar is only a toolbar.
const controlsOverlay = (navigator as any).windowControlsOverlay;
const updateControlsOverlay = () =>
  document.body.classList.toggle("wco", !!controlsOverlay?.visible);
updateControlsOverlay();
controlsOverlay?.addEventListener?.("geometrychange", updateControlsOverlay);
// App-only settings: the update entries exist only where the app has an updater.
function showUpdateReady(version: string) {
  el("menu-restart").hidden = !version;
  el("menu-restart").textContent = `다시 시작해서 업데이트 (v${version})`;
}
void api
  .updateState()
  .then((state) => {
    el("menu-update").hidden = !state.supported;
    showUpdateReady(state.ready);
  })
  .catch(() => {});
api.onUpdateReady(showUpdateReady);

type Screen = "home" | "device" | "state" | "session";
function showScreen(screen: Screen) {
  for (const name of ["home", "device", "state", "session"] as Screen[])
    el(name).hidden = name !== screen;
  el("bar-home").hidden = screen === "session";
  el("bar-session").hidden = screen !== "session";
}
// The session bar: its dot and word follow the connection.
function showSessionState(state: "connecting" | "connected" | "ended") {
  el("bar-session").dataset.state = state;
  el("session-state").textContent = {
    connecting: "연결 중",
    connected: "연결됨",
    ended: "연결 끊김",
  }[state];
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
      showViewerError("창 상태를 갱신하지 못했습니다. 앱을 다시 열어주세요."),
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
  // In the app's native full screen only the remote picture shows: the bar hides (F11 leaves).
  document.body.classList.toggle("fullscreen", enabled);
  el("fullscreen-label").textContent = enabled
    ? "전체 화면 나가기"
    : "전체 화면";
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
  const list = el("devices");
  list.replaceChildren();
  for (const target of targets) {
    const state = tileState(target);
    const row = document.createElement("div");
    row.className = `device is-${state}`;
    row.innerHTML = `<span class="device-icon">${platformIcon[target.platform]}</span><span class="device-text"><span class="device-name"></span><span class="device-meta"></span></span><span class="device-state"><span class="dot"></span><span class="device-word"></span></span>`;
    row.querySelector(".device-name")!.textContent = target.name;
    row.querySelector(".device-meta")!.textContent = metaText(target);
    row.querySelector(".device-word")!.textContent = stateText(target, state);
    // A row that cannot open has a real disabled button; its state word stays readable.
    const button = document.createElement("button");
    button.className = "primary device-connect";
    button.textContent = "연결";
    button.setAttribute("aria-label", `${target.name} 연결`);
    button.disabled = !tileEnabled(target);
    button.onclick = () => openTarget(target);
    const manage = document.createElement("button");
    manage.className = "icon-button device-manage";
    manage.innerHTML = moreIcon;
    manage.setAttribute("aria-label", `${target.name} 관리`);
    manage.onclick = () => openDevice(target);
    const actions = document.createElement("div");
    actions.className = "device-actions";
    actions.append(button, manage);
    row.append(actions);
    list.append(row);
  }
}

// Device management: the add dialog, the device page and its two dialogs. Every write
// refreshes the list. Secret inputs are cleared after every request and whenever their
// dialog closes; nothing typed here is stored or logged by the page.
const field = (id: string) => el<HTMLInputElement>(id);
const SECRET_INPUTS = [
  "add-key",
  "add-password",
  "credential-key-input",
  "credential-password",
];
function clearSecrets() {
  for (const id of SECRET_INPUTS) field(id).value = "";
}
function showWriteError(id: string, error?: unknown) {
  el(id).textContent =
    error === undefined
      ? ""
      : error instanceof Error
        ? error.message
        : String(error);
  el(id).hidden = error === undefined;
}
// One write: its button is off while it runs, its error shows under the fields.
// `mayBePartial`: a server failure may have written part of the change (an added device
// without its key), so the list is read again to show what is really there.
async function write(
  button: string,
  errorId: string,
  run: () => Promise<unknown>,
  mayBePartial = false,
) {
  el<HTMLButtonElement>(button).disabled = true;
  showWriteError(errorId);
  try {
    await run();
    return true;
  } catch (error) {
    showWriteError(errorId, error);
    const refused =
      error instanceof ApiError && error.status >= 400 && error.status < 500;
    if (mayBePartial && !refused) void refresh();
    return false;
  } finally {
    clearSecrets();
    el<HTMLButtonElement>(button).disabled = false;
  }
}
function closeDialog(id: string) {
  el<HTMLDialogElement>(id).close();
}

// The add dialog. Ubuntu is offered only while no GNOME Remote Login target exists.
let addStep: 1 | 2 = 1;
const addKind = (): NewTarget["kind"] =>
  !el("kind-ubuntu").hidden && field("kind-ubuntu-radio").checked
    ? "ubuntu-local"
    : "mac-agent";
function showAddStep(step: 1 | 2) {
  addStep = step;
  const kind = addKind();
  el("add-kind").hidden = step !== 1;
  for (const [id, fieldsKind] of [
    ["add-mac", "mac-agent"],
    ["add-ubuntu", "ubuntu-local"],
  ]) {
    const fields = el<HTMLFieldSetElement>(id);
    fields.hidden = fields.disabled = step !== 2 || kind !== fieldsKind;
  }
  el("add-title").textContent =
    step === 1 ? "기기 추가" : `${field("add-name").value.trim()} 연결`;
  el("add-step").textContent = `${step} / 2`;
  el("add-back").textContent = step === 1 ? "취소" : "뒤로";
  el("add-submit").textContent = step === 1 ? "다음" : "추가";
  el("add-footer").classList.toggle("split", step === 2);
  showWriteError("add-error");
}
function openAddDialog() {
  closeMenu();
  el("kind-ubuntu").hidden = targets.some(
    (t) => t.profile === "gnome-remote-login",
  );
  for (const id of ["add-name", "add-address", "add-username"])
    field(id).value = "";
  clearSecrets();
  field("kind-mac-radio").checked = true;
  showAddStep(1);
  el<HTMLDialogElement>("add-dialog").showModal();
  field("add-name").focus();
}
async function submitAdd() {
  if (addStep === 1) {
    showAddStep(2);
    field(addKind() === "mac-agent" ? "add-address" : "add-username").focus();
    return;
  }
  const name = field("add-name").value.trim();
  const input: NewTarget =
    addKind() === "mac-agent"
      ? {
          name,
          kind: "mac-agent",
          hostname: field("add-address").value.trim(),
          credential: { agentToken: field("add-key").value.trim() },
        }
      : {
          name,
          kind: "ubuntu-local",
          credential: {
            username: field("add-username").value.trim(),
            password: field("add-password").value,
          },
        };
  if (
    await write("add-submit", "add-error", () => api.addTarget(input), true)
  ) {
    closeDialog("add-dialog");
    void refresh();
  }
}

// The device page: rename, replace the login, delete. Kind and address are read only.
let managed: Target | undefined;
const credentialTitle = (target: Target) =>
  target.protocol === "agent"
    ? "연결 키"
    : target.profile === "gnome-remote-login"
      ? "원격 로그인 계정"
      : target.protocol === "vnc"
        ? "화면 공유 계정"
        : "로그인 계정";
function openDevice(target: Target) {
  if (!targets.includes(target)) return;
  closeMenu();
  managed = target;
  const state = tileState(target);
  el("device-head").className = `device-head is-${state}`;
  el("device-icon").innerHTML = platformIcon[target.platform];
  el("device-title").textContent = target.name;
  el("device-word").textContent = stateText(target, state);
  field("device-name").value = target.name;
  el("device-kind").textContent = metaText(target);
  el("device-address").textContent =
    target.profile === "gnome-remote-login"
      ? `이 서버 (${target.hostname})`
      : target.hostname;
  el("credential-title").textContent = credentialTitle(target);
  el("credential-note").textContent = target.ready
    ? "서버에 저장됨. 저장된 값은 앱에 다시 보여 주지 않습니다."
    : "아직 저장되지 않았습니다.";
  showWriteError("device-error");
  showScreen("device");
}
async function saveDevice() {
  const target = managed;
  if (!target) return;
  const name = field("device-name").value.trim();
  if (name === target.name) return showScreen("home");
  if (
    await write("device-save", "device-error", () =>
      api.renameTarget(target.id, name),
    )
  )
    void refresh();
}
function openCredentialDialog() {
  const target = managed;
  if (!target) return;
  const agentKind = target.protocol === "agent";
  const key = el<HTMLFieldSetElement>("credential-key");
  const login = el<HTMLFieldSetElement>("credential-login");
  key.hidden = key.disabled = !agentKind;
  login.hidden = login.disabled = agentKind;
  // A VNC login may have no user name; RDP needs one.
  field("credential-username").required = target.protocol !== "vnc";
  field("credential-username").value = "";
  clearSecrets();
  el("credential-help").hidden = target.profile !== "gnome-remote-login";
  el("credential-heading").textContent = `${credentialTitle(target)} 바꾸기`;
  showWriteError("credential-error");
  el<HTMLDialogElement>("credential-dialog").showModal();
  field(agentKind ? "credential-key-input" : "credential-username").focus();
}
async function submitCredential() {
  const target = managed;
  if (!target) return;
  const username = field("credential-username").value.trim();
  const credential: TargetCredential =
    target.protocol === "agent"
      ? { agentToken: field("credential-key-input").value.trim() }
      : {
          ...(username ? { username } : {}),
          password: field("credential-password").value,
        };
  if (
    await write("credential-submit", "credential-error", () =>
      api.setCredential(target.id, credential),
    )
  ) {
    closeDialog("credential-dialog");
    void refresh();
  }
}
function openDeleteDialog() {
  if (!managed) return;
  el("delete-heading").textContent = `${managed.name} 삭제`;
  showWriteError("delete-error");
  el<HTMLDialogElement>("delete-dialog").showModal();
}
async function confirmDelete() {
  const target = managed;
  if (!target) return;
  if (
    await write("delete-confirm", "delete-error", () =>
      api.deleteTarget(target.id),
    )
  ) {
    closeDialog("delete-dialog");
    void refresh();
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
  el("overlay-icon").innerHTML = selected
    ? platformIcon[selected.platform]
    : "";
  el("overlay-meta").textContent = selected ? metaText(selected) : "";
  el("overlay-spinner").hidden = ended;
  el("overlay-title").textContent = ended
    ? (text?.title ?? "연결이 끊겼습니다")
    : connectingText(selected?.name || "원격 데스크톱");
  el("overlay-detail").textContent =
    text?.detail ?? "작업은 그대로 남아 있습니다";
  el("overlay-detail").hidden = !ended;
  el("overlay-note").hidden =
    ended || selected?.profile !== "gnome-remote-login";
  el("overlay-cancel-row").hidden = ended;
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
  showSessionState("ended");
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
  hideToast();
  // A list refresh still on its way must not take the screen from the session.
  listGeneration++;
  const current = generation;
  document.body.classList.add("viewing");
  el<HTMLDialogElement>("viewer-error").close();
  el("session-title").textContent = selected?.name || "원격 데스크톱";
  showScreen("session");
  syncViewerMenu();
  showSessionState("connecting");
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
        showSessionState("connected");
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
      showSessionState("connected");
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
// 연결 끊기: the session stops and the list comes back, with a toast that can open the
// same target again with the same input. The toast's button is an explicit user action.
const TOAST_MS = 6000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastReconnect: { target: Target; input: ConnectInput } | undefined;
function hideToast() {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = undefined;
  toastReconnect = undefined;
  el("toast").hidden = true;
}
function disconnect() {
  const target = selected;
  const input = flow.lastInput;
  back();
  if (!target || !input) return;
  hideToast();
  toastReconnect = { target, input };
  el("toast-text").textContent = `${target.name} 연결을 끊었습니다`;
  el("toast").hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_MS);
}
function reconnectFromToast() {
  const last = toastReconnect;
  hideToast();
  if (!last) return;
  // The list may have been refreshed since: open the target as it is listed now.
  const target = targets.find((t) => t.id === last.target.id);
  if (!target || !tileEnabled(target)) return;
  selected = target;
  flow.open(last.input);
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
el("add-device").onclick = (event) => {
  event.stopPropagation();
  openAddDialog();
};
el("add-back").onclick = () =>
  addStep === 1 ? closeDialog("add-dialog") : showAddStep(1);
el<HTMLFormElement>("add-form").onsubmit = (event) => {
  event.preventDefault();
  void submitAdd();
};
el("device-back").onclick = () => showScreen("home");
el<HTMLFormElement>("device-form").onsubmit = (event) => {
  event.preventDefault();
  void saveDevice();
};
el("credential-change").onclick = openCredentialDialog;
el<HTMLFormElement>("credential-form").onsubmit = (event) => {
  event.preventDefault();
  void submitCredential();
};
el("device-delete").onclick = openDeleteDialog;
el("delete-confirm").onclick = () => void confirmDelete();
for (const id of ["add-dialog", "credential-dialog"])
  el(id).addEventListener("close", clearSecrets);
el("menu-address").onclick = el("state-address").onclick = () => {
  closeMenu();
  void api.openSetup();
};
el("state-retry").onclick = () => void refresh();
el("overlay-back").onclick = el("overlay-cancel").onclick = () => back();
el("disconnect").onclick = disconnect;
el("toast-reconnect").onclick = reconnectFromToast;
el("menu-update").onclick = () => {
  closeMenu();
  void api.checkUpdate().catch(() => {});
};
el("menu-restart").onclick = () => {
  closeMenu();
  void api.restartUpdate().catch(() => {});
};
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
  } else if (action === "disconnect" || action === "back")
    // old apps (bridge 4 and earlier) still send "back" from their 서버 목록 menu entry
    disconnect();
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
