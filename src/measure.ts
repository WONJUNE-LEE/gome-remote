// Measurement mode (spec D8, section 8). Only when the address carries `#measure` does a
// small panel appear; it sends N clicks to a chosen place of the remote screen and times,
// with one polling loop, how long the displayed pixel there takes to change. The same loop
// measures a Mac (agent) session (the video) and a Guacamole session (its canvas), so the
// two methods are compared with the same ruler. Without `#measure` nothing here runs.

export type Pixel = [number, number, number];

// Everything the loop needs from the page. Tests supply fakes for all of it.
export interface MeasureSource {
  // The colour currently displayed at a fraction of the remote screen.
  readPixel(fx: number, fy: number): Pixel | undefined;
  // A left click at that place.
  sendClick(fx: number, fy: number): void;
}
export interface MeasureClock {
  now(): number;
  // Runs `step` as soon as possible, much faster than a timer (about 1 ms or less).
  poll(step: () => void): void;
  sleep(ms: number): Promise<void>;
}
export interface MeasureOptions {
  n: number;
  fx: number;
  fy: number;
  pauseMs: number;
  timeoutMs: number;
}
export interface MeasureSummary {
  n: number;
  ok: number;
  timeouts: number;
  medianMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  over1000ms: number;
}

// A pixel counts as changed when one channel moved by more than this (the VNC baseline's rule).
export const CHANGE_THRESHOLD = 60;
export const changed = (a: Pixel, b: Pixel) =>
  Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  ) > CHANGE_THRESHOLD;

