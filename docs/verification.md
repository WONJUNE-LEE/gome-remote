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
- Tailnet HTTPS was subsequently verified from a Mac peer and with browser
  authentication, WebSocket connection, and desktop display. A separate Serve
  port was added while existing port-443 routes were preserved.
- Full-machine reboot, OS sleep/wake, access-policy enforcement, installer
  signing/notarization, and the CI native build workflow have not been tested.
  The shared server was not rebooted.
- A user-manager restart is evidence for service startup, not a substitute for
  a complete reboot test. The new installer no longer relies on nftables rules;
  a separate physical LAN peer probe remains unperformed.
- Software rendering is functional; latency, frame rate, and hardware encoding
  have not been benchmarked. The Linux desktop uses a separate account and home.

The dedicated test desktop, gateway, and guacd container remain available for
owner testing. Build and review scratch are removed after preserving artifacts.
Production installation awaits the owner-device checks above.

## Viewer correction (0.1.1)

The owner reported oversized application chrome and no obvious Windows
fullscreen escape. The connection view now hides home navigation, uses the full
viewport, and offers a collapsible overlay plus an always-visible fullscreen exit.
F11 is intercepted in Electron before page key events and menu accelerators.
Native enter/leave events keep the button label synchronized; the explicit exit
requests windowed mode rather than toggling stale renderer state. Native
transitions are serialized, so returning to the list during entry queues an exit
that is applied when entry completes.

- Node regression checks exercise the actual main-process IPC/input registrations
  with a delayed native transition: F11 down/up intercepted, repeat ignored,
  unrelated keys preserved, native state notifications, explicit exit.
- Browser checks used the real gateway and Guacamole client with a synthetic
  1920×1080 desktop: 1280×720, 1920×1080, and 900×620 windows allocate the full
  viewport to the remote view and hide navigation. Tools expand/collapse; F11
  enters/exits while the remote surface is focused; the persistent exit button
  works with tools collapsed; returning to the list restores navigation.
- Additional geometry checks measured the actual remote display bounds: a
  1920×1080 desktop in a 1920×900 viewport renders centered at 1600×900 (height
  constraint), and in a 2560×1440 viewport it fills 2560×1440 (upscaling).
- A renderer check with delayed native state notification enters a real fixture
  session, requests fullscreen, and immediately returns to the list. It observes
  the exact IPC intent sequence `[true, false]` before any entry notification.
  The main-process regression completes the delayed entry and verifies the
  queued exit request, then the final windowed state.
- Browser API regressions execute the actual TypeScript adapter with deferred
  DOM fullscreen promises: entry starts in the gesture, exit during entry is
  applied exactly once after completion, already-windowed exit is a no-op, and
  a rejected entry permits retry. A native regression presses F11 twice before
  entry completes and requires an exit request after the entry event.
- All 15 Node tests, TypeScript checks, and the production build pass on Linux.
  Mac tests/check/build and packaged startup/secure-storage/IPC smoke passed
  before the review follow-up. Native Mac fullscreen automation was inconclusive:
  IPC entry did not complete within the wait; direct native entry after focusing
  the app reached fullscreen but the expected renderer notification timed out.
  This is not counted as a native fullscreen pass.
- Native Windows interaction still needs owner confirmation with the new ZIP.


## Native menu and cursor correction (0.1.2)

The owner rejected the 0.1.1 overlay because it intercepted corner clicks, and
reported a duplicate local pointer over the software-rendered remote cursor.
The new design supersedes the overlay and persistent exit button described above.

- Desktop actions move into a native Remote menu beside View/Window. No tools or
  fullscreen-exit button remains over the remote surface. F11 remains local.
- Only connected remote surfaces suppress the OS cursor. Guacamole's software
  cursor is hidden on mouse leave/input release and restored with remote mouse
  input. Dialogs and disconnected views retain a local cursor.
- Browser tools reserve normal layout space above the viewport instead of
  overlaying it. Native clients hide that toolbar entirely.
- Main-process regression inspects the actual menu template and IPC handlers:
  home/connecting/connected/disconnected state, RDP versus VNC resolution
  availability, current resolution radio selection, exact action forwarding,
  invalid state rejection, and the View fullscreen controller.
- Existing fullscreen, input ownership, gateway and storage regressions remain.
- Native Windows menu rendering/input still requires the owner's device. Browser
  testing with a simulated desktop bridge does not prove Windows native chrome.

- Browser checks used the actual gateway/Guacamole client with a synthetic
  1920×1080 desktop and 12×18 remote cursor, plus a simulated desktop bridge.
  All four corner points (2,2), (1917,2), (2,1077), (1917,1077) hit the remote
  surface with computed cursor:none; the receiver recorded exact press/release
  coordinates. The cursor layer remained present while hovering remotely.
