// What the ended card says when a Mac (agent) session fails for a reason of its own
// (spec section 6). Reasons come from the gateway's error code (`permission`, `locked`,
// `setup`, `unavailable`) or from the session itself (`unsupported`, `timeout`,
// `disconnected`). Anything else keeps the page's usual "연결이 끊겼습니다" card, so this
// returns nothing for it.
export interface EndText {
  title: string;
  detail: string;
}

const texts: Record<string, EndText> = {
  permission: {
    title: "Mac에서 화면 기록·손쉬운 사용 권한이 필요합니다",
    detail: "Mac (VNC)로 들어가 허용할 수 있습니다",
  },
  locked: {
    title: "Mac이 잠겨 있습니다",
    detail: "Mac (VNC)로 잠금을 해제하세요",
  },
  unavailable: {
    title: "연결할 수 없습니다",
    detail: "Mac이 꺼져 있거나 에이전트가 멈췄을 수 있습니다",
  },
  setup: {
    title: "연결할 수 없습니다",
    detail: "서버에서 에이전트 토큰을 설정해야 합니다",
  },
  unsupported: {
    title: "연결할 수 없습니다",
    detail: "이 브라우저는 H.264 영상을 받을 수 없습니다",
  },
  timeout: {
    title: "연결할 수 없습니다",
    detail: "Mac에서 영상이 오지 않습니다",
  },
};

export function endText(reason: string | undefined): EndText | undefined {
  return reason !== undefined && Object.hasOwn(texts, reason)
    ? texts[reason]
    : undefined;
}

// Why a failed start ended: the gateway's code for the refusals it knows, "unavailable"
// for every other failure to reach the agent.
export function startFailureReason(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "permission" || code === "locked" || code === "setup"
    ? code
    : "unavailable";
}
