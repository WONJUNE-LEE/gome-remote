import Guacamole from "../vendor/guacamole.js";
import { api } from "./api";
import "./style.css";

const icon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4"/></svg>';
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <aside class="sidebar">
    <div class="brand"><span class="brand-icon">${icon}</span><span>gome<span class="brand-light">remote</span></span><span class="beta">01</span></div>
    <div class="workspace-label">YOUR WORKSPACE</div>
    <button class="nav-item selected" id="all-servers">${icon}<span>내 서버</span><span id="server-count" class="count">0</span></button>
    <div class="sidebar-bottom"><div class="private-badge"><span class="dot"></span> PRIVATE NETWORK</div><p>Tailscale로 연결된<br>나만의 작업 공간</p><button id="settings-button" class="text-button">연결 설정 <span>↗</span></button></div>
  </aside>
  <main>
    <header class="topbar"><div class="breadcrumb">워크스페이스 <span>/</span> <strong id="breadcrumb-title">내 서버</strong></div><span class="network-label" id="network-label">연결 설정 필요</span></header>
    <section id="home" class="home">
      <div class="page-heading"><div><div class="eyebrow">YOUR MACHINES, ONE PLACE</div><h1>어디서든, 내 작업 그대로.</h1><p>서버를 선택하고 익숙한 데스크톱으로 돌아가세요.</p></div><button id="refresh" class="secondary">↻ 새로고침</button></div>
      <div id="notice" class="notice" role="status" hidden></div>
      <div class="section-title"><h2>내 서버 <span id="online-count"></span></h2><span>화면 보기 · 원격 조작</span></div>
      <div id="server-grid" class="server-grid"></div>
      <div id="empty" class="empty"><div class="empty-icon">${icon}</div><h2>내 서버를 연결하세요</h2><p>게이트웨이 주소와 접속 키로 시작할 수 있습니다.</p><button id="setup" class="primary">연결 설정하기 <span>↗</span></button></div>
      <div class="info-strip"><span class="info-symbol">◈</span><div><strong>모니터가 없어도 괜찮아요.</strong><p>전용 가상 데스크톱은 연결을 끊어도 작업을 유지합니다.</p></div><span class="info-caption">HEADLESS READY</span></div>
    </section>
    <section id="session" class="session" hidden>
      <div class="session-toolbar"><button id="back" class="secondary">← 서버 목록</button><span class="session-status"><span class="dot"></span><span id="session-state">연결 중</span></span><div class="toolbar-spacer"></div>
        <label class="sr-only" for="resolution">해상도</label><select id="resolution"><option value="1440x900">1440 × 900</option><option value="1920x1080">1920 × 1080</option><option value="2560x1440">2560 × 1440</option></select>
        <button id="text-input" class="secondary" disabled>텍스트 입력</button><button id="fullscreen" class="secondary">전체 화면</button><button id="reconnect" class="primary" hidden>다시 연결</button><button id="disconnect" class="danger">연결 종료</button>
      </div>
      <div id="viewport" class="viewport"><div id="session-message" class="session-message">데스크톱에 연결하고 있습니다…</div><div id="display" class="display"></div></div>
      <div class="session-footer"><span id="session-hint">화면을 클릭하면 키보드와 마우스로 조작할 수 있습니다.</span><span>GOME REMOTE</span></div>
    </section>
  </main>
  <dialog id="settings-dialog"><form id="settings-form"><div class="dialog-heading"><div><div class="eyebrow">PRIVATE CONNECTION</div><h2>워크스페이스 연결</h2></div><button type="button" class="close-button" data-close="settings-dialog" aria-label="닫기">×</button></div><p class="muted">Tailscale에 연결한 상태에서 서버 주소와 접속 키를 입력하세요.</p><label>게이트웨이 주소<input id="gateway" type="url" placeholder="https://your-server.tailnet.ts.net:8449" required autocomplete="off"></label><label>접속 키<input id="gateway-token" type="password" placeholder="서버에서 발급한 접속 키" autocomplete="off"></label><p id="storage-note" class="field-note"></p><p id="settings-error" class="form-error" role="alert"></p><button class="primary wide" type="submit">워크스페이스 연결 <span>→</span></button></form></dialog>
  <dialog id="login-dialog"><form id="login-form"><div class="dialog-heading"><div><div class="eyebrow">REMOTE DESKTOP</div><h2 id="login-title">서버에 연결</h2></div><button type="button" class="close-button" data-close="login-dialog" aria-label="닫기">×</button></div><p id="login-description" class="muted"></p><div id="credential-fields"><label id="username-label">사용자 이름<input id="username" autocomplete="username"></label><label>암호<input id="password" type="password" autocomplete="current-password"></label></div><label class="checkbox"><input id="remember" type="checkbox">이 기기의 보안 저장소에 로그인 정보 저장</label><button id="forget" type="button" class="text-button" hidden>저장된 로그인 정보 지우기</button><p id="login-error" class="form-error" role="alert"></p><button class="primary wide" type="submit">데스크톱 열기 <span>→</span></button></form></dialog>
  <dialog id="text-dialog"><form id="text-form"><div class="dialog-heading"><h2>원격 화면에 텍스트 입력</h2><button type="button" class="close-button" data-close="text-dialog" aria-label="닫기">×</button></div><p class="muted">원격 앱의 입력 위치를 먼저 선택해주세요. 한글도 입력할 수 있습니다.</p><textarea id="remote-text" rows="5" maxlength="4000" aria-label="보낼 텍스트"></textarea><button class="primary wide" type="submit">입력하기 →</button></form></dialog>
