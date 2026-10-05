import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer } from "ws";
import { bridge } from "./tunnel.js";

export const FORBIDDEN_LOGIN_MESSAGE =
  "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.";

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

// `credentials` comes from the gateway's credential store, never from the caller.
// VNC targets pass the stored username too (empty when there is none): guacd's VNC
// arguments include `username`, which Apple Remote Desktop authentication needs.
export function connectionSettings(target, credentials, size = {}) {
  const { username = "", password = "" } = credentials;
  const { width = 1440, height = 900 } = size;
  if (
    !Number.isInteger(width) ||
    width < 640 ||
    width > 3840 ||
    !Number.isInteger(height) ||
    height < 480 ||
    height > 2160
  )
    throw new Error("Invalid resolution.");
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
        "disable-copy": true,
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
            { "color-depth": 16, cursor: "remote" }),
      },
    },
  };
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request too large.");
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

// `credentials.lookup(target)` resolves to {username, password} or undefined.
export function createGateway(
  config,
  {
    credentials,
    probe = reachable,
    dist = resolve("dist"),
    now = Date.now,
  } = {},
) {
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
