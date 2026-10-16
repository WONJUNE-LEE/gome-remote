// The Mac agent session (spec D1, D3, D4, D5, D8): a receive-only WebRTC video, an `input`
// data channel back, and the page's keyboard and mouse turned into its messages. The
// offer goes to the gateway (`signal`), which relays it to the agent; media and input then
// flow directly between this page and the Mac over the tailnet. The Guacamole path in
// main.ts is not involved.
import {
  contentRect,
  keyCode,
  message,
  normalise,
  parseNotice,
  preferredCodecs,
  splitText,
  wheelDelta,
} from "./agent-input";

// Reasons a session ends by itself; the page turns each into its own words.
export type EndReason = "disconnected" | "unsupported" | "timeout" | "replaced";

export interface AgentDeps {
  // Sends the page's offer to the gateway and resolves the agent's answer SDP.
  signal(offerSdp: string): Promise<{ sdp: string }>;
  // The first picture is on screen.
  onFirstFrame(): void;
  // The session ended without the page asking for it (never called after close()).
  onEnded(reason: EndReason): void;
}

export interface FrameReport {
  frames: number;
  maxGapMs: number;
  gapsOver500ms: number;
  freezeCount: number | null;
}

export interface AgentSession {
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  // Rejects when the gateway refuses (the ApiError is the caller's to show); ends the
  // session through onEnded for everything that goes wrong afterwards.
  start(): Promise<void>;
  sendSize(width: number, height: number): void;
  sendText(text: string): boolean;
  // Lets go of every key and button (blur, dialog, fullscreen, end).
  release(): void;
  focus(): void;
  close(): void;
  // For the measurement mode (#measure): a click at a fraction of the picture, and a
  // report of how steadily frames arrive.
  clickAt(fx: number, fy: number): void;
  watchFrames(durationMs: number): Promise<FrameReport>;
}

export const GATHER_LIMIT_MS = 1500;
export const FIRST_FRAME_LIMIT_MS = 20_000;
// A connection that has been "disconnected" this long without recovering is over; the
// browser itself takes about 15 s more to say "failed" (V4 measured 17.7 s).
export const DISCONNECTED_LIMIT_MS = 3000;
// A move is not sent while this much is queued in the channel: the pointer catches up
// with its newest position instead of replaying an old path.
const MAX_BUFFERED = 64 * 1024;
// The keys that hold a state of their own (they do get their keyup).
const MODIFIER_CODE = /^(Shift|Control|Alt|Meta)(Left|Right)$/;

