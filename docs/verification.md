# Verification

This file is public. Evidence recorded here uses no tailnet login, device name or tailnet
IP; those stay in the owner's private handoff notes. Results for 0.1.x (the dedicated
account design) are in git history at the tag `legacy-dedicated-account`. The
implementation plan that preceded this tree was removed from it; it is in git history at
commit `529fe56`. The specification, `docs/redesign-spec.md`, and the README are the
documents.

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
  input is refused; on a fake terminal, raw mode wraps only the password and confirmation
  prompts and is always restored, backspace deletes, arrow-key escape sequences are
  ignored, and Ctrl-C and Ctrl-D cancel without writing; the 1024 and 256 character
  limits and the 8-character note are tested on both sides of the boundary; the replacement is atomic and leaves no temporary file; a wrong-mode
  file is left untouched.
- **Gateway (D3)**, `test/gateway.test.js`: allowed or refused login on every API route
  with the exact 403 text; static UI and health check open; Origin rules; client
  credentials refused with 400; 0.1.3 client behaviour; the target list has no address or
  secret; stored credentials are injected; tickets are bound to a login, single use and
  20 s (valid one millisecond before expiry); session sizes accepted at 640x480 and
  3840x2160 and refused one pixel beyond; a guacd `error` at the `select` or `connect`
  step reaches the browser, ends the tunnel, is dialed exactly once and spends the ticket
  (the fixture fails like a real guacd); WebSocket Origin and identity matrix;
  development login.
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
  blocking; an unreachable gateway lands on the address page; the address page's own
  script is run against the URL `main.cjs` really loads (unreachable state, retry, a
  rejected save without Electron's error prefix); showing the address page closes the
  Remote menu and leaves fullscreen; `--smoke-test` checks the page and bridge and
  cannot hang; fullscreen and F11 serialization; native menu states.
- **UI (D6)**, `test/browser-api.test.js`, `test/tiles.test.js`,
  `test/viewer-flow.test.js`, `test/viewer-invariants.test.js`: same-origin requests
  without token or credentials; error classification; the bridge version gate; browser
  fullscreen serialization; tile states and labels; which screen each failure shows and
  that a connection starts only from a click or the menu, never from an error, close or
  state change (`src/flow.ts`, and `src/main.ts` itself run against a fake page and fake
  Guacamole); the cursor, overlay and in-flow toolbar rules, the palette and the exact
  screen texts (read from the source, as a fake page cannot show them).
- **Public repository (D7)**, `test/public-hygiene.test.js`: scans the files tracked by git
  (`git ls-files`) and rejects any email other than `example.com` or `noreply`, any
  `*.ts.net` tailnet name other than the placeholders, any tailnet (CGNAT range) address
  other than the documented placeholders (also the tailnet IPv6 prefix `fd7a:115c:a1e0:`
  except the documented placeholder), and any `/home/<name>/` other than `/home/user`.
  A positive control proves the scanner flags a planted value. It cannot recognise a bare
  MagicDNS device name, and it does not scan git history; checking history is a separate
  one-off step before publishing.

On Linux CI also runs `xvfb-run -a npx electron . --no-sandbox --smoke-test --user-data-dir=...`:
the real Electron opens the local address page with a throwaway data directory and no
network, and exits 0 only if the page, its title and both preload bridges are as expected.
`--no-sandbox` is needed because the runner's Electron lacks a configured setuid sandbox.

Not covered by automation: the browser rendering on a real screen, real
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