export const wantsMeasure = (hash: string) => /(^#|&)measure(&|$)/.test(hash);

const quantile = (sorted: number[], q: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
    : null;

export function summarise(samples: (number | null)[]): MeasureSummary {
  const ok = samples
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const round = (v: number | null) =>
    v === null ? null : Math.round(v * 10) / 10;
  return {
    n: samples.length,
    ok: ok.length,
    timeouts: samples.length - ok.length,
    medianMs: round(quantile(ok, 0.5)),
    p95Ms: round(quantile(ok, 0.95)),
    minMs: round(ok[0] ?? null),
    maxMs: round(ok.at(-1) ?? null),
    over1000ms: ok.filter((s) => s > 1000).length,
  };
}

// One sample: the time from the click until the pixel differs from what it was before.
// Null when it never changes within the timeout, or when there is no picture to read.
async function sample(
  source: MeasureSource,
  clock: MeasureClock,
  o: MeasureOptions,
): Promise<number | null> {
  const base = source.readPixel(o.fx, o.fy);
  if (!base) return null;
  const started = clock.now();
  source.sendClick(o.fx, o.fy);
  return new Promise((resolve) => {
    const step = () => {
      const elapsed = clock.now() - started;
      if (elapsed > o.timeoutMs) return resolve(null);
      const current = source.readPixel(o.fx, o.fy);
      if (current && changed(current, base)) return resolve(elapsed);
      clock.poll(step);
    };
    clock.poll(step);
  });
}

export async function runMeasure(
  source: MeasureSource,
  clock: MeasureClock,
  o: MeasureOptions,
): Promise<{ summary: MeasureSummary; samples: (number | null)[] }> {
  const samples: (number | null)[] = [];
  for (let i = 0; i < o.n; i++) {
    await clock.sleep(o.pauseMs);
    samples.push(await sample(source, clock, o));
  }
  return { summary: summarise(samples), samples };
}

// ---- the readers: the displayed pixel of a video and of Guacamole's canvases ----

export function videoSource(
  video: HTMLVideoElement,
  click: (fx: number, fy: number) => void,
): MeasureSource {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  return {
    readPixel(fx, fy) {
      if (!video.videoWidth) return undefined;
      const x = Math.min(
        video.videoWidth - 1,
        Math.floor(fx * video.videoWidth),
      );
      const y = Math.min(
        video.videoHeight - 1,
        Math.floor(fy * video.videoHeight),
      );
      context.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
      const d = context.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    sendClick: click,
  };
}

// Guacamole draws into several canvases; the largest is the default layer, which holds the
// desktop. Clicks go through the client exactly as the user's would.
export function guacamoleSource(client: any, root: ParentNode): MeasureSource {
  const layer = () =>
    Array.from(
      root.querySelectorAll("canvas") as ArrayLike<HTMLCanvasElement>,
    ).reduce<HTMLCanvasElement | undefined>(
      (best, c) =>
        !best || c.width * c.height > best.width * best.height ? c : best,
      undefined,
    );
  const state = (x: number, y: number, left: boolean) => ({
    x,
    y,
    left,
    middle: false,
    right: false,
    up: false,
    down: false,
  });
  return {
    readPixel(fx, fy) {
      const canvas = layer();
      if (!canvas || !canvas.width) return undefined;
      const x = Math.min(canvas.width - 1, Math.floor(fx * canvas.width));
      const y = Math.min(canvas.height - 1, Math.floor(fy * canvas.height));
      const d = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    sendClick(fx, fy) {
      const display = client.getDisplay();
      const x = Math.round(fx * display.getWidth());
      const y = Math.round(fy * display.getHeight());
      // x and y are already in remote pixels, which is what `false` means: with `true`
      // Guacamole would divide them by the display scale a second time (the user's own
      // mouse arrives in scaled units and is the case that needs `true`).
      client.sendMouseState(state(x, y, true), false);
      client.sendMouseState(state(x, y, false), false);
    },
  };
}

// ---- the panel ----

export interface PanelDeps {
  hash: string;
  // The source for whatever session is on screen, or undefined when none is connected.
  source(): MeasureSource | undefined;
  // For the 60 second drag/scroll check (Mac agent sessions only).
  soak?(durationMs: number): Promise<unknown> | undefined;
  clock?: MeasureClock;
  // Where the panel's functions are exposed to a driver script (Playwright). Defaults to
  // `globalThis.__gomeMeasure`.
  publish?(api: unknown): void;
}

// The channel is made on first use, so a page that never measures holds no open port.
const browserClock = (): MeasureClock => {
  let channel: MessageChannel | undefined;
  let next: (() => void) | undefined;
  return {
    now: () => performance.now(),
    poll(step) {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => {
          const run = next;
          next = undefined;
          run?.();
        };
      }
      next = step;
      channel.port2.postMessage(0);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
};

// Returns whether the panel was shown. Without `#measure` it returns false having touched
// nothing: no element, no listener, no timer.
export function initMeasure(deps: PanelDeps): boolean {
  if (!wantsMeasure(deps.hash)) return false;
  const clock = deps.clock ?? browserClock();
  const panel = document.createElement("div");
  panel.id = "measure-panel";
  panel.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:50;background:#000c;color:#fff;font:12px monospace;padding:8px;border-radius:6px;max-width:360px";
  const field = (label: string, value: string) => {
    const wrap = document.createElement("label");
    wrap.textContent = `${label} `;
    const input = document.createElement("input");
    input.value = value;
    input.size = 5;
    wrap.append(input);
    panel.append(wrap, " ");
    return input;
  };
  const n = field("N", "30");
  const x = field("x", "0.5");
  const y = field("y", "0.5");
  const pause = field("pause ms", "1200");
  const button = document.createElement("button");
  button.textContent = "측정";
  const soakButton = document.createElement("button");
  soakButton.textContent = "60초 멈춤 확인";
  const out = document.createElement("pre");
  out.style.cssText = "margin:6px 0 0;white-space:pre-wrap";
  panel.append(button, " ", soakButton, out);
  document.body.append(panel);

  const api = {
    results: undefined as unknown,
    async run(overrides: Partial<MeasureOptions> = {}) {
      const source = deps.source();
      if (!source) {
        out.textContent = "연결된 화면이 없습니다";
        return undefined;
      }
      const options: MeasureOptions = {
        n: Number(n.value) || 30,
        fx: Number(x.value),
        fy: Number(y.value),
        pauseMs: Number(pause.value) || 1200,
        timeoutMs: 3000,
        ...overrides,
      };
      button.disabled = true;
      try {
        const result = await runMeasure(source, clock, options);
        api.results = result;
        out.textContent = JSON.stringify(result.summary, null, 1);
        return result;
      } finally {
        button.disabled = false;
      }
    },
    async soak(seconds = 60) {
      const result = await deps.soak?.(seconds * 1000);
      out.textContent = JSON.stringify(result ?? "지원하지 않는 방식입니다");
      return result;
    },
  };
  button.onclick = () => void api.run();
  soakButton.onclick = () => void api.soak(60);
  (deps.publish ?? ((a) => ((globalThis as any).__gomeMeasure = a)))(api);
  return true;
}