- Menu actions reached renderer handlers for text input, resolution, disconnect,
  reconnect, and back. Receiver records independently confirmed the text payload
  and 2560×1440 resize. Local text dialog cursor was not hidden; disconnect
  removed the cursor-suppression class and back restored home/menu state.
- Browser-only toolbar bounds stayed above the viewport at 900×620 and
  1920×1080. Browser fullscreen/F11 exit with remote focus passed.
- Preload regression checks exact action forwarding without Electron event
  exposure, viewer-state invocation, and listener removal.
- All 18 Node tests, TypeScript check, and production build pass on Linux. The
  native fullscreen menu is also clicked twice before entry completes, proving
  that the queued exit survives the pending transition.
- Review found that incoming Guacamole mouse instructions can reattach a cursor
  hidden via showCursor(false). That mechanism was removed. The cursor layer's
  final CSS visibility now depends on connected state and local pointer ownership,
  which server instructions cannot change. The layer may remain attached while
  hidden. Mouse re-entry restores ownership even at the same coordinate, which
  Guacamole otherwise deduplicates.
- Repeated the browser probe while the synthetic server sends a changing mouse
  position every 100 ms. Hover is visible; leaving into letterbox space is hidden;
  a subsequent server-driven transform change stays hidden; re-entry at the same
  coordinate is visible. Opening the text dialog hides it, another server update
  keeps it hidden, and renewed remote mouse movement restores it. Each transition
  asserts computed visibility, not just layer presence or local cursor CSS.
- Mac native startup/bridge/storage-availability smoke passed at the first menu
  build. A later native menu connection probe encountered a safeStorage encryption
  error in its isolated test profile before connecting; it is not counted as a
  native menu interaction pass or as proof that credential encryption works.

## Ubuntu application and wallpaper correction

The owner reported Settings and Firefox failing to open and a solid blue desktop.
Four server-side defects were confirmed on the retained test desktop:

- Settings exited because D-Bus activation lacked the desktop environment that
  existed only inside the shell unit. The shell now exports its Ubuntu GNOME and
  Wayland identity to both D-Bus and the systemd user manager before starting.
- The GNOME portal unit requires an active graphical-session.target. The bare
  shell previously did not pull it in. The shell now binds to that target and is
  ordered before it; portal activation works after a user-manager restart.
- Snap Firefox rejected the dedicated account's legacy `/var/lib` home. New
  accounts use `/home/<user>`. Collision checks preserve both standard and legacy
  homes. The owner's existing account was relocated with the session stopped,
  a full backup and checksum comparison, preserving credentials and files while
  updating the RDP HOME and certificate paths. This was a controlled migration,
  not an installer upgrade path or a global Snap sandbox configuration change.
- `XDG_CURRENT_DESKTOP=GNOME` selected an upstream default wallpaper URI pointing
  to an absent `gnome/adwaita-l.jxl`. The initial diagnostic command inherited the
  host's Ubuntu identity and misleadingly reported an existing Ubuntu image.
  `ubuntu:GNOME` selects the installed Ubuntu defaults. RDP also explicitly
  enables wallpaper instead of requesting that the server suppress it.

Validation:

- All 18 Node tests, TypeScript check and build pass. The actual RDP wire fixture
  now requires wallpaper=true; VNC still leaves the RDP option unset.
- Four Python tests pass, including seven reserved destination paths as regular
  files and dangling symlinks, standard-home account creation, and the actual
  installer-generated shell unit's desktop identity, activation export and
  graphical-session ordering. The simulated installer performs no host changes.
- After resetting the temporary wallpaper override, restarting the dedicated
  user manager and reconnecting, the default Ubuntu wallpaper appears with no
  per-user picture-uri override. A no-override GNOME-only control reproduced the
  blue desktop; changing the desktop identity resolved it.
- Settings opens through D-Bus activation without injecting desktop variables
  into the calling process. Firefox opens through GNOME search over real remote
  keyboard input; its window is visible through the actual guacd/RDP/browser path.
- User-manager environment contains the new home, ubuntu:GNOME, wayland and the
  Wayland socket. The graphical target and both portal services are active.
- systemd unit verification passes; the host has an unrelated pre-existing
  spice-vdagent unit warning. No firewall, global Snap allowance, or other login
  account was changed. The original home and root-only migration backup remain.

The client UI is unchanged at 0.1.2; this correction requires server updates and
reconnection, not a replacement Windows ZIP. Full host reboot and native Windows
execution remain separate verification limits.

## Ubuntu shell mode and bottom dock

