# Gome Remote

A desktop app for viewing and controlling your own machines over Tailscale.
Windows and macOS clients share one UI. macOS hosts use Screen Sharing (VNC),
and Ubuntu hosts use a dedicated, persistent GNOME desktop (RDP).

The desktop is shown **inside the app**. It does not open another remote desktop
client. A Linux gateway runs the app backend and Apache Guacamole's `guacd`.
Traffic between the client, gateway, and other hosts stays on the tailnet.
The gateway decrypts desktop traffic and must be a trusted machine.

## Features

- Named server list with a TCP service availability check.
- Mouse, keyboard, explicit text paste, full screen, RDP resolution changes.
- Unobstructed desktop viewer with native menu controls and a single remote
  cursor. F11 is handled locally before remote keyboard input.
- Disconnect and reconnect without logging out of the remote desktop.
- A dedicated Ubuntu desktop with no physical monitor or HDMI dummy plug.
- OS-backed encrypted credential storage in the Electron app. Browser access is
  also available, but never persists tokens or passwords.
- Server-side target allowlist; authenticated API; expiring, single-use socket
  tickets; origin validation; bounded socket queues.

The first version does not include audio, file transfer, automatic discovery,
or unattended Mac login after a FileVault-protected reboot. Changing the VNC
display resolution must be done in the remote Mac's display settings.

## Viewer controls

While connected, the desktop app hides page navigation and uses the entire client
area for the remote image, preserving its aspect ratio. No permanent tools or
exit buttons cover the remote surface, including its corners.

Use the native **원격** menu beside **View / Window** for the server list,
resolution, text input, reconnect, and disconnect. Controls follow the current
connection state; resolution is enabled only for a connected RDP desktop.
Use **View → 전체 화면** or **F11** to enter/leave fullscreen. F11 remains local,
even with remote keyboard focus; Escape remains a remote key. Returning to the
server list also leaves fullscreen.

Only the remote cursor is shown over a connected remote surface. Local menus,
dialogs, and disconnected views retain their normal cursor. Leaving the remote
surface or opening a local dialog hides the software cursor until remote mouse
input resumes.

Browser access has an in-flow toolbar above the viewport because there is no
native app menu. It reserves its own space and never covers remote pixels.
Browser fullscreen retains F11 and the browser's native exit controls.

## Development

Use Node.js 24+ and npm. No production credentials are required for the tests.

```sh
npm ci
npm test
python3 -m unittest discover -s test -p '*_test.py'
npm run check
npm run build
npm start
```

`npm test` exercises the real HTTP/WebSocket/TCP boundary with an independent
guacd wire fixture, including RDP and VNC authentication parameters, Unicode
split across TCP chunks, wrong origins, forbidden destinations, expired tickets,
replay rejection, and encrypted vault persistence. Desktop IPC tests delay OS
storage and HTTP responses while changing gateways, and verify old credentials
never reach the new gateway. Python tests check installer collision refusal and
exclusive writes without changing the host. It does not assert that a
physical Windows or Mac client successfully controls a real Mac.

`npm run dev` previews the UI only. For an end-to-end development session, build
the UI and run the gateway with a loopback `publicOrigin`.

## Ubuntu Remote Login without a monitor

Use Ubuntu 26.04 / GNOME 50 with `ubuntu-desktop-minimal`, GNOME Remote Desktop,
GDM and the standard `libpam-gnome-keyring` integration. Installing only a shell
and a few applications can leave Ubuntu themes and wallpapers missing. The
normal Ubuntu session creates its headless display when a remote client connects.
No HDMI dummy plug, custom shell unit or autologin is required.

Configure **Settings → System → Remote Desktop → Remote Login** on the host.
An existing system Remote Login service is reused without changing its credentials,
certificate or port. Do not reset a shared service's password just for this app.
Host administrators remain responsible for the system RDP listener's network
policy. Gome Remote's gateway is tailnet-only; reusing system RDP does **not** make
its existing port 3389 app-only or prevent other direct RDP clients.

Run guacd and the gateway on the same Ubuntu host. Use the
`gnome-remote-login` profile with `hostname: "127.0.0.1"`, Linux RDP, NLA and
`persistent: true`. The example target uses a new ID, `ubuntu-login`, so it does
not reuse credentials saved for the previous per-user RDP service.

For a new dedicated desktop, create a regular account using Ubuntu's normal
account tools, without sudo or other administrative groups:

```sh
sudo adduser --disabled-password --gecos "" gome-remote
sudo python3 scripts/setup-remote-login.py inspect --user gome-remote
# Only after the inspection succeeds:
sudo passwd gome-remote
```

