# Gome Remote

One list of your own machines, on your own tailnet. Pick the Ubuntu server or the Mac
and the desktop fills the window. The same screen runs in the Windows app, the Mac app
and a browser.

Tiles show a coloured block per platform, an online dot, the name and one word of
state: 켜짐 (on), 꺼짐 (off) or 설정 필요 (needs setup). The Mac, which has its own agent,
also says 오프라인 (the agent does not answer), 권한 필요 (macOS permissions are missing),
권한 필요(의심) (the screen only returns black pictures, probably a missing permission) or
잠김 (the screen is locked). Off, unconfigured and unusable machines are dimmed and cannot
be opened; 권한 필요(의심) and 잠김 stay openable, so that a screen that has recovered can be
used and a locked Mac can be unlocked through the agent.

## How you sign in: one password

- **Ubuntu server.** Click the tile and the Ubuntu login screen (GDM) appears. Type the
  `gome` account password there, once. You land in the desktop session that is already
  running, with your windows as you left them. Disconnect and reconnect later: the
  session is still there and GDM asks for the password again, like a lock screen.
- **Mac.** Click the tile and the Mac screen appears. There is nothing to type in the
  app. The Mac runs a small agent of its own (see [The Mac agent](#the-mac-agent)) that
  streams the screen as H.264 video straight to your device; a second tile, **Mac (VNC)**,
  keeps the older route through Apple's Screen Sharing for unlocking the Mac, for
  allowing macOS permissions, and as a way back.
- **The app itself asks for nothing but the server address,** once, the first time.

What the machines need before their own login screen is stored on the gateway server by
its owner and injected by the gateway: the Ubuntu system Remote Login user name and
password, the Mac's macOS account name and password (Apple Remote Desktop
authentication, for the Mac (VNC) tile), and the Mac agent's token. No client stores or
sends a password or a token: the gateway decides from your Tailscale login.

## How it works

```text
Windows/Mac app (a thin window) or browser
  -> Tailscale HTTPS (Serve adds the Tailscale-User-Login header)
  -> gateway on a unix socket  (checks login and Origin, serves the UI, issues tickets)
  -> guacd on 127.0.0.1:4822   (Apache Guacamole, read-only container)
       -> 127.0.0.1:3389  GNOME Remote Desktop -> GDM -> your session
       -> <mac tailnet ip>:5900  macOS Screen Sharing   (the Mac (VNC) tile)

Mac (agent): the gateway only relays the connection set-up
  page --offer--> gateway --token--> agent on the Mac (<mac tailnet ip>:18471)
  page <== H.264 video and input, WebRTC over the tailnet, directly ==> agent
```

- The gateway listens only on a unix socket inside a 0700 directory. Only Tailscale Serve
  reaches it, and Serve overwrites the `Tailscale-User-Login` header with the real login.
- `/api/*` and the `/tunnel` WebSocket accept only logins listed in `allowedLogins`
  (required, no default). `/tunnel` also requires the exact public Origin. Connection
  tickets last 20 seconds and work once, for the login that requested them.
- The Mac agent accepts HTTP only from the gateway's tailnet address and only with the
  gateway's token; the video and the input then travel between your device and the Mac
  directly, encrypted (DTLS-SRTP), and never pass through the gateway.
- The desktop is shown inside the app. Nothing opens another remote desktop client.
- The gateway and `guacd` decrypt desktop traffic and keyboard input. Run them on a machine
  you trust. Anyone who can run code as the gateway's user can read the credentials file
  and reach the socket; with a passwordless-sudo account that is as powerful as root.
  The Mac credential is the macOS account's own name and password, so a compromised
  gateway exposes more than a screen-sharing-only password would. Every device that passes
  the login check can open the Mac screen without typing a password, so remove a lost
  device from Tailscale.

## Install the gateway (Ubuntu server)

Requirements: Node.js 24+, Docker, Tailscale, GNOME Remote Desktop with system
Remote Login enabled for the Ubuntu target.

```sh
git clone https://github.com/WONJUNE-LEE/gome-remote.git ~/remote
cd ~/remote
npm ci
npm run build
sudo docker compose -f deploy/compose.yaml up -d
```

The compose file binds `guacd` to **127.0.0.1:4822**, pins the official image, drops all
capabilities and keeps the root filesystem read-only. Never publish guacd: it has no
authentication of its own.

Copy [`deploy/targets.example.json`](deploy/targets.example.json) somewhere private, set
the Mac's Tailscale IP, then create the configuration. Target addresses must be literal
Tailscale IPs or `127.0.0.1`. A target's `protocol` is `rdp`, `vnc` or `agent`; an `agent`
target must have `platform: "mac"`, takes its port from the agent (default 18471) and
needs no other setting. The example file has three targets: the Ubuntu server (`rdp`),
the Mac through its agent (`mac`) and the Mac through Screen Sharing (`mac-vnc`). Without
a config path the command writes `~/.config/gome-remote/gateway.json` (or `$GOME_REMOTE_CONFIG`), the file the service unit
and `set-credential` read.

```sh
node scripts/init-gateway.mjs \
  --origin https://your-server.your-tailnet.ts.net:8450 \
  --login owner@example.com \
  --targets ~/targets.json
```

Repeat `--login` for each Tailscale login that may use the gateway. The file holds no
secrets. It points at `~/.local/state/gome-remote/gateway.sock` (the socket) and
`~/.config/gome-remote/credentials.json` (the credentials file).

`init-gateway` prints the `set-credential` command each target needs. Store each machine's
credentials with
`node scripts/set-credential.mjs [<gateway.json>] <target-id>`. The command prompts without echo
and writes the file atomically with mode 600; nothing is passed in arguments or
environment variables. It must run in a real terminal. With one argument the
configuration is `$GOME_REMOTE_CONFIG` or `~/.config/gome-remote/gateway.json`; give the
config path first to use another file.

```sh
node scripts/set-credential.mjs ubuntu-server        # system Remote Login user name + password
node scripts/set-credential.mjs mac-vnc              # macOS account name + password (Mac (VNC))
node scripts/set-credential.mjs <gateway.json> mac --agent-token    # the token the Mac's install.sh showed
```

Always give the config path with `--agent-token`: without it the command writes into the
default configuration's credentials, and during the parallel rollout (section 9 of
[`docs/mac-agent-spec.md`](docs/mac-agent-spec.md)) the file you mean is the candidate's
`gateway.json`, not the running gateway's.

