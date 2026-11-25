# Device management in the app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add, rename, re-key and delete devices from the app; the gateway writes `gateway.json` and the credential file itself, with no restart and no server terminal.

**Architecture:** Pure target-list logic in a new `server/targets.js`; one write coordinator `server/manage.js` (queue, re-read file, validate, `.prev`, atomic write, in-memory swap, credential writes); four new routes in `server/gateway.js`; screens in the client on top of phase 1.

**Tech Stack:** Node (ESM, `node --test`), TypeScript client built by Vite, Electron shell unchanged.

**Spec:** `docs/superpowers/specs/2026-11-25-device-management-design.md` (rev 2). Read it first; this plan does not repeat its reasons.

## Global Constraints

- Kinds: `mac-agent` (needs `hostname`, a Tailscale IP) and `ubuntu-local` (no hostname; target shape `{platform:"linux", protocol:"rdp", profile:"gnome-remote-login", hostname:"127.0.0.1", port:3389, security:"nla", ignoreCertificate:true, persistent:true}`), the latter only while no `gnome-remote-login` target exists — enforced by the server.
- No request sets or changes a hostname or port of an existing target. PATCH takes `{name}` only.
- New IDs: `t-` + 8 lowercase hex, never equal to an ID in the config or the credential file.
- Write routes require `Origin === publicOrigin` (missing Origin → 403) on top of the existing login check; JSON bodies only (415 otherwise); bodies and credential values are never logged or returned.
- Credential rules (same as `scripts/set-credential.mjs`): agent `agentToken` matches `^[A-Za-z0-9_-]{43}$`; RDP `username` required, ≤256 chars, `password` 1–1024 chars; VNC `username` optional (≤256), `password` 1–1024.
- Delete removes the credential entry first, then the target. Deleting the last target → 409 "마지막 기기는 지울 수 없습니다."
- A failed file write → 500 "서버에 저장하지 못했습니다." plus one log line. Every management write logs one line: `manage <action> <targetId> by <login>: ok|failed at <step>`.
- Session routes keep refusing credential fields with 400 (unchanged).
- Public repo: no owner identifiers (tailnet login, real device names, tailnet IPs) in code, tests or docs; tests use the documented placeholder addresses `100.64.0.10` and `100.64.0.20` (test/public-hygiene.test.js allows only those and a few range-edge probes) and placeholder names.
- Test scope: only the pure logic and the security-relevant write sequence named in the tasks; no tests for markup, CSS or UI wiring.

## Review Focus

1. Two management writes arriving together (double-click on 추가) → both are serialized; neither loses the other's change. Test in Task 3.
2. `gateway.json` edited by hand while the gateway runs (other keys, or a target added by hand) → an app write keeps those edits. Test in Task 3.
3. Credential file damaged (bad mode/JSON) when re-keying or deleting → request fails with 500, config and file untouched, one log line. Test in Task 3.
4. `ubuntu-local` requested while a `gnome-remote-login` target exists → 409 from the server even if the client offered it. Test in Task 1.
5. A credential body of the wrong shape for the target (token for an RDP target, username/password for an agent) or extra fields → 400, nothing written. Test in Task 2.

---

### Task 1: Target-list logic (`server/targets.js`)

**Files:**
- Create: `server/targets.js`
- Test: `test/targets.test.js`

**Interfaces:**
- Produces:
  - `class ManageError extends Error { constructor(status: number, message: string) }` — `status` is the HTTP status, `message` the Korean text shown in the dialog.
  - `targetForKind(kind: "mac-agent"|"ubuntu-local", input: {name: string, hostname?: string}, id: string) -> object` (a config target; trims `name`).
  - `newTargetId(taken: Set<string>, random = (n) => randomBytes(n)) -> string`.
  - `applyTargetOp(targets: object[], op) -> object[]` where `op` is `{type:"add", target}` | `{type:"rename", id, name}` | `{type:"delete", id}`; returns a new array of new objects; throws `ManageError(404, "기기를 찾을 수 없습니다.")`, `ManageError(409, "마지막 기기는 지울 수 없습니다.")`, `ManageError(409, "이 서버는 이미 목록에 있습니다.")` (ubuntu-local while a gnome-remote-login target exists), `ManageError(400, …)` for an unknown kind.
  - `koreanConfigError(error: Error) -> ManageError(400, …)` mapping `validateConfig` messages: "Invalid target name." → "이름은 1-100자로 입력하세요."; "An agent target must use the Mac's Tailscale IP." and "Targets must use a Tailscale IP or loopback." → "Mac의 Tailscale 주소(100.x.y.z)를 입력하세요."; "Configure 1–100 targets." → "기기는 100대까지 둘 수 있습니다."; anything else → "입력값을 확인하세요."

