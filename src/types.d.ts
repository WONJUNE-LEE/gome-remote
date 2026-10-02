declare module "*vendor/guacamole.js" {
  const Guacamole: any;
  export default Guacamole;
}
interface Target {
  revision: number;
  id: string;
  name: string;
  platform: "linux" | "mac" | "windows";
  protocol: "rdp" | "vnc";
  persistent: boolean;
  address: string;
  online: boolean;
}
interface Settings {
  revision: number;
  gateway: string;
  configured: boolean;
  secureStorage: boolean;
  remembered: string[];
}
interface ConnectInput {
  revision: number;
  targetId: string;
  username: string;
  password: string;
  remember: boolean;
  useSaved: boolean;
  width: number;
  height: number;
}
interface DesktopAPI {
  settings(): Promise<Settings>;
  configure(input: {
    gateway: string;
    token: string;
  }): Promise<{ gateway: string; secureStorage: boolean }>;
  targets(): Promise<{ targets: Target[]; revision: number }>;
  connect(input: ConnectInput): Promise<{ ticket: string; websocket: string }>;
  forget(targetId: string): Promise<void>;
  fullscreen(enabled: boolean): Promise<void>;
  fullscreenState(): Promise<boolean>;
  onFullscreenChange(callback: (enabled: boolean) => void): () => void;
  viewerState(state: {
    open: boolean;
    connected: boolean;
    protocol: "rdp" | "vnc" | null;
    resolution: string;
  }): Promise<void>;
  onViewerAction(callback: (action: string) => void): () => void;
}
interface Window {
  desktop?: DesktopAPI;
}
