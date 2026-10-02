declare module "*vendor/guacamole.js" {
  const Guacamole: any;
  export default Guacamole;
}
interface Target {
  id: string;
  name: string;
  platform: "linux" | "mac" | "windows";
  protocol: "rdp" | "vnc";
  persistent: boolean;
  address: string;
  online: boolean;
}
interface Settings {
  gateway: string;
  configured: boolean;
  secureStorage: boolean;
  remembered: string[];
}
interface ConnectInput {
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
  targets(): Promise<{ targets: Target[] }>;
  connect(input: ConnectInput): Promise<{ ticket: string; websocket: string }>;
  forget(targetId: string): Promise<void>;
  fullscreen(): Promise<void>;
}
interface Window {
  desktop?: DesktopAPI;
}
