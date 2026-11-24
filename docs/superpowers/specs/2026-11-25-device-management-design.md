# Add and manage devices in the app — design

Status: owner approved the direction in chat on 2026-11-25 (grade F, phase 2 of the UI rework).
Phase 1 (integrated title bar, list screen, connect → disconnect flow) is built separately on
branch `feat/titlebar-connection-flow`; this design builds its screens on top of phase 1.
Mockups: the owner's private design canvas "Gome Remote 흐름 개편 시안", boards 5–7 (기기 추가 ·
종류, 기기 추가 · Mac 연결, 기기 관리).

## 1. Why

Adding, renaming or removing a device today means editing `gateway.json` by hand on the server,
restarting the gateway, and typing the machine credential at `scripts/set-credential.mjs` in a
server terminal (README "Install the gateway" and "Operations", `scripts/init-gateway.mjs` refuses to overwrite an existing
config, `server/config.js` is read once at start in `server/index.js`). The app has no add or
manage screen at all. The owner called this flow bad (2026-11-25) and wants to add and manage
devices from the app.

## 2. Owner decisions (2026-11-25)

- O1. Devices are added and managed in the app (browser, Windows app and Mac app alike).
- O2. Machine credentials (Ubuntu system Remote Login user name + password, Mac agent token,
  Mac account for VNC) may be typed in the app. The app sends a value once to the gateway; the
  gateway stores it as today and never returns it. This amends redesign-spec D2 ("the client
  never sends, receives or stores credentials"): the client now **sends** a credential on these
  management requests only; it still never receives or stores one, and session requests still
  refuse credential fields with 400.
- O3. The Mac (VNC) target stays (the owner reversed the earlier "remove it" after hearing that
  VNC is the remote fallback when macOS asks again for Screen Recording).
- O4. Grade F for this phase.

## 3. Goals, non-goals, anti-goals

Goals
- G1. From the list: "기기 추가" → name + kind → kind-specific details → the new device appears
  in the list with its usual state (켜짐 / 꺼짐 / 설정 필요 / 권한 필요 …). No gateway restart,
  no server terminal.
- G2. From a device's menu: rename, change its address, replace its login (password or agent
  key), delete it.
- G3. The server-terminal path (`set-credential.mjs`, hand-edited `gateway.json`) keeps working.

Non-goals
- Installing the Mac agent from the app. The owner still runs the agent installer on the Mac
  (README "The Mac agent"); the app only links to that guide and takes the key it prints.
- Adding Windows targets or new VNC targets from the app (existing VNC targets can be renamed,
  re-keyed and deleted).
- Editing `publicOrigin`, `allowedLogins`, `guacdPort`, `socketPath` or `credentialsFile` from
  the app.
- Showing a stored credential, even masked, or telling whether a typed value is right before a
  connection is tried (the list state is the feedback).

Anti-goals
- A write path that lets a stored credential be sent to a host the owner did not enter it for
  (see D4).
- A second source of truth for targets: the running gateway and `gateway.json` must not drift.

## 4. Facts this rests on

- `server/index.js`: `loadConfig()` once at start; the same `config` object is handed to
  `createGateway()` and `CredentialStore` (`targets: config.targets`). `/api/targets`,
  `/api/sessions` and `/api/agent-sessions` read `config.targets` per request
  (`server/gateway.js:224-306`).
- `CredentialStore.lookup` re-reads the credential file on every request
  (`server/credentials.js:131-134`), which is why `set-credential.mjs` needs no restart.
- `scripts/set-credential.mjs:128-150` already writes the credential file atomically (temp file
  mode 600 in the same directory → fsync → rename → fsync directory).
- `server/config.js` validation: 1–100 targets, ID `[a-z0-9-]{1,64}`, allowed keys only, no
  username/password in config, hostname a Tailscale IP or 127.0.0.1, profile
  `gnome-remote-login` only for local Linux RDP with NLA and persistence; agent targets are
  `platform: mac`, Tailscale IP, port default 18471.
- Every `/api/*` route needs an allowed Tailscale login (`identify()`, header set by Tailscale
  Serve; a forged header is overwritten, redesign-spec §2) and an Origin equal to
  `publicOrigin` when an Origin is sent (`gateway.js:215-223`).
- The gateway runs as `gome`; `gateway.json` and the credential file are owned by `gome`.

## 5. Design

### D1. Management API (gateway)

All under the existing identity and Origin checks. Write requests additionally **require** an
Origin header equal to `publicOrigin` (a request with no Origin is refused), a JSON body under
a small fixed size, and never log their bodies.

| Request | Effect | Reply |
|---|---|---|
| `GET /api/targets` | as today, plus `hostname` and `port` for each target (not secret) | list |
| `POST /api/targets` `{name, kind, hostname, credential?}` | add a target (D2), then store `credential` if given (D3) | the new target |
| `PATCH /api/targets/:id` `{name?, hostname?}` | rename and/or change address; an address change deletes the stored credential (D4) | the target |
| `PUT /api/targets/:id/credential` `{username, password}` or `{agentToken}` | replace the stored credential (write-only) | 204 |
| `DELETE /api/targets/:id` | delete the stored credential, then the target | 204 |

`kind` is `mac-agent` or `linux-rdp`:
- `mac-agent` → `{platform: "mac", protocol: "agent", hostname: <Tailscale IP>}` (default port).
- `linux-rdp` with hostname `127.0.0.1` → the existing GNOME Remote Login shape
  (`profile: "gnome-remote-login"`, port 3389, `security: "nla"`, `ignoreCertificate: true`,
  `persistent: true`); with a Tailscale IP → `{platform: "linux", protocol: "rdp", port: 3389,
  ignoreCertificate: true}` (builder may adjust these defaults; the address is the only input).