- [ ] **Step 1: Write failing tests** in `test/targets.test.js`:
  - `targetForKind("ubuntu-local", {name:" 서버 "}, "t-00000001")` deep-equals the exact shape in Global Constraints with `name:"서버"`, `id:"t-00000001"`.
  - `targetForKind("mac-agent", {name:"Mac", hostname:"100.64.0.10"}, id)` → `{id, name:"Mac", platform:"mac", protocol:"agent", hostname:"100.64.0.10"}` (no port key; the default applies).
  - `newTargetId(new Set(["t-aaaaaaaa"]), stub)` where the stub returns bytes for `aaaaaaaa` first, then `bbbbbbbb` → `"t-bbbbbbbb"`.
  - `applyTargetOp` add of ubuntu-local onto a list holding a gnome-remote-login target throws status 409; delete of the only target throws 409; rename of an unknown id throws 404; rename returns new objects (`!==` the input objects) with the input array unchanged.
  - `koreanConfigError(new Error("Invalid target name."))` → status 400 with the mapped text.
- [ ] **Step 2: Run** `node --test test/targets.test.js` — expected FAIL (module missing).
- [ ] **Step 3: Implement** `server/targets.js` with the interfaces above.
- [ ] **Step 4: Run** `node --test test/targets.test.js` — expected PASS.
- [ ] **Step 5: Commit** `feat(gateway): target list operations for in-app device management`.

### Task 2: Shared atomic writer and credential entries

**Files:**
- Create: `server/atomic-file.js`
- Modify: `server/credentials.js` (add `credentialEntry`, `writeCredentialFile`, `CredentialStore#setTargets`), `scripts/set-credential.mjs:115-156` (import the moved writer; keep `export { writeCredentialFile }` so `test/set-credential-agent.test.js` imports keep working)
- Test: `test/credentials.test.js` (add cases)

**Interfaces:**
- Produces:
  - `writeFileAtomic(file: string, body: string, mode: number) -> Promise<void>` (temp in same dir with `wx` + mode → fsync → rename → fsync directory; temp removed on failure) and `syncDirectory(dir)`, moved from `set-credential.mjs`.
  - `writeCredentialFile(file, entries: Map) -> Promise<void>` in `server/credentials.js` (mode 0o600, same body format as today).
  - `credentialEntry(target, input: object) -> object` — validates per Global Constraints against `target.protocol`; returns `{agentToken}` or `{username?, password}`; throws `ManageError(400, …)` for a wrong shape, extra keys, or bad lengths (messages reuse the Korean texts of `set-credential.mjs`).
  - `CredentialStore#setTargets(targets: object[])` — rebuilds `this.protocols`.
- Consumes: `ManageError` (Task 1).

- [ ] **Step 1: Write failing tests**: `credentialEntry` accepts a 43-char token for an agent target and returns `{agentToken}`; rejects `{username,password}` for an agent target, `{agentToken}` for an RDP target, an RDP body without username, a password of 1025 chars, and a body with an extra key — each with status 400. `setTargets` then `load()` applies the new protocol map (an entry shape that fits only the new protocol loads).
- [ ] **Step 2: Run** `node --test test/credentials.test.js test/set-credential.test.js test/set-credential-agent.test.js` — new cases FAIL, existing pass.
- [ ] **Step 3: Implement** the move and the new functions.
- [ ] **Step 4: Run** the same command — all PASS.
- [ ] **Step 5: Commit** `refactor(credentials): shared atomic writer and entry validation`.