A target without stored credentials shows as 설정 필요. The gateway re-reads the file on
every request, so no restart is needed after `set-credential`. The gateway refuses to
start if the file is not mode 600, is not owned by the gateway user, or is malformed.
Each entry has the shape of its target's method: `{username, password}` for RDP and VNC,
`{agentToken}` for a Mac agent, never a mixture; an entry that does not fit its target
makes the whole file invalid. `--agent-token` is required for agent targets and refused
for the others; the token, like the passwords, is typed at the prompt and never given as an
argument.

Run it as a user service and publish it with Tailscale Serve on a port of its own:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/gome-remote-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gome-remote-gateway.service
sudo tailscale serve --bg --https=8450 unix:$HOME/.local/state/gome-remote/gateway.sock
```

Do not use Funnel. Check `tailscale serve status` first and use a free port so existing
routes stay untouched. The socket lives under `~/.local/state`, not `/tmp`, because the
unit sets `PrivateTmp=true`. Enable lingering (`loginctl enable-linger $USER`) if the
service must run without a login session.

If a 0.1.x gateway already runs on this host, do not follow the steps above as written:
the unit name, the configuration path and the Serve port are the ones it uses, and
copying the unit over it would replace the running service. Follow the parallel procedure
in section 8 of [`docs/redesign-spec.md`](docs/redesign-spec.md) instead: a new unit name,
a new configuration path and a new Serve port. Adding the Mac agent to a running gateway
follows section 9 of [`docs/mac-agent-spec.md`](docs/mac-agent-spec.md), which also says
when `publicOrigin` has to change. The unit file hardcodes
`WorkingDirectory=%h/remote` and `Environment=GOME_REMOTE_CONFIG=...`, so a copy for
another checkout or configuration must change both lines.

### The Mac (VNC)

On the Mac, turn on Screen Sharing for the owner's account (System Settings > General >
Sharing > Screen Sharing). macOS then makes `guacd` authenticate with Apple Remote
Desktop credentials, so the credential for a `vnc` Mac target is that macOS account's name
and password. On the server, run `node scripts/set-credential.mjs mac-vnc` and enter the
macOS account name and password. The separate "VNC viewers may control screen with
password" option is not needed; leave it off. The gateway asks for 16-bit colour from
the Mac to keep a 4K screen responsive, so gradients may show slight banding. This
route measured about 170 to 180 ms from click to picture; it stays as the tile for
unlocking the Mac, allowing permissions and as a fallback.

### The Mac agent

A small program in [`agent/mac`](agent/mac) (Rust) that captures the screen with
ScreenCaptureKit, encodes H.264 on the Mac's hardware encoder and sends it over WebRTC;
keyboard and mouse come back on a data channel and are posted as system events. It runs
in the owner's login session, so it exists only while the owner is logged in: after a
reboot, before login, the tile says 오프라인. The design and its decisions are in
[`docs/mac-agent-spec.md`](docs/mac-agent-spec.md).

Requirements: macOS 14 or later (the ScreenCaptureKit APIs the agent uses), Rust, the Xcode
command line tools and Tailscale on the Mac (developed and tested on macOS 27). Install and update are the same command, in Terminal on the Mac, as
the logged-in user (not with `sudo`):

```sh
git clone https://github.com/WONJUNE-LEE/gome-remote.git ~/gome-remote   # or update it
cd ~/gome-remote/agent/mac
./install.sh
```

It asks for the Mac's Tailscale address and the gateway server's Tailscale address (first
install only), builds (`cargo build --release --locked`), signs the program with a
certificate it keeps in a keychain of its own (a stable signature is what keeps the macOS
permissions across updates), installs it as root-owned `/usr/local/libexec/gome-remote-agent`
(it asks for the administrator password), writes the root-owned settings
`/usr/local/etc/gome-remote-agent/agent.json` once (the two addresses, port 18471),
creates the token once, loads the LaunchAgent `net.gome.remote-agent`, and checks that the
new program answers within 10 seconds (any HTTP answer of 200, 401 or 403 counts: from the
Mac itself the agent refuses, which proves it is serving). If it does not answer, the
previous program (`gome-remote-agent.prev`) is put back. The installer refuses to run as
root, refuses the environment variables that exist only for its tests, and refuses to
install a program built for development as the operational one.

After the **first** install, two things need a person at the Mac: in System Settings >
Privacy & Security allow `gome-remote-agent` under **Screen & System Audio Recording** and
under **Accessibility**, then restart it with
`launchctl kickstart -k gui/$(id -u)/net.gome.remote-agent` (macOS only applies a new
permission to a program that starts afterwards). On the gateway server run
`node scripts/set-credential.mjs <gateway.json> mac --agent-token` (the path of the gateway
configuration you are setting up; during the parallel rollout that is the candidate's
`gateway.json`) and paste the token the installer showed (it is shown once; it stays in
`~/Library/Application Support/Gome Remote Agent/token`). In Korean Mac settings, the 한/영 key needs **System Settings > Keyboard >
Input Sources > Use the Caps Lock key to switch to and from ABC** to be on: the Windows
Hangul key is sent as one Caps Lock press.

Good to know:

- **Security.** The agent listens only on the Mac's Tailscale address, answers only the
  gateway's address, and only with the token. Its program and settings are root-owned, it
  takes no argument and no environment variable, and it is signed with the hardened
  runtime. Anyone who controls the gateway server can therefore control the Mac's screen
  and input (as before, when the server held the Mac account password).
- **The 30-day reconfirmation.** macOS 27 asks the owner every 30 days to confirm that a
  program may record the screen. If the screen goes blank or the tile says 권한 필요 (or
  권한 필요(의심)) around then, open Mac (VNC) and click the confirmation window.
- **Updating.** Run `./install.sh` again; the token and settings are kept. The administrator
  password is needed every time, because the program lives in a root-owned folder. If
  the new program does not answer, the old one is restored and the installer says so.
  `./install.sh --dev` installs a separate copy under your home directory for development:
  its own port 18472, label `net.gome.remote-agent-dev`, token, settings and log, and no
  password. Point a separate target at that port to use it.
- **Removing.** `./uninstall.sh` (add `--dev` for the development copy; `--yes` skips the
  question) removes the LaunchAgent, program, settings, token and log. The signing keychain
  is shared by both installs and goes with whichever is removed last, so `--dev` leaves it
  while an operational install exists. Then delete the two entries in System Settings
  yourself; macOS does not let a program do that.
- **Logs.** `~/Library/Logs/gome-remote-agent.log` holds start-up, permission and
  session lines, one statistics line every ten seconds while someone watches, and is
  emptied when it passes 5 MiB.
- **Scope.** The main display only, no sound. Text clipboard sync with the desktop app or a
  browser (see "Using it"), and a typed paste at the lock screen (the held text is typed
  with key codes; nothing else is automated there). No key remapping: Ctrl stays Control,
  Alt stays Option, the Windows key stays Command. Agent 0.2.0 is the first with clipboard
  sync; installing it needs the owner's `./install.sh` (administrator password), and an older
  agent simply ignores the clipboard messages. With the older agent (0.1.0) the page's paste
  therefore gives no signal at all (no text arrives and no notice appears) until the agent is
  updated.

### Notes

`ignoreCertificate: true` in the Ubuntu target accepts GNOME Remote Desktop's
self-signed certificate on loopback. It is a per-target choice, never global.

## Install the desktop app

Download the installer for your system from the
[latest GitHub Release](https://github.com/WONJUNE-LEE/gome-remote/releases/latest): the
Windows `.exe`, the Mac `.dmg` or the Linux `.AppImage`. You can also build them
yourself (`npm run dist -- --win`, `--mac`, `--linux` on the matching OS; artifacts land in
`release/`).

The first install is manual, and neither build is signed by Microsoft or Apple, so confirm
the first-launch prompt (do not disable Gatekeeper or SmartScreen globally):

- Windows: SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**.
- Mac (Apple Silicon only; the disk image is an arm64 build): the app is signed with a
  self-signed certificate, which macOS does not trust. On macOS 15 and later, try to open the
  app once, then go to **System Settings → Privacy & Security** and choose **Open Anyway**
  (right-click → Open no longer skips the check there). On older macOS, right-click the app
  and choose **Open**.

After that, updates arrive by themselves. The packaged app looks for a new release shortly
after it starts and then every 6 hours, and downloads it in the background. It never
restarts on its own, because you may be in a remote session. The update is installed when
you quit the app, or right away with **원격 → 다시 시작해서 업데이트**, which appears once
a download has finished. **원격 → 업데이트 확인** checks now and tells you the result.
Errors in the background check are only logged. A development run (`npm start`) never
updates itself.

On first launch the app asks for the server address, for example
`your-server.your-tailnet.ts.net:8450`, and then shows the gateway's own page. Change
it later from **원격 → 서버 주소 바꾸기** or the `⋯` menu. If the gateway cannot be
reached the app shows the address page again. On first launch the app deletes the `vault.enc`
that 0.1.x versions left in its data directory.

Open the same address in a browser for the identical screen.

## Using it

- Click a tile. While connecting, the window shows a spinner and "<name>에 연결하는 중".
- In the app, use the native **원격** menu: 서버 목록, 해상도 (RDP and the Mac agent; 자동 by default; apps older than bridge version 2 offer fixed sizes only), 텍스트 입력,
  클립보드 붙여넣기 (bridge version 4 or later), 다시 연결, 연결 종료. F11 and
  **View → 전체 화면** toggle full screen locally; Escape stays a remote key.
- In a browser the same controls sit in a bar above the picture, never over it.
- One pointer is drawn over a connected desktop: the remote cursor on the Guacamole paths (RDP
  and VNC), and your own device's pointer in a Mac (agent) session, whose picture has no cursor in it.
- Resolution (Ubuntu, RDP) defaults to **자동 (창 크기)**: the remote desktop follows the window
  size and is resized shortly after the window stops changing. Fixed sizes remain in the menu.
- A Mac (VNC) session uses guacd's local cursor: a normal pointer instead of a dot, moving without round-trip lag.
- A Mac (agent) session shows your own device's pointer over the picture, and the Mac's
  cursor follows it (so hover effects work); the Mac's pointer shapes, such as the text
  cursor, are not shown. Ctrl is Control, Alt is Option and the Windows key is Command.
  The text input window types the characters directly and does not touch the Mac's
  clipboard (it is separate from clipboard sync). Opening `#measure` after the address (for example
  `https://your-server.your-tailnet.ts.net:8450/#measure`) shows a small panel that times
  click-to-picture for whichever Mac session is open; without it the page is unchanged.