Errors come back as a short Korean message the dialog can show next to the field (bad address,
name too long, last target, file problem).

Deleting the last target is refused (409): the config schema requires at least one target and
the gateway would not start again with none.

### D2. Target writes go through `gateway.json`

One in-process write queue serializes every management write. For each write the gateway:
1. reads `gateway.json` from disk again (so hand edits to other keys, and to targets, made while
   it runs are kept),
2. applies the one operation to the file's `targets`,
3. validates the whole result with the existing `validateConfig`,
4. copies the current file to `gateway.json.prev`, then writes the new file atomically (same
   temp → fsync → rename → fsync directory routine as the credential file, moved from
   `set-credential.mjs` into a shared server module),
5. only then replaces the in-memory `config.targets` contents with the validated result.

If any step fails the in-memory list is unchanged and the request fails. The gateway needs the
config path (today only `index.js` knows it); `createGateway` receives it.

New target IDs are generated (`t-` + 8 random hex characters); existing IDs never change, so
stored credentials and session code keep working. The ID is never shown.

### D3. Credential writes (the D2 amendment)

`PUT …/credential` and the optional `credential` of `POST /api/targets` use the same atomic
writer and the same entry rules as `set-credential.mjs` (RDP: user name + password, both
required; agent: `agentToken` matching `^[A-Za-z0-9_-]{43}$`; VNC: optional user name +
password). The value is written for that target ID only; nothing returns it. The client clears
its input fields after the request, success or not, and never keeps the value in storage.

An add is two writes (config, then credential). If the credential write fails after the target
was added, the target stays and shows "설정 필요"; the dialog says the login was not saved and
the owner re-enters it from the device page. Delete removes the credential first; if the target
removal then fails, the target shows "설정 필요" and the delete can be retried.

### D4. A changed address drops the stored login

`PATCH` with a different `hostname` (or a different port, if the builder exposes it) deletes the
target's stored credential in the same write sequence, and the device shows "설정 필요" until a
new login is entered. Reason: otherwise one request could point a target that holds the Ubuntu
Remote Login password or a Mac agent token at another tailnet host, and the gateway would send
that secret there on the next connection. The device page says so before saving an address
change.

### D5. App screens (on top of phase 1)

- List header: "기기 추가" next to the settings button; each row gets a "⋯" button
  (aria-label "<name> 관리") that opens the device page.
- Add dialog, step 1: 이름 + 종류 (Ubuntu / Linux · Mac). Step 2:
  - Mac: Mac의 Tailscale 주소, a link to the agent install guide in the README, 연결 키 (the
    43-character key the installer prints once).
  - Ubuntu / Linux: 주소 ("이 서버" preset = 127.0.0.1, or a Tailscale IP), 사용자 이름, 비밀번호
    (the system Remote Login values, not the desktop account password; the field help says so).
  - 추가 → list refreshes; the new row shows its state.
- Device page: 이름 (editable), 종류 (read only), 주소 (editable, with the D4 warning), 로그인
  정보 "바꾸기" (dialog with the kind's fields), 기기 삭제 (confirmation dialog; says the device
  itself is not touched).
- All three modes (browser, Windows app, Mac app) get the same screens; the desktop app needs
  no change beyond the page.

### D6. Rollout and rollback

- Gateway only: new candidate directory under `~/remote-candidates/<version>`, point
  `gome-remote-gateway-v3.service` at it, restart (same procedure as the 0.3.x releases). No
  desktop release is needed for phase 2 itself (the page is served by the gateway).
- The file formats do not change: `gateway.json` written by the new gateway is valid for the
  previous gateway, and the credential file is unchanged, so rollback = point the unit back and
  restart. `gateway.json.prev` holds the file as it was before the last app write.
- Before the first deploy, copy the production `gateway.json` aside (the credential file is not
  backed up, as today; losing it means re-entering values).

### D7. Docs

README "Install the gateway", "The Mac agent", "Using it" and "Operations" (both paths: app and terminal), redesign-spec D2 (pointer to
this amendment), mac-agent-spec where it repeats D2's input method.

## 6. Known risks left unguarded

- Any device signed in to the owner's Tailscale login can now also add, re-point and delete
  targets and overwrite credentials (it could already open sessions on all of them; D4 keeps it
  from redirecting a stored secret). Losing a device is handled as today: remove it from the
  tailnet.
- A hand edit of `gateway.json` that lands between the gateway's read and rename (D2 step 1–4)
  is lost. Single owner; not guarded.
- No undo for delete beyond `gateway.json.prev` (one step) and re-entering the login.

## 7. Verification

- Unit tests only for the branching pure logic: applying add/rename/re-address/delete to a
  targets list (incl. kind → target shape, last-target refusal, D4 clearing), and the write
  routes refusing a missing Origin. Existing credential and config tests keep guarding the
  formats.
- Local end-to-end with a temporary config in development-login mode: add a Mac-agent and a
  Linux target, rename, change an address (login cleared → 설정 필요), replace a login, delete;
  check `gateway.json`, `gateway.json.prev` and the credential file after each step (values not
  printed), and restart the gateway on the written file.
- After deploy: the owner renames one device and changes it back from the Windows app.

## 8. Left to the builder

Exact request/response field names beyond the table, error wording, body size limit, whether
port is editable, dialog layout details within the mockups, and how the list refreshes after a
write.
