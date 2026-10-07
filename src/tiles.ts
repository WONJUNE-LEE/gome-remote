// View rules for the server list, kept free of the DOM so they can be tested directly.
export type TileState = "online" | "offline" | "setup";

// Missing credentials win over power state: the owner can fix that whether or not the
// machine is on, while "꺼짐" needs no action.
export function tileState(target: Target): TileState {
  if (!target.ready) return "setup";
  return target.online ? "online" : "offline";
}
export const stateLabel: Record<TileState, string> = {
  online: "켜짐",
  offline: "꺼짐",
  setup: "설정 필요",
};
export const tileEnabled = (target: Target) => tileState(target) === "online";
export const platformClass = (platform: Target["platform"]) =>
  ({ linux: "ubuntu", mac: "mac", windows: "windows" })[platform];
export const connectingText = (name: string) => `${name}에 연결하는 중`;