`;
function el<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      )
    : "요청을 처리할 수 없습니다.";
let settings: Settings = {
  gateway: "",
  configured: false,
  secureStorage: false,
  remembered: [],
};
let targets: Target[] = [];
let selected: Target | undefined;
let generation = 0;
let client: any;
let keyboard: any;
let resizeObserver: ResizeObserver | undefined;
let releaseMouse: (() => void) | undefined;
let active = false;
let lastInput: ConnectInput | undefined;

function notice(message: string) {
  el("notice").textContent = message;
  el("notice").hidden = !message;
}
async function loadSettings() {
  settings = await api.settings();
}
async function refresh() {
  const button = el<HTMLButtonElement>("refresh");
  button.disabled = true;
  try {
    await loadSettings();
    if (!settings.configured) return;
    const result = await api.targets();
    targets = result.targets;
    el("network-label").textContent = "워크스페이스 연결됨";
    el("network-label").classList.add("connected");
    renderTargets();
    notice("");
  } catch (error) {
    el("network-label").textContent = "게이트웨이 연결 실패";
    el("network-label").classList.remove("connected");
    targets = [];
    renderTargets();
    notice(errorText(error));
  } finally {
    button.disabled = false;
  }
}
function renderTargets() {
  const grid = el("server-grid");
  grid.replaceChildren();
  el("server-count").textContent = String(targets.length);
  el("online-count").textContent = targets.length
    ? `${targets.filter((t) => t.online).length}대 응답 중`
    : "";
  el("empty").hidden = targets.length > 0;
  for (const target of targets) {
    const card = document.createElement("article");
    card.className = "server-card";
    card.innerHTML = `<div class="card-top"><span class="machine-icon">${icon}</span><span class="availability"><span class="dot"></span><span></span></span></div><h3></h3><p class="address"></p><div class="card-tags"><span class="os-tag"></span><span class="mode-tag"></span></div><div class="card-divider"></div><button class="connect-button"><span>데스크톱 열기</span><span>↗</span></button>`;
    card.querySelector("h3")!.textContent = target.name;
    card.querySelector(".address")!.textContent = target.address;
    card.querySelector(".os-tag")!.textContent = {
      mac: "macOS",
      linux: "Ubuntu",
      windows: "Windows",
    }[target.platform];
    card.querySelector(".mode-tag")!.textContent = target.persistent
      ? "가상 데스크톱"
      : "화면 공유";
    card.querySelector(".availability span:last-child")!.textContent =
      target.online ? "서비스 응답" : "응답 없음";
    card
      .querySelector(".availability")!
      .classList.toggle("offline", !target.online);
    card.querySelector("button")!.onclick = () => openLogin(target);
    grid.append(card);
  }
}
async function openSettings() {
  await loadSettings();
  el<HTMLInputElement>("gateway").value = settings.gateway;
  el<HTMLInputElement>("gateway").readOnly = !window.desktop;
  el<HTMLInputElement>("gateway-token").value = "";
  el<HTMLInputElement>("gateway-token").required = !settings.configured;
  el("storage-note").textContent = settings.secureStorage
    ? "접속 키와 저장한 암호는 OS 보안 저장소로 암호화합니다."
    : "접속 키는 이 실행 중에만 유지됩니다. 암호 저장은 보안 저장소가 있는 데스크톱 앱에서 가능합니다.";
  el("settings-error").textContent = "";
  el<HTMLDialogElement>("settings-dialog").showModal();
}
function openLogin(target: Target) {
  selected = target;
  const remembered = settings.remembered.includes(target.id);
  el("login-title").textContent = target.name;
  el("login-description").textContent = remembered
    ? "이 기기에 저장한 로그인 정보를 사용합니다."
    : target.protocol === "vnc"
      ? "맥의 화면 공유 설정에 지정한 VNC 암호를 입력하세요."
      : "전용 원격 데스크톱의 로그인 정보를 입력하세요.";
  el("credential-fields").hidden = remembered;
  el("username-label").hidden = target.protocol === "vnc";
  el<HTMLInputElement>("username").value = "";
  el<HTMLInputElement>("password").value = "";
  el<HTMLInputElement>("remember").disabled = !settings.secureStorage;
  el<HTMLInputElement>("remember").checked = remembered;
  el("forget").hidden = !remembered;
  el("login-error").textContent = "";
  el<HTMLDialogElement>("login-dialog").showModal();
}
function releaseInput() {
  keyboard?.reset();
  releaseMouse?.();
}
function stop() {
  generation++;
  releaseInput();
  active = false;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  if (client) {
    client.onstatechange = null;
    client.onerror = null;
    client.disconnect();
  }
  client = undefined;
  keyboard = undefined;
  releaseMouse = undefined;
  el("display").replaceChildren();
  el<HTMLButtonElement>("text-input").disabled = true;
}
function sessionFailed(message: string) {
  releaseInput();
  active = false;
  el("session-state").textContent = "연결 종료";
  el("session-message").textContent = message;
  el("session-message").hidden = false;
  el("reconnect").hidden = false;
  el<HTMLButtonElement>("text-input").disabled = true;
}
async function connect(input: ConnectInput) {
  stop();
  const current = generation;
  lastInput = { ...input };
  el("home").hidden = true;
  el("session").hidden = false;
  el("breadcrumb-title").textContent = selected?.name || "원격 데스크톱";
  el("session-state").textContent = "연결 중";
  el("session-message").textContent = "데스크톱에 연결하고 있습니다…";
  el("session-message").hidden = false;
  el("reconnect").hidden = true;
  el("session-hint").textContent = selected?.persistent
    ? "연결을 종료해도 가상 데스크톱의 작업은 유지됩니다."
    : "화면을 클릭하면 키보드와 마우스로 조작할 수 있습니다.";
  try {
    const result = await api.connect(input);
    if (current !== generation) return;
    const tunnel = new Guacamole.WebSocketTunnel(result.websocket);
    const connection = new Guacamole.Client(tunnel);
    client = connection;
    const display = connection.getDisplay();
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    surface.className = "remote-surface";
    surface.setAttribute("aria-label", "원격 데스크톱 화면");
    surface.append(display.getElement());
    el("display").append(surface);
    const fit = () => {
      if (!display.getWidth() || !display.getHeight()) return;
      display.scale(
        Math.min(
          (el("viewport").clientWidth - 32) / display.getWidth(),
          (el("viewport").clientHeight - 32) / display.getHeight(),
          1,
        ),
      );
    };
    display.onresize = fit;
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(el("viewport"));
    const mouse = new Guacamole.Mouse(display.getElement());
    let mouseState: any;
    mouse.onmousedown =
      mouse.onmouseup =
      mouse.onmousemove =
        (state: any) => {
          if (!active) return;
          mouseState = state;
          surface.focus({ preventScroll: true });
          connection.sendMouseState(state, true);
        };
    releaseMouse = () => {
      if (active && mouseState)
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
    };
    keyboard = new Guacamole.Keyboard(surface);
    keyboard.onkeydown = (keysym: number) => {
      if (active) connection.sendKeyEvent(1, keysym);
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (active) connection.sendKeyEvent(0, keysym);
    };
    surface.addEventListener("blur", releaseInput);
    connection.onerror = () => {
      if (current === generation)
        sessionFailed(
          "화면 연결에 실패했습니다. 서버의 로그인 정보와 원격 데스크톱 설정을 확인해주세요.",
        );
    };
    tunnel.onerror = () => {
      if (current === generation)
        sessionFailed(
          "연결이 끊어졌습니다. Tailscale 연결을 확인한 뒤 다시 연결해주세요.",
        );
    };
    connection.onstatechange = (state: number) => {
      if (current !== generation) return;
      if (state === 3) {
        active = true;
        el("session-state").textContent = "연결됨";
        el("session-message").hidden = true;
        el<HTMLButtonElement>("text-input").disabled = false;
        surface.focus();
        fit();
      } else if (state === 5)
        sessionFailed(
          "연결이 종료되었습니다. 다시 연결하면 데스크톱으로 돌아갑니다.",
        );
    };
    connection.connect(`ticket=${encodeURIComponent(result.ticket)}`);
    await loadSettings();
  } catch (error) {
    if (current === generation) sessionFailed(errorText(error));
  }
}
function back() {
  stop();
  lastInput = undefined;
  el("home").hidden = false;
  el("session").hidden = true;
  el("breadcrumb-title").textContent = "내 서버";
}
el("settings-button").onclick = el("setup").onclick = () => {
  void openSettings().catch((e) => notice(errorText(e)));
};
el("refresh").onclick = () => {
  void refresh();
};
el("all-servers").onclick = el("back").onclick = back;
el("disconnect").onclick = () => {
  stop();
  sessionFailed("연결을 종료했습니다. 필요할 때 다시 접속하세요.");
};
el("fullscreen").onclick = () => {
  void api.fullscreen().catch((e) => sessionFailed(errorText(e)));
};
el("reconnect").onclick = () => {
  if (lastInput) void connect(lastInput);
};
el<HTMLSelectElement>("resolution").onchange = () => {
  const [width, height] = el<HTMLSelectElement>("resolution")
    .value.split("x")
    .map(Number);
  if (lastInput) Object.assign(lastInput, { width, height });
  if (active && selected?.protocol === "rdp") client.sendSize(width, height);
  else if (active)
    el("session-hint").textContent =
      "맥 화면의 해상도는 원격 맥의 디스플레이 설정에서 변경해주세요. 앱은 창 크기에 맞춰 표시합니다.";
};
el("forget").onclick = async () => {
  if (!selected) return;
  try {
    await api.forget(selected.id);
    await loadSettings();
    openLoginRefresh();
  } catch (error) {
    el("login-error").textContent = errorText(error);
  }
};
function openLoginRefresh() {
  el<HTMLDialogElement>("login-dialog").close();
  if (selected) openLogin(selected);
}
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach((button) => {
    button.onclick = () => el<HTMLDialogElement>(button.dataset.close!).close();
  });
el<HTMLFormElement>("settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const button =
    el("settings-form").querySelector<HTMLButtonElement>("[type=submit]")!;
  button.disabled = true;
  try {
    back();
    await api.configure({
      gateway: el<HTMLInputElement>("gateway").value,
      token: el<HTMLInputElement>("gateway-token").value,
    });
    el<HTMLInputElement>("gateway-token").value = "";
    el<HTMLDialogElement>("settings-dialog").close();
    await refresh();
  } catch (error) {
    el("settings-error").textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
};
el<HTMLFormElement>("login-form").onsubmit = (event) => {
  event.preventDefault();
  if (!selected) return;
  const [width, height] = el<HTMLSelectElement>("resolution")
    .value.split("x")
    .map(Number);
  const input: ConnectInput = {
    targetId: selected.id,
    username: el<HTMLInputElement>("username").value,
    password: el<HTMLInputElement>("password").value,
    width,
    height,
    remember: el<HTMLInputElement>("remember").checked,
    useSaved: settings.remembered.includes(selected.id),
  };
  el<HTMLInputElement>("password").value = "";
  el<HTMLDialogElement>("login-dialog").close();
  void connect(input);
};
el("text-input").onclick = () => {
  releaseInput();
  el<HTMLDialogElement>("text-dialog").showModal();
  el("remote-text").focus();
};
el<HTMLFormElement>("text-form").onsubmit = (event) => {
  event.preventDefault();
  if (active) {
    const text = el<HTMLTextAreaElement>("remote-text").value;
    if (text) {
      const writer = new Guacamole.StringWriter(
        client.createClipboardStream("text/plain"),
      );
      writer.sendText(text);
      writer.sendEnd();
      // Clipboard transfer supports characters absent from the remote keyboard layout.
      const modifier = selected?.platform === "mac" ? 0xffe7 : 0xffe3;
      client.sendKeyEvent(1, modifier);
      client.sendKeyEvent(1, 0x76);
      client.sendKeyEvent(0, 0x76);
      client.sendKeyEvent(0, modifier);
    }
  }
  el<HTMLTextAreaElement>("remote-text").value = "";
  el<HTMLDialogElement>("text-dialog").close();
};
window.addEventListener("blur", releaseInput);
window.addEventListener("beforeunload", stop);
void refresh();
