declare module "*vendor/guacamole.js" {
  const Guacamole: any;
  export default Guacamole;
}
interface Target {
  id: string;
  name: string;
  platform: "linux" | "mac" | "windows";
  protocol: "rdp" | "vnc";
  profile?: "gnome-remote-login";
  persistent: boolean;
  online: boolean;
  ready: boolean;
}
interface ConnectInput {
  targetId: string;
  width: number;
  height: number;
}
interface ViewerState {
  open: boolean;
  connected: boolean;
  protocol: "rdp" | "vnc" | null;
  resolution: string;
}
// Functions the desktop app contributes to the page it shows. Version 1 is the first
// and only version so far; later versions only add members.
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
}
interface Window {
  desktop?: DesktopBridge;
}