### Task 3: Write coordinator (`server/manage.js`)

**Files:**
- Create: `server/manage.js`
- Test: `test/manage.test.js` (temp directory with a real `gateway.json` and credential file; uid = `process.getuid()`)

**Interfaces:**
- Consumes: Tasks 1–2, `validateConfig` (`server/config.js`), `readCredentialFile`.
- Produces: `createManager({configPath, config, credentials, log = console.error, random}) -> { add(login, {name, kind, hostname?, credential?}) -> target, rename(login, id, name) -> target, setCredential(login, id, input) -> void, remove(login, id) -> void }`.
  - One promise-chain queue: every method runs after the previous one settles.
  - Target writes (add/rename/remove): read `configPath` raw JSON → `applyTargetOp` on its `targets` → `validateConfig({...raw, targets})` (map errors with `koreanConfigError`) → copy current file to `<configPath>.prev` (mode preserved) → `writeFileAtomic(configPath, JSON.stringify({...raw, targets}, null, 2)+"\n", currentMode)` → `config.targets = validated.targets` → `credentials.setTargets(config.targets)`.
  - `add`: ID from `newTargetId` over config IDs ∪ credential-file IDs; target write; then, if `credential` given, credential write; a failed credential write leaves the target and throws `ManageError(500, "기기는 추가했지만 로그인 정보를 저장하지 못했습니다. 기기 관리에서 다시 입력하세요.")`.
  - `setCredential`: read entries with the protocol map minus this target (as `set-credential.mjs:243-250`), set `credentialEntry(target, input)`, write.
  - `remove`: delete the credential entry (write only if it existed), then the target write.
  - File/OS errors become `ManageError(500, "서버에 저장하지 못했습니다.")`; every call logs one line `manage <action> <id> by <login>: ok` or `…: failed at <config|credential> (<error.code or message>)`, never values.

- [ ] **Step 1: Write failing tests**:
  - add mac-agent with a credential → `gateway.json` has the new target, `gateway.json.prev` equals the previous file, the credential file has `{agentToken}` for the new ID with mode 600, `config.targets` includes it.
  - two `add` calls started without awaiting the first → both targets present in the file afterwards (Review Focus 1).
  - a key added to `gateway.json` by hand after the manager was created (e.g. a second target written directly to the file) survives a following `rename` (Review Focus 2).
  - credential file chmod 644 before `setCredential` and before `remove` → rejects with status 500, `gateway.json` byte-identical, one log line containing `failed at credential` and not containing the token (Review Focus 3).
  - `remove` deletes the credential entry and the target; `remove` of the last target rejects 409 and changes nothing.
- [ ] **Step 2: Run** `node --test test/manage.test.js` — FAIL.
- [ ] **Step 3: Implement** `server/manage.js`.
- [ ] **Step 4: Run** `node --test test/manage.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(gateway): serialized writes of gateway.json and credentials`.

### Task 4: Routes and wiring

**Files:**
- Modify: `server/gateway.js` (`createGateway` options gain `manager`; routes inside the `/api/` block; GET `/api/targets` items gain `hostname`; the final catch keeps 400 for parse errors but `ManageError` maps to its status), `server/index.js` (create the manager with `GOME_REMOTE_CONFIG` path and pass it)
- Test: `test/gateway.test.js` (add cases, using a stub manager)

**Interfaces:**
- Consumes: `createManager` (Task 3), `ManageError` (Task 1).
- Produces (HTTP): `POST /api/targets` → 201 `{target}`; `PATCH /api/targets/:id` `{name}` → 200 `{target}`; `PUT /api/targets/:id/credential` → 204; `DELETE /api/targets/:id` → 204; errors → `{error: <Korean message>}` with the `ManageError` status. `target` in replies is the same public shape as a GET item (no credential fields).