Inspection requires an explicit SSH exclusion for this desktop account: an exact
`DenyUsers` entry or a simple `AllowUsers` list that excludes it. It refuses
ambiguous conditional SSH policy. Review the host's policy before modifying it;
the tool never edits SSH settings. This avoids silently opening an extra login
path when the previously locked account receives a password.

There are three separate credentials:

1. Enter the **gateway token** in Gome Remote's workspace settings.
2. Enter the host's **Remote Login system credentials** in the app's connection
   dialog. These give access to the Ubuntu login screen.
3. Enter the dedicated **Ubuntu account password** inside that login screen.
   Select the Ubuntu session if a session chooser is shown.

The native vault can remember the second credential. The application does not
add a store for the Ubuntu password; it relays that input to GDM. The gateway
remains a trusted machine able to observe remote desktop traffic.

PAM unlocks or initializes the login keyring during password login. A pre-existing
keyring encrypted with a different password may still ask for that original
password once. Do not delete or reset it to suppress the prompt. Configure Ubuntu
Dock at the bottom through Ubuntu's desktop settings; migration preserves the
existing bottom-dock preference.

Disconnecting closes the viewer, not the session. Reconnecting returns through
GDM authentication to the existing session. Normal Ubuntu screen locking remains
enabled. Logging out, a compositor failure, or reboot closes applications;
network-disconnection persistence does not preserve process memory across reboot.

### Migrating an existing Gome Remote desktop

`setup-headless.py` is retired and refuses new CLI installations. Its old source
remains for identifying/rehearsing the legacy installation. Existing desktops
keep running until an explicit migration. The new tool supports app-owned legacy
accounts under `/home`; relocate a `/var/lib` home separately before using it.

```sh
sudo python3 scripts/setup-remote-login.py inspect --user gome-remote
sudo python3 scripts/setup-remote-login.py prepare --user gome-remote
# Save the dedicated desktop's work and schedule its interruption first:
sudo python3 scripts/setup-remote-login.py migrate --user gome-remote --stop-session
```

`prepare` checks the old root-owned receipt, UID/home, units and account policy,
then stores private recovery state without stopping the desktop. It supports the
known legacy unit definitions; modified definitions, extra systemd overrides,
stale loaded units or dependencies that stop unrelated services are refused. `migrate` prompts
for a new Ubuntu password (16+ characters), stops only that account's old desktop,
waits for it to quiesce, and takes a consistent home backup. It disables the old
startup path, restores normal locking/idle defaults and selects Ubuntu Wayland
through AccountsService. It does not start GNOME directly or restart shared GDM
or system GRD. The old system units remain present but disabled for recovery.

Each durable phase is recorded under `/var/lib/gome-remote-login/USER`, root-only.
The receipt includes protected password hashes/account settings; treat it and the
home archive as sensitive. If interrupted, inspect and rerun the same migration
command. Unexpected sessions or resource changes stop the operation for review.
Changes to the prepared account password/aging, enablement, linger or owned
preferences are checked before interruption. Partial configuration accepts only
the recorded before/after values. Initial receipt creation is published atomically;
an interrupted private staging directory does not block another preparation.
Do not delete recovery state or blindly run the legacy installer again.

After real GDM login, keyring and reconnect checks pass, replace the gateway's old
Ubuntu target with a **new target ID** and the system Remote Login endpoint.
Restarting a shared gateway/guacd drops every active tunnel using it, including
Mac connections; schedule that interruption. A TCP availability indicator is not
proof of desktop login. Keep the old gateway configuration privately for rollback.

To return to the legacy service after saving new-session work:

```sh
sudo python3 scripts/setup-remote-login.py rollback --user gome-remote --stop-session
```

Rollback closes only that account's GDM session, restores prior service/account
settings and starts the legacy desktop. It **does not restore the old home archive**:
new files and keyrings remain intact. Restore the old gateway target configuration
separately if it was switched. The new login keyring can remain encrypted with the
new password after service rollback; it is preserved, not silently rekeyed.

A new `prepare` after a completed rollback archives the prior recovery directory
and starts another attempt. No backup is deleted. Full data restoration, account
removal, shared-service credential replacement and host reboot are separate
administrator actions. No destructive one-command uninstall is provided.

## Gateway installation

On the trusted Ubuntu gateway, build the app and prepare a targets file based on
[`deploy/targets.example.json`](deploy/targets.example.json). Target addresses
must be literal Tailscale IPs or `127.0.0.1`; arbitrary DNS and LAN addresses are
rejected. Add a Mac using its Tailscale IP, port 5900, `protocol: "vnc"`,
`platform: "mac"`, and `persistent: false`.