- Clipboard (text only, at most 64 KiB of UTF-8; larger text is not sent or cut, and a short
  notice says so). Nothing is pushed when a session starts. Client to remote: the text is
  sent when the remote view gains focus and right before a paste, that is a paste key
  (Cmd+V on a Mac target; Ctrl+V, Ctrl+Shift+V or Shift+Insert elsewhere) or the
  **클립보드 붙여넣기** menu item or bar button. The paste key and every input after it wait up to
  500 ms for the clipboard to be read, so the new text is in place before the V. The menu item
  reads the clipboard even though the native menu took focus from the page, and retries once.
  Remote to client: only while the remote view is focused; a change made while another window
  is in front is dropped. Known limit: a Mac copy made in the last few hundred milliseconds
  before the view loses focus may not arrive; copy again with the view focused. Line endings
  are LF on Mac and Ubuntu and CRLF on Windows. Empty or non-text clipboards are ignored.
  Short notices (4 seconds) appear when text exists but was not sent: too large, the Mac
  refused the read, the bridge refused, or the read timed out. A browser works at best effort
  with the browser's own clipboard permission; a refused permission is silent. An app older
  than bridge version 4 (0.3.2 and earlier) has no clipboard sync and no menu item; the
  update arrives with the next desktop release tag.
- Mac (agent) clipboard writes are current-host-only (Universal Clipboard does not carry
  them to other Apple devices). Text the Mac marks as concealed (password managers) is passed on
  with the matching mark where the system allows it. If Windows Clipboard History still keeps
  Mac-copied text, that is a residual risk: writing the mark on Windows is not yet tested there.
  No clipboard text is logged anywhere; only the reason and the byte length.
