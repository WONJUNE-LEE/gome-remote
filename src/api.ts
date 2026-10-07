// The page is served by the gateway, so every request is same-origin. Tailscale Serve
// adds the caller's identity; the page sends no token and no credentials of its own.
export const REQUIRED_BRIDGE_VERSION = 1;
export const FORBIDDEN_TEXT = "이 기기의 Tailscale 계정으로는 쓸 수 없습니다";
export const UNREACHABLE_TEXT = "서버에 연결할 수 없습니다";

export class ApiError extends Error {
  kind: "unreachable" | "forbidden" | "failed";
  status: number;
  constructor(
    kind: "unreachable" | "forbidden" | "failed",
    message: string,
    status = 0,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

// Bridge version 1 or later means the page runs inside the desktop app. Anything else,
// including an older app without a version, is treated as an ordinary browser.
export const appMode =
  (window.desktop?.bridgeVersion ?? 0) >= REQUIRED_BRIDGE_VERSION;
// An app with bridge version 1 rejects the "auto" resolution in viewerState, so only
// browsers and newer apps may offer it.
export const autoResolution = !appMode || window.desktop!.bridgeVersion! >= 2;

async function request<T>(path: string, input?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: input ? "POST" : "GET",
      credentials: "same-origin",
      signal: AbortSignal.timeout(12_000),
      ...(input
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    });
  } catch {
    throw new ApiError("unreachable", UNREACHABLE_TEXT);
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  if (response.status === 403 && result?.code === "login")
    throw new ApiError("forbidden", FORBIDDEN_TEXT, 403);
  // A stopped gateway makes Tailscale Serve answer 502 with an HTML page.
  if (!result || response.status >= 502)
    throw new ApiError("unreachable", UNREACHABLE_TEXT, response.status);
  if (!response.ok)
    throw new ApiError(
      "failed",
      result.error || "연결 요청이 실패했습니다.",
      response.status,
    );
  return result as T;
}

let fullscreenTarget = false;
let fullscreenTransition: Promise<void> | undefined;
const browserNative: NativeBridge = {
  async viewerState() {},
  onViewerAction() {
    return () => {};
  },
  fullscreen(enabled) {
    fullscreenTarget = enabled;
    if (!fullscreenTransition) {
      // Start synchronously to preserve the browser's user activation requirement.
      fullscreenTransition = (async () => {
        while (!!document.fullscreenElement !== fullscreenTarget) {
          if (fullscreenTarget)
            await document.documentElement.requestFullscreen();
          else await document.exitFullscreen();
        }
      })().finally(() => {
        fullscreenTransition = undefined;
      });
    }
    return fullscreenTransition;
  },
  async fullscreenState() {
    return !!document.fullscreenElement;
  },
  onFullscreenChange(callback) {
    const listener = () => callback(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  },
};
const native: NativeBridge = appMode ? window.desktop! : browserNative;

export const api = {
  targets: () => request<{ targets: Target[] }>("/api/targets"),
  async connect(input: ConnectInput) {
    const result = await request<{ ticket: string }>("/api/sessions", input);
    return {
      ...result,
      websocket: `${location.origin.replace(/^http/, "ws")}/tunnel`,
    };
  },
  fullscreen: (enabled: boolean) => native.fullscreen(enabled),
  fullscreenState: () => native.fullscreenState(),
  onFullscreenChange: (callback: (enabled: boolean) => void) =>
    native.onFullscreenChange(callback),
  viewerState: (state: ViewerState) => native.viewerState(state),
  onViewerAction: (callback: (action: string) => void) =>
    native.onViewerAction(callback),
  // Only the app has an address to change; in a browser the address bar is the setting.
  openSetup: () => (appMode ? window.desktop!.openSetup() : Promise.resolve()),
};
