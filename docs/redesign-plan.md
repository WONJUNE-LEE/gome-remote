# Gome Remote Simplified Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Gome Remote into one list of the owner's machines (Ubuntu server, Mac) served by a socket-only gateway that authorizes by Tailscale login and injects server-held machine credentials, shown identically by a thin desktop window and a browser.

**Architecture:** The gateway listens only on a unix socket (0700 directory) behind Tailscale Serve, which adds the `Tailscale-User-Login` header; `/api/*` and `/tunnel` accept only logins in the required `allowedLogins`. Machine credentials live in a mode-600 file on the gateway, are entered with `scripts/set-credential.mjs`, and are put into guacd connection parameters by the gateway; clients never send, receive or store them. The Electron app shrinks to a window that opens the gateway origin, with a versioned, origin-restricted preload bridge for the native menu and fullscreen, and one local page for the server address. The UI is rewritten as design B.

**Tech Stack:** Node.js 24 ESM (`node:test`, `ws` 8.22.0 as the only runtime dependency), TypeScript 5.9 + Vite 8 (UI), Electron 44 (CommonJS main/preload), Apache Guacamole 1.6.0 guacd and vendored `guacamole.js`, Tailscale Serve, systemd user unit, Prettier 3 formatting.

**Spec:** `docs/redesign-spec.md` (rev 2, Korean). This plan implements decisions D2-D7 and sections 5-7 of it. Pre-tests P1/P2 (spec section 3) are the owner's and gate the start of implementation; V1-V6 are run after implementation. Neither is part of this plan's automated steps.

## Global Constraints

Every task's requirements include these, copied from the spec (Korean kept verbatim where it is user-visible text).

- Public repository: no real tailnet login, device name or tailnet IP anywhere in the tree. Use `owner@example.com`, `*.example.ts.net`, `*.tail123.ts.net`, `100.64.0.10` and `100.64.0.20`. (`test/public-hygiene.test.js`, Task 8, enforces this.)
- D2: machine credentials (system Remote Login user name/password, Mac VNC password) are stored in the gateway's credentials file, mode 600, owned by the gateway user, per target ID. The gateway injects them into the guacd connection parameters. "클라이언트는 자격 증명을 보내지도, 받지도, 저장하지도 않는다. 요청에 자격 증명 필드가 있으면 400으로 거부한다."
- D2: `node scripts/set-credential.mjs` prompts without echo and writes atomically (temp file 600 -> fsync -> rename); values never appear in argv, environment or logs. A target without credentials is listed as "설정 필요" and cannot be opened. The targets configuration file never contains passwords; the credentials file is not backed up.
- D3: the gateway listens on a unix socket (0700 directory, short path), not a TCP port. `/api/*` and the `/tunnel` upgrade pass only when `Tailscale-User-Login` is exactly one of `allowedLogins`; a missing header is refused. `allowedLogins` is required, has no code default, and an empty list refuses startup.
- D3: Origin rules stay: an `/api/*` Origin, if present, must equal `publicOrigin`; `/tunnel` requires Origin equal to `publicOrigin`. JSON content type is required for POST. Tickets last 20 seconds and are single use. Static UI files need no authorization.
- D3: `devLogin` may replace the header only when `publicOrigin` is `http://127.0.0.1:*`; any other configuration containing `devLogin` refuses startup. `publicOrigin` is otherwise an `https://*.ts.net` origin.
- D3: guacd stays on 127.0.0.1:4822 unauthenticated and unchanged; `server/tunnel.js` does not change.
- D4: the app opens `https://<gateway>/` as is. `contextIsolation` on, `nodeIntegration` off, `sandbox` on. The preload bridge carries a version number and only ever grows; it works only when the window's current origin equals the configured gateway origin; navigation and new windows to other origins are blocked (external links go to the OS browser). The vault, token and credential IPC, `app://` protocol and Linux `basic_text` logic are removed; a leftover `vault.enc` is deleted on first run. The UI falls back to browser mode (separate top bar) when the bridge is missing or older than required.
- D5: Ubuntu target ID `ubuntu-server`, name "Ubuntu 서버", profile `gnome-remote-login` (127.0.0.1:3389, NLA, persistent, `ignoreCertificate` as before); Mac target ID `mac`, name "Mac", Tailscale IP, port 5900, VNC. Old IDs `ubuntu` and `ubuntu-login` are not used. The list API reports `online` (TCP answer) and `ready` (credentials present) and no secret.
- D6/section 6 (design B): warm off-white `#f6f3ee`; white rounded tiles with a colour block per platform (Ubuntu `#e95420` to `#a83a1c`, Mac `#9aa3b2` to `#5d6573`), online dot, name, one-word state (켜짐/꺼짐/설정 필요); dark mode `#22201e` with tiles `#2e2b28`; no sidebar, "워크스페이스", marketing copy or decorative badges; top-right `⋯` with 새로고침 and (app only) 서버 주소 바꾸기; click opens the full window viewer with a spinner and "○○에 연결하는 중".
- Section 6 error table, verbatim: gateway unreachable "서버에 연결할 수 없습니다" + 다시 시도 + 서버 주소 바꾸기; 403 "이 기기의 Tailscale 계정으로는 쓸 수 없습니다"; machine off: dimmed tile "꺼짐", not clickable; no credentials: tile "설정 필요", not clickable; remote failure or drop: centred "연결이 끊겼습니다 / 작업은 그대로 남아 있습니다" with 다시 연결 / 목록으로. Internal error text and credentials never appear in responses or logs.
- D6: existing viewer behaviour is kept and its tests ported: nothing drawn over remote pixels, one remote cursor, F11 local, RDP resolution change, text paste dialog, reconnect, disconnect, browser-only in-flow top bar.
- D7: tag `legacy-dedicated-account` at `89ab9ec` (local; the push belongs to the PR step), then delete `scripts/setup-headless.py`, `scripts/setup-remote-login.py`, `scripts/legacy-units/`, `test/installer_test.py`, `test/remote_login_test.py`, `docs/ubuntu-remote-login-spec.md`, `docs/ubuntu-remote-login-plan.md`; remove the Python step from CI; README points to the tag. The production server's dedicated account is never touched.
- Platform: Node.js 24+; CI runs on Linux, Windows and macOS; packages for all three; no new runtime dependency. Tests use `node:test` (`node --test test/*.test.js`), in the existing style. Format every touched file with `npx prettier --write <files>` (the repository is Prettier-default).
- Out of scope: audio, file transfer, discovery, several users, per-device allow lists, app signing/notarization/auto-update, FileVault unattended login, firewall/SSH/3389 policy, server reboot.

## Review Focus

The five failure modes the spec implies that most likely bite someone using this, most likely first. Each has a named test in the owning task.

1. **Stale socket after SIGKILL or power loss.** The next start must replace a leftover socket file, but never remove a regular file at that path and never take over a live gateway's socket. Tests: Task 4 Step 1 (`test/listen.test.js`: "the socket file left behind by SIGKILL…", "a regular file…", "a live gateway's socket…") and Step 9 (`test/index.test.js`: "after SIGKILL the next start replaces the stale socket and serves again").
2. **Credentials file missing vs wrong mode vs unreadable.** Missing means "no credentials yet" (tiles show 설정 필요, startup succeeds); mode other than 600, a foreign owner, a symlink or malformed content refuses startup with a message that names the file and fixes (`chmod 600`) but no value; a file loosened or edited while running degrades targets to "not ready" instead of crashing, and `set-credential` takes effect without a restart. Tests: Task 3 Step 1 (`test/credentials.test.js`), Task 4 Step 5 ("the file-backed credential store plugs in and degrades…") and Step 9 ("startup is refused with a clear reason for a loosened credentials file").
3. **An old 0.1.3 app talking to the new gateway.** It sends `Authorization: Bearer …`, an `app://gome-remote` Origin from its window and `username`/`password` in the session body. The gateway must answer 400/403 without echoing the values, issue no ticket and open no guacd connection, and the bearer header must neither grant nor deny anything. Test: Task 4 Step 5 ("a 0.1.3 client that sends a bearer token and credentials is refused…").
4. **WebSocket upgrade edge cases.** A handshake without Origin, with `app://gome-remote`, with a trailing-slash origin, without the identity header, with another allowed login's ticket, replayed, expired, or with extra query parameters must be refused with a bare 403 and no tunnel. Test: Task 4 Step 5 ("WebSocket upgrades need the exact public Origin…").
5. **Gateway unreachable when the app starts.** A refused connection, a timeout, or Tailscale Serve answering 502 because the gateway is down must land the user on the local address page (retry and change address available), never on a blank or error page they cannot leave; a subframe failure or a superseded navigation must not. The native menu "서버 주소 바꾸기" must always work. Tests: Task 6 Step 6 ("a gateway that cannot be reached lands on a page where the address can be changed", "the Remote menu offers 서버 주소 바꾸기 at all times"); Task 7 covers the in-page "서버에 연결할 수 없습니다" screen (`test/browser-api.test.js`: "errors are classified…").

Korean text (a Korean user name and password with an emoji split across read chunks) is exercised in Task 3 Step 5 and Task 4 Step 5, so the credential prompt and the guacd wire path are UTF-8 safe.

---

## Decisions Where the Spec Left Room

These are made once here; tasks implement them.

- **Local development listens through a loopback relay, not a second server.** The gateway always listens on `socketPath`. When `devLogin` is configured (only legal with `http://127.0.0.1:<port>`), `server/index.js` also starts a byte-for-byte TCP relay on that loopback port to the socket (`forwardLoopback` in `server/listen.js`). The HTTP server, identity check and Origin rules are the same code path as production. Production configurations cannot enable it, so there is no loopback TCP route to a production gateway (spec V1). `npm run dev` (Vite alone) previews the UI and shows the unreachable screen; the full flow is `npm run build` + gateway with a dev configuration + browser or `npm start` (README, Task 8). The live 0.1.3 gateway uses 127.0.0.1:38989 on the owner's server; every example and test here uses another port or no TCP port.
- **Socket path:** `~/.local/state/gome-remote/gateway.sock` (generated by `init-gateway.mjs` from the home directory, at most 100 bytes). Not `/tmp`: the unit keeps `PrivateTmp=true`, which would hide a socket there from tailscaled. Serve target: `unix:$HOME/.local/state/gome-remote/gateway.sock` on a new HTTPS port (example 8450).
- **`address` is dropped from `/api/targets`.** The UI does not show it and it is an internal detail. The response is `id, name, platform, protocol, profile?, persistent, online, ready`.
- **403 bodies carry a `code`.** Identity refusal is `{ "error": "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.", "code": "login" }`; an Origin refusal is `{ "error": "Origin rejected.", "code": "origin" }`. The UI shows the 403 screen only for `login`.
- **Credentials file is read per request.** `set-credential` needs no gateway restart. Startup is strict; later problems degrade to "not ready" and are logged once per distinct problem.
- **"Mode 600" means exactly `0600`.** `0400` is refused too, as the spec says "not 600".
- **Tickets are bound to the login that requested them**, in addition to being single-use and 20 s.
- **Legacy config fields are refused, not ignored:** `token`, `port`, `listenHost` fail startup with an explanation; `targets[].username` is refused like `password`.
- **`GET /healthz` stays unauthenticated** (it returns only `{"ok":true}`) so the unit's operator can probe the socket.
- **`set-credential` takes `<gateway-config.json> <target-id>`** (the spec's one-argument form cannot find the credentials file). It refuses piped input.
- **Setup page IPC.** The local address page is the one `file:` page the app shows. It talks to main over `setup:*` channels that main accepts only from that page; bridge channels (`remote:*`) are accepted only from the gateway origin. The preload exposes `window.desktopSetup` only when `location.protocol === "file:"`. Origins are derived from `senderFrame.url`, which works in every Electron version.
- **Gateway down is detected two ways:** `did-fail-load` for the main frame (not `ERR_ABORTED`) and `did-navigate` with status 400 or above, because Tailscale Serve answers 502 with an HTML page when the socket is gone.
- **Window navigation:** `will-navigate`/`will-redirect` to anything but the gateway origin are blocked silently; `window.open` of an http(s) URL goes to the OS browser, anything else is dropped.
- **Address input** accepts `host.tailnet.ts.net:8450` (scheme added) and, for development, `http://127.0.0.1:<port>`.
- **Tile state priority:** missing credentials ("설정 필요") wins over power state ("꺼짐"). Windows targets, which the spec does not colour, get a blue gradient.
- **Resolution select is disabled for VNC** (the native menu already disabled it); the old Mac resolution hint is dropped with the rest of the explanatory copy.
- **Setup page CSP** is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`: a local page with no remote content whose script writes only `textContent`.
- **`index.html` loses its meta CSP**; the gateway's response header is the single source (`connect-src 'self'` covers the same-origin WebSocket).
- **Version 0.2.0** (`package.json`, lockfile): the app and gateway are mutually incompatible with 0.1.3.
- **Windows CI** skips the socket, file-mode and `set-credential` tests (the gateway is a Linux service); address, desktop, preload, UI and hygiene tests run everywhere.

## File Structure

| File | Responsibility |
|---|---|
| `server/config.js` | Validate the gateway configuration (Task 2) |
| `server/credentials.js` | Strictly read and look up the credentials file (Task 3) |
| `scripts/set-credential.mjs` | Interactive, atomic credential entry (Task 3) |
| `server/listen.js` | Socket directory/stale-socket handling, loopback dev relay (Task 4) |
| `server/gateway.js` | HTTP/WebSocket authorization, list, sessions, tickets, static UI (Task 4) |
| `server/index.js` | Process entry point, startup refusals, shutdown (Task 2 shim, Task 4) |
| `server/tunnel.js` | Unchanged guacd handshake adapter |
| `scripts/init-gateway.mjs`, `deploy/*` | Configuration generator, unit, example targets (Task 5) |
| `desktop/address.cjs`, `desktop/setup.html` | Server address validation/storage and its local page (Task 6) |
| `desktop/main.cjs`, `desktop/preload.cjs` | Thin shell, bridge, menu, navigation guard (Task 6) |
| `src/api.ts`, `src/tiles.ts`, `src/types.d.ts` | Same-origin API layer, list view rules, types (Task 7) |
| `src/main.ts`, `src/style.css`, `index.html` | The UI (Task 7) |
| `README.md`, `docs/verification.md` | Documentation (Tasks 5, 8) |
| `test/*.test.js` | One test file per unit above; `test/helpers/load-ts.js` compiles `src/*.ts` for tests |

Task order is a dependency chain: 1 (cleanup) -> 2 (config) -> 3 (credentials) -> 4 (gateway) -> 5 (ops) -> 6 (desktop) -> 7 (UI) -> 8 (docs and gate). Run every command from the repository root. The suite stays green after every task.

---

### Task 1: Remove the legacy dedicated-account tooling (spec D7)

**Files:**
- Delete: `scripts/setup-headless.py`, `scripts/setup-remote-login.py`, `scripts/legacy-units/` (4 files), `test/installer_test.py`, `test/remote_login_test.py`, `docs/ubuntu-remote-login-spec.md`, `docs/ubuntu-remote-login-plan.md`
- Modify: `.github/workflows/build.yml` (drop the Python steps), `.gitignore` (drop `__pycache__/`)
- Verify only: `package.json` (its `test` script is `node --test test/*.test.js` and its `build.files` list names no removed file, so it needs no edit)

**Interfaces:**
- Consumes: nothing.
- Produces: local git tag `legacy-dedicated-account` pointing at `89ab9ec` (not pushed; the PR step pushes it, spec section 10 O2); a tree and CI without Python.

- [ ] **Step 1: Record the baseline**

Run: `npm ci && npm test`
Expected: PASS, `tests 20`, `pass 20`, `fail 0`.

- [ ] **Step 2: Tag the last commit that contains the tools**

```bash
git tag legacy-dedicated-account 89ab9ec
git rev-parse --short legacy-dedicated-account
```
Expected: prints `89ab9ec`. Do not push the tag.

- [ ] **Step 3: Delete the legacy files**

```bash
git rm -r scripts/setup-headless.py scripts/setup-remote-login.py scripts/legacy-units \
  test/installer_test.py test/remote_login_test.py \
  docs/ubuntu-remote-login-spec.md docs/ubuntu-remote-login-plan.md
```

- [ ] **Step 4: Remove the Python step from CI**

In `.github/workflows/build.yml`, delete exactly these lines (between `- run: npm test` and `- run: npm run check`):

```yaml
      - uses: actions/setup-python@v5
        if: runner.os == 'Linux'
        with:
          python-version: '3.x'
      - run: python3 -m unittest discover -s test -p '*_test.py'
        if: runner.os == 'Linux'
```

In `.gitignore`, delete the line `__pycache__/`.

- [ ] **Step 5: Check nothing else references the removed files**

Run:
```bash
git grep -n -i -E "setup-headless|setup-remote-login|legacy-units|remote_login|installer_test|unittest|__pycache__" -- . ':!docs/redesign-spec.md' ':!docs/redesign-plan.md' ':!README.md' ':!docs/verification.md'
```
Expected: no output. (`README.md` and `docs/verification.md` still mention them until Tasks 5 and 8 rewrite those files.)

- [ ] **Step 6: Verify the suite still passes**

Run: `npm test`
Expected: PASS, `tests 20`, `pass 20`, `fail 0` (no Node test depended on the Python files).

- [ ] **Step 7: Commit**

```bash
git add -A .github .gitignore scripts test docs
git commit -m "Remove the legacy dedicated-account tooling; recover it from tag legacy-dedicated-account"
```

---

### Task 2: Gateway configuration schema (spec D3, D5)

**Files:**
- Create: `test/config.test.js`
- Modify: `server/config.js` (full rewrite), `test/gateway.test.js` (transitional edits so the suite stays green until Task 4), `server/index.js` (transitional listen on the socket)

**Interfaces:**
- Consumes: nothing.
- Produces (`server/config.js`):
  - `MAX_SOCKET_PATH_BYTES: number` (100)
  - `isTailnetAddress(host: string): boolean` (unchanged)
  - `validateConfig(value: unknown): GatewayConfig` (throws `Error` with a human message)
  - `loadConfig(path: string): Promise<GatewayConfig>`
  - `GatewayConfig = { socketPath: string, publicOrigin: string, allowedLogins: string[], credentialsFile: string, devLogin?: string, guacdPort: number /* default 4822 */, targets: Target[] }` where `Target = { id: string, name: string, platform: "linux"|"mac"|"windows", protocol: "rdp"|"vnc", hostname: string, port: number, persistent?: boolean, profile?: "gnome-remote-login", security?: "nla"|"tls"|"any", ignoreCertificate?: boolean }` (no `username`/`password`).

The listening address is `socketPath` only; `port`, `listenHost` and `token` are refused. Local development uses the relay described in "Decisions"; its config validity rule (`devLogin` only with `http://127.0.0.1:<port>`, and `devLogin` must be in `allowedLogins`) lives here.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, MAX_SOCKET_PATH_BYTES } from "../server/config.js";

const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const base = {
  socketPath: "/tmp/gome-remote/gateway.sock",
  publicOrigin: "https://gateway.example.ts.net:8450",
  allowedLogins: ["owner@example.com"],
  credentialsFile: "/home/user/.config/gome-remote/credentials.json",
  targets: [target],
};

test("a complete configuration validates and applies only the guacd default", () => {
  const config = validateConfig(base);
  assert.equal(config.guacdPort, 4822);
  assert.deepEqual(config.allowedLogins, ["owner@example.com"]);
  assert.equal(config.devLogin, undefined);
});

test("allowedLogins is required, non-empty and has no default", () => {
  const { allowedLogins: _omitted, ...without } = base;
  for (const bad of [
    without,
    { ...base, allowedLogins: [] },
    { ...base, allowedLogins: "owner@example.com" },
    { ...base, allowedLogins: [""] },
    { ...base, allowedLogins: [42] },
    { ...base, allowedLogins: ["a@example.com, b@example.com"] },
    { ...base, allowedLogins: [" owner@example.com"] },
    { ...base, allowedLogins: Array(33).fill("a@example.com") },
  ])
    assert.throws(() => validateConfig(bad), /allowedLogins/);
});

test("legacy token, port and listenHost fields are refused instead of ignored", () => {
  assert.throws(
    () => validateConfig({ ...base, token: "x".repeat(43) }),
    /token/,
  );
  assert.throws(() => validateConfig({ ...base, port: 38989 }), /port/);
  assert.throws(
    () => validateConfig({ ...base, listenHost: "127.0.0.1" }),
    /listenHost/,
  );
});

test("socketPath must be an absolute file path that fits a unix socket", () => {
  for (const socketPath of [
    undefined,
    "gateway.sock",
    "./gateway.sock",
    "/run/gome/",
    "/tmp/a\0b.sock",
    `/tmp/${"x".repeat(MAX_SOCKET_PATH_BYTES)}.sock`,
    `/tmp/${"가".repeat(40)}.sock`,
  ])
    assert.throws(
      () => validateConfig({ ...base, socketPath }),
      /socketPath/,
      String(socketPath),
    );
  const longest = `/tmp/${"x".repeat(MAX_SOCKET_PATH_BYTES - 5)}`;
  assert.equal(Buffer.byteLength(longest), MAX_SOCKET_PATH_BYTES);
  assert.doesNotThrow(() => validateConfig({ ...base, socketPath: longest }));
});

test("credentialsFile must be an absolute path", () => {
  for (const credentialsFile of [undefined, "credentials.json", "~/c.json", 7])
    assert.throws(
      () => validateConfig({ ...base, credentialsFile }),
      /credentialsFile/,
    );
});

test("publicOrigin is a Tailscale HTTPS origin, or loopback http with a port for development", () => {
  for (const publicOrigin of [
    "https://example.com",
    "https://evil.ts.net.example.com",
    "https://.ts.net",
    "http://gateway.example.ts.net",
    "http://127.0.0.1",
    "http://localhost:38989",
    "https://gateway.example.ts.net:8450/",
    "https://user:pw@gateway.example.ts.net",
    "not a url",
    undefined,
  ])
    assert.throws(
      () => validateConfig({ ...base, publicOrigin }),
      Error,
      String(publicOrigin),
    );
  assert.doesNotThrow(() =>
    validateConfig({ ...base, publicOrigin: "http://127.0.0.1:38989" }),
  );
});

test("devLogin is accepted only with a loopback development origin and must be an allowed login", () => {
  const dev = {
    ...base,
    publicOrigin: "http://127.0.0.1:38989",
    devLogin: "owner@example.com",
  };
  assert.equal(validateConfig(dev).devLogin, "owner@example.com");
  assert.throws(
    () => validateConfig({ ...base, devLogin: "owner@example.com" }),
    /devLogin/,
  );
  assert.throws(
    () => validateConfig({ ...dev, devLogin: "other@example.com" }),
    /devLogin/,
  );
});

test("Remote Login is restricted to the colocated Linux authentication boundary", () => {
  const login = {
    ...target,
    hostname: "127.0.0.1",
    persistent: true,
    profile: "gnome-remote-login",
  };
  assert.equal(
    validateConfig({ ...base, targets: [login] }).targets[0].profile,
    "gnome-remote-login",
  );
  for (const change of [
    { hostname: "100.64.0.10" },
    { protocol: "vnc" },
    { platform: "windows" },
    { persistent: false },
    { persistent: undefined },
    { security: "tls" },
    { security: "any" },
    { profile: "autologin" },
  ]) {
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...login, ...change }] }),
    );
  }
  // Existing direct RDP and VNC profiles remain valid without this opt-in.
  assert.doesNotThrow(() => validateConfig(base));
});

test("configuration rejects arbitrary destinations and embedded credentials", () => {
  for (const hostname of [
    "192.168.1.1",
    "example.com",
    "100.63.255.255",
    "100.128.0.0",
    "::1",
    "fd7a:115c:bad::1",
  ]) {
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...target, hostname }] }),
    );
  }
  for (const hostname of [
    "127.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "fd7a:115c:a1e0::1234",
  ]) {
    assert.equal(
      validateConfig({ ...base, targets: [{ ...target, hostname }] }).targets[0]
        .hostname,
      hostname,
    );
  }
  for (const credential of [{ password: "secret" }, { username: "alice" }])
    assert.throws(
      () =>
        validateConfig({ ...base, targets: [{ ...target, ...credential }] }),
      /credentials file/,
    );
});

