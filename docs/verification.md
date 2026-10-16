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
  `test/viewer-flow.test.js`, `test/viewer-invariants.test.js`,
  `test/resolution.test.js` (자동 해상도, 구 앱 호환): same-origin requests
  without token or credentials; error classification; the bridge version gate; browser
  fullscreen serialization; tile states and labels; which screen each failure shows and
  that a connection starts only from a click or the menu, never from an error, close or
  state change (`src/flow.ts`, and `src/main.ts` itself run against a fake page and fake
  Guacamole); the cursor, overlay and in-flow toolbar rules, the palette and the exact
  screen texts (read from the source, as a fake page cannot show them).
- **Mac agent, gateway side (agent spec D2, D7)**, `test/config-agent.test.js`,
  `test/credentials-agent.test.js`, `test/set-credential-agent.test.js`,
  `test/agent-relay.test.js`: an `agent` target needs platform mac, a tailnet address and no
  RDP-only setting, and defaults to port 18471; every credential entry has the shape of
  its target's method and a mismatch invalidates the file; `set-credential --agent-token`
  requires the flag for agent targets, refuses it elsewhere, never takes a token as an
  argument, trims a pasted token and replaces an old password entry; against a fake agent on
  a real socket: the tile state (permission, locked, suspect, offline, setup) is built from
  enumerations only, locked wins over suspect, status answers are cached for 10 s and shared
  between simultaneous page loads, a new token is asked at once, `/api/agent-sessions`
  checks login, Origin, content type, 64 KiB body (both sides of the limit), the offer and
  the size before the agent hears of it, relays token, size and offer, passes the agent's
  `permission` and `locked` refusals as codes, turns every other failure into "unavailable"
  within the time limit and logs a refused token separately without printing it.
- **Mac agent, page and app (agent spec D4, D5, D8)**, `test/agent-input.test.js`,
  `test/agent-session.test.js`, `test/agent-style.test.js`, `test/viewer-agent.test.js`,
  `test/measure.test.js`, `test/measure-drive.test.js`, `test/desktop.test.js`,
  `test/preload.test.js`: against a fake `RTCPeerConnection`, the codec preference keeps
  H.264 and `video/rtx`; a browser without H.264 ends at once; pointer positions are
  fractions of the picture inside the letterbox (the stylesheet's `object-fit: contain` is
  read from the source), a press on a black bar is not a click, a drag released outside
  still releases; the wheel, key (including the Hangul key), text (emoji not split) and
  size messages have the agent's exact shapes; blur, dialogs, fullscreen and the end of the
  session send `release`; first picture, 20 s without one, a failed or closed connection and
  a closed channel end the session once, and a session the page closed reports nothing;
  main.ts connects an agent tile without touching Guacamole, keeps the ended card and the
  single reconnect rule, shows each refusal in its own words, and sends the window size; a
  permission-less tile is not openable, a "suspect" one is, and a locked one follows the
  P1 switch (set to openable, see Agent P1); bridge 3 accepts the protocol "agent" and an older app is told "rdp"; the
  `#measure` panel exists only when asked for and measures a video and a Guacamole canvas
  with the same loop; the measuring driver's options and thresholds, and its guards: one
  driver per machine (a lock file holding the driver's pid, created atomically; a stale one
  is taken over), two pilot clicks that must each show a flip before the run counts (a flip
  page covered by a window or dialog stops the run), and any sample under 20 ms fails the run
  (another session is flipping the same page). The flip page logs presses, focus loss and
  frame gaps, and its flip count must equal n + 2 (the pilot clicks count).
- **Mac agent, program (agent spec D2-D6, D10)**, `cargo test --locked` in `agent/mac`
  (macOS CI; most tests also run on Linux): Host, Origin, source address and bearer-token
  checks (including an IPv4-mapped peer), body limits, backoff that never delays the
  gateway; tailnet address ranges at both edges and the offer candidate filter; the
  settings and token file ownership rules; the input message limits (512 bytes, 8 KiB for
  text), the key table, double-click counting, the typed-text chunking; bitrate following the
  estimate down to the 2 Mbps floor; the static-screen repeat and sharper-refresh timing; the black-frame
  detector; status enumerations; one session with takeover; the 10 s idle rule; the log
  cap; and that no source file reads arguments or the environment. `test/agent-install.test.js`
  runs `install.sh` and `uninstall.sh` against stand-ins for the macOS tools: layout, token
  mode, signing options, address checks before anything is installed, the 200/401/403 health check, refusal of test
  overrides, root and development builds in the operational install, the rollback to
  `.prev`, the development install and the shared keychain's removal.
  `test/agent-ci.test.js` keeps the macOS job (fmt, clippy `-D warnings`, `--locked` tests,
  `cargo deny`) from being weakened.
- **Documentation and examples (agent spec D7)**, `test/ops.test.js`,
  `test/ops-agent.test.js`, `test/config.test.js`: the example targets (Ubuntu RDP, Mac
  agent on 18471, Mac VNC) are valid and hold no secret; `init-gateway` prints one
  `set-credential` command per target, with `--agent-token` for agents only; the README
  names the install, permissions, token, rollback and removal steps and the new tile words;
  this file keeps the evidence below.
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
  Mac needs the macOS account name and password, which is what the VNC target stores (it was
  called `mac` when this was measured; today the VNC target is `mac-vnc` and `mac` is the agent).
  The VNC password option is not needed.

## Mac account authentication through the VNC route (V4 of the redesign), recorded 2026-10-14

