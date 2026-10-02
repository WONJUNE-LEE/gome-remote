let token = "";
async function request(path: string, input?: unknown) {
  const response = await fetch(path, {
    method: input ? "POST" : "GET",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "연결 요청이 실패했습니다.");
  return result;
}
export const api: DesktopAPI = window.desktop || {
  async settings() {
    return {
      gateway: location.origin,
      configured: !!token,
      secureStorage: false,
      remembered: [],
    };
  },
  async configure(input) {
    token = input.token;
    return { gateway: location.origin, secureStorage: false };
  },
  targets: () => request("/api/targets"),
  async connect(input) {
    const result = await request("/api/sessions", input);
    return {
      ...result,
      websocket: `${location.origin.replace(/^http/, "ws")}/tunnel`,
    };
  },
  async forget() {},
  async fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  },
};