test("target IDs are unique slugs", () => {
  for (const id of ["Upper", "has space", "", "a".repeat(65)])
    assert.throws(() =>
      validateConfig({ ...base, targets: [{ ...target, id }] }),
    );
  assert.throws(() =>
    validateConfig({ ...base, targets: [target, { ...target }] }),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL. The first test throws `Use a randomly generated gateway token (at least 32 bytes).` because the old validator demands `token`.

- [ ] **Step 3: Replace `server/config.js`**

```js
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path/posix";

// sockaddr_un.sun_path is 108 bytes on Linux (104 on macOS); stay well below both.
export const MAX_SOCKET_PATH_BYTES = 100;

export function isTailnetAddress(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function absolutePath(value, field) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.endsWith("/")
  )
    throw new Error(`${field} must be an absolute file path.`);
  return value;
}

function validateLogins(config, local) {
  const logins = config.allowedLogins;
  if (
    !Array.isArray(logins) ||
    logins.length < 1 ||
    logins.length > 32 ||
    logins.some(
      (login) =>
        typeof login !== "string" ||
        !login ||
        login.length > 254 ||
        /[\s,\x00-\x1f]/.test(login),
    )
  )
    throw new Error(
      "allowedLogins must list 1-32 Tailscale login names; there is no default.",
    );
  if (config.devLogin === undefined) return;
  if (!local)
    throw new Error(
      "devLogin is only allowed when publicOrigin is http://127.0.0.1:<port>.",
    );
  if (!logins.includes(config.devLogin))
    throw new Error("devLogin must also appear in allowedLogins.");
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Gateway configuration must be a JSON object.");
  const config = { guacdPort: 4822, ...value };
  if (Object.hasOwn(config, "token"))
    throw new Error(
      "Gateway tokens are no longer used. Remove `token` and list allowedLogins.",
    );
  for (const legacy of ["port", "listenHost"])
    if (Object.hasOwn(config, legacy))
      throw new Error(
        `\`${legacy}\` is no longer used. The gateway listens on socketPath.`,
      );
  if (
    !Number.isInteger(config.guacdPort) ||
    config.guacdPort < 1 ||
    config.guacdPort > 65535
  )
    throw new Error("Invalid guacdPort.");
  absolutePath(config.socketPath, "socketPath");
  if (Buffer.byteLength(config.socketPath) > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `socketPath must be at most ${MAX_SOCKET_PATH_BYTES} bytes (unix socket limit).`,
    );
  absolutePath(config.credentialsFile, "credentialsFile");
  if (typeof config.publicOrigin !== "string")
    throw new Error("publicOrigin is required.");
  let origin;
  try {
    origin = new URL(config.publicOrigin);
  } catch {
    throw new Error("publicOrigin must be an origin.");
  }
  const local =
    origin.protocol === "http:" &&
    origin.hostname === "127.0.0.1" &&
    origin.port !== "";
  if (
    !(
      origin.protocol === "https:" &&
      origin.hostname.endsWith(".ts.net") &&
      origin.hostname.length > ".ts.net".length
    ) &&
    !local
  )
    throw new Error("Use a Tailscale HTTPS origin.");
  if (
    origin.origin !== config.publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("publicOrigin must be an origin without a path.");
  validateLogins(config, local);
  if (
    !Array.isArray(config.targets) ||
    config.targets.length < 1 ||
    config.targets.length > 100
  )
    throw new Error("Configure 1–100 targets.");
  const ids = new Set();
  for (const target of config.targets) {
    if (!target || typeof target !== "object")
      throw new Error("Invalid target.");
    if (!/^[a-z0-9-]{1,64}$/.test(target.id) || ids.has(target.id))
      throw new Error("Target IDs must be unique slugs.");
    ids.add(target.id);
    if (!["rdp", "vnc"].includes(target.protocol))
      throw new Error("Only RDP and VNC are supported.");
    if (
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.length > 100
    )
      throw new Error("Invalid target name.");
    if (!["linux", "mac", "windows"].includes(target.platform))
      throw new Error("Invalid target platform.");
    if (target.profile !== undefined && target.profile !== "gnome-remote-login")
      throw new Error("Invalid desktop profile.");
    if (
      target.profile === "gnome-remote-login" &&
      (target.protocol !== "rdp" ||
        target.platform !== "linux" ||
        target.hostname !== "127.0.0.1" ||
        target.persistent !== true ||
        (target.security !== undefined && target.security !== "nla"))
    )
      throw new Error(
        "GNOME Remote Login requires local Linux RDP with NLA and session persistence.",
      );
    if (target.hostname !== "127.0.0.1" && !isTailnetAddress(target.hostname))
      throw new Error("Targets must use a Tailscale IP or loopback.");
    if (
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65535
    )
      throw new Error("Invalid target port.");
    if (target.password !== undefined || target.username !== undefined)
      throw new Error(
        "Target credentials belong in the credentials file (scripts/set-credential.mjs), not in gateway configuration.",
      );
    if (
      target.security !== undefined &&
      !["nla", "tls", "any"].includes(target.security)
    )
      throw new Error("Invalid RDP security mode.");
    if (
      target.ignoreCertificate !== undefined &&
      typeof target.ignoreCertificate !== "boolean"
    )
      throw new Error("Invalid certificate policy.");
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS, `tests 10`, `pass 10`.

- [ ] **Step 5: Keep the old gateway tests green (transitional)**

`server/gateway.js` is rewritten in Task 4. Until then the existing gateway tests must keep working with the new schema. In `test/gateway.test.js`:

(a) Delete the two tests that moved to `test/config.test.js`, from `test("Remote Login is restricted to the colocated Linux authentication boundary"` up to (not including) `test("connection tickets expire, are single-use, and cap pending credentials"`:

```bash
node -e '
const fs = require("node:fs");
const file = "test/gateway.test.js";
const s = fs.readFileSync(file, "utf8");
const a = s.indexOf("test(\"Remote Login is restricted");
const b = s.indexOf("test(\"connection tickets expire");
if (a < 0 || b < a) throw new Error("markers not found");
fs.writeFileSync(file, s.slice(0, a) + s.slice(b));
'
```

(b) Replace this text:

```js
const base = {
  publicOrigin: "http://127.0.0.1:38989",
  token: TOKEN,
  targets: [target],
};
```
with:
```js
const base = {
  socketPath: "/tmp/gome-remote/gateway.sock",
  publicOrigin: "http://127.0.0.1:38989",
  allowedLogins: ["owner@example.com"],
  credentialsFile: "/tmp/gome-remote/credentials.json",
  targets: [target],
};
```

(c) Replace this text:

```js
  const config = validateConfig({
    ...base,
    guacdPort: daemon.address().port,
    targets: [{ ...target, protocol, ...overrides }],
  });
```
with:
```js
  // Transitional: the gateway still checks a bearer token until Task 4 replaces it.
  const config = {
    ...validateConfig({
      ...base,
      guacdPort: daemon.address().port,
      targets: [{ ...target, protocol, ...overrides }],
    }),
    token: TOKEN,
  };
```

- [ ] **Step 6: Make `server/index.js` start on the socket (transitional)**

Replace the whole file (Task 4 replaces it again):

```js
import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";

const config = await loadConfig(
  process.env.GOME_REMOTE_CONFIG || "config.local.json",
);
const gateway = createGateway(config);
gateway.server.listen(config.socketPath, () => {
  console.log(`Gome Remote is listening on ${config.socketPath}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, `tests 28`, `pass 28`, `fail 0`.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --check server/config.js server/index.js test/config.test.js test/gateway.test.js
git add server/config.js server/index.js test/config.test.js test/gateway.test.js
git commit -m "Replace the gateway token schema with socketPath, allowedLogins and credentialsFile"
```
Expected: Prettier reports all files formatted (run `--write` and re-add if not).

---

### Task 3: Credential store and `set-credential` (spec D2)

**Files:**
- Create: `server/credentials.js`, `test/credentials.test.js`, `scripts/set-credential.mjs`, `test/set-credential.test.js`

**Interfaces:**
- Consumes (Task 2): `loadConfig(path): Promise<GatewayConfig>` (uses `.credentialsFile` and `.targets`).
- Produces (`server/credentials.js`):
  - `MAX_CREDENTIAL_FILE_BYTES: number` (65536)
  - `class CredentialFileError extends Error`
  - `readCredentialFile(file: string, uid?: number): Promise<Map<string, { username?: string, password: string }>>` - missing file resolves to an empty Map; refuses mode other than exactly 0600, a uid other than `uid` (default `process.getuid()`), a symlink, a non-regular file, oversize or malformed content. Messages name the file/target ID and never a value.
  - `credentialsFor(entries: Map, target: { id: string, protocol: "rdp"|"vnc" }): { username: string, password: string } | undefined` - RDP needs username and password; VNC needs a password and no username (returns `username: ""`).
  - `class CredentialStore { constructor(file: string, options?: { uid?: number, log?: (message: string) => void }); file: string; load(): Promise<Map>; lookup(target): Promise<{ username: string, password: string } | undefined> }` - `load()` is strict (throws `CredentialFileError`); `lookup()` re-reads the file each call, never throws, logs a given problem once.
- Produces (`scripts/set-credential.mjs`):
  - `writeCredentialFile(file: string, entries: Map<string, { username?: string, password: string }>): Promise<void>` - creates the directory 0700, writes `.<name>.<pid>.<hex>.tmp` (mode 600, same directory), fsyncs, renames, fsyncs the directory; removes the temp file on failure.
  - `main(options?: { argv?: string[], stdin?, stdout?, stderr?, requireTty?: boolean, uid?: number }): Promise<number>` - exit code: 0 saved, 1 refused/failed, 2 usage or non-interactive. CLI: `node scripts/set-credential.mjs <gateway-config.json> <target-id>`.

- [ ] **Step 1: Write the failing credential-store test**

Create `test/credentials.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  CredentialFileError,
  credentialsFor,
  readCredentialFile,
} from "../server/credentials.js";

const posix = process.platform !== "win32";
const rdp = { id: "ubuntu-server", protocol: "rdp" };
const vnc = { id: "mac", protocol: "vnc" };
const valid = {
  version: 1,
  targets: {
    "ubuntu-server": { username: "고매", password: "비밀🔑번호" },
    mac: { password: "vncpass1" },
  },
};

async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(dir, value, mode = 0o600, name = "credentials.json") {
  const file = join(dir, name);
  await writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  await chmod(file, mode);
  return file;
}

test("credentialsFor requires a username for RDP and none for VNC", () => {
  const entries = new Map([
    ["ubuntu-server", { username: "u", password: "p" }],
    ["mac", { password: "v" }],
    ["half-rdp", { password: "p" }],
    ["odd-vnc", { username: "u", password: "p" }],
  ]);
  assert.deepEqual(credentialsFor(entries, rdp), {
    username: "u",
    password: "p",
  });
  assert.deepEqual(credentialsFor(entries, vnc), {
    username: "",
    password: "v",
  });
  assert.equal(
    credentialsFor(entries, { id: "half-rdp", protocol: "rdp" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "odd-vnc", protocol: "vnc" }),
    undefined,
  );
  assert.equal(
    credentialsFor(entries, { id: "absent", protocol: "rdp" }),
    undefined,
  );
});

test("a missing credentials file means no credentials, not an error", async (t) => {
  const dir = await workdir(t);
  assert.equal((await readCredentialFile(join(dir, "none.json"))).size, 0);
  const store = new CredentialStore(join(dir, "none.json"), { log: () => {} });
  assert.equal(await store.lookup(rdp), undefined);
});

test(
  "a valid file is read with Unicode preserved",
  { skip: !posix },
  async (t) => {
    const file = await write(await workdir(t), valid);
    const store = new CredentialStore(file);
    assert.deepEqual(await store.lookup(rdp), {
      username: "고매",
      password: "비밀🔑번호",
    });
    assert.deepEqual(await store.lookup(vnc), {
      username: "",
      password: "vncpass1",
    });
  },
);

test(
  "startup refuses a file whose mode is not exactly 600, naming the file but not a value",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    for (const mode of [0o644, 0o640, 0o660, 0o400, 0o700, 0o666]) {
      const file = await write(dir, valid, mode, `c-${mode.toString(8)}.json`);
      await assert.rejects(
        readCredentialFile(file),
        (error) => {
          assert.ok(error instanceof CredentialFileError);
          assert.match(error.message, /mode 600/);
          assert.ok(error.message.includes(file));
          assert.ok(!error.message.includes("비밀"));
          return true;
        },
        mode.toString(8),
      );
    }
  },
);

test(
  "startup refuses a file owned by another uid and a symbolic link",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const file = await write(dir, valid);
    await assert.rejects(
      readCredentialFile(file, process.getuid() + 1),
      /owned by the gateway user/,
    );
    const link = join(dir, "link.json");
    await symlink(file, link);
    await assert.rejects(readCredentialFile(link), /symbolic link/);
  },
);

test(
  "startup refuses malformed content without echoing it",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const secret = "never-print-this";
    for (const content of [
      "{not json " + secret,
      { version: 2, targets: {} },
      { version: 1 },
      { version: 1, targets: [] },
      { version: 1, targets: { "Bad ID": { password: secret } } },
      { version: 1, targets: { mac: { password: "" } } },
      { version: 1, targets: { mac: { password: 7 } } },
      { version: 1, targets: { mac: { password: secret, token: secret } } },
      { version: 1, targets: { mac: { password: secret, username: "" } } },
      { version: 1, targets: { mac: { password: "x".repeat(1025) } } },
      { version: 1, targets: { mac: secret } },
    ]) {
      const file = await write(dir, content);
      await assert.rejects(
        readCredentialFile(file),
        (error) => {
          assert.ok(error instanceof CredentialFileError);
          assert.ok(!error.message.includes(secret), error.message);
          return true;
        },
        JSON.stringify(content).slice(0, 60),
      );
    }
  },
);

test(
  "lookup picks up a rewritten file without a restart and degrades instead of throwing",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const logged = [];
    const file = join(dir, "credentials.json");
    const store = new CredentialStore(file, { log: (m) => logged.push(m) });
    assert.equal(await store.lookup(vnc), undefined);
    assert.deepEqual(
      logged,
      [],
      "a missing file is the normal first-run state",
    );
    await write(dir, valid);
    assert.equal((await store.lookup(vnc)).password, "vncpass1");
    await chmod(file, 0o644);
    assert.equal(await store.lookup(vnc), undefined);
    assert.equal(await store.lookup(vnc), undefined);
    assert.equal(logged.length, 1, "the same problem is logged once");
    assert.match(logged[0], /mode 600/);
    assert.ok(!logged[0].includes("vncpass1"));
    await chmod(file, 0o600);
    assert.equal((await store.lookup(vnc)).password, "vncpass1");
  },
);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/credentials.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/credentials.js`.

- [ ] **Step 3: Implement the credential store**

Create `server/credentials.js`:

```js
import { constants } from "node:fs";
import { open } from "node:fs/promises";

// File format: {"version":1,"targets":{"<id>":{"username":"...","password":"..."}}}
// Values never appear in errors or logs; messages name only the file and target IDs.
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const ID = /^[a-z0-9-]{1,64}$/;

export class CredentialFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialFileError";
  }
}

function parseEntry(id, entry, file) {
  const bad = (why) =>
    new CredentialFileError(`Credentials for "${id}" in ${file} ${why}.`);
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw bad("must be an object");
  for (const key of Object.keys(entry))
    if (!["username", "password"].includes(key))
      throw bad(`has an unknown field "${key}"`);
  if (
    typeof entry.password !== "string" ||
    !entry.password ||
    entry.password.length > 1024
  )
    throw bad("need a password of 1-1024 characters");
  if (
    entry.username !== undefined &&
    (typeof entry.username !== "string" ||
      !entry.username ||
      entry.username.length > 256)
  )
    throw bad("need a username of 1-256 characters when one is present");
  return Object.freeze({
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    password: entry.password,
  });
}

// Returns Map<targetId, {username?, password}>. A missing file means "no credentials yet".
// The permission checks run on the opened descriptor, so the file cannot change between
// the check and the read, and a symbolic link is never followed.
export async function readCredentialFile(file, uid = process.getuid?.()) {
  if (uid === undefined)
    throw new CredentialFileError(
      "Credential files require a POSIX platform (no process uid).",
    );
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    if (error.code === "ELOOP")
      throw new CredentialFileError(`${file} must not be a symbolic link.`);
    throw new CredentialFileError(`Cannot open ${file}: ${error.code}.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CredentialFileError(`${file} must be a regular file.`);
    if ((stat.mode & 0o777) !== 0o600)
      throw new CredentialFileError(
        `${file} must have mode 600 (found ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
      );
    if (stat.uid !== uid)
      throw new CredentialFileError(
        `${file} must be owned by the gateway user (uid ${uid}).`,
      );
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES)
      throw new CredentialFileError(`${file} is larger than expected.`);
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new CredentialFileError(`${file} is not valid JSON.`);
    }
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.targets ||
      typeof parsed.targets !== "object" ||
      Array.isArray(parsed.targets)
    )
      throw new CredentialFileError(
        `${file} must be {"version":1,"targets":{...}}.`,
      );
    const entries = new Map();
    for (const [id, entry] of Object.entries(parsed.targets)) {
      if (!ID.test(id))
        throw new CredentialFileError(`${file} has an invalid target ID.`);
      entries.set(id, parseEntry(id, entry, file));
    }
    return entries;
  } finally {
    await handle.close();
  }
}

// What a target needs: RDP a username and password, VNC a password only.
export function credentialsFor(entries, target) {
  const entry = entries.get(target.id);
  if (!entry) return undefined;
  if (target.protocol === "rdp")
    return entry.username === undefined
      ? undefined
      : { username: entry.username, password: entry.password };
  return entry.username === undefined
    ? { username: "", password: entry.password }
    : undefined;
}

