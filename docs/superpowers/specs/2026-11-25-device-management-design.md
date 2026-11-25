# Add and manage devices in the app — design

Status: Implemented on branch feat/device-management (not yet merged or deployed). Owner approved the direction in chat on 2026-11-25 (grade F, phase 2 of the UI rework).
Revision 2 (after design review round 1): addresses are no longer editable (a changed address
is delete + add), remote Linux hosts are out of scope, writes are logged.
Phase 1 (integrated title bar, list screen, connect → disconnect flow) is built separately on
branch `feat/titlebar-connection-flow`; this design builds its screens on top of phase 1.
Mockups: the owner's private design canvas "Gome Remote 흐름 개편 시안", boards 5–7 (기기 추가 ·
종류, 기기 추가 · Mac 연결, 기기 관리).

## 1. Why

Adding, renaming or removing a device today means editing `gateway.json` by hand on the server,
restarting the gateway, and typing the machine credential at `scripts/set-credential.mjs` in a
server terminal (README "Install the gateway" and "Operations"; `scripts/init-gateway.mjs`
refuses to overwrite an existing config; `server/config.js` is read once at start in
`server/index.js`). The app has no add or manage screen at all. The owner called this flow bad
(2026-11-25) and wants to add and manage devices from the app.

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
- G2. From a device's menu: rename, replace its login (password or agent key), delete it.
- G3. The server-terminal path (`set-credential.mjs`, hand-edited `gateway.json`) keeps working.

Non-goals
- Changing a device's address in the app. A device whose address changed is deleted and added
  again (for a Mac this coincides with re-running the agent installer, which records the Mac
  and gateway addresses once in its `agent.json`, README "The Mac agent").
- Installing the Mac agent from the app. The owner still runs the agent installer on the Mac;
  the app only links to that guide and takes the key it prints.
- Adding remote Linux hosts, Windows targets or new VNC targets from the app. Existing targets
  of every kind (incl. VNC) can be renamed, re-keyed and deleted.
- Editing `publicOrigin`, `allowedLogins`, `guacdPort`, `socketPath` or `credentialsFile` from
  the app.
- Showing a stored credential, even masked, or telling whether a typed value is right before a
  connection is tried (the list state is the feedback).

Anti-goals
- A stored credential ever being sent to a host other than the one it was entered for.
- A second source of truth for targets: the running gateway and `gateway.json` must not drift.

## 4. Facts this rests on

- `server/index.js:7-10`: `loadConfig()` once at start; the `config` object goes to
  `createGateway()`; `CredentialStore` is built from `config.targets` and derives its
  protocol map once in its constructor (`server/credentials.js:164-166`).
- `/api/targets`, `/api/sessions` and `/api/agent-sessions` read `config.targets` per request
  (`server/gateway.js:224-306`); `CredentialStore.lookup` re-reads the credential file on every
  request (`credentials.js:170-173`), which is why `set-credential.mjs` needs no restart.
- `scripts/set-credential.mjs:128-156` writes the credential file atomically (temp file mode
  600 in the same directory → fsync → rename → fsync directory).
- `server/config.js`: 1–100 targets, ID `[a-z0-9-]{1,64}`, allowed keys only, no
  username/password in config, hostname a Tailscale IP or 127.0.0.1, profile
  `gnome-remote-login` only for 127.0.0.1 RDP with NLA and persistence; agent targets are
  `platform: mac`, Tailscale IP, port default 18471.
- Every `/api/*` route needs an allowed Tailscale login (`identify()`, header set by Tailscale
  Serve; a forged header is overwritten, redesign-spec §2) and an Origin equal to
  `publicOrigin` when an Origin is sent (`gateway.js:215-223`). Production `allowedLogins` has
  exactly one login (the owner's).
- Production: `gome-remote-gateway-v3.service` runs code from `~/remote-candidates/<version>`
  with `GOME_REMOTE_CONFIG=~/.config/gome-remote-v3/gateway.json` and
  `credentialsFile: ~/.config/gome-remote-v3/credentials.json`; both files live outside the code
  directory and are shared by every version. The unit has no write restrictions on them.
- The system GNOME Remote Desktop listens on `*:3389` and the owner's Windows Remote Desktop
  reaches it over the tailnet directly (redesign-spec §2); the owner's tailnet devices are
  untagged (redesign-spec §2).

## 5. Design

### D1. Management API (gateway)

All under the existing identity and Origin checks. Write requests additionally **require** an
Origin header equal to `publicOrigin` (a request with no Origin is refused), take a JSON body
under a small fixed size, and never log their bodies.

| Request | Effect | Reply |
|---|---|---|
| `GET /api/targets` | as today, plus `hostname` for each target (not secret) | list |
| `POST /api/targets` `{name, kind, hostname?, credential?}` | add a target (D2), then store `credential` if given (D3) | the new target |
| `PATCH /api/targets/:id` `{name}` | rename | the target |
| `PUT /api/targets/:id/credential` `{username, password}` or `{agentToken}` | replace the stored credential (write-only) | 204 |
| `DELETE /api/targets/:id` | delete the stored credential, then the target | 204 |

`kind` is one of:
- `mac-agent` + `hostname` (a Tailscale IP) → `{platform: "mac", protocol: "agent", hostname}`
  (default port).
- `ubuntu-local` (no hostname) → the existing GNOME Remote Login shape: `{platform: "linux",
  protocol: "rdp", profile: "gnome-remote-login", hostname: "127.0.0.1", port: 3389,
  security: "nla", ignoreCertificate: true, persistent: true}`. Offered only while no
  `gnome-remote-login` target exists (in practice: after that target was deleted).

No request can set or change a hostname or port of an existing target, so a stored credential
always stays with the host it was entered for.

Errors come back as a short Korean message the dialog can show next to the field (bad address,
name too long, last target, could not save). Validation messages from `validateConfig` are
mapped to Korean, not passed through.

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
   `set-credential.mjs` into a shared server module), writing the file's own content with the
   one change, not the defaults `validateConfig` fills in,
