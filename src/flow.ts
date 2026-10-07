// Decisions of the viewer that must not depend on the DOM, so they can be tested
// directly: which screen a failure leads to, and when a connection may start.

export interface ErrorScreen {
  screen: "unreachable" | "forbidden";
  title: string;
  showAddressButton: boolean;
}

// `kind` is ApiError.kind, or undefined for anything that is not an ApiError. Every
// failure that is not a refused login is shown as "unreachable".
export function errorScreen(
  kind: string | undefined,
  appMode: boolean,
): ErrorScreen {
  if (kind === "forbidden")
    return {
      screen: "forbidden",
      title: "이 기기의 Tailscale 계정으로는 쓸 수 없습니다",
      // The address is not the cause of a refused login. "다시 시도" stays: the owner
      // may switch the Tailscale account on this device and try again.
      showAddressButton: false,
    };
  return {
    screen: "unreachable",
    title: "서버에 연결할 수 없습니다",
    showAddressButton: appMode,
  };
}

// A refused login while opening a session leaves the viewer for the forbidden screen;
// any other failure keeps the session view with the "ended" card and its reconnect button.
export function connectFailure(
  kind: string | undefined,
): "forbidden" | "ended" {
  return kind === "forbidden" ? "forbidden" : "ended";
}

export interface SessionEffects {
  // Starts exactly one connection attempt.
  begin(input: ConnectInput): void;
  // Shows that the session is over.
  ended(): void;
}

// A connection attempt starts only from an explicit user action: open() for a tile
// click, reconnect() for the "다시 연결" button or the menu entry. A failed login on a
// Mac can lock the account, so errors, closes and state changes never start one;
// ended() only reports that the session is over.
export function createSessionFlow(effects: SessionEffects) {
  let last: ConnectInput | undefined;
  let active = false;
  return {
    get active() {
      return active;
    },
    get lastInput() {
      return last && { ...last };
    },
    open(input: ConnectInput) {
      last = { ...input };
      effects.begin({ ...last });
    },
    reconnect() {
      if (last && !active) effects.begin({ ...last });
    },
    // The resolution picker changed: the next reconnect uses the new size.
    resize(width: number, height: number) {
      if (last) Object.assign(last, { width, height });
    },
    connected() {
      active = true;
    },
    stopped() {
      active = false;
    },
    ended() {
      active = false;
      effects.ended();
    },
    // Leaving the viewer: there is nothing to reconnect to any more.
    discard() {
      last = undefined;
      active = false;
    },
  };
}