// The gateway reads the file again on every lookup, so `set-credential` takes effect
// without a restart. load() is strict and is used once at startup; lookup() never
// throws, so a file that is damaged later makes targets "not ready" instead of
// crashing the service. The first failure after startup is logged, not repeated.
export class CredentialStore {
  #lastProblem = "";
  constructor(file, { uid = process.getuid?.(), log = console.error } = {}) {
    this.file = file;
    this.uid = uid;
    this.log = log;
  }
  load() {
    return readCredentialFile(this.file, this.uid);
  }
  async lookup(target) {
    try {
      const entries = await this.load();
      this.#lastProblem = "";
      return credentialsFor(entries, target);
    } catch (error) {
      if (error.message !== this.#lastProblem) {
        this.#lastProblem = error.message;
        this.log(`Credentials unavailable: ${error.message}`);
      }
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/credentials.test.js`
Expected: PASS, `tests 7`, `pass 7`. (On Windows the POSIX-only cases are skipped.)

- [ ] **Step 5: Write the failing `set-credential` test**

Create `test/set-credential.test.js`. It injects the input stream (a `PassThrough` fed scripted keystrokes, including a Korean password split mid-code-point) and captures output:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, writeCredentialFile } from "../scripts/set-credential.mjs";
import { readCredentialFile } from "../server/credentials.js";

const posix = process.platform !== "win32";
const script = new URL("../scripts/set-credential.mjs", import.meta.url);

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-setcred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsFile = join(dir, "state", "credentials.json");
  const configPath = join(dir, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({
      socketPath: join(dir, "g.sock"),
      publicOrigin: "http://127.0.0.1:38989",
      allowedLogins: ["owner@example.com"],
      credentialsFile,
      targets: [
        {
          id: "ubuntu-server",
          name: "Ubuntu 서버",
          platform: "linux",
          protocol: "rdp",
          profile: "gnome-remote-login",
          hostname: "127.0.0.1",
          port: 3389,
          persistent: true,
        },
        {
          id: "mac",
          name: "Mac",
          platform: "mac",
          protocol: "vnc",
          hostname: "100.64.0.20",
          port: 5900,
        },
      ],
    }),
  );
  return { dir, configPath, credentialsFile };
}

// Feeds scripted keystrokes and records everything the program prints.
async function run(argv, keystrokes, options = {}) {
  const stdin = new PassThrough();
  const out = [];
  const err = [];
  const stdout = new PassThrough().on("data", (c) => out.push(String(c)));
  const stderr = new PassThrough().on("data", (c) => err.push(String(c)));
  const done = main({
    argv,
    stdin,
    stdout,
    stderr,
    requireTty: false,
    ...options,
  });
  for (const chunk of keystrokes) {
    stdin.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stdin.end();
  const code = await done;
  return { code, out: out.join(""), err: err.join("") };
}

test(
  "RDP target prompts for username and password, stores UTF-8 atomically with mode 600",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    // Split the Korean/emoji bytes mid-codepoint to exercise the UTF-8 decoder.
    const bytes = Buffer.from("고매\n비밀🔑번호\n비밀🔑번호\n");
    const cut = bytes.indexOf(Buffer.from("🔑")) + 2;
    const result = await run(
      [configPath, "ubuntu-server"],
      [bytes.subarray(0, cut), bytes.subarray(cut)],
    );
    assert.equal(result.code, 0, result.err);
    assert.ok(
      !result.out.includes("비밀🔑번호"),
      "the password is never echoed",
    );
    assert.match(result.out, /저장했습니다: ubuntu-server/);
    assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "state")), ["credentials.json"]);
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("ubuntu-server"), {
      username: "고매",
      password: "비밀🔑번호",
    });
  },
);

test(
  "VNC target asks for a password only and keeps other targets",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    await run([configPath, "ubuntu-server"], ["u\n", "p1\n", "p1\n"]);
    const result = await run(
      [configPath, "mac"],
      ["longer-than-8\r\n", "longer-than-8\r\n"],
    );
    assert.equal(result.code, 0, result.err);
    assert.ok(!result.out.includes("사용자 이름"), "VNC has no username");
    assert.match(result.out, /8자/, "Apple's 8 character limit is mentioned");
    const entries = await readCredentialFile(credentialsFile);
    assert.deepEqual(entries.get("mac"), { password: "longer-than-8" });
    assert.deepEqual(entries.get("ubuntu-server"), {
      username: "u",
      password: "p1",
    });
  },
);

test(
  "a mismatched confirmation, empty value, or early EOF writes nothing",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile } = await setup(t);
    for (const keys of [
      ["u\n", "one\n", "two\n"],
      ["  \n", "pw\n", "pw\n"],
      ["u\n", "\n", "\n"],
      ["u\n"],
    ]) {
      const result = await run([configPath, "ubuntu-server"], keys);
      assert.notEqual(result.code, 0, JSON.stringify(keys));
      await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
    }
  },
);

test("argument errors never prompt, and secrets cannot be passed as arguments", async (t) => {
  const { configPath } = await setup(t);
  for (const argv of [[], [configPath], [configPath, "mac", "hunter2"]]) {
    const result = await run(argv, []);
    assert.equal(result.code, 2);
    assert.match(result.err, /Usage/);
    assert.equal(result.out, "");
  }
  const unknown = await run([configPath, "nope"], []);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /ubuntu-server, mac/);
  assert.equal((await run(["/nonexistent.json", "mac"], [])).code, 1);
});

test("the real command refuses piped input", { skip: !posix }, async (t) => {
  const { configPath, credentialsFile } = await setup(t);
  const result = spawnSync(
    process.execPath,
    [script.pathname, configPath, "mac"],
    { input: "secret\nsecret\n", encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive terminal/);
  assert.ok(!result.stdout.includes("secret"));
  await assert.rejects(stat(credentialsFile), { code: "ENOENT" });
});

test(
  "a credentials file with the wrong mode is refused and left untouched",
  { skip: !posix },
  async (t) => {
    const { configPath, credentialsFile, dir } = await setup(t);
    await mkdir(join(dir, "state"), { recursive: true });
    const original = '{"version":1,"targets":{}}';
    await writeFile(credentialsFile, original);
    await chmod(credentialsFile, 0o644);
    const result = await run([configPath, "mac"], ["pw\n", "pw\n"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /mode 600/);
    assert.equal(await readFile(credentialsFile, "utf8"), original);
  },
);

test(
  "a failed replacement keeps the old file and leaves no temporary file",
  { skip: !posix },
  async (t) => {
    const { dir } = await setup(t);
    const target = join(dir, "state", "credentials.json");
    await mkdir(join(target, "occupied"), { recursive: true });
    await assert.rejects(
      writeCredentialFile(target, new Map([["mac", { password: "pw" }]])),
    );
    assert.deepEqual(await readdir(join(dir, "state")), ["credentials.json"]);
    assert.deepEqual(await readdir(target), ["occupied"]);
  },
);
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/set-credential.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/set-credential.mjs`.

- [ ] **Step 7: Implement `set-credential`**

Create `scripts/set-credential.mjs`:

```js
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { loadConfig } from "../server/config.js";
import { readCredentialFile } from "../server/credentials.js";

// Secrets are read from the terminal only: never from argv, the environment, or a file
// named on the command line, so they cannot appear in `ps`, shell history, or logs.

class Prompter {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #waiting;
  #ended = false;
  #skipLineFeed = false;
  constructor(input, output) {
    this.input = input;
    this.output = output;
    input.on("data", (chunk) => {
      this.#buffer += this.#decoder.write(chunk);
      this.#wake();
    });
    input.on("end", () => {
      this.#buffer += this.#decoder.end();
      this.#ended = true;
      this.#wake();
    });
    input.on("error", () => {
      this.#ended = true;
      this.#wake();
    });
  }
  #wake() {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.();
  }
  async #next() {
    while (!this.#buffer) {
      if (this.#ended) return undefined;
      await new Promise((resolve) => {
        this.#waiting = resolve;
      });
    }
    const [char] = this.#buffer; // one code point, so Korean and emoji stay intact
    this.#buffer = this.#buffer.slice(char.length);
    return char;
  }
  async ask(label, { secret }) {
    const raw = secret && this.input.isTTY;
    this.output.write(label);
    if (raw) this.input.setRawMode(true);
    this.input.resume();
    const typed = [];
    try {
      for (;;) {
        const char = await this.#next();
        if (char === undefined) {
          if (typed.length) break; // final line without a newline
          throw new Error("Input ended before a value was entered.");
        }
        if (char === "\n" && this.#skipLineFeed) {
          this.#skipLineFeed = false;
          continue;
        }
        this.#skipLineFeed = false;
        if (char === "\r" || char === "\n") {
          this.#skipLineFeed = char === "\r";
          break;
        }
        if (char === "\x03" || char === "\x04") throw new Error("Cancelled.");
        if (raw && (char === "\x7f" || char === "\b")) {
          typed.pop();
          continue;
        }
        if (raw && char < " ") continue; // ignore other control keys
        typed.push(char);
      }
    } finally {
      if (raw) {
        this.input.setRawMode(false);
        this.output.write("\n"); // raw mode does not echo Enter
      }
      this.input.pause();
    }
    return typed.join("");
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows cannot open or fsync a directory; every POSIX system can.
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

// Temp file (mode 600, same directory) -> fsync -> rename -> fsync directory.
export async function writeCredentialFile(file, entries) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const body = `${JSON.stringify(
    { version: 1, targets: Object.fromEntries(entries) },
    null,
    2,
  )}\n`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.chmod(0o600); // the umask can only remove bits, but be explicit
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

const usage =
  "Usage: node scripts/set-credential.mjs <gateway-config.json> <target-id>";

export async function main({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  requireTty = true,
  uid = process.getuid?.(),
} = {}) {
  const fail = (message, code = 1) => {
    stderr.write(`${message}\n`);
    return code;
  };
  if (argv.length !== 2) return fail(usage, 2);
  const [configPath, targetId] = argv;
  if (requireTty && !stdin.isTTY)
    return fail("Run this in an interactive terminal; do not pipe secrets.", 2);
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    return fail(`Cannot use ${configPath}: ${error.message}`);
  }
  const target = config.targets.find((t) => t.id === targetId);
  if (!target)
    return fail(
      `Unknown target "${targetId}". Configured targets: ${config.targets.map((t) => t.id).join(", ")}`,
    );
  let entries;
  try {
    entries = await readCredentialFile(config.credentialsFile, uid);
  } catch (error) {
    return fail(`Refusing to modify the credentials file: ${error.message}`);
  }
  const prompter = new Prompter(stdin, stdout);
  try {
    stdout.write(
      `${target.name} (${target.id}): 값은 화면에 표시되지 않고 ${config.credentialsFile} 에만 저장됩니다.\n`,
    );
    const username =
      target.protocol === "rdp"
        ? await prompter.ask("사용자 이름: ", { secret: false })
        : undefined;
    if (username !== undefined && !username.trim())
      return fail("사용자 이름이 비어 있어 저장하지 않았습니다.");
    const password = await prompter.ask(
      target.protocol === "rdp" ? "비밀번호: " : "VNC 비밀번호: ",
      { secret: true },
    );
    const again = await prompter.ask("비밀번호 확인: ", { secret: true });
    if (password !== again)
      return fail("두 비밀번호가 달라 저장하지 않았습니다.");
    if (!password || password.length > 1024)
      return fail("비밀번호는 1-1024자여야 합니다. 저장하지 않았습니다.");
    if (username !== undefined && username.length > 256)
      return fail("사용자 이름은 256자 이하여야 합니다. 저장하지 않았습니다.");
    if (
      target.protocol === "vnc" &&
      target.platform === "mac" &&
      password.length > 8
    )
      stdout.write(
        "참고: Apple 화면 공유는 VNC 비밀번호를 앞 8자까지만 사용합니다.\n",
      );
    entries.set(target.id, {
      ...(username !== undefined ? { username } : {}),
      password,
    });
    await writeCredentialFile(config.credentialsFile, entries);
    stdout.write(`저장했습니다: ${target.id}\n`);
    return 0;
  } catch (error) {
    return fail(`저장하지 않았습니다: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
```

- [ ] **Step 8: Run it to verify it passes**

Run: `node --test test/set-credential.test.js`
Expected: PASS, `tests 7`, `pass 7`.

- [ ] **Step 9: Check the real terminal path once (not automatable in `node:test`)**

The tests inject streams, so raw-mode echo suppression and backspace need one manual run in a real terminal. Use a throwaway directory:

```bash
dir=$(mktemp -d)
cat > "$dir/gateway.json" <<EOF
{
  "socketPath": "$dir/g.sock",
  "publicOrigin": "http://127.0.0.1:38991",
  "allowedLogins": ["owner@example.com"],
  "credentialsFile": "$dir/state/credentials.json",
  "targets": [{"id":"ubuntu-server","name":"Ubuntu 서버","platform":"linux","protocol":"rdp","profile":"gnome-remote-login","hostname":"127.0.0.1","port":3389,"persistent":true}]
}
EOF
node scripts/set-credential.mjs "$dir/gateway.json" ubuntu-server
```
Type a user name, then a password containing a mistake corrected with Backspace, then the same password again. Expected: the password characters are never shown; the command prints `저장했습니다: ubuntu-server`; `ls -l "$dir/state"` shows only `credentials.json` with mode `-rw-------`. Remove the directory afterwards (`rm -r "$dir"`). If no real terminal is available (non-interactive agent), record "not run" in the commit message instead of claiming it passed.

- [ ] **Step 10: Run the whole suite, format, commit**

```bash
npm test
npx prettier --check server/credentials.js scripts/set-credential.mjs test/credentials.test.js test/set-credential.test.js
git add server/credentials.js scripts/set-credential.mjs test/credentials.test.js test/set-credential.test.js
git commit -m "Add the credentials file reader and the set-credential prompt"
```
Expected: `tests 42`, `pass 42`, `fail 0`; Prettier clean.

---

### Task 4: Gateway authorization, credential injection and socket listening (spec D2, D3, D5)

**Files:**
- Create: `server/listen.js`, `test/listen.test.js`, `test/index.test.js`
- Modify: `server/gateway.js` (rewrite), `server/index.js` (rewrite), `test/gateway.test.js` (rewrite)
- Unchanged: `server/tunnel.js`

**Interfaces:**
- Consumes (Task 2): `validateConfig`, `GatewayConfig`, `loadConfig`. (Task 3): `CredentialStore`, `credentialsFor` semantics (`lookup(target)` resolves `{username, password}` or `undefined`).
- Produces (`server/listen.js`):
  - `prepareSocketDirectory(socketPath: string, uid?: number): Promise<void>` - `mkdir -p` mode 0700, then refuses a non-directory, a foreign owner, or any group/other permission bit.
  - `clearStaleSocket(socketPath: string): Promise<void>` - no-op if absent; refuses a non-socket; refuses (`already listening`) if a connection succeeds; removes only a socket that refuses connections.
  - `listenOnSocket(server: http.Server, socketPath: string): Promise<void>` - prepare, clear, listen, chmod 0600.
  - `removeSocket(socketPath: string): Promise<void>` - unlinks only a socket, ignores errors.
  - `forwardLoopback(socketPath: string, port: number): Promise<net.Server>` - dev-only relay on `127.0.0.1:<port>`.
- Produces (`server/gateway.js`):
  - `FORBIDDEN_LOGIN_MESSAGE: "이 기기의 Tailscale 계정으로는 쓸 수 없습니다."`
  - `class Tickets` (unchanged API: `issue(value)`, `take(ticket)`, `sweep()`, `clear()`; 20 s, 64 pending)
  - `connectionSettings(target, credentials: {username?, password?}, size?: {width?, height?}): { connection: { type, settings } }`
  - `createGateway(config: GatewayConfig, options: { credentials: { lookup(target): Promise<{username, password} | undefined> }, probe?: (target) => Promise<boolean>, dist?: string, now?: () => number }): { server: http.Server, close(): Promise<void> }`
  - HTTP contract, identity = `Tailscale-User-Login` (exact match in `allowedLogins`; with `config.devLogin` it stands in for a missing header only):
    - `GET /healthz` -> 200 `{"ok":true}` (no identity).
    - Static files for `GET`/`HEAD` (no identity).
    - `/api/*` without a permitted login -> 403 `{ error: FORBIDDEN_LOGIN_MESSAGE, code: "login" }`; with an Origin other than `publicOrigin` -> 403 `{ error: "Origin rejected.", code: "origin" }`.
    - `GET /api/targets` -> 200 `{ targets: [{ id, name, platform, protocol, profile?, persistent, online, ready }] }`.
    - `POST /api/sessions` with `Content-Type: application/json`, body `{ targetId, width?, height? }` -> 201 `{ ticket, expiresIn: 20 }`; 415 non-JSON; 400 if the body has an own `username` or `password` key (any value) or is invalid; 404 unknown target; 409 `{ error: "이 서버는 아직 설정되지 않았습니다." }` when no credentials.
    - Upgrade `GET /tunnel?ticket=<t>` (subprotocol `guacamole`): requires Origin exactly `publicOrigin`, a permitted login, the ticket issued to that same login; otherwise a bare 403.
- Produces (`server/index.js`): the service entry point. Reads `GOME_REMOTE_CONFIG` (default `config.local.json`). Refuses to start (stderr `Gome Remote refused to start: <reason>`, exit 1) on invalid configuration or credentials file; listens on `socketPath` (0700 dir, 0600 socket); with `devLogin` also relays the `publicOrigin` loopback port; removes the socket on SIGTERM/SIGINT.

- [ ] **Step 1: Write the failing socket tests**

Create `test/listen.test.js` (uses real unix sockets in short `mkdtemp` directories and a child process killed with SIGKILL):

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStaleSocket,
  forwardLoopback,
  listenOnSocket,
  prepareSocketDirectory,
} from "../server/listen.js";

const posix = process.platform !== "win32";

async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), "gr-l-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const echoServer = () =>
  http.createServer((req, res) => res.end("hello from the socket"));
const get = (socketPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/" }, async (res) => {
        let text = "";
        for await (const chunk of res) text += chunk;
        resolve(text);
      })
      .on("error", reject);
  });

test(
  "listening creates a 0600 socket inside a freshly created 0700 directory",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "state", "g.sock");
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    t.after(() => server.close());
    assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "a directory open to group or others, or owned by someone else, is refused",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    for (const mode of [0o755, 0o750, 0o770, 0o701]) {
      const open = join(dir, `m${mode.toString(8)}`);
      await mkdir(open);
      await chmod(open, mode);
      await assert.rejects(
        prepareSocketDirectory(join(open, "g.sock")),
        /must not be accessible/,
        mode.toString(8),
      );
    }
    await assert.rejects(
      prepareSocketDirectory(join(dir, "g.sock"), process.getuid() + 1),
      /owned by the gateway user/,
    );
  },
);

test(
  "a regular file at the socket path is never removed",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    await writeFile(socketPath, "precious");
    await assert.rejects(clearStaleSocket(socketPath), /not a socket/);
    assert.ok((await lstat(socketPath)).isFile());
  },
);

test(
  "a live gateway's socket is never taken over",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const first = echoServer();
    await listenOnSocket(first, socketPath);
    t.after(() => first.close());
    await assert.rejects(
      listenOnSocket(echoServer(), socketPath),
      /already listening/,
    );
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "the socket file left behind by SIGKILL is replaced on the next start",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import net from "node:net"; net.createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up")); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.ok(
      (await lstat(socketPath)).isSocket(),
      "the killed process left its socket file",
    );
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    t.after(() => server.close());
    assert.equal(await get(socketPath), "hello from the socket");
  },
);

test(
  "the development relay forwards bytes between a loopback port and the socket",
  { skip: !posix },
  async (t) => {
    const dir = await workdir(t);
    const socketPath = join(dir, "g.sock");
    const server = echoServer();
    await listenOnSocket(server, socketPath);
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const relay = await forwardLoopback(socketPath, port);
    t.after(() => {
      relay.close();
      server.close();
    });
    assert.equal(relay.address().address, "127.0.0.1");
    const text = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, async (res) => {
          let body = "";
          for await (const chunk of res) body += chunk;
          resolve(body);
        })
        .on("error", reject);
    });
    assert.equal(text, "hello from the socket");
  },
);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/listen.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/listen.js`.

- [ ] **Step 3: Implement `server/listen.js`**

```js
import net from "node:net";
import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

// The socket's directory is the real access boundary: mode 700, owned by the gateway
// user. Refuse to start rather than quietly tighten a directory someone else owns.
export async function prepareSocketDirectory(
  socketPath,
  uid = process.getuid?.(),
) {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory.`);
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${directory} must be owned by the gateway user.`);
  if (info.mode & 0o077)
    throw new Error(
      `${directory} must not be accessible by group or others; run: chmod 700 ${directory}`,
    );
}

function probe(socketPath) {
  return new Promise((resolveProbe) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe("live");
    });
    socket.once("error", (error) =>
      resolveProbe(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? "stale"
          : error.code,
      ),
    );
  });
}

// SIGKILL and power loss leave the socket file behind. Remove it only when it is a
// socket nobody is listening on; never a regular file and never a live gateway.
export async function clearStaleSocket(socketPath) {
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket())
    throw new Error(
      `${socketPath} exists and is not a socket; not removing it.`,
    );
  const state = await probe(socketPath);
  if (state === "live")
    throw new Error(`Another gateway is already listening on ${socketPath}.`);
  if (state !== "stale")
    throw new Error(`Cannot inspect ${socketPath}: ${state}.`);
  await rm(socketPath);
}

export async function listenOnSocket(server, socketPath) {
  await prepareSocketDirectory(socketPath);
  await clearStaleSocket(socketPath);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  // Safe even before this runs: the 700 directory already keeps other users out.
  await chmod(socketPath, 0o600);
}

// net.Server unlinks the socket when it closes; this covers the case where close()
// raced with an error, and never touches anything that is not a socket.
export async function removeSocket(socketPath) {
  try {
    if ((await lstat(socketPath)).isSocket()) await rm(socketPath);
  } catch {
    // already gone
  }
}

// Development only (devLogin + http://127.0.0.1:<port>): a browser or the desktop app
// cannot reach a unix socket, so relay a loopback TCP port to it byte for byte. The
// gateway still sees one HTTP server and applies the same identity and Origin rules.
export function forwardLoopback(socketPath, port) {
  const relay = net.createServer((client) => {
    const upstream = net.connect(socketPath);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolveListen, rejectListen) => {
    relay.once("error", rejectListen);
    relay.listen(port, "127.0.0.1", () => resolveListen(relay));
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/listen.test.js`
Expected: PASS, `tests 6`, `pass 6`.

- [ ] **Step 5: Rewrite the gateway tests (they fail against the old gateway)**

Replace `test/gateway.test.js` entirely. It runs a real gateway on a real unix socket (short `mkdtemp` path, well under the 108-byte limit) with the independent guacd wire fixture from the old file; requests go through `http.request({ socketPath })` and WebSockets through `ws+unix://`. The fake guacd now drops non-Guacamole input instead of throwing, because stray port scanners can connect to its random port.

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGateway, Tickets } from "../server/gateway.js";
import { validateConfig } from "../server/config.js";
import { CredentialStore } from "../server/credentials.js";
import { listenOnSocket } from "../server/listen.js";

// The gateway listens on a unix socket, which Windows does not support the same way.
const posix = process.platform !== "win32";
const LOGIN = "owner@example.com";
const ORIGIN = "http://127.0.0.1:38989";
const FORBIDDEN = "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.";
const target = {
  id: "linux",
  name: "Linux",
  protocol: "rdp",
  platform: "linux",
  hostname: "100.64.0.10",
  port: 3390,
};
const base = {
  socketPath: "/tmp/gr/gateway.sock",
  publicOrigin: ORIGIN,
  allowedLogins: [LOGIN],
  credentialsFile: "/tmp/gr/credentials.json",
  targets: [target],
};

test("connection tickets expire, are single-use, and cap pending credentials", () => {
  let now = 0;
  const tickets = new Tickets(() => now, 20);
  const first = tickets.issue({ secret: "a" });
  assert.deepEqual(tickets.take(first), { secret: "a" });
  assert.equal(tickets.take(first), undefined);
  const second = tickets.issue("b");
  now = 20;
  assert.equal(tickets.take(second), undefined);
  for (let i = 0; i < 64; i++) tickets.issue(i);
  assert.throws(() => tickets.issue("overflow"));
  now = 40;
  tickets.issue("after-expiry");
  tickets.clear();
});

// An independent wire fixture: preserve every received instruction and inspect the
// actual TCP handshake, rather than asserting a mock call to the settings builder.
function wire(parts) {
  return (
    parts.map((p) => `${Array.from(String(p)).length}.${p}`).join(",") + ";"
  );
}
function decode(buffer) {
  let offset = 0;
  const parts = [];
  while (offset < buffer.length) {
    const dot = buffer.indexOf(".", offset);
    if (dot < 0) return null;
    const length = Number(buffer.slice(offset, dot));
    if (!Number.isInteger(length) || length < 0)
      throw new Error("Invalid wire input");
    const rest = Array.from(buffer.slice(dot + 1));
    if (rest.length <= length) return null;
    const part = rest.slice(0, length).join("");
    parts.push(part);
    offset = dot + 1 + part.length;
    const delimiter = buffer[offset++];
    if (delimiter === ";") return { parts, rest: buffer.slice(offset) };
    assert.equal(delimiter, ",");
  }
  return null;
}

function fakeGuacd(received, connections) {
  return net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        let decoded;
        try {
          decoded = decode(buffer);
        } catch {
          // Anything that is not Guacamole (for example a port scanner) is dropped.
          return socket.destroy();
        }
        if (!decoded) break;
        buffer = decoded.rest;
        const parts = decoded.parts;
        received.push(parts);
        if (parts[0] === "select")
          socket.write(
            wire([
              "args",
              "VERSION_1_5_0",
              "hostname",
              "port",
              "username",
              "password",
              "read-only",
              "enable-drive",
              "disable-copy",
              "enable-wallpaper",
              "security",
            ]),
          );
        if (parts[0] === "connect") {
          assert.deepEqual(
            received.find((p) => p[0] === "size"),
            ["size", "1920", "1080", "96"],
          );
          assert.deepEqual(
            received.find((p) => p[0] === "image"),
            ["image", "image/png", "image/jpeg"],
          );
          socket.write(wire(["ready", "$test"]));
          // Deliberately split a multibyte name across TCP writes.
          const name = Buffer.from(wire(["name", "원격 🖥️"]));
          const cut = name.indexOf(Buffer.from("원")) + 1;
          socket.write(name.subarray(0, cut));
          setImmediate(() => socket.write(name.subarray(cut)));
        }
      }
    });
  });
}

function request(
  socketPath,
  path,
  { method = "GET", headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method, headers },
      async (res) => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: parsed,
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const stub = (entries) => ({
  entries,
  lookup: async (t) => entries[t.id],
});
const defaults = {
  rdp: { linux: { username: "entry-user", password: "entry-password" } },
  vnc: { linux: { username: "", password: "vnc-password" } },
};

// A real gateway on a real unix socket in a short, private temp directory (the
// sun_path limit is about 100 bytes), with an independent guacd fixture behind it.
async function fixture(t, options = {}) {
  const {
    protocol = "rdp",
    clock = Date.now,
    overrides = {},
    config: extra = {},
    credentials = stub({ ...defaults[protocol] }),
    probe = async () => true,
    dist,
  } = options;
  const received = [];
  const connections = new Set();
  const daemon = fakeGuacd(received, connections);
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const dir = await mkdtemp(join(tmpdir(), "gr-"));
  const socketPath = join(dir, "g.sock");
  const config = validateConfig({
    ...base,
    socketPath,
    guacdPort: daemon.address().port,
    targets: [{ ...target, protocol, ...overrides }],
    ...extra,
  });
  const gateway = createGateway(config, {
    now: clock,
    credentials,
    probe: probe ?? undefined,
    dist,
  });
  await listenOnSocket(gateway.server, socketPath);
  t.after(async () => {
    await gateway.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => daemon.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const call = (path, { login = LOGIN, headers = {}, ...rest } = {}) =>
    request(socketPath, path, {
      ...rest,
      headers: {
        ...(login ? { "Tailscale-User-Login": login } : {}),
        ...headers,
      },
    });
  const post = (input, { headers = {}, ...rest } = {}) =>
    call("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
      ...rest,
    });
  const open = (ticket, { origin = ORIGIN, query = "", login = LOGIN } = {}) =>
    new WebSocket(
      `ws+unix://${socketPath}:/tunnel?ticket=${ticket}${query}`,
      "guacamole",
      {
        ...(origin ? { origin } : {}),
        headers: login ? { "Tailscale-User-Login": login } : {},
      },
    );
  return { received, connections, call, post, open, socketPath, credentials };
}

async function rejected(socket) {
  const [error] = await once(socket, "error");
  assert.match(error.message, /403/);
}

test(
  "a missing or foreign Tailscale login is refused on every API route, with the exact message",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const login of [
      null,
      "",
      "other@example.com",
      `${LOGIN}, other@example.com`,
      LOGIN.toUpperCase(),
    ]) {
      for (const [path, options] of [
        ["/api/targets", {}],
        [
          "/api/sessions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{"targetId":"linux"}',
          },
        ],
        ["/api/unknown", {}],
      ]) {
        const response = await f.call(path, { login, ...options });
        assert.equal(response.status, 403, `${login} ${path}`);
        assert.deepEqual(response.json, { error: FORBIDDEN, code: "login" });
      }
    }
    assert.equal(f.connections.size, 0);
    assert.equal((await f.call("/api/targets")).status, 200);
  },
);

test(
  "the health check and static UI need no identity, API and tunnel do",
  { skip: !posix },
  async (t) => {
    const dist = await mkdtemp(join(tmpdir(), "gr-dist-"));
    t.after(() => rm(dist, { recursive: true, force: true }));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>ui</title>",
    );
    const f = await fixture(t, { dist });
    assert.equal((await f.call("/healthz", { login: null })).status, 200);
    const page = await f.call("/", { login: null });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>ui<\/title>/);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(
      (await f.call("/../package.json", { login: null })).status,
      404,
    );
    assert.equal((await f.call("/api/targets", { login: null })).status, 403);
  },
);

test(
  "API Origin must be absent or the public origin; the old app origin is refused",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    for (const origin of [
      "https://evil.example",
      "app://gome-remote",
      "null",
      ORIGIN + ".evil.example",
    ]) {
      const response = await f.call("/api/targets", {
        headers: { Origin: origin },
      });
      assert.equal(response.status, 403, origin);
      assert.equal(response.json.code, "origin");
    }
    assert.equal(
      (await f.call("/api/targets", { headers: { Origin: ORIGIN } })).status,
      200,
    );
    assert.equal((await f.call("/api/targets")).status, 200);
  },
);

test(
  "a 0.1.3 client that sends a bearer token and credentials is refused before any ticket or guacd contact",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    const old = {
      Authorization: `Bearer ${"x".repeat(43)}`,
      "Content-Type": "application/json",
    };
    const response = await f.post(
      {
        targetId: "linux",
        username: "old-user",
        password: "old-secret",
        width: 1920,
        height: 1080,
      },
      { headers: old },
    );
    assert.equal(response.status, 400);
    assert.ok(!response.text.includes("old-secret"));
    assert.ok(!response.text.includes("old-user"));
    assert.equal(response.json.ticket, undefined);
    // Even an empty string counts as "sent credentials".
    assert.equal(
      (await f.post({ targetId: "linux", password: "" })).status,
      400,
    );
    assert.equal(
      (await f.post({ targetId: "linux", username: "" })).status,
      400,
    );
    // Its Electron-hosted origin is not the public origin.
    const app = await f.post(
      { targetId: "linux" },
      { headers: { Origin: "app://gome-remote" } },
    );
    assert.equal(app.status, 403);
    // The Authorization header neither helps nor hurts a request that passes the real checks.
    assert.equal(
      (
        await f.post(
          { targetId: "linux", width: 1920, height: 1080 },
          { headers: old },
        )
      ).status,
      201,
    );
    assert.equal(f.connections.size, 0);
  },
);

test(
  "the target list carries state but no address and no secret",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      overrides: {
        profile: "gnome-remote-login",
        hostname: "127.0.0.1",
        persistent: true,
      },
    });
    const response = await f.call("/api/targets");
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.json.targets[0]).sort(), [
      "id",
      "name",
      "online",
      "persistent",
      "platform",
      "profile",
      "protocol",
      "ready",
    ]);
    assert.equal(response.json.targets[0].profile, "gnome-remote-login");
    assert.equal(response.json.targets[0].ready, true);
    for (const secret of ["entry-user", "entry-password", "127.0.0.1", "3390"])
      assert.ok(!response.text.includes(secret), secret);
  },
);

test(
  "online reflects a real TCP probe of the target",
  { skip: !posix },
  async (t) => {
    const listener = net.createServer().listen(0, "127.0.0.1");
    await once(listener, "listening");
    t.after(() => listener.close());
    const open = { hostname: "127.0.0.1", port: listener.address().port };
    const f = await fixture(t, { overrides: open, probe: null });
    assert.equal((await f.call("/api/targets")).json.targets[0].online, true);
    const closed = net.createServer().listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const g = await fixture(t, {
      overrides: { hostname: "127.0.0.1", port },
      probe: null,
    });
    assert.equal((await g.call("/api/targets")).json.targets[0].online, false);
  },
);

test(
  "a target without stored credentials is not ready and cannot start a session",
  { skip: !posix },
  async (t) => {
    const credentials = stub({});
    const f = await fixture(t, { credentials });
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, false);
    const response = await f.post({ targetId: "linux" });
    assert.equal(response.status, 409);
    assert.equal(f.connections.size, 0);
    credentials.entries.linux = { username: "u", password: "p" };
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, true);
    assert.equal((await f.post({ targetId: "linux" })).status, 201);
  },
);

test(
  "HTTP rejects unregistered targets, bad bodies and bad sizes before dialing guacd",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.post({ targetId: "other", hostname: "8.8.8.8" })).status,
      404,
    );
    assert.equal(
      (await f.post({ targetId: "linux", width: 999999 })).status,
      400,
    );
    assert.equal((await f.post([])).status, 400);
    assert.equal(
      (
        await f.call("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await f.call("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(f.connections.size, 0);
  },
);

test(
  "Remote Login ignores caller routing overrides and uses only the stored credentials",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, {
      overrides: {
        profile: "gnome-remote-login",
        hostname: "127.0.0.1",
        persistent: true,
      },
    });
    const { json: ticket } = await f.post({
      targetId: "linux",
      width: 1920,
      height: 1080,
      profile: "direct",
      hostname: "100.64.0.99",
      port: 22,
      security: "tls",
    });
    const ws = f.open(ticket.ticket);
    await new Promise((resolve) =>
      ws.on("message", (data) => {
        if (data.toString().includes("원격")) resolve();
      }),
    );
    assert.deepEqual(f.received.find((p) => p[0] === "connect").slice(2, 6), [
      "127.0.0.1",
      "3390",
      "entry-user",
      "entry-password",
    ]);
    assert.equal(f.received.find((p) => p[0] === "connect").at(-1), "nla");
    ws.close();
    await once(ws, "close");
  },
);

for (const protocol of ["rdp", "vnc"])
  test(
    `${protocol} tunnel injects the stored credentials and preserves Unicode`,
    { skip: !posix },
    async (t) => {
      const credentials = stub({
        linux:
          protocol === "rdp"
            ? { username: "고매🖥", password: "암호🔑" }
            : { username: "", password: "암호🔑" },
      });
      const f = await fixture(t, { protocol, credentials });
      const response = await f.post({
        targetId: "linux",
        hostname: "8.8.8.8",
        port: 22,
        width: 1920,
        height: 1080,
      });
      assert.equal(response.status, 201);
      const result = response.json;
      assert.deepEqual(Object.keys(result).sort(), ["expiresIn", "ticket"]);
      const ws = f.open(result.ticket);
      const messages = [];
      const gotName = new Promise((resolve) =>
        ws.on("message", (data) => {
          messages.push(data.toString());
          if (data.toString().includes("원격")) resolve();
        }),
      );
      await gotName;
      assert.deepEqual(f.received[0], ["select", protocol]);
      assert.deepEqual(
        f.received.find((p) => p[0] === "connect"),
        [
          "connect",
          "VERSION_1_1_0",
          "100.64.0.10",
          "3390",
          protocol === "rdp" ? "고매🖥" : "",
          "암호🔑",
          "false",
          protocol === "rdp" ? "false" : "",
          "true",
          protocol === "rdp" ? "true" : "",
          protocol === "rdp" ? "nla" : "",
        ],
      );
      assert.ok(messages.includes("0.,5.$test;"));
      assert.ok(messages.includes(wire(["name", "원격 🖥️"])));
      ws.send("3.key,2.65,1.1;");
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (f.received.some((p) => p[0] === "key")) {
            clearInterval(interval);
            resolve();
          }
        }, 5);
        interval.unref();
      });
      assert.deepEqual(
        f.received.find((p) => p[0] === "key"),
        ["key", "65", "1"],
      );
      ws.close();
      await once(ws, "close");
      const replay = f.open(result.ticket);
      await rejected(replay);
    },
  );

test(
  "WebSocket upgrades need the exact public Origin, a permitted login and the same login's ticket",
  { skip: !posix },
  async (t) => {
    let now = 0;
    const f = await fixture(t, {
      clock: () => now,
      config: { allowedLogins: [LOGIN, "second@example.com"] },
    });
    const fresh = async (login = LOGIN) =>
      (await f.post({ targetId: "linux" }, { login })).json.ticket;
    for (const options of [
      { origin: "https://evil.example" },
      { origin: "app://gome-remote" },
      { origin: null },
      { origin: ORIGIN + "/" },
      { query: "&hostname=8.8.8.8" },
      { login: null },
      { login: "stranger@example.com" },
      { login: "second@example.com" },
    ])
      await rejected(f.open(await fresh(), options));
    const ticket = await fresh();
    now = 20_000;
    await rejected(f.open(ticket));
    assert.equal(f.connections.size, 0);
    // A ticket survives a refused attempt only if the refusal happened before it was taken.
    now = 0;
    const good = f.open(await fresh());
    await once(good, "open");
    good.close();
  },
);

test(
  "a development login stands in for a missing header only when configured",
  { skip: !posix },
  async (t) => {
    const f = await fixture(t, { config: { devLogin: LOGIN } });
    assert.equal((await f.call("/api/targets", { login: null })).status, 200);
    assert.equal(
      (await f.call("/api/targets", { login: "other@example.com" })).status,
      403,
    );
    const production = await fixture(t);
    assert.equal(
      (await production.call("/api/targets", { login: null })).status,
      403,
    );
  },
);

test(
  "the file-backed credential store plugs in and degrades when its mode is loosened",
  { skip: !posix },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gr-cs-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "credentials.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        targets: { linux: { username: "u", password: "p" } },
      }),
    );
    await chmod(file, 0o600);
    const store = new CredentialStore(file, { log: () => {} });
    const f = await fixture(t, { credentials: store });
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, true);
    await chmod(file, 0o644);
    assert.equal((await f.call("/api/targets")).json.targets[0].ready, false);
    assert.equal((await f.post({ targetId: "linux" })).status, 409);
  },
);
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/gateway.test.js`
Expected: FAIL. The old gateway still authorizes with a bearer token, so identity-based requests answer 401 and `createGateway` ignores `credentials`.

- [ ] **Step 7: Rewrite `server/gateway.js`**

`server/tunnel.js` is untouched. The new gateway keeps the ticket store, `connectionSettings` body and static serving, and replaces bearer authorization with the identity check, credential injection, the credential-field refusal and the stricter upgrade rules.

```js
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
          : { "color-depth": 24, cursor: "remote" }),
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
  const identify = (req) => {
    const header = req.headers["tailscale-user-login"];
    const login =
      typeof header === "string" && header ? header : config.devLogin;
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
```

- [ ] **Step 8: Run it to verify it passes**

Run: `node --test test/gateway.test.js`
Expected: PASS, `tests 15`, `pass 15`.

- [ ] **Step 9: Write the failing process-level tests**

Create `test/index.test.js`. It starts the real `server/index.js` as a child process with a temporary configuration:

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const posix = process.platform !== "win32";
const entry = new URL("../server/index.js", import.meta.url).pathname;

async function setup(
  t,
  { config = {}, credentials, credentialsMode = 0o600 } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "gr-i-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "run", "g.sock");
  const credentialsFile = join(dir, "credentials.json");
  const configPath = join(dir, "gateway.json");
  const full = {
    socketPath,
    publicOrigin: "https://gateway.example.ts.net:8450",
    allowedLogins: ["owner@example.com"],
    credentialsFile,
    targets: [
      {
        id: "mac",
        name: "Mac",
        platform: "mac",
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      },
    ],
    ...config,
  };
  await writeFile(configPath, JSON.stringify(full));
  if (credentials !== undefined) {
    await writeFile(credentialsFile, JSON.stringify(credentials));
    await chmod(credentialsFile, credentialsMode);
  }
  return { dir, socketPath, configPath };
}

function launch(configPath) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, GOME_REMOTE_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  return {
    child,
    output: () => ({ out, err }),
    exited: once(child, "exit").then(([code, signal]) => ({ code, signal })),
    async listening() {
      for (let i = 0; i < 100 && !out.includes("listening"); i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(out, /listening/, err);
    },
  };
}
const health = (socketPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/healthz" }, async (res) => {
        let text = "";
        for await (const chunk of res) text += chunk;
        resolve(text);
      })
      .on("error", reject);
  });

test(
  "startup is refused with a clear reason for a loosened credentials file",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t, {
      credentials: { version: 1, targets: { mac: { password: "pw-secret" } } },
      credentialsMode: 0o644,
    });
    const run = launch(configPath);
    const { code } = await run.exited;
    const { err, out } = run.output();
    assert.equal(code, 1);
    assert.match(err, /refused to start/);
    assert.match(err, /mode 600/);
    assert.ok(!err.includes("pw-secret") && !out.includes("pw-secret"));
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "startup is refused without allowedLogins or with a legacy token",
  { skip: !posix },
  async (t) => {
    for (const [change, expected] of [
      [{ allowedLogins: [] }, /allowedLogins/],
      [{ token: "x".repeat(43) }, /token/],
    ]) {
      const { configPath } = await setup(t, { config: change });
      const run = launch(configPath);
      assert.equal((await run.exited).code, 1);
      assert.match(run.output().err, expected);
    }
  },
);

test(
  "a running gateway answers on its 0600 socket and removes it on SIGTERM",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t);
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(socketPath, ".."))).mode & 0o777, 0o700);
    assert.equal(await health(socketPath), '{"ok":true}');
    run.child.kill("SIGTERM");
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  },
);

test(
  "after SIGKILL the next start replaces the stale socket and serves again",
  { skip: !posix },
  async (t) => {
    const { configPath, socketPath } = await setup(t);
    const first = launch(configPath);
    await first.listening();
    first.child.kill("SIGKILL");
    await first.exited;
    assert.ok((await lstat(socketPath)).isSocket(), "stale socket remains");
    const second = launch(configPath);
    t.after(() => second.child.kill("SIGKILL"));
    await second.listening();
    assert.equal(await health(socketPath), '{"ok":true}');
  },
);

test(
  "a development configuration also relays its loopback port",
  { skip: !posix },
  async (t) => {
    const port = 38000 + Math.floor(Math.random() * 1000);
    const { configPath } = await setup(t, {
      config: {
        publicOrigin: `http://127.0.0.1:${port}`,
        devLogin: "owner@example.com",
      },
    });
    const run = launch(configPath);
    t.after(() => run.child.kill("SIGKILL"));
    await run.listening();
    const targets = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/api/targets`, async (res) => {
          let text = "";
          for await (const chunk of res) text += chunk;
          resolve({ status: res.statusCode, text });
        })
        .on("error", reject);
    });
    assert.equal(targets.status, 200);
    assert.match(run.output().err, /Development login/);
  },
);
```

- [ ] **Step 10: Run it to verify it fails**

Run: `node --test test/index.test.js`
Expected: FAIL. The transitional `index.js` from Task 2 has no credential check, prints a stack trace instead of `refused to start`, and never relays the development port.

- [ ] **Step 11: Rewrite `server/index.js`**

```js
import { loadConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { createGateway } from "./gateway.js";
import { forwardLoopback, listenOnSocket, removeSocket } from "./listen.js";

async function start() {
  const config = await loadConfig(
    process.env.GOME_REMOTE_CONFIG || "config.local.json",
  );
  const credentials = new CredentialStore(config.credentialsFile);
  // Refuse to start on a credentials file with the wrong mode, owner or shape.
  const known = await credentials.load();
  const unknown = [...known.keys()].filter(
    (id) => !config.targets.some((t) => t.id === id),
  );
  if (unknown.length)
    console.warn(`Credentials exist for unconfigured targets: ${unknown}`);
  const gateway = createGateway(config, { credentials });
  await listenOnSocket(gateway.server, config.socketPath);
  let relay;
  if (config.devLogin) {
    relay = await forwardLoopback(
      config.socketPath,
      Number(new URL(config.publicOrigin).port),
    );
    console.warn(
      `Development login "${config.devLogin}" is active on ${config.publicOrigin}.`,
    );
  }
  console.log(`Gome Remote is listening on ${config.socketPath}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    relay?.close();
    await gateway.close();
    await removeSocket(config.socketPath);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  await start();
} catch (error) {
  console.error(`Gome Remote refused to start: ${error.message}`);
  process.exit(1);
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `node --test test/index.test.js`
Expected: PASS, `tests 5`, `pass 5`.

- [ ] **Step 13: Mutation check (keeps the tests honest)**

Temporarily weaken each rule and confirm the named test fails, then restore it: (a) in `server/gateway.js` change `if (req.headers.origin !== config.publicOrigin) return reject();` to accept a missing Origin; (b) replace `pending.login !== login` with `false`; (c) replace the `Object.hasOwn(input, "username") || Object.hasOwn(input, "password")` condition with `false`. Each must make `node --test test/gateway.test.js` report at least one failure. Undo each edit before the next (copy the file aside first, e.g. `cp server/gateway.js /tmp/gateway.js.bak`, and copy it back).

- [ ] **Step 14: Run the whole suite, format, commit**

```bash
npm test
npx prettier --check server test
git add server/listen.js server/gateway.js server/index.js test/listen.test.js test/gateway.test.js test/index.test.js
git commit -m "Authorize by Tailscale login, inject stored credentials and listen on a unix socket"
```
Expected: `tests 62`, `pass 62`, `fail 0`.

---

### Task 5: Operations files and gateway README sections (spec D7)

**Files:**
- Create: `test/ops.test.js`
- Modify: `scripts/init-gateway.mjs` (rewrite), `deploy/gome-remote-gateway.service`, `deploy/targets.example.json`, `README.md` (interim rewrite, finished in Task 8)

**Interfaces:**
- Consumes (Task 2): `validateConfig`, `loadConfig`.
- Produces (`scripts/init-gateway.mjs`):
  - `defaultPaths(home?: string): { socketPath: string, credentialsFile: string }` - POSIX paths `<home>/.local/state/gome-remote/gateway.sock` and `<home>/.config/gome-remote/credentials.json`.
  - `buildConfig({ origin: string, logins: string[], targets: Target[], socketPath?: string, credentialsFile?: string }): GatewayConfig` (validated; no token).
  - `main(argv?: string[]): Promise<number>`; CLI `node scripts/init-gateway.mjs <config-path> --origin <https://host.tailnet.ts.net:8450> --login <login> [--login ...] --targets <targets.json> [--socket <path>] [--credentials <path>]`; writes mode 600, refuses to overwrite (exit 1), exit 2 on usage errors.
- Produces: `deploy/targets.example.json` with `ubuntu-server` and `mac` (`100.64.0.20` placeholder); `deploy/gome-remote-gateway.service` keeping `PrivateTmp=true` with a comment on why the socket lives under `%h/.local/state`.

- [ ] **Step 1: Write the failing test**

Create `test/ops.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, defaultPaths } from "../scripts/init-gateway.mjs";
import { loadConfig, validateConfig } from "../server/config.js";

const posix = process.platform !== "win32";
const root = new URL("../", import.meta.url);
const examples = JSON.parse(
  await readFile(new URL("deploy/targets.example.json", root), "utf8"),
);
const script = new URL("scripts/init-gateway.mjs", root).pathname;

test("the example targets are the two spec targets and carry no secret or real address", () => {
  assert.deepEqual(
    examples.map((t) => t.id),
    ["ubuntu-server", "mac"],
  );
  assert.equal(examples[0].profile, "gnome-remote-login");
  assert.equal(examples[1].protocol, "vnc");
  assert.equal(examples[1].hostname, "100.64.0.20");
  assert.doesNotThrow(() =>
    buildConfig({
      origin: "https://gateway.example.ts.net:8450",
      logins: ["owner@example.com"],
      targets: examples,
    }),
  );
});

test("a generated configuration has the new schema and no token", () => {
  const config = buildConfig({
    origin: "https://gateway.example.ts.net:8450",
    logins: ["owner@example.com", "second@example.com"],
    targets: examples,
  });
  assert.equal(config.token, undefined);
  assert.deepEqual(config.allowedLogins, [
    "owner@example.com",
    "second@example.com",
  ]);
  assert.match(
    config.socketPath,
    /\.local\/state\/gome-remote\/gateway\.sock$/,
  );
  assert.match(
    config.credentialsFile,
    /\.config\/gome-remote\/credentials\.json$/,
  );
  assert.throws(() =>
    buildConfig({
      origin: "https://gateway.example.ts.net:8450",
      logins: [],
      targets: examples,
    }),
  );
});

test("the default socket stays out of /tmp, which the unit's PrivateTmp hides, and fits sun_path", async () => {
  const unit = await readFile(
    new URL("deploy/gome-remote-gateway.service", root),
    "utf8",
  );
  assert.match(unit, /^PrivateTmp=true$/m);
  assert.match(
    unit,
    /GOME_REMOTE_CONFIG=%h\/\.config\/gome-remote\/gateway\.json/,
  );
  for (const home of ["/home/user", "/home/user/a-rather-long-nested-home-directory"]) {
    const { socketPath } = defaultPaths(home);
    assert.ok(!/^\/(var\/)?tmp\//.test(socketPath), socketPath);
    assert.doesNotThrow(() =>
      validateConfig({
        socketPath,
        publicOrigin: "https://gateway.example.ts.net:8450",
        allowedLogins: ["owner@example.com"],
        credentialsFile: defaultPaths(home).credentialsFile,
        targets: examples,
      }),
    );
  }
});

test(
  "the command writes a 0600 file once, never overwrites it, and needs every flag",
  { skip: !posix },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gr-init-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const output = join(dir, "conf", "gateway.json");
    const args = [
      script,
      output,
      "--origin",
      "https://gateway.example.ts.net:8450",
      "--login",
      "owner@example.com",
      "--targets",
      new URL("deploy/targets.example.json", root).pathname,
      "--socket",
      join(dir, "run", "g.sock"),
      "--credentials",
      join(dir, "conf", "credentials.json"),
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const config = await loadConfig(output);
    assert.equal(config.socketPath, join(dir, "run", "g.sock"));
    assert.deepEqual(config.allowedLogins, ["owner@example.com"]);
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /refusing to overwrite/);
    const missing = spawnSync(process.execPath, [script, join(dir, "x.json")], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Usage/);
    await writeFile(join(dir, "bad.json"), "[]");
    const bad = spawnSync(
      process.execPath,
      [
        ...args.slice(0, 1),
        join(dir, "y.json"),
        ...args.slice(2, 7),
        join(dir, "bad.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid configuration/);
  },
);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ops.test.js`
Expected: FAIL. Importing the old script runs its top-level code, which prints a usage error and exits 1 (it has no `defaultPaths`/`buildConfig`), and the old example targets use `ubuntu-login`.

- [ ] **Step 3: Rewrite `scripts/init-gateway.mjs`**

```js
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { validateConfig } from "../server/config.js";

const usage = `Usage: node scripts/init-gateway.mjs <private-config-path> \\
  --origin https://host.tailnet.ts.net:8450 \\
  --login owner@example.com [--login second@example.com ...] \\
  --targets deploy/targets.example.json \\
  [--socket <path>] [--credentials <path>]

Creates the gateway configuration. It contains no secrets: desktop passwords go into the
credentials file with scripts/set-credential.mjs, and access is decided by the Tailscale
login names given with --login.`;

export function defaultPaths(home = homedir()) {
  return {
    // Not under /tmp: the unit sets PrivateTmp=true, which would hide the socket from Serve.
    socketPath: posix.join(
      home,
      ".local",
      "state",
      "gome-remote",
      "gateway.sock",
    ),
    credentialsFile: posix.join(
      home,
      ".config",
      "gome-remote",
      "credentials.json",
    ),
  };
}

export function buildConfig({
  origin,
  logins,
  targets,
  socketPath = defaultPaths().socketPath,
  credentialsFile = defaultPaths().credentialsFile,
}) {
  return validateConfig({
    socketPath,
    publicOrigin: origin,
    allowedLogins: logins,
    credentialsFile,
    targets,
  });
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        origin: { type: "string" },
        login: { type: "string", multiple: true },
        targets: { type: "string" },
        socket: { type: "string" },
        credentials: { type: "string" },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (
    positionals.length !== 1 ||
    !values.origin ||
    !values.login?.length ||
    !values.targets
  ) {
    console.error(usage);
    return 2;
  }
  let config;
  try {
    config = buildConfig({
      origin: values.origin,
      logins: values.login,
      targets: JSON.parse(await readFile(values.targets, "utf8")),
      ...(values.socket ? { socketPath: resolve(values.socket) } : {}),
      ...(values.credentials
        ? { credentialsFile: resolve(values.credentials) }
        : {}),
    });
  } catch (error) {
    console.error(`Invalid configuration: ${error.message}`);
    return 1;
  }
  const file = resolve(positionals[0]);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.error(`${file} already exists; refusing to overwrite it.`);
    return 1;
  }
  console.log(
    `Created ${file}. Next: node scripts/set-credential.mjs ${file} <target-id> for each target.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
```

- [ ] **Step 4: Replace the example targets**

`deploy/targets.example.json`:

```json
[
  {
    "id": "ubuntu-server",
    "name": "Ubuntu 서버",
    "platform": "linux",
    "protocol": "rdp",
    "profile": "gnome-remote-login",
    "hostname": "127.0.0.1",
    "port": 3389,
    "security": "nla",
    "ignoreCertificate": true,
    "persistent": true
  },
  {
    "id": "mac",
    "name": "Mac",
    "platform": "mac",
    "protocol": "vnc",
    "hostname": "100.64.0.20",
    "port": 5900,
    "persistent": false
  }
]
```

- [ ] **Step 5: Update the systemd unit**

`deploy/gome-remote-gateway.service` (only the `PrivateTmp` comment is new; keep every other directive):

```ini
[Unit]
Description=Gome Remote gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/remote
Environment=GOME_REMOTE_CONFIG=%h/.config/gome-remote/gateway.json
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
# The gateway listens on a unix socket under %h/.local/state/gome-remote/ (the
# socketPath in its configuration). Keep it out of /tmp: PrivateTmp gives this
# service its own /tmp, so a socket there would be invisible to Tailscale Serve.
PrivateTmp=true

[Install]
WantedBy=default.target
```

- [ ] **Step 6: Run the ops tests**

Run: `node --test test/ops.test.js`
Expected: PASS, `tests 4`, `pass 4`.

- [ ] **Step 7: Interim README (installation and operations)**

Replace the whole `README.md` with the following. Task 8 adds the product description, desktop app and development sections around it; the install and operations text here is final.

````markdown
# Gome Remote

One list of your own machines on your own tailnet, shown by a desktop app or a
browser. This README is being rewritten for the redesign; the sections below are final.

## Install the gateway (Ubuntu server)

Requirements: Node.js 24+, Docker, Tailscale, GNOME Remote Desktop with system
Remote Login enabled for the Ubuntu target.

```sh
git clone https://github.com/WONJUNE-LEE/gome-remote.git ~/remote
cd ~/remote
npm ci
npm run build
sudo docker compose -f deploy/compose.yaml up -d
```

The compose file binds `guacd` to **127.0.0.1:4822**, pins the official image, drops all
capabilities and keeps the root filesystem read-only. Never publish guacd: it has no
authentication of its own.

Copy [`deploy/targets.example.json`](deploy/targets.example.json) somewhere private, set
the Mac's Tailscale IP, then create the configuration. Target addresses must be literal
Tailscale IPs or `127.0.0.1`.

```sh
node scripts/init-gateway.mjs ~/.config/gome-remote/gateway.json \
  --origin https://YOUR-SERVER.YOUR-TAILNET.ts.net:8450 \
  --login you@example.com \
  --targets ~/targets.json
```

Repeat `--login` for each Tailscale login that may use the gateway. The file holds no
secrets. It points at `~/.local/state/gome-remote/gateway.sock` (the socket) and
`~/.config/gome-remote/credentials.json` (the credentials file).

Store each machine's credentials. The command prompts without echo and writes the
file atomically with mode 600; nothing is passed in arguments or environment variables.
It must run in a real terminal.

```sh
node scripts/set-credential.mjs ~/.config/gome-remote/gateway.json ubuntu-server  # system Remote Login user name + password
node scripts/set-credential.mjs ~/.config/gome-remote/gateway.json mac            # Screen Sharing VNC password
```

A target without stored credentials shows as 설정 필요. The gateway re-reads the file on
every request, so no restart is needed after `set-credential`. Apple's VNC uses only the
first 8 characters of its password. The gateway refuses to start if the file is not mode
600, is not owned by the gateway user, or is malformed.

Run it as a user service and publish it with Tailscale Serve on a port of its own:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/gome-remote-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gome-remote-gateway.service
sudo tailscale serve --bg --https=8450 unix:$HOME/.local/state/gome-remote/gateway.sock
```

Do not use Funnel. Check `tailscale serve status` first and use a free port so existing
routes stay untouched. The socket lives under `~/.local/state`, not `/tmp`, because the
unit sets `PrivateTmp=true`. Enable lingering (`loginctl enable-linger $USER`) if the
service must run without a login session.

To run a candidate beside an older gateway, install the unit under another name with its
own configuration, socket and Serve port, and remove it when done.

`ignoreCertificate: true` in the Ubuntu target accepts GNOME Remote Desktop's
self-signed certificate on loopback. It is a per-target choice, never global.

## Operations

- **Restart** the gateway after changing `gateway.json` (targets, logins):
  `systemctl --user restart gome-remote-gateway.service`. Connections drop; the Ubuntu
  session and its windows do not.
- **Change a password:** run `set-credential` again for that target. No restart.
- **Stop access:** stop the service and remove only its Serve listener,
  `sudo tailscale serve --https=8450 off`. Never reset all Serve routes.
- **Startup refused?** The log says why (`journalctl --user -u gome-remote-gateway`):
  an empty `allowedLogins`, a legacy `token` field, a credentials file whose mode is not
  600, or a socket directory open to group or others.
- **Stale socket:** a SIGKILL or crash can leave the socket file behind. The next start
  removes it only if it is a socket with nobody listening, and refuses to touch anything
  else.

## Upstream

Apache Guacamole 1.6.0 provides the RDP/VNC engine and browser client. Its JavaScript is
vendored from the official archive with checksum and licence notices in
[`vendor/`](vendor/README.md). The Node gateway contains only the authenticated
WebSocket tunnel and the guacd handshake adapter.

- [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [GNOME Remote Desktop configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md)
- [Apple VNC access](https://support.apple.com/en-au/guide/remote-desktop/apde0dd523e/mac)
- [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)
````

- [ ] **Step 8: Check the unit file and the Serve command syntax**

Run: `systemd-analyze --user verify deploy/gome-remote-gateway.service` (if available). Expected: no message that mentions `gome-remote-gateway.service` (warnings about unrelated system units may print; a note that `/usr/bin/node` or the working directory is missing on a machine that lacks them is acceptable). The `tailscale serve ... unix:` command in the README is for the operator's server; it cannot be run in CI. Record "not run" if the operator machine is not at hand.

- [ ] **Step 9: Run the whole suite, format, commit**

```bash
npm test
npx prettier --check scripts deploy/targets.example.json test/ops.test.js README.md
git add scripts/init-gateway.mjs deploy test/ops.test.js README.md
git commit -m "Generate the token-free gateway configuration and document socket-based installation"
```
Expected: `tests 66`, `pass 66`, `fail 0`.

---

### Task 6: Thin desktop shell (spec D4)

**Files:**
- Create: `desktop/address.cjs`, `desktop/setup.html`, `test/address.test.js`
- Modify: `desktop/main.cjs` (rewrite), `desktop/preload.cjs` (rewrite), `test/desktop.test.js` (rewrite), `test/preload.test.js` (rewrite)
- Delete: `desktop/vault.cjs`, `test/vault.test.js`
- `package.json` `build.files` already includes `desktop/**/*`, so `setup.html` and `address.cjs` are packaged.

**Interfaces:**
- Consumes: nothing from the server tasks. The gateway origin it opens is whatever the user saved.
- Produces (`desktop/address.cjs`):
  - `gatewayOrigin(raw: unknown): string` - trims, adds `https://` if no scheme, returns `url.origin`; throws a Korean `Error` unless the result is `https://<label>.ts.net` or `http://127.0.0.1:<port>`; refuses credentials, path other than `/`, query, fragment.
  - `class AddressStore { constructor(file: string); load(): Promise<string> /* "" if missing or invalid */; save(origin: string): Promise<string> /* validated origin, atomic */ }` stored as `{"gateway":"<origin>"}` in `<userData>/gateway.json`.
- Produces (preload, `window.desktop`, frozen): `{ bridgeVersion: 1, fullscreen(enabled: boolean): Promise<void>, fullscreenState(): Promise<boolean>, viewerState(state: { open: boolean, connected: boolean, protocol: "rdp"|"vnc"|null, resolution: "1440x900"|"1920x1080"|"2560x1440" }): Promise<void>, openSetup(): Promise<void>, onViewerAction(cb: (action: string) => void): () => void, onFullscreenChange(cb: (enabled: boolean) => void): () => void }`. On `file:` pages only, also `window.desktopSetup` = `{ current(): Promise<string>, save(address: string): Promise<{ gateway: string }>, retry(): Promise<void> }`.
- IPC channels (main process; every handler requires `event.sender === window.webContents` and `event.senderFrame === window.webContents.mainFrame`):

| Channel | Accepted from | Effect |
|---|---|---|
| `remote:fullscreen` (boolean), `remote:fullscreen-state`, `remote:viewer-state` (state), `remote:open-setup` | top frame whose URL origin equals the configured gateway origin | fullscreen request/query, native menu state, show the address page |
| `setup:current`, `setup:save` (address), `setup:retry` | top frame whose URL (without query) is `desktop/setup.html` | read/validate+persist+load address, reload the gateway |
| `remote:viewer-action` (string), `remote:fullscreen-state` (boolean) | main -> page notifications | menu commands, fullscreen changes |

- Produces (behaviour of `desktop/main.cjs`): on startup deletes `vault.enc` and `vault.enc.tmp` in `userData`; loads the saved address or the address page; `BrowserWindow.webPreferences = { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }`; blocks `will-navigate`/`will-redirect` away from the gateway origin; `window.open` of http(s) goes to `shell.openExternal`, everything else dropped; permission requests/checks denied; native menu "원격" gains "서버 주소 바꾸기" (`id: "change-server"`); main-frame load failure (not `ERR_ABORTED = -3`) or `did-navigate` status >= 400 on the gateway origin loads the address page with `?reason=unreachable`. The `--smoke-test` flag always loads the address page and prints `{"title","bridgeVersion","setup"}`.

- [ ] **Step 1: Write the failing address test**

Create `test/address.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { AddressStore, gatewayOrigin } = createRequire(import.meta.url)(
  "../desktop/address.cjs",
);

test("the address must be a Tailscale HTTPS origin or loopback http with a port", () => {
  assert.equal(
    gatewayOrigin("https://server.tail123.ts.net:8450/"),
    "https://server.tail123.ts.net:8450",
  );
  assert.equal(
    gatewayOrigin("  server.tail123.ts.net:8450  "),
    "https://server.tail123.ts.net:8450",
    "a missing scheme is filled in",
  );
  assert.equal(
    gatewayOrigin("http://127.0.0.1:38989"),
    "http://127.0.0.1:38989",
  );
  for (const bad of [
    "https://evil.example",
    "http://server.tail123.ts.net",
    "https://server.tail123.ts.net.evil.example",
    "https://.ts.net",
    "http://127.0.0.1",
    "http://localhost:38989",
    "https://user:pass@server.tail123.ts.net",
    "https://server.tail123.ts.net/path",
    "https://server.tail123.ts.net/?q=1",
    "https://server.tail123.ts.net/#frag",
    "ftp://server.tail123.ts.net",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "",
    "   ",
    undefined,
  ])
    assert.throws(() => gatewayOrigin(bad), Error, String(bad));
});

test("the saved address round-trips, rewrites atomically and ignores invalid files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gr-addr-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "gateway.json");
  const store = new AddressStore(file);
  assert.equal(await store.load(), "", "nothing saved yet");
  assert.equal(
    await store.save("server.tail123.ts.net:8450"),
    "https://server.tail123.ts.net:8450",
  );
  assert.equal(await store.load(), "https://server.tail123.ts.net:8450");
  await store.save("https://other.tail123.ts.net");
  assert.equal(await store.load(), "https://other.tail123.ts.net");
  assert.deepEqual(await readdir(join(dir, "nested")), ["gateway.json"]);
  await assert.rejects(store.save("https://evil.example"));
  assert.equal(await store.load(), "https://other.tail123.ts.net");
  for (const content of [
    "not json",
    '{"gateway":"https://evil.example"}',
    "{}",
  ]) {
    await writeFile(file, content);
    assert.equal(await store.load(), "", content);
  }
  await store.save("server.tail123.ts.net:8450");
  assert.match(
    await readFile(file, "utf8"),
    /"gateway":"https:\/\/server\.tail123\.ts\.net:8450"/,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/address.test.js`
Expected: FAIL with `Cannot find module '../desktop/address.cjs'`.

- [ ] **Step 3: Implement `desktop/address.cjs`**

```js
const fs = require("node:fs/promises");
const path = require("node:path");

// The app's only setting is the gateway origin. It is not a secret, so it lives in a
// plain JSON file and is validated again whenever it is read.
function gatewayOrigin(raw) {
  if (typeof raw !== "string") throw new Error("서버 주소를 입력해주세요.");
  const text = raw.trim();
  // Accept "host.tailnet.ts.net:8450" typed without a scheme.
  const url = new URL(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
  );
  const tailnet =
    url.protocol === "https:" &&
    url.hostname.endsWith(".ts.net") &&
    url.hostname.length > ".ts.net".length;
  const loopback =
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (!tailnet && !loopback)
    throw new Error("Tailscale HTTPS 주소(…ts.net)를 입력해주세요.");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("서버 주소만 입력해주세요.");
  return url.origin;
}

class AddressStore {
  constructor(file) {
    this.file = file;
  }
  // Returns the saved origin, or "" when nothing valid is saved.
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      return gatewayOrigin(saved.gateway);
    } catch {
      return "";
    }
  }
  async save(origin) {
    const checked = gatewayOrigin(origin);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ gateway: checked })}\n`);
    await fs.rename(temp, this.file);
    return checked;
  }
}