- [ ] **Step 1: Write failing tests**: each write route without an Origin header → 403 and the stub manager not called; with a foreign Origin → 403; with `Origin: publicOrigin` → the stub is called with the login and parsed body; a stub throwing `ManageError(409, "x")` → 409 `{error:"x"}`; a non-JSON content type → 415; GET items include `hostname`; a PATCH body with `hostname` → 400 and the stub not called.
- [ ] **Step 2: Run** `node --test test/gateway.test.js` — new cases FAIL.
- [ ] **Step 3: Implement** the routes (path match `^/api/targets/([a-z0-9-]{1,64})(/credential)?$`), reuse `body(req)` (8192 limit) and the 415 rule of `/api/sessions`.
- [ ] **Step 4: Run** `npm test` and `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(gateway): management routes for devices`.

### Task 5: Screens (on top of phase 1)

Precondition: phase 1 (`feat/titlebar-connection-flow`) is merged or this branch is rebased onto it.

**Files:**
- Modify: `src/api.ts` (four calls: `addTarget`, `renameTarget`, `setCredential`, `deleteTarget`, each `fetch` with JSON and returning the parsed reply or throwing `ApiError` with the server's `error` text), `src/types.d.ts` (`hostname` on `Target`), `src/main.ts`, `src/style.css`
- No new tests (UI wiring); `npm run check` and the e2e of Task 7 verify it.

**Interfaces:**
- Consumes: Task 4 HTTP API; phase 1 list rows and settings button.

- [ ] **Step 1:** List header gets "기기 추가"; each row a "⋯" button (`aria-label="<name> 관리"`) opening the device page. Look and copy per mockup boards 5–7 (`AddDevice`, `AddMac`, `DeviceSettings`), except: the Mac step shows no connection-check line; the device page shows 종류 and 주소 read only with the help text "주소가 바뀌었으면 기기를 지우고 다시 추가하세요."
- [ ] **Step 2:** Add dialog: step 1 이름 + 종류 (Mac; Ubuntu only when no target has `profile === "gnome-remote-login"`); step 2 Mac: 주소, 설치 안내 link (README "The Mac agent" on GitHub), 연결 키 (`type=password`); Ubuntu: 사용자 이름, 비밀번호 with help "시스템 원격 로그인 값입니다(데스크톱 계정 비밀번호가 아닙니다)." Server errors show under the dialog's fields; secret inputs are cleared after every request.
- [ ] **Step 3:** Device page: 이름 (save via PATCH), 로그인 정보 "바꾸기" dialog (kind's fields), 기기 삭제 with a confirmation dialog "목록과 저장된 로그인 정보를 지웁니다. 기기 자체는 건드리지 않습니다."; after any write, refresh the list.
- [ ] **Step 4:** `npm run check && npm run build` — PASS.
- [ ] **Step 5: Commit** `feat(client): add and manage devices`.

### Task 6: Docs

**Files:** `README.md` ("Install the gateway", "The Mac agent", "Using it", "Operations"), `docs/redesign-spec.md` (D2: one-line pointer to the amendment), `docs/mac-agent-spec.md` (where it repeats D2's input method), the spec's status line (implemented on branch …).

- [ ] **Step 1:** Describe both paths (app and terminal), the write-only rule, `gateway.json.prev`, and that an address change is delete + add.
- [ ] **Step 2:** `npm test` (public-hygiene) — PASS. Commit `docs: in-app device management`.

### Task 7: Local end-to-end (visual-worker)

- [ ] **Step 1:** Temp dir with a production-shaped `gateway.json` (same keys and target kinds as production, placeholder names/IPs, `publicOrigin` loopback + `devLogin`) and a credential file of the same shapes with dummy values (mode 600). Start `npm run gateway` with `GOME_REMOTE_CONFIG` pointing at it and `npm run dev` or a build.
- [ ] **Step 2:** In the browser: add a Mac-agent device with a dummy 43-char key → row shows (오프라인 is fine); rename it; replace its key; delete it; delete the Ubuntu target and add it back. After each step check `gateway.json`, `gateway.json.prev` and the credential file (`jq 'keys'`-style checks, never print values) and that untouched entries are byte-identical.
- [ ] **Step 3:** Restart the gateway on the written files — starts cleanly. Screenshots of the add dialog (both kinds), device page, delete confirmation, an inline error.
