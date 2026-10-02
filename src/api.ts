let token = "";
let revision = 0;
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
      revision,
      gateway: location.origin,
      configured: !!token,
      secureStorage: false,
      remembered: [],
    };
  },
  async configure(input) {
    revision++;
    token = input.token || token;
    return { gateway: location.origin, secureStorage: false };
  },
  async targets() {
    const current = revision;
    const result = await request("/api/targets");
    if (current !== revision) throw new Error("연결 설정이 변경되었습니다.");
    return { ...result, revision: current };
  },
  async connect(input) {
    if (input.revision !== revision)
      throw new Error("연결 설정이 변경되었습니다.");
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
