declare module "*vendor/guacamole.js" {
  const Guacamole: any;
  export default Guacamole;
}
// What the gateway tells about a Mac agent (server/agent-client.js normaliseStatus).
interface AgentTargetState {
  issue: "none" | "permission" | "locked" | "suspect";
  display: "ok" | "asleep" | "none";
  lastCaptureAt: number | null;
}
interface Target {
  id: string;
  name: string;
  platform: "linux" | "mac" | "windows";
  protocol: "rdp" | "vnc" | "agent";
  profile?: "gnome-remote-login";
  persistent: boolean;
  online: boolean;
  ready: boolean;
  // Present for an online agent target only.
  agent?: AgentTargetState;
}
interface ConnectInput {
  targetId: string;
  width: number;
  height: number;
}
interface ViewerState {
  open: boolean;
  connected: boolean;
  protocol: "rdp" | "vnc" | "agent" | null;
  resolution: string;
}
// Functions the desktop app contributes to the page it shows. Version 1 is the first;
// later versions only add members or accepted values. Version 2 adds the "auto"
// resolution to viewerState and the resolution:auto menu action. Version 3 adds the
// protocol "agent" to viewerState (the page sends "rdp" to older apps). Version 4 adds
// readClipboard and writeClipboard: text only, answered only while the window has focus.
type ClipboardRead =
  | { ok: true; text: string; concealed: boolean }
  | { ok: false; reason: "unfocused" | "failed" };
type ClipboardWrite =
  | { ok: true; concealed: boolean }
  | { ok: false; reason: "unfocused" | "failed" | "too-large" };
interface NativeBridge {
  fullscreen(enabled: boolean): Promise<void>;
  fullscreenState(): Promise<boolean>;
  onFullscreenChange(callback: (enabled: boolean) => void): () => void;
  viewerState(state: ViewerState): Promise<void>;
  onViewerAction(callback: (action: string) => void): () => void;
}
interface DesktopBridge extends NativeBridge {
  bridgeVersion?: number;
  openSetup(): Promise<void>;
  // Absent in apps older than bridge version 4 and in browsers (no navigator.clipboard
  // fallback inside the app).
  readClipboard?(): Promise<ClipboardRead>;
  writeClipboard?(
    text: string,
    opts?: { concealed?: boolean },
  ): Promise<ClipboardWrite>;
}
// navigator.keyboard (Keyboard Lock API); Chromium only, so it may be absent.
interface Navigator {
  readonly keyboard?: {
    lock(keyCodes?: string[]): Promise<void>;
    unlock(): void;
  };
}
interface Window {
  desktop?: DesktopBridge;
}
