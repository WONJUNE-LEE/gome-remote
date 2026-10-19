import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer } from "ws";
import { bridge } from "./tunnel.js";
import { AgentError, createAgentClient } from "./agent-client.js";

export const FORBIDDEN_LOGIN_MESSAGE =
  "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.";
// What the page is told when the Mac agent refuses or cannot be reached (spec D7).
export const AGENT_MESSAGES = {
  permission:
    "Mac에서 화면 기록·손쉬운 사용 권한이 필요합니다. Mac (VNC)로 들어가 허용할 수 있습니다.",
  locked: "Mac이 잠겨 있습니다. Mac (VNC)로 잠금을 해제하세요.",
  unavailable: "연결할 수 없습니다.",
};
const AGENT_BODY_LIMIT = 64 * 1024;

export class Tickets {
  #entries = new Map();
  constructor(now = Date.now, ttl = 20_000) {
    this.now = now;
    this.ttl = ttl;
  }
  sweep() {
    for (const [key, entry] of this.#entries)
      if (entry.expires <= this.now()) this.#entries.delete(key);
  }
  issue(value) {
    this.sweep();
    if (this.#entries.size >= 64)
      throw new Error("Too many pending connections.");
    const ticket = randomBytes(32).toString("base64url");
    this.#entries.set(ticket, { value, expires: this.now() + this.ttl });
    return ticket;
  }
  take(ticket) {
    const entry = this.#entries.get(ticket);
    this.#entries.delete(ticket);
    return entry && entry.expires > this.now() ? entry.value : undefined;
  }
  clear() {
    this.#entries.clear();
  }
}

// The size limits of a session, shared by the Guacamole and the agent routes.
export function validateSize(width, height) {
  if (
    !Number.isInteger(width) ||
    width < 640 ||
    width > 3840 ||
    !Number.isInteger(height) ||
    height < 480 ||
    height > 2160
  )
    throw new Error("Invalid resolution.");
}

// `credentials` comes from the gateway's credential store, never from the caller.
// VNC targets pass the stored username too (empty when there is none): guacd's VNC
// arguments include `username`, which Apple Remote Desktop authentication needs.
export function connectionSettings(target, credentials, size = {}) {
  const { username = "", password = "" } = credentials;
  const { width = 1440, height = 900 } = size;
  validateSize(width, height);
  return {
    connection: {
      type: target.protocol,
      settings: {
        hostname: target.hostname,
        port: String(target.port),
        username,
        password,
        width,
        height,
        dpi: 96,
        "read-only": false,
        "disable-copy": false,
        "disable-paste": false,
        ...(target.protocol === "rdp"
          ? {
              security: target.security || "nla",
              "ignore-cert": target.ignoreCertificate === true,
              "resize-method": "display-update",
              "server-layout": "en-us-qwerty",
              "enable-wallpaper": true,
              "enable-drive": false,
              "enable-printing": false,
              "disable-audio": true,
              "enable-audio-input": false,
            }
          : // 16-bit colour: measured on a 4K Mac, a full frame shrinks from 5.4 MB to
            // 2.0 MB. macOS refuses 8-bit (error 515), and non-default `encodings`
            // make it send ~32 MB per frame, so leave those alone.
            { "color-depth": 16, cursor: "local" }),
      },
    },
  };
}

class BodyTooLarge extends Error {}

async function body(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reachable(target) {
  return new Promise((resolveStatus) => {
    const socket = net.connect(target.port, target.hostname);
    const done = (online) => {
      socket.destroy();
      resolveStatus(online);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function loopbackOrigin(value) {
  try {
    const origin = new URL(value);
    return (
      origin.protocol === "http:" &&
      origin.hostname === "127.0.0.1" &&
      origin.port !== ""
    );
  } catch {
    return false;
  }
}

// `credentials.lookup(target)` resolves to {username, password} (rdp, vnc), {agentToken}
// (agent) or undefined. `agent` is the Mac agent client (server/agent-client.js).
export function createGateway(
  config,
  {
    credentials,
    probe = reachable,
    dist = resolve("dist"),
    now = Date.now,
    agent = createAgentClient({ now }),
    log = console.error,
  } = {},
) {
  const firstLine = (value) => String(value ?? "").split(/\r?\n/, 1)[0];
  const tickets = new Tickets(now);
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  const sweep = setInterval(() => tickets.sweep(), 5000);
  sweep.unref();
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  // Tailscale Serve sets this header from the authenticated tailnet identity and
  // overwrites any value the client sent. Requests that reach the socket without
  // passing through Serve carry no header, so they are refused. Only a development
  // configuration (devLogin, loopback origin) may stand in for a missing header.
  // Nothing else (no Authorization header, no token) ever identifies a caller.
  // Same rule as validateConfig, repeated here so a caller that skipped validation
  // still cannot enable devLogin on a real (tailnet) origin.
  const standIn = loopbackOrigin(config.publicOrigin)
    ? config.devLogin
    : undefined;
  const identify = (req) => {
    const header = req.headers["tailscale-user-login"];
    const login = typeof header === "string" && header ? header : standIn;
    return config.allowedLogins.includes(login) ? login : undefined;
  };
  // An agent target is "ready" once it has a token; "online" and its state come from the
  // agent's own status (cached, one request at a time), not from a TCP probe.
  const agentTile = async (t) => {
    const credential = await credentials.lookup(t);
    const status = credential
      ? await agent.status(t, credential.agentToken)
      : undefined;
    return {
      id: t.id,
      name: t.name,
      platform: t.platform,
      protocol: t.protocol,
      persistent: false,
      online: status !== undefined,
      ready: credential !== undefined,
      ...(status ? { agent: status } : {}),
    };
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const url = new URL(req.url, "http://gateway");
      if (url.pathname === "/healthz" && req.method === "GET")
        return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) {
        const login = identify(req);
        if (!login)
          return json(res, 403, {
            error: FORBIDDEN_LOGIN_MESSAGE,
            code: "login",
          });
        if (req.headers.origin && req.headers.origin !== config.publicOrigin)
          return json(res, 403, { error: "Origin rejected.", code: "origin" });
        if (req.method === "GET" && url.pathname === "/api/targets") {
          const targets = await Promise.all(
            config.targets.map(async (t) => {
              if (t.protocol === "agent") return agentTile(t);
              const [online, credential] = await Promise.all([
                probe(t),
                credentials.lookup(t),
              ]);
              return {
                id: t.id,
                name: t.name,
                platform: t.platform,
                protocol: t.protocol,
                ...(t.profile ? { profile: t.profile } : {}),
                persistent: t.persistent === true,
                online,
                ready: credential !== undefined,
              };
            }),
          );
          return json(res, 200, { targets });
        }
        if (req.method === "POST" && url.pathname === "/api/sessions") {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            return json(res, 415, { error: "JSON required." });
          const input = await body(req);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("Invalid body.");
          // Credentials live only on the server; a client that sends them is
          // either outdated or hostile, and the value must not travel further.
          if (
            Object.hasOwn(input, "username") ||
            Object.hasOwn(input, "password")
          )
            return json(res, 400, {
              error: "자격 증명은 서버에 저장되어 있어 보낼 수 없습니다.",
            });
          const target = config.targets.find((t) => t.id === input.targetId);
          if (!target)
            return json(res, 404, { error: "등록된 서버를 찾을 수 없습니다." });
          // An agent credential is truthy too; it must never reach connectionSettings.
          if (target.protocol === "agent")
            return json(res, 400, {
              error: "이 서버는 /api/agent-sessions 로 연결해야 합니다.",
            });
          const credential = await credentials.lookup(target);
          if (!credential)
            return json(res, 409, {
              error: "이 서버는 아직 설정되지 않았습니다.",
            });
          const settings = connectionSettings(target, credential, {
            width: input.width,
            height: input.height,
          });
          const ticket = tickets.issue({ login, settings });
          return json(res, 201, { ticket, expiresIn: 20 });
        }
        if (req.method === "POST" && url.pathname === "/api/agent-sessions") {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            return json(res, 415, { error: "JSON required." });
          let input;
          try {
            input = await body(req, AGENT_BODY_LIMIT);
          } catch (error) {
            if (error instanceof BodyTooLarge)
              return json(res, 413, { error: "Request too large." });
            throw error;
          }
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("Invalid body.");
          // The token lives only on the server; a client that sends one is outdated or hostile.
          if (
            ["agentToken", "username", "password"].some((key) =>
              Object.hasOwn(input, key),
            )
          )
            return json(res, 400, {
              error: "자격 증명은 서버에 저장되어 있어 보낼 수 없습니다.",
            });
          if (typeof input.sdp !== "string" || !input.sdp.startsWith("v=0"))
            throw new Error("Invalid offer.");
          validateSize(input.width, input.height);
          const target = config.targets.find((t) => t.id === input.targetId);
          if (!target)
            return json(res, 404, { error: "등록된 서버를 찾을 수 없습니다." });
          if (target.protocol !== "agent")
            return json(res, 400, {
              error: "이 서버는 에이전트 방식이 아닙니다.",
            });
          const credential = await credentials.lookup(target);
          if (!credential)
            return json(res, 409, {
              error: "이 서버는 아직 설정되지 않았습니다.",
              code: "setup",
            });
          try {
            const sdp = await agent.createSession(
              target,
              credential.agentToken,
              { width: input.width, height: input.height, sdp: input.sdp },
            );
            return json(res, 200, { sdp });
          } catch (error) {
            if (error instanceof AgentError && error.kind === "rejected")
              return json(res, 409, {
                error: AGENT_MESSAGES[error.code],
                code: error.code,
              });
            // Anything that is not the client's own error is a bug here: say so once, in one
            // line with no secret (the token is cut out of the message, the stack is dropped).
            if (!(error instanceof AgentError))
              log(
                `Mac agent session for "${target.id}" failed unexpectedly: ${String(error?.name ?? "Error")}: ${firstLine(error?.message).split(credential.agentToken).join("[token]")}`,
              );
            // Bad token, timeout, unreachable, nonsense: the page only learns "unavailable".
            return json(res, 424, {
              error: AGENT_MESSAGES.unavailable,
              code: "unavailable",
            });
          }
        }
        return json(res, 404, { error: "Not found." });
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Method not allowed." });
      const path =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const file = resolve(dist, path);
      if (!file.startsWith(`${resolve(dist)}/`))
        return json(res, 404, { error: "Not found." });
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      if (!types[extname(file)]) return json(res, 404, { error: "Not found." });
      let content;
      try {
        content = await readFile(file);
      } catch {
        return json(res, 404, { error: "Not found." });
      }
      res.writeHead(200, {
        "Content-Type": types[extname(file)],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      if (!res.headersSent)
        json(res, 400, {
          error: "요청을 처리할 수 없습니다. 입력값을 확인해주세요.",
        });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const reject = () =>
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    try {
      const url = new URL(req.url, "http://gateway");
      if (
        url.pathname !== "/tunnel" ||
        [...url.searchParams.keys()].some((k) => k !== "ticket")
      )
        return reject();
      // Browsers always send Origin on WebSocket handshakes; a missing or foreign
      // Origin is a non-browser or cross-site client.
      if (req.headers.origin !== config.publicOrigin) return reject();
      const login = identify(req);
      if (!login) return reject();
      if (sockets.clients.size >= 8) return reject();
      const pending = tickets.take(url.searchParams.get("ticket"));
      // A ticket is bound to the login that requested it.
      if (!pending || pending.login !== login) return reject();
      // Only server-generated settings reach guacd. Client query parameters cannot override them.
      sockets.handleUpgrade(req, socket, head, (ws) => {
        bridge(ws, pending.settings.connection, config.guacdPort);
      });
    } catch {
      reject();
    }
  });
  return {
    server,
    async close() {
      clearInterval(sweep);
      tickets.clear();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
