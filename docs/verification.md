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
- **`set-credential` (D2)**, `test/set-credential.test.js`: RDP and VNC targets prompt for
  a user name and a password (an empty VNC user name stores the password only, and the
  8-character note applies to a password without a user name); UTF-8 split across chunks
  survives; a confirmation mismatch, empty value or early EOF writes nothing; no secret
  travels in argv; the configuration path is the first argument, or comes from
  `GOME_REMOTE_CONFIG` or the default location when only the target ID is given; piped
  input is refused; the replacement is atomic and leaves no temporary file; a wrong-mode
  file is left untouched.
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
- **Public repository (D7)**, `test/public-hygiene.test.js`: scans the files tracked by git
  (`git ls-files`) and rejects any email other than `example.com` or `noreply`, any
  `*.ts.net` tailnet name other than the placeholders, any tailnet (CGNAT range) address
  other than the documented placeholders, and any `/home/<name>/` other than `/home/user`.
  A positive control proves the scanner flags a planted value.

Not covered by automation: the real Electron window, the browser rendering, real
guacd with real GNOME Remote Desktop or macOS Screen Sharing. Those are the
pre-tests and V-checks below.

## Pre-tests (spec section 3)

- **P1, passed 2026-10-05.** With the 0.1.3 app and gateway: the app path (guacd to the
  system GNOME Remote Desktop on loopback), then GDM, then the existing `gome` session. The
  `loginctl` session ID and leader were the same as before the test, and no new session was
  created. The owner confirmed that the open windows were as left, and that disconnecting
  and reconnecting kept them. The Windows Remote Desktop connection was handed over.
- **P2, finding recorded 2026-10-05.** The Mac offers Apple Remote Desktop authentication
  (RFB security type 30) first, even with the separate VNC password option on, and guacd 1.6.0
  selects the first supported type from the server's list. Measured with a loopback fake RFB
  server that offers the same list. A password alone therefore does not authenticate: the
  Mac needs the macOS account name and password, which is what the `mac` target stores.
  The VNC password option is not needed.

## Pending: Mac account authentication and V1–V6 (not yet run)

Nothing below has been run and no result is recorded. Each entry is filled in, with the
date and the evidence, when the owner and the operator perform it. Do not edit an entry to
say "pass" without that evidence. See `docs/redesign-spec.md` sections 3, 7 and 8 for the
procedure.

- Mac account authentication (spec section 3). Whether guacd opens the real Mac screen
  with the account name and password has not been tested; it is checked as part of V4. If
  it fails, the Mac leaves the scope and the owner decides.
- V1 (operator). UI, list and WebSocket through the new Serve port; no loopback TCP route
  to the gateway; negative test with a temporarily different `allowedLogins`
  (the real app shows the 403 screen), then restored.
- V2 (owner). Windows app, Ubuntu tile, GDM, `gome`, desktop (S1). To record: `loginctl`
  session ID and leader compared with P1.
- V3 (owner). Disconnect and reconnect keeps the windows (S4); Windows Remote Desktop and
  the app take the session from each other.
- V4 (owner). Mac tile shows and controls the Mac with the stored account credentials (S2).
- V5 (owner). Mac app repeats V2 and V4 (S5); light and dark screenshots approved (S6).
- V6 (operator). Gateway restart comes back with Serve answering; each refusal condition
  (empty `allowedLogins`, credentials file mode, open socket directory) leaves a clear
  line in the log.