5. only then swaps the in-memory target list for the validated result (new target objects, never
   edited in place) and refreshes the credential store's protocol map from it.

If any step fails the in-memory list is unchanged and the request fails. The gateway needs the
config path (today only `index.js` knows it); `createGateway` receives it.

New target IDs are generated (`t-` + 8 random hex characters), never equal to an ID present in
the config or the credential file; existing IDs never change, so stored credentials and session
code keep working. The ID is never shown.

### D3. Credential writes (the D2 amendment)

`PUT …/credential` and the optional `credential` of `POST /api/targets` use the same atomic
writer and the same entry rules as `set-credential.mjs`, checked against the target's protocol
at request time (RDP: user name + password, both required; agent: `agentToken` matching
`^[A-Za-z0-9_-]{43}$`; VNC: optional user name + password). The value is written for that
target ID only; nothing returns it. The client clears its input fields after the request,
success or not, and never keeps the value in storage.

An add is two writes (config, then credential). If the credential write fails after the target
was added, the target stays and shows "설정 필요"; the dialog says the login was not saved and
the owner re-enters it from the device page. Delete removes the credential first; if the target
removal then fails, the target shows "설정 필요" and the delete can be retried.

### D4. Logging

Each management write logs one line: login, action (add / rename / credential / delete),
target ID, and the step that failed if any. Never a credential value, never a request body. A failed file write returns 500 with "서버에 저장하지 못했습니다" instead of falling into
the generic 400 handler (`gateway.js:374-380`).

### D5. App screens (on top of phase 1)

- List header: "기기 추가" next to the settings button; each row gets a "⋯" button
  (aria-label "<name> 관리") that opens the device page.
- Add dialog, step 1: 이름 + 종류 (Mac · Ubuntu, the latter only while D1 offers it). Step 2:
  - Mac: Mac의 Tailscale 주소, a link to the agent install guide in the README, 연결 키 (the
    43-character key the installer prints once).
  - Ubuntu: 사용자 이름, 비밀번호 (the system Remote Login values, not the desktop account
    password; the field help says so).
  - 추가 → list refreshes; the new row shows its state.
- Device page: 이름 (editable), 종류 and 주소 (read only; the help says a changed address means
  deleting and adding the device again), 로그인 정보 "바꾸기" (dialog with the kind's fields),
  기기 삭제 (confirmation dialog; says the device itself is not touched).
- All three modes (browser, Windows app, Mac app) get the same screens; the desktop app needs
  no change beyond the page.

### D6. Rollout and rollback

- Gateway only: new candidate directory under `~/remote-candidates/<version>`, point
  `gome-remote-gateway-v3.service` at it, restart (same procedure as the 0.3.x releases). No
  desktop release is needed for phase 2 itself (the page is served by the gateway).
- Before the first deploy, copy `gateway.json` and `credentials.json` aside (mode 600, values
  never printed).
- The file formats do not change and both files are shared by every code version (§4), so
  rollback = point the unit back and restart, and devices added in the app stay.
  `gateway.json.prev` holds the file as it was before the last app write.

### D7. Docs

README "Install the gateway", "The Mac agent", "Using it" and "Operations" (both paths: app and
terminal), redesign-spec D2 (pointer to this amendment), mac-agent-spec where it repeats D2's
input method.

## 6. Known risks left unguarded

- Every allowed login can now add, rename and delete targets and overwrite credentials. In
  production that is one login, the owner's, on all of their tailnet devices. What this adds
  over today: a device could add the Ubuntu preset (only while none exists) or a Mac-agent
  target with credentials it supplies. Both reach hosts that device can already reach directly
  (GRD on `*:3389` over the tailnet; the Mac agent only answers the gateway, but that device can
  already open the existing Mac target). A stored credential cannot be moved to another host
  (no address edits, new IDs never reuse a credential entry). Losing a device is handled as
  today: remove it from the tailnet. If more logins are ever added to `allowedLogins`, they get
  these rights too.
- A hand edit of `gateway.json` that lands between the gateway's read and rename (D2 steps 1–4)
  is lost; so is a `set-credential.mjs` run that overlaps an app credential write (both rewrite
  the whole file). Single owner; not guarded.
- No undo for delete or for an overwritten login beyond `gateway.json.prev` (one step) and
  re-entering the value: a Mac key is still in the Mac's token file (README "The Mac agent"),
  the Ubuntu Remote Login values come from `grdctl --system status --show-credentials` on the
  server (owner only).

## 7. Verification

- Unit tests only for the branching pure logic: applying add/rename/delete to a targets list
  (kind → target shape, Ubuntu preset offered only without one, generated ID never reusing a
  config or credential ID, last-target refusal), and the write routes refusing a missing Origin.
  Existing credential and config tests keep guarding the formats.
- Local end-to-end with development-login mode on a production-shaped copy of `gateway.json`
  and a credential file of the same shapes with dummy values: add a Mac-agent target, rename it,
  replace its login, delete it; delete the Ubuntu target and add it back; check `gateway.json`,
  `gateway.json.prev` and the credential file after each step (values not printed) and that the
  untouched entries are unchanged; restart the gateway on the written files.
- After deploy (owner, first session after the deploy): add the existing Mac a second time as
  a new device with the key from its token file, connect to it, then delete it; the original
  Mac target and its login stay untouched.

## 8. Left to the builder

Exact request/response field names beyond the table, error wording, body size limit, dialog
layout details within the mockups, and how the list refreshes after a write.
