// The local clipboard the page syncs with: the desktop app's bridge (version 4 or later),
// or navigator.clipboard in an ordinary browser. Inside the app with an older bridge there
// is no local clipboard at all, and the page never falls back to the browser API there.
import { appMode, clipboardBridge } from "./api";
import type { LocalClipboard } from "./clipboard-sync";

interface BridgeClipboard {
  readClipboard(): Promise<any>;
  writeClipboard(text: string, opts?: any): Promise<any>;
}

const failure = (result: any): "unfocused" | "failed" =>
  result?.reason === "unfocused" ? "unfocused" : "failed";

export function bridgeClipboard(desktop: BridgeClipboard): LocalClipboard {
  return {
    async read() {
      try {
        const result = await desktop.readClipboard();
        if (result?.ok === true && typeof result.text === "string")
          return {
            ok: true,
            text: result.text,
            concealed: result.concealed === true,
          };
        return { ok: false, reason: failure(result) };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
    async write(text, concealed) {
      try {
        const result = await desktop.writeClipboard(text, { concealed });
        if (result?.ok === true) return { ok: true };
        return { ok: false, reason: failure(result) };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
  };
}

export function browserClipboard(
  nav: Pick<Navigator, "clipboard">,
): LocalClipboard | undefined {
  const clipboard = nav?.clipboard;
  if (!clipboard) return undefined;
  return {
    async read() {
      try {
        return { ok: true, text: await clipboard.readText(), concealed: false };
      } catch {
        return { ok: false, reason: "denied" };
      }
    },
    async write(text) {
      try {
        await clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, reason: "denied" };
      }
    },
  };
}

export function localClipboardFor(): LocalClipboard | undefined {
  if (appMode) {
    const desktop = window.desktop;
    if (!clipboardBridge || !desktop?.readClipboard || !desktop.writeClipboard)
      return undefined;
    return bridgeClipboard({
      readClipboard: () => desktop.readClipboard!(),
      writeClipboard: (text, opts) => desktop.writeClipboard!(text, opts),
    });
  }
  return typeof navigator === "undefined"
    ? undefined
    : browserClipboard(navigator);
}
