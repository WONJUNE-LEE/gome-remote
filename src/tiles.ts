// View rules for the server list, kept free of the DOM so they can be tested directly.
export type TileState =
  "online" | "offline" | "setup" | "permission" | "locked" | "suspect";

// P1 (lock screen pre-test, spec section 3). On 2026-10-16 capture and key input both worked
// on the lock screen, so a locked Mac (tile word 잠김) can be opened from its agent tile and
// unlocked through the agent; the VNC tile stays as the fallback. Its counterpart is
// REFUSE_WHEN_LOCKED in agent/mac/src/status.rs. Set to false (and that to true) to go back.
export const LOCKED_TILE_ENABLED = true;

// Missing credentials win over power state: the owner can fix that whether or not the
// machine is on, while "꺼짐" needs no action. A Mac agent that answers but cannot work
// (permissions, lock screen) says so instead of "켜짐".
export function tileState(target: Target): TileState {
  if (!target.ready) return "setup";
  if (!target.online) return "offline";
  if (target.protocol === "agent") {
    if (target.agent?.issue === "permission") return "permission";
    if (target.agent?.issue === "locked") return "locked";
    if (target.agent?.issue === "suspect") return "suspect";
  }
  return "online";
}
export const stateLabel: Record<TileState, string> = {
  online: "켜짐",
  offline: "꺼짐",
  setup: "설정 필요",
  permission: "권한 필요",
  locked: "잠김",
  // Screen capture answered but produced nothing usable: probably a missing permission, but
  // unproven, so the tile still opens.
  suspect: "권한 필요(의심)",
};
// An agent that does not answer is "오프라인": its program may be stopped while the Mac is on.
export const stateText = (target: Target, state: TileState) =>
  target.protocol === "agent" && state === "offline"
    ? "오프라인"
    : stateLabel[state];
// `lockedEnabled` is P1's switch; a test passes it to exercise both of its values.
export const tileEnabled = (
  target: Target,
  lockedEnabled: boolean = LOCKED_TILE_ENABLED,
) => {
  const state = tileState(target);
  return (
    state === "online" ||
    state === "suspect" ||
    (state === "locked" && lockedEnabled)
  );
};
export const platformClass = (platform: Target["platform"]) =>
  ({ linux: "ubuntu", mac: "mac", windows: "windows" })[platform];
export const connectingText = (name: string) => `${name}에 연결하는 중`;