module.exports = { AddressStore, gatewayOrigin };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/address.test.js`
Expected: PASS, `tests 2`, `pass 2`.

- [ ] **Step 5: Rewrite the preload test, run it red, rewrite the preload**

Replace `test/preload.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

const source = await readFile(
  new URL("../desktop/preload.cjs", import.meta.url),
  "utf8",
);

function load(protocol = "https:") {
  const ipc = new EventEmitter();
  const calls = [];
  const exposed = {};
  ipc.invoke = async (...args) => {
    calls.push(args);
  };
  vm.runInNewContext(source, {
    location: { protocol },
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          assert.ok(!(name in exposed), `${name} exposed twice`);
          exposed[name] = api;
        },
      },
    }),
  });
  return { ipc, calls, exposed };
}

test("the bridge announces version 1 and exposes only the viewer, fullscreen and address-page functions", () => {
  const { exposed } = load();
  assert.deepEqual([...Object.keys(exposed)], ["desktop"]);
  assert.equal(exposed.desktop.bridgeVersion, 1);
  assert.deepEqual([...Object.keys(exposed.desktop)].sort(), [
    "bridgeVersion",
    "fullscreen",
    "fullscreenState",
    "onFullscreenChange",
    "onViewerAction",
    "openSetup",
    "viewerState",
  ]);
  for (const removed of [
    "settings",
    "configure",
    "targets",
    "connect",
    "forget",
  ])
    assert.equal(exposed.desktop[removed], undefined, removed);
  assert.ok(Object.isFrozen(exposed.desktop));
});