Not a unit test but a real run, on 2026-10-08 and again on 2026-10-14: with the 0.2.0
gateway, guacd and the Mac's own account name and password (Apple Remote Desktop
authentication, 16-bit colour, local cursor), a headless Chrome on the gateway server opened
the Mac tile, the Mac's screen appeared and clicks sent from the page changed what the Mac
showed. Measured with canvas pixel polling: median 171 to 182 ms from click to picture, p95
193 ms, with an occasional 1 to 2 second stall. The result files and conditions are in the
owner's private handoff notes. This is the evidence for redesign V4 below; redesign V4 is therefore passed
for the Mac account route, and the real-app part of redesign V4 and V5 stays pending until the owner
runs it.

## Pending: the redesign's owner and operator checks V1–V6 (the account-authentication check has been run)

These are the checks of the 0.2.0 redesign, named V1 to V6 in `docs/redesign-spec.md`; the
Mac agent has its own V1 to V6 in the next section, which are not these. Except for the
Mac account authentication (first entry, run and passed) and the operator's part of
redesign V4, nothing below has been run and no result is recorded. Each entry is filled in,
with the date and the evidence, when the owner and the operator perform it. Do not edit an
entry to say "pass" without that evidence. See `docs/redesign-spec.md` sections 3, 7 and 8
for the procedure.

- Mac account authentication (spec section 3). Whether guacd opens the real Mac screen
  with the account name and password: tested on 2026-10-08 and 2026-10-14, see the section
  above (it worked).
- Redesign V1 (operator). UI, list and WebSocket through the new Serve port; no loopback TCP route
  to the gateway; negative test with a temporarily different `allowedLogins`
  (the real app shows the 403 screen), then restored.
- Redesign V2 (owner). Windows app, Ubuntu tile, GDM, `gome`, desktop (S1). To record: `loginctl`
  session ID and leader compared with P1.
- Redesign V3 (owner). Disconnect and reconnect keeps the windows (S4); Windows Remote Desktop and
  the app take the session from each other.
- Redesign V4 (owner). Mac tile shows and controls the Mac with the stored account credentials (S2).
  The operator's run of 2026-10-14 is recorded above; the owner's check in the app is still
  to be done.
- Redesign V5 (owner). Mac app repeats redesign V2 and V4 (S5); light and dark screenshots approved (S6).
- Redesign V6 (operator). Gateway restart comes back with Serve answering; each refusal condition
  (empty `allowedLogins`, credentials file mode, open socket directory) leaves a clear
  line in the log.

## Mac agent pre-test P1 (lock screen), recorded 2026-10-16

Run on the owner's Mac with the owner's knowledge (spec section 3, P1): the Mac was locked
and the agent was opened from its tile.

- (a) Capture: the agent captured the lock screen.
- (b) Keys: the agent typed into the password field (the letter x four times, four dots
  appeared, then four Backspaces deleted them; no password was used).
- (c) The VNC path showed the lock screen, but the characters typed through it did not appear.
  The cause was not determined.

Outcome: the first branch of P1 ("(a)(b) pass: unlock through the agent"). The switch is set:
`REFUSE_WHEN_LOCKED = false` in `agent/mac/src/status.rs` and `LOCKED_TILE_ENABLED = true` in
`src/tiles.ts` (the tile still says 잠김 but opens). The Mac (VNC) tile stays as the fallback.

## Pending: the Mac agent's device checks (not yet run)

The agent's automated checks above ran on Linux and, for the Rust program, on a macOS
runner. Apart from P1 (recorded above), nothing about a real Mac, a real network path or a
real client has a result recorded here. The pre-tests and verification runs are in section 3 and
section 8 of `docs/mac-agent-spec.md`; each entry below is filled in by the operator or the
owner with its date and evidence (numbers and words, no tailnet login, device name or
address) when it is run. Do not edit an entry to say "pass" without that evidence.

- Agent P2. Real clients: the selected ICE pair and whether the path is direct, click-to-picture
  at 2560x1440, still-screen hold with 1000 ms and 100 ms repeat, the decoder in use.
- Agent P3. Permissions survive updates of the same signing certificate.
- Agent P4. The 30-day screen-recording reconfirmation (scheduled for 2026-11-12): whether capture
  continues and whether the Mac (VNC) tile can click the confirmation window.
- Agent V1. The agent tile measured from the gateway server's Chrome against S2, S3 and S4.
  Partial results, 2026-10-16, development install of the agent behind the parallel gateway,
  headless Chrome on the gateway server, 30 clicks per run, each run a fresh session:
  - S2 with native capture and VideoToolbox scaling: 3 runs pooled, median 93.2 ms,
    p95 112.8 ms, max 193 ms, nothing over 1 s.
  - S4 with this server's receive from the Mac shaped to 5 Mbit/s (ifb with tbf 5mbit, burst
    32kbit, latency 150ms). Before 95c5a27 it failed: click medians 164, 195 and 428 ms, one
    sample at 1011 ms, and a 60 s drag soak stalled after about 40 s. The cause was the
    bandwidth estimate collapsing on a still screen; str0m paces at 1.1 times that estimate.
    After 95c5a27: medians 179, 178 and 196 ms, nothing over 1 s; the 60 s soak had a
    longest gap of 167 ms and no freezes. The same build without the limit had a 63 ms
    median. The margin to the 200 ms S4 median is small.
  - Still open: S3 without the limit on the final build, and the owner's own clients (V2, V3).
- Agent V2 (Windows app) and Agent V3 (Mac app). (Both against S1 and S5.)
- Agent V4. Agent states: lock screen (unlocking through the agent, P1), display sleep, takeover, agent restart, nothing left
  pressed after a session, missing permission.
- Agent V5. Negative tests: wrong token, a caller other than the gateway, an `Origin` header, a
  login outside `allowedLogins`, an extra argument or environment variable.
- Agent V6. Cutover and rollback rehearsal, including the installer's rollback to `.prev`.
