# Verification record — 2026-10-03

This records local verification and fixes identified by independent review. It is not a
claim that all four physical client/host combinations have been tested.

## Observed passes

- Initial `npm test`: 8 tests passed on Linux (Node 24.21.0) and macOS (Node 26.0.0).
  After review fixes, all 10 tests pass on Linux and macOS, including delayed IPC
  credential and server-list responses across gateway changes. Updated macOS
  native packaging and the secure-storage/IPC startup smoke test also pass.
  The integration fixture records the actual TCP handshake received from the
  HTTP/WebSocket gateway, rather than asserting a settings-builder mock.
- `npm run check` and `npm run build`: pass on Linux and macOS.
- `npm audit --omit=dev`: zero reported runtime vulnerabilities.
- `python3 -m py_compile scripts/setup-headless.py`: pass.
- Real headless Ubuntu 26.04.1 / GNOME 50.1 / GNOME Remote Desktop 50.2:
  no HDMI/DP connector attached. A dedicated user runs a headless GNOME shell.
- The app's browser client displays that desktop through the real guacd 1.6.0
  RDP backend. Keyboard input launches Text Editor, English typing reaches the
  editor, and explicit clipboard-based text paste inserts Korean.
- Disconnect/reconnect preserves the same editor and unsaved document.
- Mouse clicks reach the editor and its Save button. A file saved through the
  remote UI was independently read on the server and checked for all three
  expected markers (English typing, Korean paste, and mouse/keyboard proof).
- The initial installer was exercised with a temporary account. Review exposed
  a firewall-reload weakness; that firewall mechanism has been removed.
- The revised installer was exercised with a fresh temporary account. RDP runs
  in a distinct network namespace and systemd forwards only a host loopback
  socket. Namespace inode comparison and actual connection probes confirm
  loopback success and rejection through the host's Tailscale IP. The host's
  firewall was not flushed or reloaded.
- Real guacd/browser screen, mouse/keyboard, English and Korean text paste work
  with the isolated RDP daemon. The stock user daemons are masked before startup.
  GRD needs FUSE clipboard support, so NoNewPrivileges is not applied to GRD;
  it remains enabled for the socket proxy.
- Python tests pass (3 cases). Collision checks cover all six reserved paths, including dangling
  links, assert the exact refusal reason with an executable proxy available, and
  stop before any system command runs. A clean-path positive control reaches
  account creation without performing it. Exclusive-write tests preserve existing
  files and symlink targets. `systemd-analyze verify` passes for all three units.
- Restarting that dedicated user manager automatically starts the shell and RDP
  services; the browser reconnects and launches Text Editor again.
- Changing resolution to 1920×1080 updates the remote display's unscaled layer
  to exactly 1920×1080 while its outer container remains scaled to the viewport.
- After the vendored image-decoder cleanup fix, the fresh installer-rehearsal
  browser reported zero console errors or warnings during the live connection.
- macOS 26.4.1 / Apple Silicon: an actual native ZIP build and hidden app startup
  pass. `--smoke-test` reports the correct title, working preload IPC bridge, and
  OS secret-storage availability. The older synchronous Electron storage API
  reported false; the asynchronous API reports true and is now used by the app.
- Windows x64 ZIP and Linux unpacked application packaging succeed on Linux.
  The final Windows ZIP is cross-built without executable resource editing or
  signing. No signing credentials were used.

## Publication

The owner authorized the public repository `WONJUNE-LEE/gome-remote` on
2026-10-03. Test fixtures use synthetic addresses and credentials. Independent
review applies to the pushed implementation branch before merging.

## Still required

- The owner chose Codex 3. The first review found configuration races, missing
  collision checks, firewall reload exposure, and two test gaps. Fixes are
  implemented; the independent gate is tracked in the review records.
- Windows native execution, DPAPI persistence, and all four physical connection
  combinations require owner-device checks. A real Mac VNC service was found
  reachable, but no existing Mac VNC password was read or changed, and Mac host
  authentication/control has not been tested.
- Full-machine reboot, OS sleep/wake, real tailnet HTTPS access and access-policy
  enforcement, installer signing/notarization, and the native build workflow
  have not been tested. The shared server was not rebooted, and its existing
  Tailscale Serve routes were not changed.
- A user-manager restart is evidence for service startup, not a substitute for
  a complete reboot test. The new installer no longer relies on nftables rules;
  a separate physical LAN peer probe remains unperformed.
- Software rendering is functional; latency, frame rate, and hardware encoding
  have not been benchmarked. The Linux desktop uses a separate account and home.

The test accounts, containers, local listeners, and remote build scratch are
temporary and are removed after retaining the source, packages, and evidence.
Production installation awaits review and the owner-device checks above.