- Lock screen (Mac agent): when the Mac is really locked (the console lock, not just a sleeping
  display), Cmd+V or **클립보드 붙여넣기** types the client's text into the password field with key
  codes (characters outside the US layout fall back to Unicode typing). The text is held in the
  agent's memory only and is never written to the Mac pasteboard; it is dropped on unlock and
  at session end. One trailing line break is dropped; text with a line break inside is refused
  with a notice. VNC sessions have no such special case.
- Windows key (desktop app on Windows): full screen (F11 or **View → 전체 화면**) is HTML full
  screen with the keyboard locked to the page, so Win+V, Win+C and the bare Windows key go to
  the Mac as Command. While locked the page handles F11 itself to leave full screen; hold
  Escape for about 2 seconds to leave as well (a tap stays a remote key). A denied full-screen
  permission falls back to ordinary full screen after 2 seconds, without Windows key capture.
  In a window, the Windows key stays with Windows; use **클립보드 붙여넣기**.
- Korean text over Mac (VNC): whether macOS Screen Sharing carries Korean and emoji in the
  clipboard is not yet measured (see `docs/verification.md`); until it is, assume Latin-1 text
  only on that path. The Mac agent carries Unicode; Ubuntu (RDP) with Korean is also still to be checked.
- Lost connection: the window says **연결이 끊겼습니다 / 작업은 그대로 남아 있습니다**.
  Choose 다시 연결 or 목록으로. A Mac (agent) session also ends this way once its
  connection has been down for 3 seconds. If another device opens the same Mac (agent), the
  older window says **다른 기기에서 연결했습니다** at once; 다시 연결 takes the session
  back. If the page vanishes (browser killed, network lost), the agent lets go of any held
  key or mouse button after 3 seconds of silence.