test("preload forwards native menu actions without exposing Electron events", async () => {
  const { ipc, calls, exposed } = load();
  const desktop = exposed.desktop;
  const received = [];
  const remove = desktop.onViewerAction((...args) => received.push(args));
  const privilegedEvent = { sender: "must-not-cross-bridge" };
  ipc.emit("remote:viewer-action", privilegedEvent, "text-input");
  assert.deepEqual(received, [["text-input"]]);
  const state = {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "1920x1080",
  };
  await desktop.viewerState(state);
  await desktop.fullscreen(true);
  await desktop.fullscreenState();
  await desktop.openSetup();
  assert.deepEqual(calls, [
    ["remote:viewer-state", state],
    ["remote:fullscreen", true],
    ["remote:fullscreen-state"],
    ["remote:open-setup"],
  ]);
  const fullscreen = [];
  const removeFullscreen = desktop.onFullscreenChange((...args) =>
    fullscreen.push(args),
  );
  ipc.emit("remote:fullscreen-state", privilegedEvent, true);
  assert.deepEqual(fullscreen, [[true]]);
  removeFullscreen();
  remove();
  ipc.emit("remote:viewer-action", privilegedEvent, "disconnect");
  ipc.emit("remote:fullscreen-state", privilegedEvent, false);
  assert.equal(received.length, 1);
  assert.equal(fullscreen.length, 1);
});

test("address-page functions exist only on the local file page", async () => {
  assert.equal(load("https:").exposed.desktopSetup, undefined);
  assert.equal(load("http:").exposed.desktopSetup, undefined);
  const { exposed, calls } = load("file:");
  assert.deepEqual([...Object.keys(exposed.desktopSetup)].sort(), [
    "current",
    "retry",
    "save",
  ]);
  await exposed.desktopSetup.current();
  await exposed.desktopSetup.save("server.example.ts.net");
  await exposed.desktopSetup.retry();
  assert.deepEqual(calls, [
    ["setup:current"],
    ["setup:save", "server.example.ts.net"],
    ["setup:retry"],
  ]);
});
```

Run: `node --test test/preload.test.js`
Expected: FAIL (`bridgeVersion` is undefined; `settings`, `configure`, ... still exist).

Replace `desktop/preload.cjs`:

```js
const { contextBridge, ipcRenderer } = require("electron");

// Contract for pages served by the gateway. It only ever grows: existing functions keep
// their meaning, and a page that needs a newer bridge falls back to browser mode.
// The main process answers these calls only while the window shows the configured
// gateway origin, so exposing them here grants nothing to any other page.
const bridge = {
  bridgeVersion: 1,
  fullscreen: (enabled) => ipcRenderer.invoke("remote:fullscreen", enabled),
  fullscreenState: () => ipcRenderer.invoke("remote:fullscreen-state"),
  viewerState: (state) => ipcRenderer.invoke("remote:viewer-state", state),
  openSetup: () => ipcRenderer.invoke("remote:open-setup"),
  onViewerAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("remote:viewer-action", listener);
    return () => ipcRenderer.removeListener("remote:viewer-action", listener);
  },
  onFullscreenChange: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on("remote:fullscreen-state", listener);
    return () =>
      ipcRenderer.removeListener("remote:fullscreen-state", listener);
  },
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));

// The local address page is the only file: page the app ever shows. The main process
// also checks the sender, so a gateway page gains nothing even if this object leaked.
if (location.protocol === "file:")
  contextBridge.exposeInMainWorld(
    "desktopSetup",
    Object.freeze({
      current: () => ipcRenderer.invoke("setup:current"),
      save: (address) => ipcRenderer.invoke("setup:save", address),
      retry: () => ipcRenderer.invoke("setup:retry"),
    }),
  );
```

Run: `node --test test/preload.test.js`
Expected: PASS, `tests 3`, `pass 3`.

- [ ] **Step 6: Rewrite the main-process test (the fullscreen and menu tests are carried over unchanged)**

Replace `test/desktop.test.js`. The harness runs `desktop/main.cjs` against a stand-in Electron whose `loadURL` updates the main frame URL like a real navigation. The first nine tests are new; the last five (`F11 is intercepted…` onward) are the existing tests, only receiving `t` for temp-directory cleanup.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL("../desktop/main.cjs", import.meta.url),
  "utf8",
);
const desktopDir = fileURLToPath(new URL("../desktop/", import.meta.url));
const GATEWAY = "https://gateway.tail123.ts.net:8450";
const SETUP = pathToFileURL(join(desktopDir, "setup.html")).href;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

// Runs desktop/main.cjs against a stand-in for Electron. `loadURL` updates the main
// frame's URL the way a real navigation would, so IPC origin checks see what they would
// see in the app.
async function desktop(
  { stored = GATEWAY, files = {}, platform = "win32" } = {},
  t,
) {
  const userData = await mkdtemp(join(tmpdir(), "gr-desk-"));
  t?.after(() => rm(userData, { recursive: true, force: true }));
  if (stored)
    await writeFile(
      join(userData, "gateway.json"),
      JSON.stringify({ gateway: stored }),
    );
  for (const [name, content] of Object.entries(files))
    await writeFile(join(userData, name), content);
  const ready = deferred();
  const handlers = new Map();
  const loads = [];
  const external = [];
  const fullscreenRequests = [];
  const notifications = [];
  let fullscreen = false;
  let window;
  let menu;
  let openHandler;
  let windowOptions;
  const permissions = {};
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      windowOptions = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "about:blank" },
        send: (...args) => notifications.push(args),
        setWindowOpenHandler(handler) {
          openHandler = handler;
        },
        session: {
          setPermissionRequestHandler(handler) {
            permissions.request = handler;
          },
          setPermissionCheckHandler(handler) {
            permissions.check = handler;
          },
        },
      });
    }
    isFullScreen() {
      return fullscreen;
    }
    setFullScreen(value) {
      fullscreenRequests.push(value);
    }
    async loadURL(url) {
      loads.push(url);
      this.webContents.mainFrame.url = url;
      ready.resolve();
    }
  }
  const electron = {
    app: {
      whenReady: async () => {},
      getPath: () => userData,
      on() {},
      quit() {},
      exit() {},
    },
    BrowserWindow,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: async (url) => external.push(url) },
    dialog: {
      showErrorBox: (_title, message) =>
        ready.resolve(Promise.reject(new Error(message))),
    },
    Menu: {
      buildFromTemplate: (template) => {
        const items = new Map();
        function collect(entries) {
          for (const item of entries) {
            if (item.id) items.set(item.id, item);
            if (item.submenu) collect(item.submenu);
          }
        }
        collect(template);
        return { items, template, getMenuItemById: (id) => items.get(id) };
      },
      setApplicationMenu(value) {
        menu = value;
      },
      getApplicationMenu() {
        return menu;
      },
    },
  };
  vm.runInNewContext(source, {
    require: (name) =>
      name === "electron"
        ? electron
        : name.startsWith("./")
          ? require(join(desktopDir, name))
          : require(name),
    __dirname: desktopDir,
    URL,
    console,
    Promise,
    process: { argv: [], platform },
  });
  await ready.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const frame = () => window.webContents.mainFrame;
  const call = (channel, input, event) =>
    handlers.get(channel)(
      event || { sender: window.webContents, senderFrame: frame() },
      input,
    );
  return {
    userData,
    loads,
    external,
    handlers,
    permissions,
    get window() {
      return window;
    },
    get windowOptions() {
      return windowOptions;
    },
    get openHandler() {
      return openHandler;
    },
    call,
    invoke: (name, input, event) => call(`remote:${name}`, input, event),
    // Pretend the window now shows `url` (without a main-process load).
    show(url) {
      frame().url = url;
    },
    menu,
    fullscreenRequests,
    notifications,
    finishFullscreen(value) {
      fullscreen = value;
      window.emit(value ? "enter-full-screen" : "leave-full-screen");
    },
    input(input) {
      let prevented = false;
      window.webContents.emit(
        "before-input-event",
        {
          preventDefault() {
            prevented = true;
          },
        },
        input,
      );
      return prevented;
    },
    navigate(url, event = "will-navigate") {
      let prevented = false;
      window.webContents.emit(
        event,
        {
          preventDefault() {
            prevented = true;
          },
        },
        url,
      );
      return prevented;
    },
  };
}

test("first run shows only the address page; a saved address opens the gateway", async (t) => {
  const first = await desktop({ stored: "" }, t);
  assert.deepEqual(first.loads, [SETUP]);
  const later = await desktop({}, t);
  assert.deepEqual(later.loads, [`${GATEWAY}`]);
  const damaged = await desktop(
    { stored: "", files: { "gateway.json": "{" } },
    t,
  );
  assert.deepEqual(damaged.loads, [SETUP]);
});

test("a vault left by an older version is deleted at startup and nothing else is touched", async (t) => {
  const f = await desktop(
    {
      files: {
        "vault.enc": "old encrypted token and passwords",
        "vault.enc.tmp": "partial write",
        Preferences: "{}",
      },
    },
    t,
  );
  assert.equal(await exists(join(f.userData, "vault.enc")), false);
  assert.equal(await exists(join(f.userData, "vault.enc.tmp")), false);
  assert.equal(await exists(join(f.userData, "Preferences")), true);
  assert.equal(await exists(join(f.userData, "gateway.json")), true);
});

test("the window is sandboxed, isolated and has no Node integration", async (t) => {
  const f = await desktop({}, t);
  const prefs = f.windowOptions.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.match(prefs.preload, /preload\.cjs$/);
  assert.equal(await f.permissions.check(), false);
  await new Promise((resolve) =>
    f.permissions.request({}, "media", (granted) => {
      assert.equal(granted, false);
      resolve();
    }),
  );
});

test("bridge calls work only from the gateway origin in the window's top frame", async (t) => {
  const f = await desktop({}, t);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.fullscreenRequests, [true]);
  for (const url of [
    "https://evil.example/",
    "https://gateway.tail123.ts.net:8451/",
    "https://gateway.tail123.ts.net/",
    "http://gateway.tail123.ts.net:8450/",
    "https://gateway.tail123.ts.net.evil.example:8450/",
    "app://gome-remote/",
    SETUP,
    "about:blank",
    "",
  ]) {
    f.show(url);
    for (const [name, input] of [
      ["fullscreen", false],
      ["fullscreen-state"],
      [
        "viewer-state",
        {
          open: false,
          connected: false,
          protocol: null,
          resolution: "1440x900",
        },
      ],
      ["open-setup"],
    ])
      await assert.rejects(
        f.invoke(name, input),
        /Untrusted origin/,
        `${name} from ${url}`,
      );
  }
  assert.deepEqual(
    f.fullscreenRequests,
    [true],
    "refused calls change nothing",
  );
  const loadsBefore = f.loads.length;
  f.show(`${GATEWAY}/`);
  const subframe = { url: `${GATEWAY}/` };
  await assert.rejects(
    f.invoke("fullscreen", false, {
      sender: f.window.webContents,
      senderFrame: subframe,
    }),
    /Untrusted sender/,
  );
  await assert.rejects(
    f.invoke("fullscreen", false, {
      sender: {},
      senderFrame: f.window.webContents.mainFrame,
    }),
    /Untrusted sender/,
  );
  assert.equal(f.loads.length, loadsBefore);
  await f.invoke("open-setup");
  assert.deepEqual(f.loads.at(-1), SETUP);
});

test("without a configured address no bridge call is accepted from any page", async (t) => {
  const f = await desktop({ stored: "" }, t);
  f.show("https://gateway.tail123.ts.net:8450/");
  await assert.rejects(f.invoke("fullscreen", true), /Untrusted origin/);
  f.show("");
  await assert.rejects(f.invoke("fullscreen", true), /Untrusted origin/);
});

test("the address page may save a validated address and nothing else may", async (t) => {
  const f = await desktop({ stored: "" }, t);
  assert.equal(await f.call("setup:current"), "");
  await assert.rejects(f.call("setup:retry"), /서버 주소를 먼저/);
  for (const bad of [
    "https://evil.example",
    "http://gateway.tail123.ts.net",
    "javascript:alert(1)",
    "",
    42,
  ])
    await assert.rejects(f.call("setup:save", bad), Error, String(bad));
  assert.deepEqual(f.loads, [SETUP], "an invalid address loads nothing");
  assert.equal(
    (await f.call("setup:save", "gateway.tail123.ts.net:8450")).gateway,
    GATEWAY,
  );
  assert.equal(f.loads.at(-1), GATEWAY);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.userData, "gateway.json"), "utf8")),
    {
      gateway: GATEWAY,
    },
  );
  f.show(SETUP);
  assert.equal(await f.call("setup:current"), GATEWAY);
  // The same channels are closed to the gateway page and to other origins.
  for (const url of [GATEWAY + "/", "https://evil.example/"]) {
    f.show(url);
    for (const channel of ["setup:current", "setup:save", "setup:retry"])
      await assert.rejects(f.call(channel, GATEWAY), /Untrusted origin/);
  }
  f.show(`${SETUP}?reason=unreachable`);
  await f.call("setup:retry");
  assert.equal(f.loads.at(-1), GATEWAY);
});

test("navigation away from the gateway is blocked and links open in the OS browser only for http(s)", async (t) => {
  const f = await desktop({}, t);
  assert.equal(f.navigate("https://evil.example/"), true);
  assert.equal(f.navigate("https://evil.example/", "will-redirect"), true);
  assert.equal(
    f.navigate(SETUP),
    true,
    "pages cannot send the window to the local page",
  );
  assert.equal(f.navigate("file:///etc/passwd"), true);
  assert.equal(f.navigate(`${GATEWAY}/other`), false);
  assert.equal(f.navigate(`${GATEWAY}/other`, "will-redirect"), false);
  assert.equal(
    f.openHandler({ url: "https://example.org/docs" }).action,
    "deny",
  );
  assert.equal(f.openHandler({ url: `${GATEWAY}/x` }).action, "deny");
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "app://x",
    "not a url",
  ])
    assert.equal(f.openHandler({ url }).action, "deny");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.external, ["https://example.org/docs", `${GATEWAY}/x`]);
});

test("a gateway that cannot be reached lands on a page where the address can be changed", async (t) => {
  const f = await desktop({}, t);
  const fail = (code, url = `${GATEWAY}/`, main = true) =>
    f.window.webContents.emit("did-fail-load", {}, code, "ERR", url, main);
  fail(-3); // superseded navigation (ERR_ABORTED)
  fail(-102, `${GATEWAY}/`, false); // a subframe
  fail(-102, "https://evil.example/");
  assert.deepEqual(f.loads, [GATEWAY]);
  fail(-102); // ERR_CONNECTION_REFUSED
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), `${SETUP}?reason=unreachable`);
  // The address page works on that error page, and a bad status from Serve gets there too.
  assert.equal(await f.call("setup:current"), GATEWAY);
  const before = f.loads.length;
  f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 200);
  assert.equal(f.loads.length, before);
  f.window.webContents.emit("did-navigate", {}, `${GATEWAY}/`, 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), `${SETUP}?reason=unreachable`);
  f.window.webContents.emit("did-navigate", {}, "https://evil.example/", 502);
  assert.equal(f.loads.length, before + 1);
});

test("the Remote menu offers 서버 주소 바꾸기 at all times", async (t) => {
  const f = await desktop({}, t);
  const item = f.menu.getMenuItemById("change-server");
  assert.equal(item.label, "서버 주소 바꾸기");
  assert.notEqual(item.enabled, false);
  item.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads.at(-1), SETUP);
});

test("F11 is intercepted before the remote keyboard and both exit controls use native fullscreen state", async (t) => {
  const f = await desktop({}, t);
  assert.equal(await f.invoke("fullscreen-state"), false);
  await f.invoke("fullscreen", true);
  assert.deepEqual(f.fullscreenRequests, [true]);
  assert.equal(
    await f.invoke("fullscreen-state"),
    false,
    "OS transition is asynchronous",
  );
  f.finishFullscreen(true);
  assert.equal(await f.invoke("fullscreen-state"), true);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", true]);
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
    true,
  );
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: true }),
    true,
  );
  assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  assert.equal(
    f.fullscreenRequests.length,
    2,
    "repeat and keyup must not toggle again",
  );
  f.finishFullscreen(false);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
  assert.equal(
    f.input({ key: "Escape", type: "keyDown" }),
    false,
    "remote Escape remains available",
  );
  assert.equal(f.input({ key: "a", type: "keyDown" }), false);
  // F11 must also enter from windowed mode, with exactly one request.
  const beforeEntry = f.fullscreenRequests.length;
  assert.equal(
    f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
    true,
  );
  assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  assert.deepEqual(f.fullscreenRequests.slice(beforeEntry), [true]);
  f.finishFullscreen(true);
  const beforeExit = f.fullscreenRequests.length;
  await f.invoke("fullscreen", false);
  assert.deepEqual(f.fullscreenRequests.slice(beforeExit), [false]);
  f.finishFullscreen(false);
  await f.invoke("fullscreen", false);
  assert.equal(
    f.fullscreenRequests.length,
    beforeExit + 1,
    "exit while windowed never enters fullscreen",
  );
  await assert.rejects(
    f.invoke("fullscreen", "false"),
    /Invalid fullscreen state/,
  );
});

test("windowed intent during a native entry is applied after that entry completes", async (t) => {
  const f = await desktop({}, t);
  await f.invoke("fullscreen", true);
  await f.invoke("fullscreen", false);
  assert.deepEqual(
    f.fullscreenRequests,
    [true],
    "serialize transitions instead of losing the exit",
  );
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
  assert.deepEqual(f.notifications.at(-1), ["remote:fullscreen-state", false]);
  // OS/menu transitions remain authoritative when no app request is pending.
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  assert.equal(await f.invoke("fullscreen-state"), true);
});

test("a second F11 during entry queues exit instead of repeating entry", async (t) => {
  const f = await desktop({}, t);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      f.input({ key: "F11", type: "keyDown", isAutoRepeat: false }),
      true,
    );
    assert.equal(f.input({ key: "F11", type: "keyUp" }), true);
  }
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
});

test("native remote menu enables valid commands and forwards exact actions", async (t) => {
  const f = await desktop({}, t);
  const item = (id) => f.menu.getMenuItemById(id);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution",
  ])
    assert.equal(item(id).enabled, false, `home: ${id}`);
  await f.invoke("viewer-state", {
    open: true,
    connected: false,
    protocol: "rdp",
    resolution: "1440x900",
  });
  assert.equal(item("back").enabled, true);
  assert.equal(item("disconnect").enabled, true);
  assert.equal(item("reconnect").enabled, true);
  assert.equal(item("text-input").enabled, false);
  assert.equal(item("resolution").enabled, false);
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "rdp",
    resolution: "1920x1080",
  });
  assert.equal(item("reconnect").enabled, false);
  assert.equal(item("text-input").enabled, true);
  assert.equal(item("resolution").enabled, true);
  assert.equal(item("resolution:1920x1080").checked, true);
  assert.equal(item("resolution:1440x900").checked, false);
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution:2560x1440",
  ]) {
    const before = f.notifications.length;
    item(id).click();
    assert.deepEqual(f.notifications.slice(before), [
      ["remote:viewer-action", id],
    ]);
  }
  await f.invoke("viewer-state", {
    open: true,
    connected: true,
    protocol: "vnc",
    resolution: "1920x1080",
  });
  assert.equal(item("resolution").enabled, false);
  assert.equal(item("text-input").enabled, true);
  await f.invoke("viewer-state", {
    open: false,
    connected: false,
    protocol: null,
    resolution: "1920x1080",
  });
  for (const id of [
    "back",
    "disconnect",
    "text-input",
    "reconnect",
    "resolution",
  ])
    assert.equal(item(id).enabled, false, `returned home: ${id}`);
  await assert.rejects(
    f.invoke("viewer-state", { open: true }),
    /Invalid viewer state/,
  );
  const view = f.menu.template.find((item) => item.label === "View");
  view.submenu[0].click();
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  view.submenu[0].click();
  assert.deepEqual(f.fullscreenRequests, [true, false]);
});

test("native fullscreen menu preserves a second click during entry", async (t) => {
  const f = await desktop({}, t);
  const fullscreen = f.menu.template.find((item) => item.label === "View")
    .submenu[0];
  fullscreen.click();
  fullscreen.click();
  assert.deepEqual(f.fullscreenRequests, [true]);
  f.finishFullscreen(true);
  assert.deepEqual(f.fullscreenRequests, [true, false]);
  f.finishFullscreen(false);
  assert.equal(await f.invoke("fullscreen-state"), false);
});
```

