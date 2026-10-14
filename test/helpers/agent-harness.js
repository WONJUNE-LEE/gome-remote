import { loadTs } from "./load-ts.js";

// A just-enough browser for src/agent.ts: elements that record their listeners, a fake
// RTCPeerConnection whose data channel records what is sent, and timers the test advances
// by hand. It knows none of the rules under test.
export class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.listeners = {};
    this.children = [];
    this.attributes = {};
    this.classNames = new Set();
    this.rect = { left: 0, top: 0, width: 1000, height: 1000 };
    this.clientHeight = 1000;
    this.focused = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.frameCallbacks = [];
    this.srcObject = undefined;
    this.played = 0;
  }
  set className(value) {
    this.classNames = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classNames].join(" ");
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, listener, options) {
    (this.listeners[type] ??= []).push({ listener, options });
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(
      (l) => l.listener !== listener,
    );
  }
  count(type) {
    return (this.listeners[type] ?? []).length;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  focus() {
    this.focused++;
  }
  play() {
    this.played++;
    return Promise.resolve();
  }
  requestVideoFrameCallback(callback) {
    this.frameCallbacks.push(callback);
  }
  // Test helpers.
  fire(type, event = {}) {
    const e = {
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...event,
    };
    for (const { listener } of this.listeners[type] ?? []) listener(e);
    return e;
  }
  showFrame(now = 0) {
    const callbacks = this.frameCallbacks.splice(0);
    for (const callback of callbacks) callback(now, {});
  }
}

export class FakeChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = "connecting";
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = 0;
    this.onclose = null;
  }
  open() {
    this.readyState = "open";
  }
  send(text) {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    this.sent.push(text);
  }
  close() {
    this.closed++;
    this.readyState = "closed";
  }
  // The messages sent so far, parsed.
  messages() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export async function agentHarness({
  codecs = [
    { mimeType: "video/VP8" },
    {
      mimeType: "video/H264",
      sdpFmtpLine:
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    },
    { mimeType: "video/rtx", sdpFmtpLine: "apt=102" },
  ],
  peerConnection = true,
  gathering = "immediate", // "immediate" | "never"
  frameCallbacks = true,
} = {}) {
  const peers = [];
  const nodes = [];
  const documentNode = new FakeNode("document");
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();

  class FakePeerConnection {
    constructor(config) {
      this.config = config;
      this.connectionState = "new";
      this.iceGatheringState = "new";
      this.transceivers = [];
      this.channels = [];
      this.closed = 0;
      this.remote = undefined;
      this.localDescription = null;
      this.onconnectionstatechange = null;
      this.ontrack = null;
      this.onicegatheringstatechange = null;
      peers.push(this);
    }
    addTransceiver(kind, init) {
      const transceiver = {
        kind,
        init,
        receiver: {},
        preferences: undefined,
        setCodecPreferences(list) {
          this.preferences = list;
        },
      };
      this.transceivers.push(transceiver);
      return transceiver;
    }
    createDataChannel(label, options) {
      const channel = new FakeChannel(label, options);
      this.channels.push(channel);
      return channel;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\no=offer" };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
      if (gathering === "immediate") this.iceGatheringState = "complete";
    }
    async setRemoteDescription(description) {
      this.remote = description;
    }
    async getStats() {
      return new Map([
        [
          "v",
          {
            type: "inbound-rtp",
            kind: "video",
            freezeCount: this.freezeCount ?? 0,
          },
        ],
      ]);
    }
    close() {
      this.closed++;
      this.connectionState = "closed";
    }
    // Test helpers.
    completeGathering() {
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    }
    setState(state) {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
    track(stream) {
      this.ontrack?.({ streams: stream ? [stream] : [], track: { id: "t" } });
    }
  }

  const document = {
    createElement(tag) {
      const node = new FakeNode(tag);
      nodes.push(node);
      return node;
    },
    addEventListener: (...args) => documentNode.addEventListener(...args),
    removeEventListener: (...args) => documentNode.removeEventListener(...args),
  };
  class FakeMediaStream {
    constructor(tracks) {
      this.tracks = tracks;
    }
  }
  const setTimeoutFake = (callback, ms) => {
    timers.set(nextTimer, { callback, at: now + ms });
    return nextTimer++;
  };
  const clearTimeoutFake = (id) => timers.delete(id);
  const rafQueue = [];

  const globals = {
    document,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    requestAnimationFrame: (callback) => rafQueue.push(callback),
    performance: { now: () => now },
    MediaStream: FakeMediaStream,
    RTCRtpReceiver: { getCapabilities: () => ({ codecs }) },
    ...(peerConnection ? { RTCPeerConnection: FakePeerConnection } : {}),
  };
  const input = await loadTs("agent-input.ts");
  const mod = await loadTs("agent.ts", globals, { "./agent-input": input });

  const deps = {
    offers: [],
    answers: [],
    frames: 0,
    ended: [],
    signalError: undefined,
    signal(offer) {
      deps.offers.push(offer);
      if (deps.signalError) return Promise.reject(deps.signalError);
      return Promise.resolve({ sdp: "v=0\r\nanswer" });
    },
    onFirstFrame() {
      deps.frames++;
    },
    onEnded(reason) {
      deps.ended.push(reason);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0];
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  };
  const session = mod.createAgentSession(deps);
  const [surface, video] = nodes;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  if (!frameCallbacks) video.requestVideoFrameCallback = undefined;
  // Brings the session up to "channel open, picture showing".
  const connect = async () => {
    const started = session.start();
    await settle();
    const pc = peers.at(-1);
    pc.channels[0].open();
    pc.setState("connected");
    await started;
    pc.track({ id: "stream" });
    video.showFrame(1);
    return pc;
  };
  return {
    session,
    mod,
    surface,
    video,
    documentNode,
    deps,
    peers,
    settle,
    advance,
    connect,
    timers,
    rafQueue,
    flushFrame: () => rafQueue.splice(0).forEach((callback) => callback()),
    channel: () => peers.at(-1)?.channels[0],
    messages: () => peers.at(-1).channels[0].messages(),
  };
}