- If this device's Tailscale account is not in `allowedLogins`, the window says
  **이 기기의 Tailscale 계정으로는 쓸 수 없습니다**.

Not included: audio, file transfer, discovery, several users, per-device allow lists,
Apple/Microsoft code signing (the Mac build uses a self-signed certificate), unattended Mac
login after a FileVault reboot.

## Operations

- **Restart** the gateway after changing `gateway.json` (targets, logins):
  `systemctl --user restart gome-remote-gateway.service`. Connections drop; the Ubuntu
  session and its windows do not.
- **Change a password:** run `set-credential` again for that target. No restart.
- **Stop access:** stop the service and remove only its Serve listener,
  `sudo tailscale serve --https=8450 off`. Never reset all Serve routes.
- **A Mac (agent) tile says 오프라인** when the agent does not answer: the Mac is off or
  asleep, nobody is logged in, or the program stopped (`launchctl print
gui/$(id -u)/net.gome.remote-agent` on the Mac). **권한 필요**: allow the two permissions
  (or the 30-day reconfirmation) through Mac (VNC). **잠김** (the screen is locked): the
  tile still opens, and the agent shows the lock screen and takes keys, so the Mac is
  unlocked through the agent (spec P1, 2026-10-16); Mac (VNC) stays as the fallback. **권한 필요(의심)**: the screen
  returned only black pictures for a few seconds, or the system stopped the capture while the
  permission still reads as granted; the tile still opens (the mark clears at the next
  session), and if the picture stays black the permission is the first thing to check. After a token change on the Mac
  (delete `token` and run `install.sh`), run
  `node scripts/set-credential.mjs <gateway.json> <id> --agent-token` again; the
  gateway log says when a token was refused ("did not accept the gateway token").