Run: `node --test test/desktop.test.js`
Expected: FAIL. The old `main.cjs` calls `protocol.registerSchemesAsPrivileged` and builds a vault, neither of which the new harness provides, so every test fails while loading it (and it would still never delete `vault.enc` or answer `setup:*`).

- [ ] **Step 7: Create the local address page**

`desktop/setup.html` (one input; Korean copy; no remote content):

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <!-- Local page with no remote content; its inline script only writes text with textContent. -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gome Remote</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f3ee;
        --ink: #2b2723;
        --muted: #7a7168;
        --field: #ffffff;
        --line: #ddd5ca;
        --accent: #2b2723;
        --accent-ink: #ffffff;
        --error: #b3261e;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #22201e;
          --ink: #f0ebe4;
          --muted: #a39a90;
          --field: #2e2b28;
          --line: #433f3a;
          --accent: #f0ebe4;
          --accent-ink: #22201e;
          --error: #f2b8b5;
        }
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--ink);
        font:
          15px/1.5 Inter,
          "Noto Sans KR",
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
      }
      main {
        width: min(420px, 90vw);
      }
      h1 {
        margin: 0 0 20px;
        font-size: 22px;
        font-weight: 600;
      }
      p {
        margin: 0 0 16px;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--field);
        color: var(--ink);
        font: inherit;
      }
      button {
        margin-top: 12px;
        padding: 11px 18px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: transparent;
        color: var(--ink);
        font: inherit;
        cursor: pointer;
      }
      button.primary {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--accent-ink);
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      input:focus-visible,
      button:focus-visible {
        outline: 2px solid var(--ink);
        outline-offset: 2px;
      }
      #error {
        min-height: 1.5em;
        margin: 10px 0 0;
        color: var(--error);
      }
      [hidden] {
        display: none !important;
      }
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">서버 주소</h1>
      <p id="current" hidden></p>
      <button id="retry" class="primary" type="button" hidden>다시 시도</button>
      <form id="form">
        <label for="address">서버 주소</label>
        <input
          id="address"
          type="text"
          inputmode="url"
          placeholder="your-server.your-tailnet.ts.net:8450"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <p id="error" role="alert"></p>
        <button id="save" class="primary" type="submit">열기</button>
      </form>
    </main>
    <script>
      const $ = (id) => document.getElementById(id);
      const setup = window.desktopSetup;
      const readable = (error) =>
        String((error && error.message) || error).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        );
      const unreachable =
        new URLSearchParams(location.search).get("reason") === "unreachable";
      setup
        .current()
        .then((address) => {
          $("address").value = address;
          if (unreachable && address) {
            $("title").textContent = "서버에 연결할 수 없습니다";
            $("current").textContent = address;
            $("current").hidden = false;
            $("retry").hidden = false;
          }
        })
        .catch((error) => {
          $("error").textContent = readable(error);
        });
      $("retry").onclick = () => {
        setup.retry().catch((error) => {
          $("error").textContent = readable(error);
        });
      };
      $("form").onsubmit = async (event) => {
        event.preventDefault();
        $("error").textContent = "";
        $("save").disabled = true;
        try {
          await setup.save($("address").value);
        } catch (error) {
          $("error").textContent = readable(error);
          $("save").disabled = false;
        }
      };
    </script>
  </body>
</html>
```

- [ ] **Step 8: Rewrite `desktop/main.cjs`**

```js
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { AddressStore, gatewayOrigin } = require("./address.cjs");
const smokeTest = process.argv.includes("--smoke-test");

// The app is a thin window: it shows the gateway's own web page. The only local page is
// setup.html, where the user types the server address.
const setupPage = pathToFileURL(path.join(__dirname, "setup.html")).href;
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
const pageOf = (url) => String(url).split(/[?#]/)[0];
const ERR_ABORTED = -3;

let window;
let store;
let gateway = ""; // configured gateway origin, "" until the user enters one
let fullscreenTarget = false;
let fullscreenTransition = false;
function applyFullscreenTarget() {
  if (fullscreenTransition || window.isFullScreen() === fullscreenTarget)
    return;
  fullscreenTransition = true;
  window.setFullScreen(fullscreenTarget);
}
function requestFullscreen(enabled) {
  fullscreenTarget = enabled;
  applyFullscreenTarget();
}

// Every IPC call must come from the top frame of this window, and from the page the
// channel is meant for: the gateway origin for bridge calls, the local setup page for
// address changes. Anything else (another origin, a subframe) is refused.
function handle(audience, channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted sender.");
    const url = event.senderFrame.url;
    const allowed =
      audience === "gateway"
        ? !!gateway && originOf(url) === gateway
        : pageOf(url) === setupPage;
    if (!allowed) throw new Error("Untrusted origin.");
    return callback(...args);
  });
}

function showSetup(reason) {
  return window
    .loadURL(reason ? `${setupPage}?reason=${reason}` : setupPage)
    .catch(() => {});
}
function openGateway() {
  return window.loadURL(gateway).catch(() => {});
}
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      Promise.resolve(shell.openExternal(parsed.href)).catch(() => {});
  } catch {
    // not a URL; ignore
  }
}

app
  .whenReady()
  .then(async () => {
    const userData = app.getPath("userData");
    // Versions before 0.2 kept the gateway token and desktop passwords here. The new
    // design never reads them, so remove the only remaining copy.
    await Promise.all(
      ["vault.enc", "vault.enc.tmp"].map((name) =>
        fs.rm(path.join(userData, name), { force: true }),
      ),
    );
    store = new AddressStore(path.join(userData, "gateway.json"));
    gateway = await store.load();

    handle("setup", "setup:current", () => gateway);
    handle("setup", "setup:save", async (address) => {
      const saved = await store.save(gatewayOrigin(address));
      gateway = saved;
      void openGateway();
      return { gateway: saved };
    });
    handle("setup", "setup:retry", () => {
      if (!gateway) throw new Error("서버 주소를 먼저 입력해주세요.");
      void openGateway();
    });
    handle("gateway", "remote:open-setup", () => {
      void showSetup();
    });
    handle("gateway", "remote:fullscreen", (enabled) => {
      if (typeof enabled !== "boolean")
        throw new Error("Invalid fullscreen state.");
      requestFullscreen(enabled);
    });
    handle("gateway", "remote:fullscreen-state", () => window.isFullScreen());
    const resolutions = ["1440x900", "1920x1080", "2560x1440"];
    const command = (id, label) => ({
      id,
      label,
      enabled: false,
      click: () => window.webContents.send("remote:viewer-action", id),
    });
    handle("gateway", "remote:viewer-state", (state) => {
      if (
        !state ||
        typeof state.open !== "boolean" ||
        typeof state.connected !== "boolean" ||
        ![null, "rdp", "vnc"].includes(state.protocol) ||
        !resolutions.includes(state.resolution)
      )
        throw new Error("Invalid viewer state.");
      const menu = Menu.getApplicationMenu();
      for (const id of ["back", "disconnect"])
        menu.getMenuItemById(id).enabled = state.open;
      menu.getMenuItemById("reconnect").enabled =
        state.open && !state.connected;
      menu.getMenuItemById("text-input").enabled =
        state.open && state.connected;
      menu.getMenuItemById("resolution").enabled =
        state.open && state.connected && state.protocol === "rdp";
      for (const size of resolutions)
        menu.getMenuItemById(`resolution:${size}`).checked =
          size === state.resolution;
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        {
          label: "View",
          submenu: [
            {
              label: "전체 화면",
              accelerator: "F11",
              click: () =>
                requestFullscreen(
                  fullscreenTransition
                    ? !fullscreenTarget
                    : !window.isFullScreen(),
                ),
            },
            { role: "resetZoom" },
          ],
        },
        {
          label: "원격",
          submenu: [
            command("back", "서버 목록"),
            { type: "separator" },
            {
              id: "resolution",
              label: "해상도",
              enabled: false,
              submenu: resolutions.map((size) => ({
                id: `resolution:${size}`,
                label: size.replace("x", " × "),
                type: "radio",
                checked: size === resolutions[0],
                click: () =>
                  window.webContents.send(
                    "remote:viewer-action",
                    `resolution:${size}`,
                  ),
              })),
            },
            command("text-input", "텍스트 입력"),
            command("reconnect", "다시 연결"),
            command("disconnect", "연결 종료"),
            { type: "separator" },
            {
              id: "change-server",
              label: "서버 주소 바꾸기",
              click: () => void showSetup(),
            },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    window = new BrowserWindow({
      show: !smokeTest,
      width: 1420,
      height: 940,
      minWidth: 900,
      minHeight: 620,
      title: "Gome Remote",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#22201e" : "#f6f3ee",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    const publishFullscreen = () => {
      const requested = fullscreenTransition;
      fullscreenTransition = false;
      if (!requested) fullscreenTarget = window.isFullScreen();
      window.webContents.send("remote:fullscreen-state", window.isFullScreen());
      // Serialize OS transitions so a pending entry cannot swallow an exit request.
      applyFullscreenTarget();
    };
    window.on("enter-full-screen", publishFullscreen);
    window.on("leave-full-screen", publishFullscreen);
    window.webContents.on("before-input-event", (event, input) => {
      if (input.key !== "F11") return;
      // Intercept both edges before Guacamole or a menu accelerator can receive F11.
      event.preventDefault();
      if (input.type === "keyDown" && !input.isAutoRepeat)
        requestFullscreen(
          fullscreenTransition ? !fullscreenTarget : !window.isFullScreen(),
        );
    });
    // The window may only ever show the gateway origin (and the local address page,
    // which the main process loads itself). Links elsewhere go to the OS browser.
    const stay = (event, url) => {
      if (originOf(url) !== gateway) event.preventDefault();
    };
    window.webContents.on("will-navigate", stay);
    window.webContents.on("will-redirect", stay);
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    // A gateway that is down shows as a failed load, or as an error status from
    // Tailscale Serve. Either way the user lands on a page where the address can change.
    window.webContents.on(
      "did-fail-load",
      (_event, code, _description, url, isMainFrame) => {
        if (isMainFrame && code !== ERR_ABORTED && originOf(url) === gateway)
          void showSetup("unreachable");
      },
    );
    window.webContents.on("did-navigate", (_event, url, status) => {
      if (originOf(url) === gateway && status >= 400)
        void showSetup("unreachable");
    });
    window.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    if (smokeTest || !gateway) await showSetup();
    else void openGateway();
    if (smokeTest) {
      const state = await window.webContents.executeJavaScript(
        "({title: document.title, bridgeVersion: window.desktop.bridgeVersion, setup: typeof window.desktopSetup.save})",
      );
      console.log(JSON.stringify(state));
      app.quit();
    }
  })
  .catch((error) => {
    if (smokeTest) {
      console.error("Desktop smoke test failed:", error.message);
      app.exit(1);
      return;
    }
    dialog.showErrorBox("Gome Remote", error.message);
    app.quit();
  });

app.on("window-all-closed", () => app.quit());
```

- [ ] **Step 9: Remove the vault and run the desktop tests**

```bash
git rm desktop/vault.cjs test/vault.test.js
node --test test/desktop.test.js test/preload.test.js test/address.test.js
```
Expected: PASS, `tests 19` (14 + 3 + 2), `fail 0`.

- [ ] **Step 10: Mutation check**

Temporarily change `? !!gateway && originOf(url) === gateway` in `desktop/main.cjs` to `? true` and confirm `node --test test/desktop.test.js` fails (bridge origin test, plus the unconfigured-address test); then change the `stay` guard to never `preventDefault()` and confirm the navigation test fails. Restore both edits.

- [ ] **Step 11: Real Electron smoke test (only where the Electron binary is installed)**

Run: `npx electron . --smoke-test` (on a headless Linux machine: `xvfb-run -a npx electron . --smoke-test`; if `node_modules/electron/dist` is missing run `node node_modules/electron/install.js` first).
Expected: one stdout line `{"title":"Gome Remote","bridgeVersion":1,"setup":"function"}` and exit code 0. If Electron cannot run here, record "not run" in the commit message; do not claim a result.

- [ ] **Step 12: Run the whole suite, format, commit**

```bash
npm test
npx prettier --check desktop test/address.test.js test/desktop.test.js test/preload.test.js
git add desktop test/address.test.js test/desktop.test.js test/preload.test.js
git commit -m "Reduce the desktop app to a thin window with an origin-restricted bridge"
```
Expected: `tests 75`, `pass 75`, `fail 0`.

---

### Task 7: UI rewrite, design B (spec D6, section 6)

**Files:**
- Create: `src/tiles.ts`, `test/helpers/load-ts.js`, `test/tiles.test.js`, `test/viewer-invariants.test.js`
- Modify: `src/api.ts` (rewrite), `src/types.d.ts` (rewrite), `src/main.ts` (rewrite), `src/style.css` (rewrite), `index.html` (rewrite), `test/browser-api.test.js` (port)

**Interfaces:**
- Consumes (Task 4 HTTP contract): `GET /api/targets -> { targets: Target[] }`, `POST /api/sessions { targetId, width, height } -> { ticket }`, error bodies `{ error, code? }`, WebSocket `/tunnel` on the same origin. (Task 6) `window.desktop` bridge v1 including `openSetup()`.
- Produces (`src/api.ts`): `REQUIRED_BRIDGE_VERSION = 1`, `FORBIDDEN_TEXT`, `UNREACHABLE_TEXT`, `class ApiError extends Error { kind: "unreachable"|"forbidden"|"failed"; status: number }`, `appMode: boolean` (`(window.desktop?.bridgeVersion ?? 0) >= 1`), `api = { targets(), connect(input: ConnectInput): Promise<{ ticket: string, websocket: string }>, fullscreen(enabled), fullscreenState(), onFullscreenChange(cb), viewerState(state), onViewerAction(cb), openSetup() }`. Requests are same-origin `fetch` with `credentials: "same-origin"`, no `Authorization` header, JSON only for POST. Classification: 403 with `code: "login"` -> `forbidden`; a non-JSON body or status >= 502 -> `unreachable`; other non-2xx -> `failed`; a network error -> `unreachable`.
- Produces (`src/tiles.ts`): `type TileState = "online"|"offline"|"setup"`, `tileState(target): TileState`, `stateLabel: Record<TileState, string>` (켜짐/꺼짐/설정 필요), `tileEnabled(target): boolean`, `platformClass(platform): "ubuntu"|"mac"|"windows"`, `connectingText(name): string`.
- Produces (`src/types.d.ts`): global `Target = { id, name, platform, protocol, profile?, persistent, online, ready }`, `ConnectInput = { targetId, width, height }`, `ViewerState`, `NativeBridge`, `DesktopBridge`.
- Produces (`test/helpers/load-ts.js`): `loadTs(name: string, globals?: object): Promise<exports>` compiles `src/<name>` with the TypeScript compiler and runs it in a fresh `vm` context with only the supplied globals (not matched by `node --test test/*.test.js`).

- [ ] **Step 1: Test helper and the failing tiles test**

`test/helpers/load-ts.js`:

```js
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Compiles one src/*.ts module and runs it in a fresh context with only the globals the
// test supplies, so a test sees exactly what the browser or app would give the module.
export async function loadTs(name, globals = {}) {
  const source = await readFile(
    new URL(`../../src/${name}`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, { exports, window: {}, ...globals });
  return exports;
}
```

`test/tiles.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

const tiles = await loadTs("tiles.ts");
const target = (change) => ({
  id: "ubuntu-server",
  name: "Ubuntu 서버",
  platform: "linux",
  protocol: "rdp",
  persistent: true,
  online: true,
  ready: true,
  ...change,
});

test("a tile is usable only when the machine answers and its credentials are set", () => {
  const cases = [
    [{}, "online", "켜짐", true],
    [{ online: false }, "offline", "꺼짐", false],
    [{ ready: false }, "setup", "설정 필요", false],
    [{ ready: false, online: false }, "setup", "설정 필요", false],
  ];
  for (const [change, state, label, enabled] of cases) {
    const t = target(change);
    assert.equal(tiles.tileState(t), state, JSON.stringify(change));
    assert.equal(tiles.stateLabel[tiles.tileState(t)], label);
    assert.equal(tiles.tileEnabled(t), enabled);
  }
});

test("platform colours and the connecting text follow the design", () => {
  assert.equal(tiles.platformClass("linux"), "ubuntu");
  assert.equal(tiles.platformClass("mac"), "mac");
  assert.equal(tiles.platformClass("windows"), "windows");
  assert.equal(
    tiles.connectingText("Ubuntu 서버"),
    "Ubuntu 서버에 연결하는 중",
  );
});
```

Run: `node --test test/tiles.test.js`
Expected: FAIL (`ENOENT` reading `src/tiles.ts`).

- [ ] **Step 2: Implement `src/tiles.ts`**

```ts
// View rules for the server list, kept free of the DOM so they can be tested directly.
export type TileState = "online" | "offline" | "setup";

// Missing credentials win over power state: the owner can fix that whether or not the
// machine is on, while "꺼짐" needs no action.
export function tileState(target: Target): TileState {
  if (!target.ready) return "setup";
  return target.online ? "online" : "offline";
}
export const stateLabel: Record<TileState, string> = {
  online: "켜짐",
  offline: "꺼짐",
  setup: "설정 필요",
};
export const tileEnabled = (target: Target) => tileState(target) === "online";
export const platformClass = (platform: Target["platform"]) =>
  ({ linux: "ubuntu", mac: "mac", windows: "windows" })[platform];
export const connectingText = (name: string) => `${name}에 연결하는 중`;
```

Run: `node --test test/tiles.test.js`
Expected: PASS, `tests 2`, `pass 2`.

- [ ] **Step 3: Port the API tests (they fail against the old `api.ts`)**

Replace `test/browser-api.test.js`. The two fullscreen tests are the existing ones, unchanged in substance; the other three are new.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.js";

async function browser({ window = {}, fetch, location } = {}) {
  const calls = [];
  let entry;
  const document = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen() {
        calls.push("enter");
        entry = Promise.withResolvers();
        return entry.promise;
      },
    },
    async exitFullscreen() {
      calls.push("exit");
      document.fullscreenElement = null;
    },
  };
  const exports = await loadTs("api.ts", {
    window,
    document,
    fetch,
    location: location || { origin: "https://gateway.example.ts.net:8450" },
    AbortSignal,
    JSON,
  });
  return {
    exports,
    api: exports.api,
    calls,
    document,
    completeEntry() {
      document.fullscreenElement = document.documentElement;
      entry.resolve();
    },
    rejectEntry() {
      entry.reject(new Error("Fullscreen denied"));
    },
  };
}

test("browser windowed intent waits for pending entry and exits exactly once", async () => {
  const f = await browser();
  const entering = f.api.fullscreen(true);
  assert.deepEqual(f.calls, ["enter"], "request starts in the user gesture");
  const exiting = f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter"]);
  f.completeEntry();
  await Promise.all([entering, exiting]);
  assert.deepEqual(f.calls, ["enter", "exit"]);
  assert.equal(f.document.fullscreenElement, null);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit"], "already windowed is a no-op");
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.equal(await f.api.fullscreenState(), true);
  await f.api.fullscreen(false);
  assert.deepEqual(f.calls, ["enter", "exit", "enter", "exit"]);
});

test("browser fullscreen rejection allows a later attempt", async () => {
  const f = await browser();
  const denied = f.api.fullscreen(true);
  f.rejectEntry();
  await assert.rejects(denied, /Fullscreen denied/);
  const retry = f.api.fullscreen(true);
  f.completeEntry();
  await retry;
  assert.deepEqual(f.calls, ["enter", "enter"]);
  assert.equal(await f.api.fullscreenState(), true);
});

const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (body === undefined) throw new SyntaxError("not JSON");
    return body;
  },
});

test("requests are same-origin, carry no token and no credentials", async () => {
  const seen = [];
  const f = await browser({
    fetch: async (path, options) => {
      seen.push({ path, options });
      return path === "/api/targets"
        ? reply(200, { targets: [] })
        : reply(201, { ticket: "t1", expiresIn: 20 });
    },
  });
  await f.api.targets();
  const session = await f.api.connect({
    targetId: "ubuntu-server",
    width: 1920,
    height: 1080,
  });
  assert.equal(session.ticket, "t1");
  assert.equal(session.websocket, "wss://gateway.example.ts.net:8450/tunnel");
  assert.deepEqual(
    seen.map((s) => s.path),
    ["/api/targets", "/api/sessions"],
  );
  for (const { options } of seen) {
    assert.equal(options.credentials, "same-origin");
    const headers = options.headers || {};
    assert.equal(
      Object.keys(headers).some((k) => k.toLowerCase() === "authorization"),
      false,
    );
  }
  assert.equal(
    seen[1].options.body,
    '{"targetId":"ubuntu-server","width":1920,"height":1080}',
  );
  for (const key of ["username", "password", "token"])
    assert.equal(seen[1].options.body.includes(key), false, key);
});

test("errors are classified for the screens that show them", async () => {
  const outcomes = {
    "403 with the login code": reply(403, {
      error: "이 기기의 Tailscale 계정으로는 쓸 수 없습니다.",
      code: "login",
    }),
    "403 for another reason": reply(403, {
      error: "Origin rejected.",
      code: "origin",
    }),
    "Serve's 502 page": reply(502, undefined),
    "an HTML 200": reply(200, undefined),
    "a JSON 500": reply(500, { error: "x" }),
    "a refusal with a message": reply(409, {
      error: "이 서버는 아직 설정되지 않았습니다.",
    }),
  };
  const expected = {
    "403 with the login code": "forbidden",
    "403 for another reason": "failed",
    "Serve's 502 page": "unreachable",
    "an HTML 200": "unreachable",
    "a JSON 500": "failed",
    "a refusal with a message": "failed",
  };
  for (const [name, response] of Object.entries(outcomes)) {
    const f = await browser({ fetch: async () => response });
    await assert.rejects(
      f.api.targets(),
      (error) => {
        assert.equal(error.name, "ApiError");
        assert.equal(error.kind, expected[name], name);
        return true;
      },
      name,
    );
  }
  const down = await browser({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(down.api.targets(), (error) => {
    assert.equal(error.kind, "unreachable");
    assert.equal(error.message, "서버에 연결할 수 없습니다");
    return true;
  });
});

test("app mode needs bridge version 1; anything older or absent behaves as a browser", async () => {
  const bridge = (version) => ({
    bridgeVersion: version,
    fullscreen: async (enabled) => `native:${enabled}`,
    fullscreenState: async () => "native-state",
    viewerState: async () => {},
    onViewerAction: () => () => {},
    onFullscreenChange: () => () => {},
    openSetup: async () => "opened",
  });
  const app = await browser({ window: { desktop: bridge(1) } });
  assert.equal(app.exports.appMode, true);
  assert.equal(await app.api.fullscreen(true), "native:true");
  assert.equal(await app.api.fullscreenState(), "native-state");
  assert.equal(await app.api.openSetup(), "opened");
  const later = await browser({ window: { desktop: bridge(2) } });
  assert.equal(later.exports.appMode, true, "newer bridges only add members");
  for (const desktop of [undefined, bridge(0), bridge(undefined)]) {
    const plain = await browser({ window: { desktop } });
    assert.equal(plain.exports.appMode, false);
    assert.equal(await plain.api.fullscreenState(), false);
    assert.equal(await plain.api.openSetup(), undefined);
    assert.deepEqual(plain.calls, []);
  }
});
```

Run: `node --test test/browser-api.test.js`
Expected: FAIL (the old `api.ts` sends `Authorization: Bearer`, has no `ApiError`, `appMode` or `connect` without credentials).

- [ ] **Step 4: Rewrite `src/types.d.ts` and `src/api.ts`**

`src/types.d.ts`:

```ts
declare module "*vendor/guacamole.js" {
  const Guacamole: any;
  export default Guacamole;
}
interface Target {
  id: string;
  name: string;
  platform: "linux" | "mac" | "windows";
  protocol: "rdp" | "vnc";
  profile?: "gnome-remote-login";
  persistent: boolean;
  online: boolean;
  ready: boolean;
}
interface ConnectInput {
  targetId: string;
  width: number;
  height: number;
}
interface ViewerState {
  open: boolean;
  connected: boolean;
  protocol: "rdp" | "vnc" | null;
  resolution: string;
}
// Functions the desktop app contributes to the page it shows. Version 1 is the first
// and only version so far; later versions only add members.
interface NativeBridge {
  fullscreen(enabled: boolean): Promise<void>;
  fullscreenState(): Promise<boolean>;
  onFullscreenChange(callback: (enabled: boolean) => void): () => void;
  viewerState(state: ViewerState): Promise<void>;
  onViewerAction(callback: (action: string) => void): () => void;
}
interface DesktopBridge extends NativeBridge {
  bridgeVersion?: number;
  openSetup(): Promise<void>;
}
interface Window {
  desktop?: DesktopBridge;
}
```

`src/api.ts`:

```ts
// The page is served by the gateway, so every request is same-origin. Tailscale Serve
// adds the caller's identity; the page sends no token and no credentials of its own.
export const REQUIRED_BRIDGE_VERSION = 1;
export const FORBIDDEN_TEXT = "이 기기의 Tailscale 계정으로는 쓸 수 없습니다";
export const UNREACHABLE_TEXT = "서버에 연결할 수 없습니다";

export class ApiError extends Error {
  kind: "unreachable" | "forbidden" | "failed";
  status: number;
  constructor(
    kind: "unreachable" | "forbidden" | "failed",
    message: string,
    status = 0,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

// Bridge version 1 or later means the page runs inside the desktop app. Anything else,
// including an older app without a version, is treated as an ordinary browser.
export const appMode =
  (window.desktop?.bridgeVersion ?? 0) >= REQUIRED_BRIDGE_VERSION;

async function request<T>(path: string, input?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: input ? "POST" : "GET",
      credentials: "same-origin",
      signal: AbortSignal.timeout(12_000),
      ...(input
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    });
  } catch {
    throw new ApiError("unreachable", UNREACHABLE_TEXT);
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  if (response.status === 403 && result?.code === "login")
    throw new ApiError("forbidden", FORBIDDEN_TEXT, 403);
  // A stopped gateway makes Tailscale Serve answer 502 with an HTML page.
  if (!result || response.status >= 502)
    throw new ApiError("unreachable", UNREACHABLE_TEXT, response.status);
  if (!response.ok)
    throw new ApiError(
      "failed",
      result.error || "연결 요청이 실패했습니다.",
      response.status,
    );
  return result as T;
}

let fullscreenTarget = false;
let fullscreenTransition: Promise<void> | undefined;
const browserNative: NativeBridge = {
  async viewerState() {},
  onViewerAction() {
    return () => {};
  },
  fullscreen(enabled) {
    fullscreenTarget = enabled;
    if (!fullscreenTransition) {
      // Start synchronously to preserve the browser's user activation requirement.
      fullscreenTransition = (async () => {
        while (!!document.fullscreenElement !== fullscreenTarget) {
          if (fullscreenTarget)
            await document.documentElement.requestFullscreen();
          else await document.exitFullscreen();
        }
      })().finally(() => {
        fullscreenTransition = undefined;
      });
    }
    return fullscreenTransition;
  },
  async fullscreenState() {
    return !!document.fullscreenElement;
  },
  onFullscreenChange(callback) {
    const listener = () => callback(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  },
};
const native: NativeBridge = appMode ? window.desktop! : browserNative;

export const api = {
  targets: () => request<{ targets: Target[] }>("/api/targets"),
  async connect(input: ConnectInput) {
    const result = await request<{ ticket: string }>("/api/sessions", input);
    return {
      ...result,
      websocket: `${location.origin.replace(/^http/, "ws")}/tunnel`,
    };
  },
  fullscreen: (enabled: boolean) => native.fullscreen(enabled),
  fullscreenState: () => native.fullscreenState(),
  onFullscreenChange: (callback: (enabled: boolean) => void) =>
    native.onFullscreenChange(callback),
  viewerState: (state: ViewerState) => native.viewerState(state),
  onViewerAction: (callback: (action: string) => void) =>
    native.onViewerAction(callback),
  // Only the app has an address to change; in a browser the address bar is the setting.
  openSetup: () => (appMode ? window.desktop!.openSetup() : Promise.resolve()),
};
```

Run: `node --test test/browser-api.test.js test/tiles.test.js`
Expected: PASS, `tests 7` (5 + 2), `fail 0`. (`npm run check` fails until `src/main.ts` is rewritten in Step 7; that is expected here.)

- [ ] **Step 5: Write the failing viewer-invariants test**

This suite has no DOM. `test/viewer-invariants.test.js` reads `src/style.css`, `src/main.ts` and `src/tiles.ts` for the rules that keep remote pixels clean (single remote cursor, overlay hidden on connect, in-flow browser bar, F11 local, the viewer commands, paste, the palette and every screen text).

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// There is no DOM in this test suite, so these read the sources for the rules that keep
// the remote picture clean. They fail loudly if a rewrite drops one; the manual
// checklist in the plan covers what only a browser can show.
const read = (name) =>
  readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const css = (await read("style.css")).replace(/\s+/g, " ");
const main = await read("main.ts");
const tiles = await read("tiles.ts");
const body = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
};

test("only the remote cursor shows over a connected desktop", () => {
  assert.match(
    css,
    /\.remote-surface\.remote-connected, \.remote-surface\.remote-connected \* \{ cursor: none !important; \}/,
  );
  assert.match(body(".remote-cursor"), /visibility: hidden/);
  assert.match(
    body(".remote-connected.remote-pointer-active .remote-cursor"),
    /visibility: visible/,
  );
  assert.match(
    main,
    /getCursorLayer\(\)\.getElement\(\)\.classList\.add\("remote-cursor"\)/,
  );
});

test("nothing is drawn over remote pixels: the overlay hides on connect and the browser bar is in the page flow", () => {
  assert.match(main, /state === 3\) \{[^}]*el\("overlay"\)\.hidden = true/);
  assert.match(body(".session-toolbar"), /flex-shrink: 0/);
  assert.doesNotMatch(body(".session-toolbar"), /position: (absolute|fixed)/);
  assert.match(body(".session"), /display: flex/);
  assert.match(css, /\.app-mode \.browser-only \{ display: none; \}/);
});

test("F11 stays local and the viewer keeps its commands", () => {
  assert.match(main, /if \(!appMode\) \{[^}]*key !== "F11"/s);
  for (const command of [
    "resolution:",
    '"back"',
    '"disconnect"',
    '"reconnect"',
    '"text-input"',
  ])
    assert.ok(main.includes(command), command);
  assert.match(main, /client\.sendSize\(width, height\)/);
  assert.match(main, /createClipboardStream\("text\/plain"\)/);
});

test("the list uses the approved palette, dark mode and state words", () => {
  for (const colour of [
    "#f6f3ee",
    "#22201e",
    "#2e2b28",
    "#e95420",
    "#a83a1c",
    "#9aa3b2",
    "#5d6573",
  ])
    assert.ok(css.includes(colour), colour);
  assert.match(css, /prefers-color-scheme: dark/);
  for (const word of ["켜짐", "꺼짐", "설정 필요"])
    assert.ok(tiles.includes(word), word);
  for (const text of [
    "연결이 끊겼습니다",
    "작업은 그대로 남아 있습니다",
    "다시 연결",
    "목록으로",
    "서버에 연결할 수 없습니다",
    "다시 시도",
    "이 기기의 Tailscale 계정으로는 쓸 수 없습니다",
  ])
    assert.ok(main.includes(text), text);
});
```

Run: `node --test test/viewer-invariants.test.js`
Expected: FAIL (the old `main.ts`/`style.css` have the dark-green palette, the workspace copy and no `app-mode`).

- [ ] **Step 6: Rewrite `index.html` and `src/style.css`**

`index.html` (no meta CSP: the gateway's header is the single source; recoloured favicon):

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>Gome Remote</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e95420'/%3E%3Crect x='6' y='7' width='20' height='14' rx='3' stroke='%23fff' fill='none' stroke-width='2'/%3E%3Cpath d='M16 21v5m-5 0h10' stroke='%23fff' stroke-width='2'/%3E%3C/svg%3E"
    />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/style.css` (design B; the `.remote-*` cursor rules are carried over verbatim from the old file):

```css
:root {
  --bg: #f6f3ee;
  --ink: #2b2723;
  --muted: #7a7168;
  --tile: #ffffff;
  --line: #e4ddd2;
  --shadow: 0 1px 2px rgba(43, 39, 35, 0.06), 0 6px 18px rgba(43, 39, 35, 0.06);
  --accent: #2b2723;
  --accent-ink: #ffffff;
  --viewport: #141210;
  --on: #3fa66b;
  --off: #b7aea3;
  --setup: #d9902f;
  --danger: #b3261e;
  font-family:
    Inter,
    "Noto Sans KR",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color: var(--ink);
  background: var(--bg);
  font-synthesis: none;
  color-scheme: light dark;
  font-size: 15px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #22201e;
    --ink: #f0ebe4;
    --muted: #a39a90;
    --tile: #2e2b28;
    --line: #433f3a;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 18px rgba(0, 0, 0, 0.25);
    --accent: #f0ebe4;
    --accent-ink: #22201e;
    --viewport: #0d0c0b;
    --off: #6f675f;
    --danger: #f2b8b5;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
}
button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
}
button {
  cursor: pointer;
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--tile);
}
button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
}
button.danger {
  color: var(--danger);
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
button:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
select,
textarea {
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--tile);
}
svg {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}
[hidden] {
  display: none !important;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.muted {
  color: var(--muted);
}

/* Server list */
#app {
  min-height: 100vh;
}
.home {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 32px 48px;
}
.home-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}
.home-bar h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.menu-wrap {
  position: relative;
}
.icon-button {
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
  font-size: 20px;
  line-height: 1;
  background: transparent;
  border-color: transparent;
}
.icon-button:hover {
  background: var(--tile);
  border-color: var(--line);
}
.menu {
  position: absolute;
  right: 0;
  top: 46px;
  z-index: 10;
  min-width: 190px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--tile);
  box-shadow: var(--shadow);
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
}
.menu button:hover {
  background: var(--bg);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 20px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 12px 16px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--tile);
  box-shadow: var(--shadow);
  text-align: left;
  transition: transform 0.12s ease;
}
.tile:not(:disabled):hover {
  transform: translateY(-2px);
}
.tile:disabled {
  opacity: 0.55;
  box-shadow: none;
}
.tile-art {
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 10;
  margin-bottom: 10px;
  border-radius: 12px;
  color: #ffffff;
}
.platform-ubuntu {
  background: linear-gradient(145deg, #e95420, #a83a1c);
}
.platform-mac {
  background: linear-gradient(145deg, #9aa3b2, #5d6573);
}
.platform-windows {
  background: linear-gradient(145deg, #5b8fd1, #2f5f9e);
}
.tile:disabled .tile-art {
  filter: grayscale(1);
}
.tile-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}
.tile-name {
  font-weight: 600;
  font-size: 16px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--off);
}
.is-online .dot {
  background: var(--on);
}
.is-setup .dot {
  background: var(--setup);
}
.tile-state {
  padding: 0 4px 0 21px;
  color: var(--muted);
  font-size: 13px;
}

/* Loading, unreachable and refused-login screens */
.state {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px;
  text-align: center;
}
.state h2,
.overlay h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid var(--line);
  border-top-color: var(--ink);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 3s;
  }
  .tile {
    transition: none;
  }
}

