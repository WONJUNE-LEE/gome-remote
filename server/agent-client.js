import http from "node:http";

// The gateway's side of the Mac agent's HTTP interface (agent/mac, spec D2, D5, D7):
//   GET  /v1/status    -> {screen, accessibility, display, locked, lastCaptureAt, version}
//   POST /v1/sessions  -> {width, height, sdp} in, {sdp} out
// Both carry the target's bearer token. Only enumerations from the status ever leave this
// module; nothing the agent says is forwarded as text.
export const STATUS_TIMEOUT_MS = 2_000;
export const STATUS_TTL_MS = 10_000;
export const SESSION_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

// kind "rejected": the agent refuses for a state reason, `code` is "permission" or "locked".
// kind "token": the agent did not accept the gateway's token.
// kind "unavailable": unreachable, too slow, or an answer that makes no sense.
export class AgentError extends Error {
  constructor(kind, code) {
    super(`Mac agent: ${kind}${code ? ` (${code})` : ""}`);
    this.name = "AgentError";
    this.kind = kind;
    this.code = code;
  }
}

const ENUMS = {
  screen: ["granted", "denied", "suspect"],
  accessibility: ["granted", "denied"],
  display: ["ok", "asleep", "none"],
};

// Reduces a status document to what the page may see, or undefined when it is not one.
//   issue: "none" | "permission" | "suspect" | "locked"
//     permission: a permission is denied. suspect: the screen only returns black frames; the
//     page shows it as a hint but the tile stays openable, since a new session re-checks.
//     A lock screen is black on purpose, so locked wins over suspect.
//   display: "ok" | "asleep" | "none"
//   lastCaptureAt: seconds since the epoch, or null
export function normaliseStatus(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  for (const [key, allowed] of Object.entries(ENUMS))
    if (!allowed.includes(raw[key])) return undefined;
  if (typeof raw.locked !== "boolean") return undefined;
  const at = raw.lastCaptureAt;
  if (at !== null && !(Number.isSafeInteger(at) && at >= 0)) return undefined;
  const issue =
    raw.screen === "denied" || raw.accessibility === "denied"
      ? "permission"
      : raw.locked
        ? "locked"
        : raw.screen === "suspect"
          ? "suspect"
          : "none";
  return { issue, display: raw.display, lastCaptureAt: at };
}

// One HTTP exchange with a hard deadline and a response size cap. Resolves
// {status, json} (json undefined when the body is not JSON); rejects on a network error,
// on the deadline, or on an oversized answer.
function exchange({ host, port }, { method, path, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// `address(target)` says where the agent listens (tests point it at a local fake).
export function createAgentClient({
  address = (target) => ({ host: target.hostname, port: target.port }),
  now = Date.now,
  log = console.error,
  request = exchange,
  statusTimeoutMs = STATUS_TIMEOUT_MS,
  sessionTimeoutMs = SESSION_TIMEOUT_MS,
} = {}) {
  // One status answer per target for 10 s (offline counts as an answer, so a dead agent
  // is probed once per 10 s, not once per page load). A different token is a different
  // question: after `set-credential` the tile does not wait for the old answer to expire.
  const cache = new Map();
  const pending = new Map();
  const tokenLogged = new Set();

  const rejectedToken = (target) => {
    if (tokenLogged.has(target.id)) return;
    tokenLogged.add(target.id);
    log(
      `Mac agent for target "${target.id}" did not accept the gateway token (401).`,
    );
  };

  return {
    // The normalised status, or undefined when the agent is offline or not understood.
    async status(target, token) {
      const hit = cache.get(target.id);
      if (hit && hit.token === token && now() - hit.at < STATUS_TTL_MS)
        return hit.value;
      const running = pending.get(target.id);
      if (running && running.token === token) return running.promise;
      const promise = (async () => {
        let value;
        try {
          const res = await request(address(target), {
            method: "GET",
            path: "/v1/status",
            token,
            timeoutMs: statusTimeoutMs,
          });
          if (res.status === 200) {
            value = normaliseStatus(res.json);
            tokenLogged.delete(target.id);
          } else if (res.status === 401) rejectedToken(target);
        } catch {
          value = undefined;
        }
        cache.set(target.id, { at: now(), token, value });
        return value;
      })().finally(() => {
        if (pending.get(target.id)?.promise === promise)
          pending.delete(target.id);
      });
      pending.set(target.id, { token, promise });
      return promise;
    },

    // Relays an offer; resolves the answer SDP or throws an AgentError.
    async createSession(target, token, { width, height, sdp }) {
      let res;
      try {
        res = await request(address(target), {
          method: "POST",
          path: "/v1/sessions",
          token,
          body: { width, height, sdp },
          timeoutMs: sessionTimeoutMs,
        });
      } catch {
        throw new AgentError("unavailable");
      }
      if (res.status === 200) {
        const answer = res.json?.sdp;
        if (typeof answer === "string" && answer.startsWith("v=0"))
          return answer;
        throw new AgentError("unavailable");
      }
      if (res.status === 401) {
        rejectedToken(target);
        throw new AgentError("token");
      }
      const code = res.json?.code;
      if (
        (res.status === 403 || res.status === 423) &&
        ["permission", "locked"].includes(code)
      ) {
        cache.delete(target.id); // the tile should show the new state at once
        throw new AgentError("rejected", code);
      }
      throw new AgentError("unavailable");
    },
  };
}