The owner approved using Ubuntu shell mode and placing its dock at the bottom.
The headless shell now starts with `--mode=ubuntu`, selecting the installed Yaru
theme and Ubuntu default extensions, while retaining its dedicated account and
isolated RDP service. Ubuntu Dock is configured as fixed and bottom-positioned.
The installer initializes standard XDG user directories before the shell starts:
without a Desktop directory, the newly enabled desktop-icons extension retried
and failed. No per-user extension enable list or copied mode definition is needed.

- Five installer tests and Python compilation pass. The generated-unit test now
  verifies the actual shell command, captured bottom/fixed settings commands and
  user-directory initialization before writing the shell service.
  Review added full command-prefix assertions (dedicated user, runtime directory,
  and D-Bus address) plus missing-XDG-command rejection before account lookup or
  any system command. Isolated-copy mutations that remove the Dock user prefix
  or omit the new dependency check fail these tests; the unmodified copy passes.
- The retained desktop was restarted with the generated unit. D-Bus reports shell
  mode `ubuntu`; all seven installed extensions from Ubuntu's mode definition are
  active, including Ubuntu Dock and desktop icons. Settings reports `BOTTOM` and
  `dock-fixed=true`. The real RDP/browser screen shows the bottom dock, wallpaper
  and home icon outside the overview, after a dedicated user-manager restart.
- Settings still opens via D-Bus activation. A click on the bottom Firefox icon
  launches Firefox. No extension JavaScript error was found in the final shell
  invocation after initializing user directories; existing headless GDM/session
  and software-rendering warnings are not claimed to be resolved.
- systemd unit verification passes with the previously noted host spice-vdagent
  warning. This change is confined to the installer and dedicated desktop settings;
  client/gateway source, credentials, other accounts and RDP network isolation are
  unchanged. Previous shell/dock settings were backed up before application.

This selects Ubuntu's shell mode within the existing headless architecture; a
full machine reboot and every Ubuntu extension feature remain untested.

## Standard Ubuntu Remote Login (0.1.3)

This replaces the legacy bare-shell lifecycle above. Production has **not** been
cut over. The following evidence comes from a disposable monitorless QEMU guest,
through the real browser client, gateway, pinned guacd and guest system GRD/GDM.
Native Windows/macOS execution and the production host's reboot remain unverified.

### Recorded environment and compatibility

- Ubuntu 26.04 cloud image `release-20260927`, SHA256
  `8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2`.
  The published SHA256SUMS signature was verified with Ubuntu's cloud image keyring.
- QEMU KVM, 4 CPUs/8 GiB, `-vga none -display none`; isolated user networking with
  only host-loopback SSH/RDP forwards. Synthetic accounts/passwords/data only.
- `ubuntu-desktop-minimal` 1.570.4, GDM 50.1-0ubuntu0.1,
  GRD 50.2-0ubuntu0.1, GNOME Shell 50.1-0ubuntu1.3,
  libpam-gnome-keyring 50.0-1. Complete Ubuntu desktop packages matter: the initial
  hand-picked shell packages lacked themes/wallpaper. Inspection now requires the
  desktop metapackage rather than treating a runnable shell as a complete desktop.
- guacd 1.6.0 image digest
  `8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f`,
  containing FreeRDP 2.11.7. **No FreeRDP replacement was necessary.**
- Initial readonly-container negotiation failed because FreeRDP could not create
  its certificate store under `/home/guacd`. Adding an ephemeral UID1000 mode0700
  tmpfs there resolved it while preserving the readonly root/capability restrictions.
  The repeated real login/handover/reconnect tests used those restrictions.

### Actual UI and lifecycle outcomes

- The app displayed the stock GDM greeter; Linux password authentication created
  a logind `Service=gdm-password`, `Type=wayland`, `Remote=yes` session. A fresh
  login keyring reported `Locked=false` without a manual unlock.
- Settings opened, Snap Firefox opened and navigated to example.com, Ubuntu
  wallpaper and the existing bottom dock appeared. Keyboard and pointer operated
  these apps. Both GNOME portal services were active; Text Editor's save dialog
  worked. Explicit Korean paste was saved through the UI and independently read
  as `한글 붙여넣기 — GDM PAM remote login` from the guest's file.
- Disconnect/reconnect and a test-gateway process restart returned through GDM
  and preserved session84, leader41030, shell41347 and terminal bash42918. The
  terminal's unsaved scrollback marker remained visible after the gateway restart.
- Normal locking produced `LockedHint=yes`. A wrong password left it locked;
  correct password authentication changed it to `no`, preserving the session.
  A separate wrong system-RDP-password attempt failed before a desktop appeared.
  Wrong account authentication at GDM also remained at the password prompt.
