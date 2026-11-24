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
  // Not secret: shown read only on the device page.
  hostname: string;
  persistent: boolean;
  online: boolean;
  ready: boolean;
  // Present for an online agent target only.
  agent?: AgentTargetState;
}
// What the add dialog and the 바꾸기 dialog send; never stored in the page.
type TargetCredential =
  { agentToken: string } | { username?: string; password: string };
interface NewTarget {
  name: string;
  kind: "mac-agent" | "ubuntu-local";
  hostname?: string;
  credential?: TargetCredential;
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
// Version 5 adds the updater (updateState, checkUpdate, restartUpdate, onUpdateReady); the
// viewer state then also sets the colours of the Windows and Linux caption buttons.
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
  // The Windows key lock: true only in the Windows app. keyLock(true) puts the page in
  // in-window HTML full screen (main refuses unless the window has focus), keyLock(false)
  // leaves it; both answer whether it worked. Absent in older (unreleased) bridge 4 builds.
  keyLockSupported?: boolean;
  keyLock?(on: boolean): Promise<boolean>;
  // Absent in apps older than bridge version 4 and in browsers (no navigator.clipboard
  // fallback inside the app).
  readClipboard?(): Promise<ClipboardRead>;
  writeClipboard?(
    text: string,
    opts?: { concealed?: boolean },
  ): Promise<ClipboardWrite>;
  // Version 5: the updater, for the page's settings menu. Absent in older apps.
  updateState?(): Promise<UpdateState>;
  checkUpdate?(): Promise<void>;
  restartUpdate?(): Promise<void>;
  onUpdateReady?(callback: (version: string) => void): () => void;
}
// `supported`: the app has an updater (packaged); `ready`: the downloaded version waiting
// for a restart, or "".
interface UpdateState {
  supported: boolean;
  ready: string;
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