export function createAgentSession(deps: AgentDeps): AgentSession {
  const surface = document.createElement("div");
  surface.tabIndex = 0;
  surface.className = "agent-surface";
  surface.setAttribute("aria-label", "원격 데스크톱 화면");
  const video = document.createElement("video");
  video.className = "agent-video";
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  surface.append(video);

  let pc: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let closed = false;
  let ended = false;
  let framed = false;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  const pressedButtons = new Set<number>();
  const pressedKeys = new Set<string>();
  let lastPoint = { x: 0.5, y: 0.5 };

  const open = () => channel?.readyState === "open";
  const send = (text: string) => {
    if (open()) channel!.send(text);
  };

  // ---- pointer moves are coalesced to one per animation frame, and ordered before clicks ----
  let pendingMove: { x: number; y: number } | undefined;
  let moveScheduled = false;
  const flushMove = () => {
    moveScheduled = false;
    if (!pendingMove) return;
    const point = pendingMove;
    pendingMove = undefined;
    if ((channel?.bufferedAmount ?? 0) > MAX_BUFFERED) return;
    send(message.pointer(point));
  };
  const queueMove = (point: { x: number; y: number }) => {
    pendingMove = point;
    if (moveScheduled) return;
    moveScheduled = true;
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(flushMove);
    else setTimeout(flushMove, 16);
  };

  const box = () => {
    const r = surface.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const at = (event: MouseEvent, clamp: boolean) =>
    normalise(
      event.clientX,
      event.clientY,
      box(),
      { width: video.videoWidth, height: video.videoHeight },
      clamp,
    );

  // ---- input listeners ----
  const onMouseMove = (event: MouseEvent) => {
    const point = at(event, true);
    if (point) queueMove(point);
  };
  const onMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    surface.focus({ preventScroll: true });
    if (event.button > 2) return; // back and forward buttons have no Mac meaning
    // A press on a black bar is not a click on the Mac's edge.
    const point = at(event, false);
    if (!point) return;
    flushMove();
    pressedButtons.add(event.button);
    lastPoint = point;
    send(message.button(event.button, true, point));
  };
  const onMouseUp = (event: MouseEvent) => {
    // Also heard on the document: a drag may end outside the picture or the window.
    if (!pressedButtons.has(event.button)) return;
    flushMove();
    pressedButtons.delete(event.button);
    const point = at(event, true) ?? lastPoint;
    send(message.button(event.button, false, point));
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!at(event, false)) return; // over a bar, not over the Mac
    const d = wheelDelta(event, surface.clientHeight || 800);
    if (d.x === 0 && d.y === 0) return;
    flushMove();
    send(message.wheel(d));
  };
  const onKey = (down: boolean) => (event: KeyboardEvent) => {
    const code = keyCode(event);
    event.preventDefault();
    event.stopPropagation();
    if (!code) return;
    // Browsers on macOS send no keyup for a key pressed while Command is held, so the Mac
    // would keep that key down. When the Command key (the Meta key here) comes up, every
    // other key still held is let go first, while Command is still down on the Mac.
    if (!down && /^Meta(Left|Right)$/.test(code))
      for (const held of [...pressedKeys]) {
        if (MODIFIER_CODE.test(held)) continue;
        pressedKeys.delete(held);
        send(message.key(held, false));
      }
    if (down) pressedKeys.add(code);
    else pressedKeys.delete(code);
    send(message.key(code, down));
  };
  const onKeyDown = onKey(true);
  const onKeyUp = onKey(false);
  const onContextMenu = (event: Event) => event.preventDefault();
  const onBlur = () => release();

  surface.addEventListener("mousemove", onMouseMove);
  surface.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("keydown", onKeyDown);
  surface.addEventListener("keyup", onKeyUp);
  surface.addEventListener("contextmenu", onContextMenu);
  surface.addEventListener("blur", onBlur);

  function release() {
    pendingMove = undefined;
    pressedButtons.clear();
    pressedKeys.clear();
    send(message.release());
  }

  // ---- the end of a session ----
  const teardown = () => {
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    frameTimer = undefined;
    if (lostTimer !== undefined) clearTimeout(lostTimer);
    lostTimer = undefined;
    document.removeEventListener("mouseup", onMouseUp);
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.onicegatheringstatechange = null;
    }
    if (channel) {
      channel.onclose = null;
      channel.onmessage = null;
    }
    try {
      channel?.close();
    } catch {}
    try {
      pc?.close();
    } catch {}
    video.srcObject = null;
  };
  const end = (reason: EndReason) => {
    if (closed || ended) return;
    ended = true;
    // Whatever the page still held down on the Mac is let go while the channel can still
    // carry the message (a channel that is already gone cannot; the agent releases on its
    // own when the channel closes).
    release();
    teardown();
    deps.onEnded(reason);
  };

  const gathered = (connection: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, GATHER_LIMIT_MS);
      connection.onicegatheringstatechange = () => {
        if (connection.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });

  const watchFirstFrame = () => {
    const shown = () => {
      if (framed || closed || ended) return;
      framed = true;
      if (frameTimer !== undefined) clearTimeout(frameTimer);
      frameTimer = undefined;
      deps.onFirstFrame();
    };
    if (typeof video.requestVideoFrameCallback === "function")
      video.requestVideoFrameCallback(() => shown());
    else video.addEventListener("playing", shown, { once: true });
    // A session that never shows a picture is over; ICE alone can take half a minute to give up.
    frameTimer = setTimeout(() => {
      if (!framed) end("timeout");
    }, FIRST_FRAME_LIMIT_MS);
  };

  return {
    element: surface,
    video,

    async start() {
      const supported =
        typeof RTCPeerConnection === "function" &&
        typeof RTCRtpReceiver !== "undefined" &&
        typeof RTCRtpReceiver.getCapabilities === "function";
      const codecs = supported
        ? preferredCodecs(RTCRtpReceiver.getCapabilities("video")?.codecs ?? [])
        : [];
      if (!codecs.some((c) => c.mimeType.toLowerCase() === "video/h264")) {
        end("unsupported");
        return;
      }
      const connection = new RTCPeerConnection({ iceServers: [] });
      pc = connection;
      try {
        const transceiver = connection.addTransceiver("video", {
          direction: "recvonly",
        });
        transceiver.setCodecPreferences(codecs);
        // Both are hints that only some browsers know; neither failing matters.
        try {
          (transceiver.receiver as any).jitterBufferTarget = 0;
        } catch {}
        try {
          (transceiver.receiver as any).playoutDelayHint = 0;
        } catch {}
        channel = connection.createDataChannel("input", { ordered: true });
        channel.onclose = () => end("disconnected");
        channel.onmessage = (event) => {
          if (parseNotice(event.data) === "replaced") end("replaced");
        };
        connection.ontrack = (event) => {
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
        };
        connection.onconnectionstatechange = () => {
          const state = connection.connectionState;
          if (state === "failed" || state === "closed") end("disconnected");
          else if (state === "disconnected") {
            // The browser may recover by itself; if it has not within the limit, the Mac
            // is gone (or another device replaced us without the notice getting through).
            lostTimer ??= setTimeout(
              () => end("disconnected"),
              DISCONNECTED_LIMIT_MS,
            );
          } else if (lostTimer !== undefined) {
            clearTimeout(lostTimer);
            lostTimer = undefined;
          }
        };
        await connection.setLocalDescription(await connection.createOffer());
        if (closed || ended) return;
        await gathered(connection);
        // The page may have let go while candidates were gathering: an offer posted now
        // would make the agent replace a live session with this stale one.
        if (closed || ended) return;
        const answer = await deps.signal(connection.localDescription!.sdp);
        if (closed || ended) return;
        await connection.setRemoteDescription({
          type: "answer",
          sdp: answer.sdp,
        });
        watchFirstFrame();
      } catch (error) {
        if (!closed && !ended) {
          ended = true; // a failed start is reported by the rejection, not by onEnded
          teardown();
        }
        throw error;
      }
    },

    sendSize(width, height) {
      send(message.size(width, height));
    },
    sendText(text) {
      if (!open()) return false;
      for (const piece of splitText(text)) send(message.text(piece));
      return true;
    },
    release,
    focus() {
      surface.focus({ preventScroll: true });
    },
    close() {
      if (closed) return;
      release(); // nothing stays pressed on the Mac when the page lets go
      closed = true;
      teardown();
    },

    clickAt(fx, fy) {
      const point = { x: fx, y: fy };
      send(message.pointer(point));
      send(message.button(0, true, point));
      send(message.button(0, false, point));
    },

    watchFrames(durationMs) {
      return new Promise<FrameReport>((resolve) => {
        const report: FrameReport = {
          frames: 0,
          maxGapMs: 0,
          gapsOver500ms: 0,
          freezeCount: null,
        };
        const started = performance.now();
        let previous = started;
        const freezes = async () => {
          try {
            let count: number | null = null;
            (await pc?.getStats())?.forEach((s: any) => {
              if (s.type === "inbound-rtp" && s.kind === "video")
                count = s.freezeCount ?? null;
            });
            return count;
          } catch {
            return null;
          }
        };
        const base = freezes();
        const tick = (now: number) => {
          const gap = now - previous;
          previous = now;
          report.frames++;
          report.maxGapMs = Math.max(report.maxGapMs, gap);
          if (gap > 500) report.gapsOver500ms++;
          if (now - started >= durationMs) {
            void Promise.all([base, freezes()]).then(([a, b]) => {
              report.freezeCount = a !== null && b !== null ? b - a : null;
              resolve(report);
            });
          } else video.requestVideoFrameCallback(tick);
        };
        video.requestVideoFrameCallback(tick);
      });
    },
  };
}