- Explicit `gnome-session-quit --logout --no-prompt` ended session84 and its
  processes. The next GDM login created session113/leader49652.
- After a guest reboot there was no automatic desktop session. The app reached
  GDM and logged in to a new session4/leader7043 using the normal PAM/Wayland path.
  Legacy app units stayed disabled. User files/keyrings survived the reboot.

### Migration/recovery and refusal evidence

- A second synthetic account reproduced the previous installer's units and
  locked-password lifecycle. The retired installer's credential helper had an
  existing PTY-completion race: it reported failure although the synthetic stored
  credential matched. The fixture completed only the original post-credential
  installation steps to obtain the old baseline; the new migration does not use
  that credential helper or reset shared RDP credentials.
- Forced exits immediately after durable `stopping`, `stopped`, `configuring`,
  `ready` and rollback `restoring` phases were resumed successfully. A discovered
  logind timing race was fixed by bounded quiescence polling; it does not kill
  unknown processes. Both delayed-exit and refusal cases have regression tests.
- Recovery receipt and consistent home archive were root-owned mode0600 under
  a mode0700 directory. Rollback restored the old password lock, linger and
  active old RDP/socket. A file written after migration and the Korean saved
  document survived; the new login.keyring hash stayed exactly unchanged.
- A different account's session44/leader16147 survived migration, interruptions,
  rollback and the second migration. The deliberate whole-guest reboot came later.
- Starting another attempt preserved the previous recovery directory. The second
  migration deliberately used a different OS password from the existing synthetic
  keyring's password. Login succeeded, but that keyring remained locked with its
  identical SHA256. Requesting access displayed the standard password-mismatch
  prompt. The tool did not erase, decrypt, rekey or change the default alias.
- The production account was inspected read-only successfully. Its GDM/GRD,
  desktop, credentials, Serve routes and gateway were not changed by rehearsal.
  Guest listeners showed the pre-existing system RDP3389; the legacy33490 listener
  was absent after migration/reboot. Shared system RDP exposure remains host policy.

### Automated checks and remaining scope

- 20 Node tests pass, including real HTTP/WebSocket/guacd-wire profile assertions,
  malicious caller routing/security overrides, generic RDP/VNC behavior, native
  menu/fullscreen, encrypted vault and gateway-revision credential boundaries.
- 17 Python tests pass, covering legacy refusal/collision behavior, receipt and
  intermediate symlinks, changed resources, explicit SSH exclusion, secret-safe
  command errors, no-op prepared rollback and bounded account quiescence.
- TypeScript check, production build and `git diff --check` pass.
- Windows x64 ZIP is cross-built with executable editing/signing disabled. It
  contains the new two-stage credential guidance. This is packaging evidence,
  not proof of native Windows menus, OS credential storage or the full login flow.
- Sanitized screenshots, source and package checksums are delivered separately.
  Synthetic private credentials, VM disks and browser logs are excluded.
- The retained 0.1.2 Windows client's new-login compatibility is **not certified**.
  Use 0.1.3 for owner-device testing. Mac targets and native UI behavior were not
  changed; a real Mac control session is still part of the outstanding device matrix.

### Implementation review corrections (round 1)

- A-001/C-001 accepted: legacy recognition now compares all four unit bodies to
  frozen supported templates, checks actual loaded fragments/drop-ins/reload state,
  rejects user-unit search-path overrides and checks outgoing/incoming stop
  propagation outside this account. This is intentionally conservative.
- A-002 accepted: before/desired/configured account metadata is recorded and
  revalidated before interruption and recovery. Unexpected password/aging,
  enablement, linger, owned preferences or shell-link changes stop the operation.
  Partial configuration/rollback accepts only the recorded before/after values.
- A-003 accepted: the initial private receipt is fully written/fsynced in staging
  before its directory is published. A first-write interruption cannot leave an
  empty active recovery directory. Previous completed recovery archives remain.
- B-001 accepted: process-free manager/session blockers now have independent wait
  and timeout cases. In a disposable test copy, deleting both manager/session
  conditions caused all four new subcases to fail. The copy was removed.
- An actual guest rehearsal changed the proxy to another user before prepare,
  added a loaded PropagatesStopTo=gdm.service drop-in after prepare, changed the
  shell enablement link, and changed account password-aging metadata. Each was
  refused before stopping the account; GDM and user-manager PIDs stayed unchanged.
  Restoring the synthetic baseline made validation pass again.
- Injecting the first receipt-write failure left no active recovery directory;
  the next prepare succeeded. The revised migration was then interrupted and
  resumed again at every durable migration phase, followed by rollback recovery.