- **Startup refused?** The log says why (`journalctl --user -u gome-remote-gateway`):
  an empty `allowedLogins`, a legacy `token` field, a credentials file whose mode is not
  600, or a socket directory open to group or others.
- **Stale socket:** a SIGKILL or crash can leave the socket file behind. The next start
  removes it only if it is a socket with nobody listening, and refuses to touch anything
  else.

## Legacy dedicated account

The dedicated-account recovery and rollback tools are in the git tag
`legacy-dedicated-account` (commit `89ab9ec`), for example
`git show legacy-dedicated-account:scripts/setup-remote-login.py`. The old dedicated-account
desktop (`gome-remote-review`) and those tools are gone from this tree. Disabling or
removing that account on a server is a separate, deliberate step that this project does not
perform.

## Development

Node.js 24+ and npm. No production credentials are needed.

```sh
npm ci
npm test          # unit and integration tests
npm run check     # TypeScript
npm run build     # UI into dist/
npm start         # the desktop app (Electron)
```

CI also starts the real Electron on the local address page (`electron . --smoke-test`,
Linux runner) and fails unless the page and the bridge, version 3, are as expected. The
updater is off in that run.

### Releasing the desktop app

1. Raise `version` in `package.json` (and `package-lock.json`; `npm version X.Y.Z --no-git-tag-version`
   does both) and merge it to `main`.