/* Viewer */
.viewing {
  overflow: hidden;
}
.session {
  position: relative;
  height: 100dvh;
  display: flex;
  flex-direction: column;
}
/* The desktop app uses the native Remote menu instead of this bar. */
.app-mode .browser-only {
  display: none;
}
.session-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
.session-title {
  font-weight: 600;
  margin-left: 6px;
}
.session-state {
  color: var(--muted);
  font-size: 12px;
}
.toolbar-spacer {
  flex: 1;
}
.viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--viewport);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
}
.display {
  display: flex;
  align-items: center;
  justify-content: center;
}
.remote-surface {
  outline: none;
}
.remote-surface.remote-connected,
.remote-surface.remote-connected * {
  cursor: none !important;
}
.remote-cursor {
  visibility: hidden;
  pointer-events: none;
}
.remote-connected.remote-pointer-active .remote-cursor {
  visibility: visible;
}
/* Shown only while there is no remote picture to cover; hidden once connected. */
.overlay {
  position: absolute;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 80%;
  padding: 28px 36px;
  border-radius: 20px;
  background: var(--tile);
  box-shadow: var(--shadow);
  text-align: center;
}
.overlay p {
  margin: 0;
  color: var(--muted);
}

/* Dialogs */
dialog {
  max-width: min(480px, 92vw);
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--tile);
  color: var(--ink);
}
dialog::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.dialog-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dialog-heading h2 {
  margin: 0;
  font-size: 17px;
}
.close-button {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
  border-color: transparent;
  background: transparent;
  font-size: 18px;
}
#text-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
#remote-text {
  width: 100%;
  resize: vertical;
}
.wide {
  width: 100%;
}
```

- [ ] **Step 7: Rewrite `src/main.ts`**

The viewer code (Guacamole client, mouse/keyboard, resize fitting, text paste, fullscreen handling, menu sync) is carried over from the old file; the list, the state screens, the overlay and the single-argument `connect` are new.

```ts
import Guacamole from "../vendor/guacamole.js";
import { ApiError, api, appMode } from "./api";
import {
  connectingText,
  platformClass,
  stateLabel,
  tileEnabled,
  tileState,
} from "./tiles";
import "./style.css";

const monitor =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4"/></svg>';
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <section id="home" class="home" hidden>
    <header class="home-bar">
      <h1>Gome Remote</h1>
      <div class="menu-wrap">
        <button id="menu-button" class="icon-button" aria-label="메뉴" aria-haspopup="menu" aria-expanded="false">⋯</button>
        <div id="menu" class="menu" role="menu" hidden>
          <button id="menu-refresh" role="menuitem">새로고침</button>
          <button id="menu-address" role="menuitem" hidden>서버 주소 바꾸기</button>
        </div>
      </div>
    </header>
    <div id="tiles" class="tiles"></div>
  </section>
  <section id="state" class="state">
    <div id="state-spinner" class="spinner" role="status" aria-label="불러오는 중"></div>
    <h2 id="state-title" hidden></h2>
    <div id="state-actions" class="actions" hidden>
      <button id="state-retry" class="primary">다시 시도</button>
      <button id="state-address" hidden>서버 주소 바꾸기</button>
    </div>
  </section>
  <section id="session" class="session" hidden>
    <div id="session-tools" class="session-toolbar browser-only">
      <button id="back">← 목록</button>
      <span id="session-title" class="session-title"></span>
      <span id="session-state" class="session-state"></span>
      <div class="toolbar-spacer"></div>
      <label class="sr-only" for="resolution">해상도</label>
      <select id="resolution"><option value="1440x900">1440 × 900</option><option value="1920x1080">1920 × 1080</option><option value="2560x1440">2560 × 1440</option></select>
      <button id="text-input" disabled>텍스트 입력</button>
      <button id="fullscreen">전체 화면</button>
      <button id="reconnect" class="primary" hidden>다시 연결</button>
      <button id="disconnect" class="danger">연결 종료</button>
    </div>
    <div id="viewport" class="viewport">
      <div id="overlay" class="overlay">
        <div id="overlay-spinner" class="spinner"></div>
        <h2 id="overlay-title"></h2>
        <p id="overlay-detail" hidden>작업은 그대로 남아 있습니다</p>
        <div id="overlay-actions" class="actions" hidden>
          <button id="overlay-reconnect" class="primary">다시 연결</button>
          <button id="overlay-back">목록으로</button>
        </div>
      </div>
      <div id="display" class="display"></div>
    </div>
  </section>
  <dialog id="viewer-error"><p id="viewer-error-text"></p><button data-close="viewer-error">닫기</button></dialog>
  <dialog id="text-dialog"><form id="text-form"><div class="dialog-heading"><h2>원격 화면에 텍스트 입력</h2><button type="button" class="close-button" data-close="text-dialog" aria-label="닫기">×</button></div><p class="muted">원격 앱의 입력 위치를 먼저 선택해주세요. 한글도 입력할 수 있습니다.</p><textarea id="remote-text" rows="5" maxlength="4000" aria-label="보낼 텍스트"></textarea><button class="primary wide" type="submit">입력하기 →</button></form></dialog>
`;
function el<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
let targets: Target[] = [];
let listGeneration = 0;
let selected: Target | undefined;
let generation = 0;
let client: any;
let keyboard: any;
let resizeObserver: ResizeObserver | undefined;
let releaseMouse: (() => void) | undefined;
let active = false;
let lastInput: ConnectInput | undefined;
let fullscreen = false;
document.body.classList.toggle("app-mode", appMode);
el("menu-address").hidden = !appMode;
el("state-address").hidden = !appMode;

type Screen = "home" | "state" | "session";
function showScreen(screen: Screen) {
  for (const name of ["home", "state", "session"] as Screen[])
    el(name).hidden = name !== screen;
}
function showState(kind: "loading" | "unreachable" | "forbidden") {
  showScreen("state");
  el("state-spinner").hidden = kind !== "loading";
  el("state-title").hidden = kind === "loading";
  el("state-actions").hidden = kind === "loading";
  el("state-title").textContent =
    kind === "forbidden"
      ? "이 기기의 Tailscale 계정으로는 쓸 수 없습니다"
      : "서버에 연결할 수 없습니다";
  // Another attempt cannot fix a refused login, and the address is not the cause.
  el("state-address").hidden = !appMode || kind !== "unreachable";
}

function syncViewerMenu() {
  void api
    .viewerState({
      open: !el("session").hidden,
      connected: active,
      protocol: selected?.protocol || null,
      resolution: el<HTMLSelectElement>("resolution").value,
    })
    .catch(() =>
      showViewerError("원격 메뉴를 갱신하지 못했습니다. 앱을 다시 열어주세요."),
    );
}
function showViewerError(message: string) {
  releaseInput();
  el("viewer-error-text").textContent = message;
  const dialog = el<HTMLDialogElement>("viewer-error");
  if (!dialog.open) dialog.showModal();
}
function fullscreenChanged(enabled: boolean) {
  releaseInput();
  fullscreen = enabled;
  el("fullscreen").textContent = enabled
    ? "전체화면 나가기 · F11"
    : "전체 화면 · F11";
}
async function setFullscreen(enabled: boolean) {
  releaseInput();
  el<HTMLDialogElement>("viewer-error").close();
  try {
    await api.fullscreen(enabled);
  } catch {
    showViewerError("전체화면을 변경하지 못했습니다. 다시 시도해주세요.");
  }
}
api.onFullscreenChange(fullscreenChanged);
void api.fullscreenState().then(fullscreenChanged);
// Browser fallback: the desktop app reserves F11 in its main process instead.
if (!appMode) {
  const localShortcut = (event: KeyboardEvent) => {
    if (event.key !== "F11") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat)
      void setFullscreen(!document.fullscreenElement);
  };
  window.addEventListener("keydown", localShortcut, true);
  window.addEventListener("keyup", localShortcut, true);
}

async function refresh() {
  const current = ++listGeneration;
  closeMenu();
  showState("loading");
  try {
    const result = await api.targets();
    if (current !== listGeneration) return;
    targets = result.targets;
    renderTargets();
    showScreen("home");
  } catch (error) {
    if (current !== listGeneration) return;
    targets = [];
    showState(
      error instanceof ApiError && error.kind === "forbidden"
        ? "forbidden"
        : "unreachable",
    );
  }
}
function renderTargets() {
  const grid = el("tiles");
  grid.replaceChildren();
  for (const target of targets) {
    const state = tileState(target);
    const tile = document.createElement("button");
    tile.className = `tile is-${state}`;
    tile.disabled = !tileEnabled(target);
    tile.innerHTML = `<span class="tile-art platform-${platformClass(target.platform)}">${monitor}</span><span class="tile-meta"><span class="dot"></span><span class="tile-name"></span></span><span class="tile-state"></span>`;
    tile.querySelector(".tile-name")!.textContent = target.name;
    tile.querySelector(".tile-state")!.textContent = stateLabel[state];
    tile.onclick = () => openTarget(target);
    grid.append(tile);
  }
}
function openTarget(target: Target) {
  if (!targets.includes(target) || !tileEnabled(target)) return;
  selected = target;
  const [width, height] = el<HTMLSelectElement>("resolution")
    .value.split("x")
    .map(Number);
  void connect({ targetId: target.id, width, height });
}
function releaseInput() {
  keyboard?.reset();
  releaseMouse?.();
  el("display")
    .querySelector(".remote-surface")
    ?.classList.remove("remote-pointer-active");
}
function stop() {
  generation++;
  releaseInput();
  active = false;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  if (client) {
    client.onstatechange = null;
    client.onerror = null;
    client.disconnect();
  }
  client = undefined;
  keyboard = undefined;
  releaseMouse = undefined;
  el("display").replaceChildren();
  el<HTMLButtonElement>("text-input").disabled = true;
}
function showOverlay(kind: "connecting" | "ended") {
  const ended = kind === "ended";
  el("overlay").hidden = false;
  el("overlay-spinner").hidden = ended;
  el("overlay-title").textContent = ended
    ? "연결이 끊겼습니다"
    : connectingText(selected?.name || "원격 데스크톱");
  el("overlay-detail").hidden = !ended;
  el("overlay-actions").hidden = !ended;
}
function sessionEnded() {
  releaseInput();
  active = false;
  el("session-state").textContent = "연결 종료";
  showOverlay("ended");
  el("reconnect").hidden = false;
  el("display")
    .querySelector(".remote-surface")
    ?.classList.remove("remote-connected");
  syncViewerMenu();
  el<HTMLButtonElement>("text-input").disabled = true;
}
async function connect(input: ConnectInput) {
  stop();
  const current = generation;
  lastInput = { ...input };
  document.body.classList.add("viewing");
  el<HTMLDialogElement>("viewer-error").close();
  el("session-title").textContent = selected?.name || "원격 데스크톱";
  showScreen("session");
  syncViewerMenu();
  el("session-state").textContent = "연결 중";
  showOverlay("connecting");
  el("reconnect").hidden = true;
  el<HTMLSelectElement>("resolution").disabled = selected?.protocol !== "rdp";
  try {
    const result = await api.connect(input);
    if (current !== generation) return;
    const tunnel = new Guacamole.WebSocketTunnel(result.websocket);
    const connection = new Guacamole.Client(tunnel);
    client = connection;
    const display = connection.getDisplay();
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    surface.className = "remote-surface";
    surface.setAttribute("aria-label", "원격 데스크톱 화면");
    // Incoming server mouse instructions can reattach the cursor layer. CSS owns
    // final visibility so delayed messages cannot steal local cursor ownership.
    display.getCursorLayer().getElement().classList.add("remote-cursor");
    surface.append(display.getElement());
    el("display").append(surface);
    const fit = () => {
      if (!display.getWidth() || !display.getHeight()) return;
      display.scale(
        Math.min(
          el("viewport").clientWidth / display.getWidth(),
          el("viewport").clientHeight / display.getHeight(),
        ),
      );
    };
    display.onresize = fit;
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(el("viewport"));
    const mouse = new Guacamole.Mouse(display.getElement());
    let mouseState: any;
    mouse.onmousedown =
      mouse.onmouseup =
      mouse.onmousemove =
        (state: any) => {
          if (!active) return;
          surface.classList.add("remote-pointer-active");
          mouseState = state;
          surface.focus({ preventScroll: true });
          connection.sendMouseState(state, true);
        };
    mouse.onmouseout = () => surface.classList.remove("remote-pointer-active");
    // Guacamole deduplicates moves to the last coordinate, including re-entry.
    surface.addEventListener("mouseenter", () => {
      if (active) surface.classList.add("remote-pointer-active");
    });
    releaseMouse = () => {
      if (active && mouseState)
        connection.sendMouseState(
          {
            ...mouseState,
            left: false,
            middle: false,
            right: false,
            up: false,
            down: false,
          },
          true,
        );
    };
    keyboard = new Guacamole.Keyboard(surface);
    keyboard.onkeydown = (keysym: number) => {
      if (active) connection.sendKeyEvent(1, keysym);
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (active) connection.sendKeyEvent(0, keysym);
    };
    surface.addEventListener("blur", releaseInput);
    connection.onerror = () => {
      if (current === generation) sessionEnded();
    };
    tunnel.onerror = () => {
      if (current === generation) sessionEnded();
    };
    connection.onstatechange = (state: number) => {
      if (current !== generation) return;
      if (state === 3) {
        active = true;
        surface.classList.add("remote-connected");
        syncViewerMenu();
        el("session-state").textContent = "연결됨";
        el("overlay").hidden = true;
        el<HTMLButtonElement>("text-input").disabled = false;
        surface.focus();
        fit();
      } else if (state === 5) sessionEnded();
    };
    connection.connect(`ticket=${encodeURIComponent(result.ticket)}`);
  } catch (error) {
    if (current !== generation) return;
    if (error instanceof ApiError && error.kind === "forbidden") {
      back(false);
      showState("forbidden");
    } else sessionEnded();
  }
}
function back(reload = true) {
  stop();
  document.body.classList.remove("viewing");
  el<HTMLDialogElement>("viewer-error").close();
  void setFullscreen(false);
  lastInput = undefined;
  el<HTMLSelectElement>("resolution").disabled = false;
  showScreen("home");
  syncViewerMenu();
  if (reload) void refresh();
}
function disconnect() {
  stop();
  sessionEnded();
}
function reconnect() {
  if (lastInput && !active) void connect(lastInput);
}
function openTextDialog() {
  if (!active) return;
  releaseInput();
  el<HTMLDialogElement>("text-dialog").showModal();
  el("remote-text").focus();
}

function closeMenu() {
  el("menu").hidden = true;
  el("menu-button").setAttribute("aria-expanded", "false");
}
el("menu-button").onclick = (event) => {
  event.stopPropagation();
  const open = el("menu").hidden;
  el("menu").hidden = !open;
  el("menu-button").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
el("menu-refresh").onclick = () => void refresh();
el("menu-address").onclick = el("state-address").onclick = () => {
  closeMenu();
  void api.openSetup();
};
el("state-retry").onclick = () => void refresh();
el("back").onclick = el("overlay-back").onclick = () => back();
el("disconnect").onclick = disconnect;
el("reconnect").onclick = el("overlay-reconnect").onclick = reconnect;
el("fullscreen").onclick = () => {
  void setFullscreen(!fullscreen);
};
el<HTMLSelectElement>("resolution").onchange = () => {
  releaseInput();
  syncViewerMenu();
  const [width, height] = el<HTMLSelectElement>("resolution")
    .value.split("x")
    .map(Number);
  if (lastInput) Object.assign(lastInput, { width, height });
  if (active && selected?.protocol === "rdp") client.sendSize(width, height);
};
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach((button) => {
    button.onclick = () => el<HTMLDialogElement>(button.dataset.close!).close();
  });
el("text-input").onclick = openTextDialog;
el<HTMLFormElement>("text-form").onsubmit = (event) => {
  event.preventDefault();
  if (active) {
    const text = el<HTMLTextAreaElement>("remote-text").value;
    if (text) {
      const writer = new Guacamole.StringWriter(
        client.createClipboardStream("text/plain"),
      );
      writer.sendText(text);
      writer.sendEnd();
      // Clipboard transfer supports characters absent from the remote keyboard layout.
      const modifier = selected?.platform === "mac" ? 0xffe7 : 0xffe3;
      client.sendKeyEvent(1, modifier);
      client.sendKeyEvent(1, 0x76);
      client.sendKeyEvent(0, 0x76);
      client.sendKeyEvent(0, modifier);
    }
  }
  el<HTMLTextAreaElement>("remote-text").value = "";
  el<HTMLDialogElement>("text-dialog").close();
};
api.onViewerAction((action) => {
  if (el("session").hidden) return;
  releaseInput();
  if (action.startsWith("resolution:")) {
    if (!active || selected?.protocol !== "rdp") return;
    const select = el<HTMLSelectElement>("resolution");
    const size = action.slice("resolution:".length);
    if (!Array.from(select.options).some((option) => option.value === size))
      return;
    select.value = size;
    select.dispatchEvent(new Event("change"));
  } else if (action === "back") back();
  else if (action === "disconnect") disconnect();
  else if (action === "reconnect") reconnect();
  else if (action === "text-input") openTextDialog();
});
window.addEventListener("blur", releaseInput);
window.addEventListener("beforeunload", stop);
void refresh();
```

