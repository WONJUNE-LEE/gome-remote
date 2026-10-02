#!/usr/bin/env python3
"""Create a dedicated GNOME desktop without changing existing user sessions."""
import argparse
import json
import os
from pathlib import Path
import pty
import pwd
import re
import secrets
import select
import shutil
import signal
import socket
import subprocess
import time


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def private_write(path, content, uid=0, gid=0):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
    os.chown(path, uid, gid)


def set_credentials(prefix, username, password):
    # grdctl 50 crashes when its password prompt has no terminal. A private PTY
    # keeps the password out of argv and logs while satisfying the prompt.
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(prefix[0], prefix + ["grdctl", "--headless", "rdp", "set-credentials", username])
    buffered = b""
    sent = False
    completed = False
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    buffered += os.read(fd, 4096)
                except OSError:
                    break
                if b"password" in buffered.lower() and not sent:
                    os.write(fd, (password + "\n").encode())
                    sent = True
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                completed = True
                if os.waitstatus_to_exitcode(status) != 0 or not sent:
                    raise RuntimeError("Credential setup failed; no secret output was logged")
                return
        if sent:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                completed = True
                if os.waitstatus_to_exitcode(status) == 0:
                    return
        raise RuntimeError("Credential setup did not finish")
    finally:
        if not completed:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", default="gome-remote")
    parser.add_argument("--port", type=int, default=33490)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run with sudo")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", args.user) or not 1024 <= args.port <= 65535:
        parser.error("Invalid user or port")
    for binary in ["gnome-shell", "grdctl", "openssl", "runuser", "loginctl", "unshare", "dbus-update-activation-environment", "xdg-user-dirs-update"]:
        if not shutil.which(binary):
            parser.error(f"Missing required command: {binary}")
    try:
        pwd.getpwnam(args.user)
    except KeyError:
        pass
    else:
        parser.error("The dedicated user already exists. Refusing to overwrite it.")
    state_dir = Path("/etc/gome-remote")
    # Desktop applications (including confined Snap apps) expect a normal home.
    home = Path(f"/home/{args.user}")
    legacy_home = Path(f"/var/lib/{args.user}")
    system_units = Path("/etc/systemd/system")
    unit_names = ["gome-remote-rdp.service", "gome-remote-rdp-proxy.service", "gome-remote-rdp-proxy.socket"]
    # Refuse all existing destinations, including dangling links and old installations.
    for path in [state_dir, home, legacy_home, system_units / "gome-remote-firewall.service", *[system_units / name for name in unit_names]]:
        if os.path.lexists(path):
            parser.error(f"Existing installation resource: {path}. Refusing to overwrite it.")
    proxy = Path("/usr/lib/systemd/systemd-socket-proxyd")
    if not os.access(proxy, os.X_OK):
        parser.error("Missing systemd-socket-proxyd")
    # Fail before mutation on hosts that cannot isolate the RDP listener.
    run(["unshare", "--net", "true"])
    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", args.port))
    finally:
        probe.close()

    run(["useradd", "--create-home", "--home-dir", str(home), "--shell", "/bin/bash", args.user])
    account = pwd.getpwnam(args.user)
    uid, gid = account.pw_uid, account.pw_gid
    home = Path(account.pw_dir)
    state_dir.mkdir(mode=0o700)
    password = secrets.token_urlsafe(32)
    private_write(state_dir / "headless.json", json.dumps({"user": args.user, "uid": uid, "port": args.port, "password": password}, indent=2))

    units = home / ".config/systemd/user"
    run(["runuser", "-u", args.user, "--", "mkdir", "-p", str(units)])
    # Disable the stock daemons before starting the user manager: only the system
    # service in its private network namespace may launch this user's RDP daemon.
    for name in ["gnome-remote-desktop-headless.service", "gnome-remote-desktop.service"]:
        os.symlink("/dev/null", units / name)
    run(["loginctl", "enable-linger", args.user])
    run(["systemctl", "start", f"user@{uid}.service"])
    prefix = ["runuser", "-u", args.user, "--", "env", "LC_ALL=C", f"XDG_RUNTIME_DIR=/run/user/{uid}", f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus"]
    # Ubuntu's desktop icons extension needs the user's Desktop directory.
    run(prefix + ["xdg-user-dirs-update"])
    tls = home / ".local/share/gnome-remote-desktop"
    run(prefix + ["mkdir", "-p", str(tls)])
    run(prefix + ["openssl", "req", "-new", "-newkey", "rsa:2048", "-days", "730", "-nodes", "-x509", "-subj", f"/CN={args.user}", "-out", str(tls / "tls.crt"), "-keyout", str(tls / "tls.key")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(tls / "tls.key", 0o600)
    for command in [["set-port", str(args.port)], ["set-tls-cert", str(tls / "tls.crt")], ["set-tls-key", str(tls / "tls.key")], ["disable-port-negotiation"], ["disable-view-only"]]:
        run(prefix + ["grdctl", "--headless", "rdp"] + command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(prefix + ["gsettings", "set", "org.gnome.desktop.remote-desktop.rdp.headless", "enable", "true"])
    set_credentials(prefix, args.user, password)
    run(prefix + ["gsettings", "set", "org.gnome.desktop.session", "idle-delay", "0"])
    run(prefix + ["gsettings", "set", "org.gnome.desktop.screensaver", "lock-enabled", "false"])
    run(prefix + ["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "dock-position", "BOTTOM"])
    run(prefix + ["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "dock-fixed", "true"])
    private_write(units / "gome-remote-shell.service", """[Unit]
Description=Gome Remote dedicated headless GNOME desktop
BindsTo=graphical-session.target
Before=graphical-session.target

[Service]
Type=dbus
BusName=org.gnome.Shell
Environment=XDG_SESSION_TYPE=wayland
Environment=XDG_CURRENT_DESKTOP=ubuntu:GNOME
# D-Bus/systemd-launched applications must see the same desktop as the shell.
ExecStartPre=/usr/bin/dbus-update-activation-environment --systemd XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
ExecStart=/usr/bin/gnome-shell --headless --no-x11 --mode=ubuntu
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
""", uid, gid)
    run(prefix + ["systemctl", "--user", "daemon-reload"])
    run(prefix + ["systemctl", "--user", "enable", "--now", "gome-remote-shell.service"])
    private_write(system_units / "gome-remote-rdp.service", f"""[Unit]
Description=Gome Remote isolated RDP daemon
Requires=user@{uid}.service
After=user@{uid}.service
PartOf=user@{uid}.service

[Service]
Type=exec
User={args.user}
Environment=HOME={home}
Environment=XDG_RUNTIME_DIR=/run/user/{uid}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus
ExecStartPre=/usr/bin/systemctl --user start gome-remote-shell.service
ExecStart=/usr/libexec/gnome-remote-desktop-daemon --headless
PrivateNetwork=yes
Restart=on-failure
RestartSec=3

[Install]
WantedBy=user@{uid}.service
""")
    private_write(system_units / "gome-remote-rdp-proxy.socket", f"""[Unit]
Description=Gome Remote loopback-only RDP socket

[Socket]
ListenStream=127.0.0.1:{args.port}
NoDelay=true

[Install]
WantedBy=sockets.target
""")
    private_write(system_units / "gome-remote-rdp-proxy.service", f"""[Unit]
Description=Forward the loopback RDP socket into the isolated daemon
Requires=gome-remote-rdp.service
After=gome-remote-rdp.service
JoinsNamespaceOf=gome-remote-rdp.service
PartOf=gome-remote-rdp.service

[Service]
User={args.user}
ExecStart={proxy} 127.0.0.1:{args.port}
PrivateNetwork=yes
NoNewPrivileges=yes
""")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "gome-remote-rdp.service", "gome-remote-rdp-proxy.socket"])
    print(f"Dedicated desktop configured for {args.user} on port {args.port}.")
    print("Credentials: /etc/gome-remote/headless.json (root-readable only).")
    print("RDP is reachable only on loopback. Run guacd/gateway on this host.")
    print("Verify screen, input, disconnect/reconnect and reboot before relying on it.")


if __name__ == "__main__":
    main()