```sh
node scripts/init-gateway.mjs ~/.config/gome-remote/gateway.json \
  https://YOUR-SERVER.YOUR-TAILNET.ts.net:8449 deploy/targets.example.json
sudo docker compose -f deploy/compose.yaml up -d
```

The compose configuration binds `guacd` to **127.0.0.1:4822**, uses a pinned
official image, and grants no extra capabilities. Its root filesystem is read-only;
an ephemeral `/home/guacd` tmpfs lets FreeRDP initialize its certificate store.
Without it, a read-only container can fail security negotiation before login.
Never publish guacd directly:
it has no application authentication.

Copy [`deploy/gome-remote-gateway.service`](deploy/gome-remote-gateway.service)
to `~/.config/systemd/user/`, adjusting its working directory and Node executable
if needed. Its default checkout is `~/remote`.

```sh
systemctl --user daemon-reload
systemctl --user enable --now gome-remote-gateway.service
sudo tailscale serve --bg --https=8449 http://127.0.0.1:38989
```

The backend only binds loopback. Tailscale Serve supplies HTTPS; do not use
Funnel. Use a separate HTTPS port to preserve any existing Serve routes, and
restrict it to the intended clients in your tailnet access policy. Check the
existing Serve configuration before adding it. Ensure the gateway's user manager
has lingering enabled if it must run without an interactive login.

The generated configuration contains the gateway access token. Retrieve it
locally and enter it in the app's connection settings. For Ubuntu Remote Login,
enter the existing system Remote Login credentials, then the Ubuntu password in GDM.
The old headless receipt password is only for the legacy endpoint.
Never commit either file, paste their contents in an issue, or print them in CI.
Desktop passwords are not stored in gateway configuration. A token authorizes
access to every configured target; this first version is for a single owner.

`ignoreCertificate: true` is an explicit option for a self-signed RDP endpoint
reached over loopback/Tailscale. It is not enabled globally. The HTTPS connection
to the gateway always uses normal certificate validation.

## macOS hosts

In **System Settings → General → Sharing → Screen Sharing**, enable access for
the intended account. Enable the option allowing VNC viewers to control the
screen with a password. Enter that password in Gome Remote; a VNC connection
does not use the gateway token or the Mac's login password.

Screen Sharing must be reachable over the Mac's Tailscale IP. Restrict the Mac's
VNC listener to intended networks using host/network policy; the application
cannot enforce the Mac's host firewall from another machine. Initial host setup,
FileVault unlock after reboot, and sleep/wake behavior remain OS responsibilities.
Do not overwrite an existing screen-sharing password to run a test.

## Desktop packages

```sh
npm run dist -- --mac      # run on macOS
npm run dist -- --win      # run on Windows
npm run dist -- --linux    # run on Linux
```

Artifacts are written to `release/`. The source includes a native OS build
workflow; it does not publish releases. Signing/notarization requires the owner's
signing credentials and is not configured. Unsigned packages may require OS
confirmation on first launch; do not globally disable Gatekeeper or SmartScreen.
macOS signing should stay consistent for stable Keychain access across updates.

Browser access uses the same HTTPS gateway URL. The Electron app additionally
stores credentials with Keychain/DPAPI or a Linux secret store. It refuses the
Linux `basic_text` fallback. Browser credentials exist only in memory; returning
to the server list clears the reconnect credential copy.

## Operations and removal

Changing target configuration requires restarting only the gateway service.
This drops connections but does not log out the dedicated desktop. Rotating the
gateway token also requires restarting the gateway, so old active connections
are closed. Re-enter the new token in each app.

To stop gateway access, stop the user gateway service and remove only its Serve
listener (`tailscale serve --https=8449 off`). Do not reset all Serve routes.
Stop the compose project with its own compose file.

Removing an app target does not remove its OS account or stop shared Ubuntu Remote
Login. Preserve the user's work before account removal. Once migration is accepted
and rollback is no longer needed, review only the old `gome-remote-*` units and
recovery directories for removal. Do not remove shared GDM/GRD, delete the user's
keyrings or restore a home snapshot over newer files as part of app cleanup.

## Upstream

Apache Guacamole 1.6.0 provides the RDP/VNC engine and browser client. Its
JavaScript source is vendored from the official archive with the archive checksum
and license notices in [`vendor/`](vendor/README.md). The Node gateway contains
only the authenticated WebSocket tunnel and guacd handshake adapter.

- [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [GNOME headless configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md)
- [Apple VNC access](https://support.apple.com/en-au/guide/remote-desktop/apde0dd523e/mac)
- [Electron credential storage](https://www.electronjs.org/docs/latest/api/safe-storage)

The isolated socket design follows [systemd socket proxy documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd-socket-proxyd.html).