- [ ] **Step 8: Run the checks**

```bash
npm test
npm run check
npm run build
```
Expected: `tests 84`, `pass 84`; `tsc --noEmit` prints nothing; Vite writes `dist/index.html`, one CSS and one JS asset.

- [ ] **Step 9: Browser check against a development gateway (manual; cannot run in `node:test`)**

Write a development configuration as in the README "Development" section (loopback `publicOrigin` on a free port that is not 38989, `devLogin`, two or three targets on loopback ports where you start throwaway `net` listeners so some tiles are online), run `npm run build`, start `GOME_REMOTE_CONFIG=<file> node server/index.js`, run `node scripts/set-credential.mjs <file> <id>` for one target only, and open the printed address in a desktop browser. Verify and record:

1. Light and dark (`prefers-color-scheme`) screenshots show design B: warm background, white/dark tiles, colour blocks, dot, name, one-word state; no sidebar or marketing copy.
2. A target with credentials and a listening port shows 켜짐 and opens; an unlistening one shows 꺼짐 and is not clickable; one without credentials shows 설정 필요 and is not clickable.
3. Opening a tile shows the spinner and "<name>에 연결하는 중" (a target that is only a bare TCP listener will then show the "연결이 끊겼습니다 / 작업은 그대로 남아 있습니다" card with 다시 연결 and 목록으로 - that is the expected failure screen).
4. `⋯` shows only 새로고침 in a browser (서버 주소 바꾸기 appears in the app only).
5. Stop the gateway and press 새로고침: "서버에 연결할 수 없습니다" with 다시 시도. The 403 screen "이 기기의 Tailscale 계정으로는 쓸 수 없습니다" cannot be reached with `devLogin` (it must be an allowed login); in development it appears only if a browser extension sets a different `Tailscale-User-Login` header. It is checked on the real server in V1 by temporarily changing `allowedLogins`.
6. Against a real desktop (owner's V-checks, not here): no overlay on the remote picture, one cursor, F11 local, RDP resolution change, text paste.

If no browser is available, record steps 1-6 as "not run"; the automated checks above are what is verified.

- [ ] **Step 10: Format and commit**

```bash
npx prettier --check src index.html test/helpers test/browser-api.test.js test/tiles.test.js test/viewer-invariants.test.js
git add src index.html test/helpers test/browser-api.test.js test/tiles.test.js test/viewer-invariants.test.js
git commit -m "Rewrite the UI as design B served by the gateway"
```

---

### Task 8: Documentation and final verification (spec D7, section 7)

**Files:**
- Create: `test/public-hygiene.test.js`
- Modify: `README.md` (final), `docs/verification.md` (rewrite), `package.json` and `package-lock.json` (version 0.2.0)

**Interfaces:**
- Consumes: everything above. Produces: the final README (product description, one-password flow, installation, desktop app, operations, legacy tag pointer, development), a verification record that lists what the automated checks prove and what P1/P2/V1-V6 will record, and a hygiene test that keeps real identifiers out of the public tree.

- [ ] **Step 1: Write the public-hygiene test and run it**

`test/public-hygiene.test.js` scans the tracked text files for emails other than `@example.com`, tailnet host labels other than the placeholders and tailnet IPs other than the documented placeholders:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The repository is public. Fixtures, docs and examples may only use placeholders:
// example.com logins, example/tail123/your-tailnet tailnet names and the tailnet
// addresses below. A real login, device name or tailnet IP must stay out of the tree.
const root = fileURLToPath(new URL("../", import.meta.url));
const skip = new Set([
  "node_modules",
  "dist",
  "release",
  ".git",
  "vendor",
  "package-lock.json",
]);
const tailnetLabels = new Set([
  "example",
  "tail123",
  "tailnet",
  "your-tailnet",
  "evil",
]);
const tailnetAddresses = new Set([
  "100.64.0.1",
  "100.64.0.10",
  "100.64.0.20",
  "100.64.0.99",
  "100.63.255.255",
  "100.127.255.254",
  "100.128.0.0",
]);

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (
      /\.(js|mjs|cjs|ts|json|md|html|css|yml|yaml|service)$/.test(entry.name)
    )
      found.push(path);
  }
  return found;
}

test("tracked text contains only placeholder logins, tailnet names and addresses", async () => {
  const problems = [];
  for (const path of await files(root)) {
    const text = await readFile(path, "utf8");
    const name = relative(root, path);
    for (const [email] of text.matchAll(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ))
      if (!/@example\.com$/.test(email) && !/\.ts\.net$/.test(email))
        problems.push(`${name}: ${email}`);
    for (const [host, label] of text.matchAll(/([A-Za-z0-9-]+)\.ts\.net/g))
      if (!tailnetLabels.has(label.toLowerCase()))
        problems.push(`${name}: ${host}`);
    for (const [address] of text.matchAll(
      /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    ))
      if (!tailnetAddresses.has(address)) problems.push(`${name}: ${address}`);
  }
  assert.deepEqual(problems, []);
});
```

Run: `node --test test/public-hygiene.test.js`
Expected: PASS (the tree already uses only placeholders). If it fails, replace the reported value with a placeholder; never add a real value to the allow lists.

- [ ] **Step 2: Write the final README**

Replace `README.md` with the following (it contains the install and operations sections from Task 5 unchanged):

````markdown
# Gome Remote

One list of your own machines, on your own tailnet. Pick the Ubuntu server or the Mac
and the desktop fills the window. The same screen runs in the Windows app, the Mac app
and a browser.

Tiles show a coloured block per platform, an online dot, the name and one word of
state: 켜짐 (on), 꺼짐 (off) or 설정 필요 (needs setup). Off and unconfigured machines
are dimmed and cannot be opened.

## How you sign in: one password

- **Ubuntu server.** Click the tile and the Ubuntu login screen (GDM) appears. Type the
  `gome` account password there, once. You land in the desktop session that is already
  running, with your windows as you left them. Disconnect and reconnect later: the
  session is still there and GDM asks for the password again, like a lock screen.
- **Mac.** Click the tile and the Mac screen appears. There is nothing to type in the
  app.
- **The app itself asks for nothing but the server address,** once, the first time.

Passwords the machines need before the login screen (Ubuntu's system Remote Login
credentials and the Mac's VNC password) are stored on the gateway server by its
owner and injected by the gateway. No client stores or sends a password, and there is no
access token to copy around: the gateway decides from your Tailscale login.

## How it works

```text
Windows/Mac app (a thin window) or browser
  -> Tailscale HTTPS (Serve adds the Tailscale-User-Login header)
  -> gateway on a unix socket  (checks login and Origin, serves the UI, issues tickets)
  -> guacd on 127.0.0.1:4822   (Apache Guacamole, read-only container)
       -> 127.0.0.1:3389  GNOME Remote Desktop -> GDM -> your session
       -> <mac tailnet ip>:5900  macOS Screen Sharing
```

- The gateway listens only on a unix socket inside a 0700 directory. Only Tailscale Serve
  reaches it, and Serve overwrites the `Tailscale-User-Login` header with the real login.
- `/api/*` and the `/tunnel` WebSocket accept only logins listed in `allowedLogins`
  (required, no default). `/tunnel` also requires the exact public Origin. Connection
  tickets last 20 seconds and work once, for the login that requested them.
- The desktop is shown inside the app. Nothing opens another remote desktop client.
- The gateway and `guacd` decrypt desktop traffic and keyboard input. Run them on a machine
  you trust. Anyone who can run code as the gateway's user can read the credentials file
  and reach the socket; with a passwordless-sudo account that is as powerful as root.
  Every device that passes the login check can open the Mac screen without a password,
  so remove a lost device from Tailscale.

## Install the gateway (Ubuntu server)

Requirements: Node.js 24+, Docker, Tailscale, GNOME Remote Desktop with system
Remote Login enabled for the Ubuntu target.

```sh
git clone https://github.com/WONJUNE-LEE/gome-remote.git ~/remote
cd ~/remote
npm ci
npm run build
sudo docker compose -f deploy/compose.yaml up -d
```

The compose file binds `guacd` to **127.0.0.1:4822**, pins the official image, drops all
capabilities and keeps the root filesystem read-only. Never publish guacd: it has no
authentication of its own.

Copy [`deploy/targets.example.json`](deploy/targets.example.json) somewhere private, set
the Mac's Tailscale IP, then create the configuration. Target addresses must be literal
Tailscale IPs or `127.0.0.1`.

```sh
node scripts/init-gateway.mjs ~/.config/gome-remote/gateway.json \
  --origin https://YOUR-SERVER.YOUR-TAILNET.ts.net:8450 \
  --login you@example.com \
  --targets ~/targets.json
```

Repeat `--login` for each Tailscale login that may use the gateway. The file holds no
secrets. It points at `~/.local/state/gome-remote/gateway.sock` (the socket) and
`~/.config/gome-remote/credentials.json` (the credentials file).

Store each machine's credentials. The command prompts without echo and writes the
file atomically with mode 600; nothing is passed in arguments or environment variables.
It must run in a real terminal.

```sh
node scripts/set-credential.mjs ~/.config/gome-remote/gateway.json ubuntu-server  # system Remote Login user name + password
node scripts/set-credential.mjs ~/.config/gome-remote/gateway.json mac            # Screen Sharing VNC password
```

A target without stored credentials shows as 설정 필요. The gateway re-reads the file on
every request, so no restart is needed after `set-credential`. Apple's VNC uses only the
first 8 characters of its password. The gateway refuses to start if the file is not mode
600, is not owned by the gateway user, or is malformed.

Run it as a user service and publish it with Tailscale Serve on a port of its own:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/gome-remote-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gome-remote-gateway.service
sudo tailscale serve --bg --https=8450 unix:$HOME/.local/state/gome-remote/gateway.sock
```

Do not use Funnel. Check `tailscale serve status` first and use a free port so existing
routes stay untouched. The socket lives under `~/.local/state`, not `/tmp`, because the
unit sets `PrivateTmp=true`. Enable lingering (`loginctl enable-linger $USER`) if the
service must run without a login session.

To run a candidate beside an older gateway, install the unit under another name with its
own configuration, socket and Serve port, and remove it when done.

`ignoreCertificate: true` in the Ubuntu target accepts GNOME Remote Desktop's
self-signed certificate on loopback. It is a per-target choice, never global.

## Install the desktop app

Download the Windows installer or the Mac disk image from the CI artifacts, or build
them (`npm run dist -- --win`, `--mac`, `--linux` on the matching OS; artifacts land in
`release/`). Packages are unsigned: confirm the first-launch prompt, do not disable
Gatekeeper or SmartScreen globally.

On first launch the app asks for the server address, for example
`your-server.your-tailnet.ts.net:8450`, and then shows the gateway's own page. Change
it later from **원격 → 서버 주소 바꾸기** or the `⋯` menu. If the gateway cannot be
reached the app shows the address page again. On first launch the app deletes the `vault.enc`
that 0.1.x versions left in its data directory.

Open the same address in a browser for the identical screen.

## Using it

- Click a tile. While connecting, the window shows a spinner and "<name>에 연결하는 중".
- In the app, use the native **원격** menu: 서버 목록, 해상도 (RDP only), 텍스트 입력,
  다시 연결, 연결 종료. F11 and **View → 전체 화면** toggle full screen locally; Escape
  stays a remote key.
- In a browser the same controls sit in a bar above the picture, never over it.
- Only the remote cursor is drawn over a connected desktop.
- Lost connection: the window says **연결이 끊겼습니다 / 작업은 그대로 남아 있습니다**.
  Choose 다시 연결 or 목록으로.
- If this device's Tailscale account is not in `allowedLogins`, the window says
  **이 기기의 Tailscale 계정으로는 쓸 수 없습니다**.

Not included: audio, file transfer, discovery, several users, per-device allow lists,
code signing, auto-update, unattended Mac login after a FileVault reboot.

## Operations

- **Restart** the gateway after changing `gateway.json` (targets, logins):
  `systemctl --user restart gome-remote-gateway.service`. Connections drop; the Ubuntu
  session and its windows do not.
- **Change a password:** run `set-credential` again for that target. No restart.
- **Stop access:** stop the service and remove only its Serve listener,
  `sudo tailscale serve --https=8450 off`. Never reset all Serve routes.
- **Startup refused?** The log says why (`journalctl --user -u gome-remote-gateway`):
  an empty `allowedLogins`, a legacy `token` field, a credentials file whose mode is not
  600, or a socket directory open to group or others.
- **Stale socket:** a SIGKILL or crash can leave the socket file behind. The next start
  removes it only if it is a socket with nobody listening, and refuses to touch anything
  else.

## Legacy dedicated account

The old dedicated-account desktop (`gome-remote-review`) and its migration and rollback
tools are gone from this tree. They are kept at the git tag `legacy-dedicated-account`
(commit `89ab9ec`), for example
`git show legacy-dedicated-account:scripts/setup-remote-login.py`. Disabling or removing
that account on a server is a separate, deliberate step that this project does not
perform.

## Development

Node.js 24+ and npm. No production credentials are needed.

```sh
npm ci
npm test          # unit and integration tests
npm run check     # TypeScript
npm run build     # UI into dist/
npm start         # the desktop app (Electron)
```

`npm test` runs a real gateway on a real unix socket with an independent guacd wire
fixture: login and Origin checks, ticket rules, credential injection, refusal of client
credentials, stale-socket recovery, the credentials file's mode and ownership checks,
`set-credential`'s prompts and atomic write, the desktop shell's origin checks and the
UI's API layer. It does not control a real Windows or Mac machine.

To run everything locally, write a development configuration with a loopback origin and
a `devLogin`, which is allowed only for `http://127.0.0.1:<port>`:

```json
{
  "socketPath": "/tmp/gome-remote-dev/gateway.sock",
  "publicOrigin": "http://127.0.0.1:38991",
  "devLogin": "dev@example.com",
  "allowedLogins": ["dev@example.com"],
  "credentialsFile": "/tmp/gome-remote-dev/credentials.json",
  "targets": [
    {
      "id": "ubuntu-server",
      "name": "Ubuntu 서버",
      "platform": "linux",
      "protocol": "rdp",
      "profile": "gnome-remote-login",
      "hostname": "127.0.0.1",
      "port": 3389,
      "persistent": true
    }
  ]
}
```

```sh
npm run build
GOME_REMOTE_CONFIG=./dev-gateway.json node server/index.js   # also relays 127.0.0.1:38991
node scripts/set-credential.mjs ./dev-gateway.json <target-id>
```

Open `http://127.0.0.1:38991/` in a browser, or run `npm start` and enter that address.
`npm run dev` serves the UI alone for layout work; its API calls fail, which shows the
"서버에 연결할 수 없습니다" screen.

## Upstream

Apache Guacamole 1.6.0 provides the RDP/VNC engine and browser client. Its JavaScript is
vendored from the official archive with checksum and licence notices in
[`vendor/`](vendor/README.md). The Node gateway contains only the authenticated
WebSocket tunnel and the guacd handshake adapter.

- [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [GNOME Remote Desktop configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md)
- [Apple VNC access](https://support.apple.com/en-au/guide/remote-desktop/apde0dd523e/mac)
- [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)
````

- [ ] **Step 3: Rewrite `docs/verification.md`**

This replaces the 0.1.x record (which describes removed features and stays in git history at the legacy tag). It records no result that has not been produced: P1/P2/V1-V6 stay "not yet run".

````markdown
# Verification

This file is public. Evidence recorded here uses no tailnet login, device name or tailnet
IP; those stay in the owner's private handoff notes. Results for 0.1.x (the dedicated
account design) are in git history at the tag `legacy-dedicated-account`.

## Automated checks

CI runs these on Linux, Windows and macOS (`.github/workflows/build.yml`), followed by
packaging. Socket, file-mode and `set-credential` tests run on POSIX and are skipped
on Windows, because the gateway is a Linux service.

```sh
npm test          # node --test test/*.test.js
npm run check     # tsc --noEmit
npm run build     # vite build
```

- **Configuration (D3, D5)**, `test/config.test.js`: `allowedLogins` required and
  non-empty; legacy `token`, `port`, `listenHost` refused; `socketPath` absolute and at
  most 100 bytes; `devLogin` only with `http://127.0.0.1:<port>` and an allowed login;
  target and profile rules; no credentials in targets.
- **Credential store (D2)**, `test/credentials.test.js`: a missing file means none; a mode
  other than 600, a foreign owner, a symlink or malformed content is refused without
  echoing values; a rewritten file is picked up without a restart; a loosened mode
  degrades to "not ready".
- **`set-credential` (D2)**, `test/set-credential.test.js`: RDP asks for a user name, VNC
  does not; UTF-8 split across chunks survives; a confirmation mismatch or empty value
  writes nothing; no secret travels in argv; piped input is refused; the replacement is
  atomic and leaves no temp file; a wrong-mode file is left untouched.
- **Gateway (D3)**, `test/gateway.test.js`: allowed or refused login on every API route
  with the exact 403 text; static UI and health check open; Origin rules; client
  credentials refused with 400; 0.1.3 client behaviour; the target list has no address or
  secret; stored credentials are injected; tickets are bound to a login, single use and
  20 s; WebSocket Origin and identity matrix; development login.
- **Socket (D3)**, `test/listen.test.js`, `test/index.test.js`: socket 0600 in a 0700
  directory; an open directory refused; a regular file never removed; a live gateway never
  taken over; the stale socket left by SIGKILL replaced; clear refusal messages at
  startup; socket removed on SIGTERM; the development relay.
- **Operations (D7)**, `test/ops.test.js`: the generated configuration has the new schema
  and no token; the example targets are valid; the default socket is outside `/tmp` while
  the unit sets `PrivateTmp=true`.
- **Desktop shell (D4)**, `test/desktop.test.js`, `test/preload.test.js`,
  `test/address.test.js`: address validation and storage; the legacy `vault.enc` deleted;
  window security flags; bridge calls accepted only from the gateway origin in the top
  frame; address-page channels only from the local page; navigation and new-window
  blocking; an unreachable gateway lands on the address page; fullscreen and F11
  serialization; native menu states.
- **UI (D6)**, `test/browser-api.test.js`, `test/tiles.test.js`,
  `test/viewer-invariants.test.js`: same-origin requests without token or credentials;
  error classification; the bridge version gate; browser fullscreen serialization; tile
  states and labels; the cursor, overlay and in-flow toolbar rules, the palette and the
  exact screen texts.
- **Public repository (D7)**, `test/public-hygiene.test.js`: only `example.com` logins,
  placeholder tailnet names and the documented placeholder tailnet addresses appear in the
  tree.

Not covered by automation: the real Electron window, the browser rendering, real
guacd with real GNOME Remote Desktop or macOS Screen Sharing. Those are the
pre-tests and V-checks below.

## Pre-tests P1/P2 and V1–V6 (2026-10-05: not yet run)

Nothing below has been run. Each entry is filled in, with the date and the evidence, when
the owner and the operator perform it. Do not edit an entry to say "pass" without that
evidence. See `docs/redesign-spec.md` sections 3, 7 and 8 for the procedure.

- P1 (owner, 0.1.3 app and gateway). After the owner sets a new system Remote Login value
  in GNOME settings: the 0.1.3 app's `ubuntu-login` target, GDM, `gome`. To record:
  `loginctl` session ID and leader before and after (same ID and leader expected), that
  the Windows Remote Desktop session ended, and that disconnect and reconnect returns to
  the same session.
- P2 (owner, 0.1.3 app and gateway). Mac VNC password enabled; temporary Mac target. To
  record: Mac screen visible, mouse and keyboard reach it, and the 8-character limit.
- V1 (operator). UI, list and WebSocket through the new Serve port; no loopback TCP route
  to the gateway; negative test with a temporarily different `allowedLogins`
  (the real app shows the 403 screen), then restored.
- V2 (owner). Windows app, Ubuntu tile, GDM, `gome`, desktop (S1). To record: `loginctl`
  session ID and leader compared with P1.
- V3 (owner). Disconnect and reconnect keeps the windows (S4); Windows Remote Desktop and
  the app take the session from each other.
- V4 (owner). Mac tile shows and controls the Mac (S2).
- V5 (owner). Mac app repeats V2 and V4 (S5); light and dark screenshots approved (S6).
- V6 (operator). Gateway restart comes back with Serve answering; each refusal condition
  (empty `allowedLogins`, credentials file mode, open socket directory) leaves a clear
  line in the log.
````

- [ ] **Step 4: Bump the version**

```bash
npm version 0.2.0 --no-git-tag-version
```
Expected: prints `v0.2.0`; `package.json` and the two top entries of `package-lock.json` read `0.2.0`.

- [ ] **Step 5: Run the full gate**

```bash
npm test
npm run check
npm run build
```
Expected: `npm test` -> `tests 85`, `pass 85`, `fail 0`; `npm run check` prints nothing after the tsc banner; `npm run build` ends with `built in …ms`.

- [ ] **Step 6: Scan the whole tree for identifiers and leftovers**

```bash
git grep -n -i -E "vault|bearer|app://gome-remote|setup-headless|unittest" -- . ':!docs/redesign-spec.md' ':!docs/redesign-plan.md'
```
Expected: matches only in `desktop/main.cjs` (the `vault.enc` deletion), `test/desktop.test.js` (its test and the old `app://gome-remote/` origin that must be refused), `test/gateway.test.js` (the 0.1.3-client and WebSocket-origin tests name `Bearer` and `app://gome-remote` on purpose), `README.md` (one sentence about the deleted vault, and "FileVault") and `docs/verification.md` (one line). Anything else is a leftover to remove.

- [ ] **Step 7: Optional packaging check (the CI job runs it on all three OSes)**

Run: `npm run dist -- --linux` (needs the Electron and electron-builder binaries and network; skip where unavailable and say so). Expected: `release/` contains an AppImage that includes `desktop/setup.html` and `desktop/address.cjs`.

- [ ] **Step 8: Commit**

```bash
npx prettier --check README.md docs/verification.md test/public-hygiene.test.js
git add README.md docs/verification.md package.json package-lock.json test/public-hygiene.test.js
git commit -m "Document the redesign, record what is verified, and bump to 0.2.0"
```

---

## Spec Coverage and Consistency Notes

**Spec coverage.** D2 (credential file, injection, `set-credential`, "설정 필요", 400 on client credentials): Tasks 3-4. D3 (socket, login check, Origin, tickets, `devLogin`, `allowedLogins` required): Tasks 2, 4. D4 (thin window, bridge, version, origin restriction, vault removal, `vault.enc` deletion, browser-mode fallback): Tasks 6, 7. D5 (targets, `online`/`ready`): Tasks 4, 5. D6 (UI, error table, viewer behaviour): Task 7. D7 (tag, deletions, CI, README pointer, unit, example targets, `init-gateway`): Tasks 1, 5, 8. Section 7 automated list: authorization, injection, secret-free list, file mode, `set-credential` argv/atomic, bridge origin, viewer behaviour - each has a named test above. Section 7 V1-V6 and pre-tests P1/P2 are the owner's and the operator's and are recorded as "not yet run" in `docs/verification.md`. History rewrite (D7, third bullet) and O1/O2 (account lock, PR) are operational steps outside this plan.

**Placeholders.** No step relies on "TBD", "similar to Task N" or an unnamed test; every code step shows the file. The only intentionally non-automated steps (real terminal prompt, real Electron, browser screenshots, systemd verification, packaging) are marked with what to record if they cannot run.

**Type consistency.** `lookup(target)`, `credentialsFor`, `readCredentialFile(file, uid)`, `CredentialStore.load/lookup` (Task 3) are the names Tasks 4-5 use; `listenOnSocket`, `removeSocket`, `forwardLoopback`, `createGateway(config, { credentials, probe, dist, now })`, `FORBIDDEN_LOGIN_MESSAGE` (Task 4) match the tests and `server/index.js`; the `/api/targets` shape (no `address`, with `ready`) matches `src/types.d.ts`; bridge names (`fullscreen`, `fullscreenState`, `viewerState`, `onViewerAction`, `onFullscreenChange`, `openSetup`) and channel names agree between `preload.cjs`, `main.cjs`, the tests and `src/api.ts`.

**Review Focus.** Each of the five has a named test (see that section). The Korean prompt/wire path is covered by Task 3 Step 5 and Task 4 Step 5.