2. Tag the merge commit `vX.Y.Z` and push the tag. `.github/workflows/release.yml` fails unless the
   tag is `v` plus the `package.json` version, builds Windows, Mac and Linux, uploads them into one
   draft release, and publishes it only when `latest.yml`, `latest-mac.yml`, `latest-linux.yml`,
   the installers, and a `<name>.blockmap` for every `.exe` and `.zip` are all attached (the
   updater fetches `<zip url>.blockmap`, so `package.json` sets Mac artifact names without a
   space). Installed apps never see a half-filled release.
3. The Mac job needs the repository secrets `MAC_SIGN_P12_BASE64` and `MAC_SIGN_P12_PASSWORD`
   (it fails without them rather than ship an unsigned Mac build). Make them once with
   `scripts/make-mac-signing-cert.sh --keep <private directory>`, which prints both values,
   and keep the `.p12` safe. Every release must be signed by this same certificate (20 years):
   macOS installs an update only if it is signed like the app it replaces. If the certificate
   is lost or replaced, Mac users have to install the next version by hand once.

The Mac agent (`agent/mac`) uses macOS frameworks and builds only on a Mac:

```sh
cd agent/mac
cargo test --locked                    # unit tests; most of them also run on Linux
cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check
cargo build --release --locked --features dev-install
```

CI runs the same checks, plus `cargo deny check`, on a macOS runner (the `agent-mac` job).
`scripts/measure-drive.mjs` drives the `#measure` panel from a headless Chrome for the
verification runs of section 8 of the agent spec.

`npm test` runs a real gateway on a real unix socket with an independent guacd wire
fixture: login and Origin checks, ticket rules, credential injection, refusal of client
credentials, stale-socket recovery, the credentials file's mode and ownership checks,
`set-credential`'s prompts and atomic write, the desktop shell's origin checks, the UI's
API layer, and that the public tree holds only placeholder identifiers. It does not
control a real Windows or Mac machine; see [`docs/verification.md`](docs/verification.md).

To run everything locally, write a development configuration with a loopback origin and
a `devLogin`, which is allowed only for `http://127.0.0.1:<port>`:

```json
{
  "socketPath": "/tmp/gome-remote-dev/gateway.sock",
  "publicOrigin": "http://127.0.0.1:38991",
  "devLogin": "dev@example.com",
  "allowedLogins": ["dev@example.com"],
  "credentialsFile": "/tmp/gome-remote-dev/credentials.json",
  "targets": [
    {
      "id": "ubuntu-server",
      "name": "Ubuntu 서버",
      "platform": "linux",
      "protocol": "rdp",
      "profile": "gnome-remote-login",
      "hostname": "127.0.0.1",
      "port": 3389,
      "persistent": true
    }
  ]
}
```

```sh
npm run build
GOME_REMOTE_CONFIG=./dev-gateway.json node server/index.js   # also relays 127.0.0.1:38991
node scripts/set-credential.mjs ./dev-gateway.json <target-id>
```

Open `http://127.0.0.1:38991/` in a browser, or run `npm start` and enter that address.
`npm run dev` serves the UI alone for layout work; its API calls fail, which shows the
"서버에 연결할 수 없습니다" screen.

## Upstream

Apache Guacamole 1.6.0 provides the RDP/VNC engine and browser client. Its JavaScript is
vendored from the official archive with checksum and licence notices in
[`vendor/`](vendor/README.md). The Node gateway contains only the authenticated
WebSocket tunnel and the guacd handshake adapter.

- [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
- [GNOME Remote Desktop configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md)
- [Apple VNC access](https://support.apple.com/en-au/guide/remote-desktop/apde0dd523e/mac)
- [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)
