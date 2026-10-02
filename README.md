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

## Ubuntu headless desktop

The installer is for Ubuntu 26.04 with GNOME 50, `gnome-remote-desktop`, `openssl`,
systemd with network namespaces, and `systemd-socket-proxyd`. It creates a **new, dedicated Linux user** with its own
home under `/home/<user>` and applications, including Snap-installed Firefox.
It does not reuse or expose your existing login session.
It refuses existing users, homes, state directories, and unit files (including
dangling symlinks). New files are created exclusively, never overwritten.

```sh
sudo python3 scripts/setup-headless.py --user gome-remote --port 33490
```

The installer creates:

- A dedicated user and a lingering systemd user manager for the GNOME shell.
- Ubuntu GNOME/Wayland environment exported to both D-Bus and systemd application
  activation before the shell starts, so desktop-launched Settings recognizes GNOME.
  `ubuntu:GNOME` selects Ubuntu's installed default wallpaper and theme instead
  of upstream GNOME wallpaper paths that may not exist on Ubuntu.
- A graphical session target tied to the shell, allowing desktop portals to start.
- A headless GNOME shell and a system RDP service running as that user in its
  own private network namespace. The stock user RDP services are masked.
- A local TLS certificate and random RDP credentials, with the private key
  readable only by that user. The credential receipt is
  `/etc/gome-remote/headless.json`, mode `0600`, owned by root.
- A socket bound only to `127.0.0.1`, forwarded into the RDP namespace by
  `systemd-socket-proxyd`. Host firewall reloads cannot expose the isolated RDP
  listener. This installer does not modify any host firewall rules.

Run `guacd` and the gateway on **the same Ubuntu host** as this dedicated desktop.
The RDP port itself is not reachable over Tailscale or the LAN; remote clients
reach it through the authenticated gateway. For a second Ubuntu host, deploy a
separate gateway there. The GNOME desktop's applications retain normal host
networking; only the RDP daemon and its socket proxy are isolated.

RDP connections enable desktop wallpaper. A physical monitor is not required
for the wallpaper or applications. New installation requires
`dbus-update-activation-environment` (Ubuntu's `dbus-bin` package).
The installer does not upgrade existing accounts. For a legacy `/var/lib/<user>`
home, preserve files and credentials before a planned session shutdown and home
relocation; TLS certificate paths and the RDP service's `HOME` must also be updated.
Simply moving the directory while the desktop is running is not supported.

Do **not** add `--virtual-monitor` to the GNOME shell. GNOME Remote Desktop creates
the display when a client connects; pre-creating another monitor can select an
empty secondary desktop. Keep the shell running when clients disconnect.

The dedicated desktop intentionally disables screen blanking and locking. RDP
authentication and Tailscale are the access boundary. The Linux account has no
sudo privileges. GPU acceleration is not required; software rendering is used
when the user has no GPU access. This is aimed at server administration and
development, not gaming or high-frame-rate video.

After installation, verify mouse and keyboard input, disconnect/reconnect,
and startup after reboot during a suitable maintenance window. A reboot closes
running applications; session persistence here means **network disconnection**,
not preserving process memory across reboots. A compositor crash also ends the
graphical applications. Do not restart the shared host as part of a casual test.

If installation fails partway, it prints the failed command and leaves created
resources for inspection. Do not blindly rerun or delete the user's home.
Credentials never appear in installer output or command-line arguments.

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
official image, and grants no extra capabilities. Never publish guacd directly:
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
locally and enter it in the app's connection settings. Enter the separate RDP
credentials from the root-readable headless receipt when opening Ubuntu.
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

For headless removal, first preserve the dedicated user's work. Stop and disable
`gome-remote-rdp-proxy.socket` and `gome-remote-rdp.service` with system `systemctl`,
and stop `gome-remote-rdp-proxy.service`. Stop the dedicated user's
`gome-remote-shell.service` and user manager, then disable linger. Remove only
those three system unit files and their enablement links after reviewing them.
Review the dedicated home and `/etc/gome-remote` before deleting anything.
There is intentionally no destructive one-command uninstall.

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
