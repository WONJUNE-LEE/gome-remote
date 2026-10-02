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
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
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
    for binary in ["gnome-shell", "grdctl", "openssl", "nft", "runuser", "loginctl"]:
        if not shutil.which(binary):
            parser.error(f"Missing required command: {binary}")
    try:
        pwd.getpwnam(args.user)
    except KeyError:
        pass
    else:
        parser.error("The dedicated user already exists. Refusing to overwrite it.")
    state_dir = Path("/etc/gome-remote")
    if state_dir.exists():
        parser.error("/etc/gome-remote already exists. Refusing to overwrite an installation.")
    probe = socket.socket()
    try:
        probe.bind(("0.0.0.0", args.port))
    finally:
        probe.close()
    if subprocess.run(["nft", "list", "table", "inet", "gome_remote"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        parser.error("An existing gome_remote firewall table must be reviewed first.")

    run(["useradd", "--create-home", "--home-dir", f"/var/lib/{args.user}", "--shell", "/bin/bash", args.user])
    account = pwd.getpwnam(args.user)
    uid, gid = account.pw_uid, account.pw_gid
    home = Path(account.pw_dir)
    state_dir.mkdir(mode=0o700)
    password = secrets.token_urlsafe(32)
    private_write(state_dir / "headless.json", json.dumps({"user": args.user, "uid": uid, "port": args.port, "password": password}, indent=2))

    # The RDP daemon listens on all interfaces. Drop external traffic in a
    # dedicated table without flushing or changing any existing firewall rules.
    firewall = f"""add table inet gome_remote
flush table inet gome_remote
table inet gome_remote {{
  chain input {{
    type filter hook input priority -10; policy accept;
    tcp dport {args.port} iifname != "lo" iifname != "tailscale0" drop
    udp dport {args.port} iifname != "lo" iifname != "tailscale0" drop
  }}
}}
"""
    private_write(state_dir / "firewall.nft", firewall)
    run(["nft", "--check", "--file", str(state_dir / "firewall.nft")])
    private_write(Path("/etc/systemd/system/gome-remote-firewall.service"), f"""[Unit]
Description=Restrict Gome Remote RDP to Tailscale and loopback
Before=user@{uid}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft --file /etc/gome-remote/firewall.nft

[Install]
WantedBy=multi-user.target
""")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "gome-remote-firewall.service"])
    # Require the firewall before this dedicated user's manager may start.
    private_write(Path(f"/etc/systemd/system/user@{uid}.service.d/gome-remote.conf"), "[Unit]\nRequires=gome-remote-firewall.service\nAfter=gome-remote-firewall.service\n")
    run(["systemctl", "daemon-reload"])
    run(["loginctl", "enable-linger", args.user])
    run(["systemctl", "start", f"user@{uid}.service"])
    prefix = ["runuser", "-u", args.user, "--", "env", "LC_ALL=C", f"XDG_RUNTIME_DIR=/run/user/{uid}", f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus"]
    tls = home / ".local/share/gnome-remote-desktop"
    run(prefix + ["mkdir", "-p", str(tls)])
    run(prefix + ["openssl", "req", "-new", "-newkey", "rsa:2048", "-days", "730", "-nodes", "-x509", "-subj", f"/CN={args.user}", "-out", str(tls / "tls.crt"), "-keyout", str(tls / "tls.key")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(tls / "tls.key", 0o600)
    for command in [["set-port", str(args.port)], ["set-tls-cert", str(tls / "tls.crt")], ["set-tls-key", str(tls / "tls.key")], ["disable-port-negotiation"], ["disable-view-only"], ["enable"]]:
        run(prefix + ["grdctl", "--headless", "rdp"] + command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    set_credentials(prefix, args.user, password)
    run(prefix + ["gsettings", "set", "org.gnome.desktop.session", "idle-delay", "0"])
    run(prefix + ["gsettings", "set", "org.gnome.desktop.screensaver", "lock-enabled", "false"])
    units = home / ".config/systemd/user"
    run(prefix + ["mkdir", "-p", str(units)])
    private_write(units / "gome-remote-shell.service", """[Unit]
Description=Gome Remote dedicated headless GNOME desktop

[Service]
Type=dbus
BusName=org.gnome.Shell
Environment=XDG_SESSION_TYPE=wayland
Environment=XDG_CURRENT_DESKTOP=GNOME
ExecStart=/usr/bin/gnome-shell --headless --no-x11
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
""", uid, gid)
    private_write(units / "gome-remote-rdp.service", """[Unit]
Description=Gome Remote dedicated RDP service
Requires=gome-remote-shell.service
After=gome-remote-shell.service
Conflicts=gnome-remote-desktop-headless.service gnome-remote-desktop.service

[Service]
Type=dbus
BusName=org.gnome.RemoteDesktop.Headless
ExecStart=/usr/libexec/gnome-remote-desktop-daemon --headless
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
""", uid, gid)
    run(prefix + ["systemctl", "--user", "daemon-reload"])
    run(prefix + ["systemctl", "--user", "enable", "--now", "gome-remote-rdp.service"])
    print(f"Dedicated desktop configured for {args.user} on port {args.port}.")
    print("Credentials: /etc/gome-remote/headless.json (root-readable only).")
    print("Verify screen, input, disconnect/reconnect and reboot before relying on it.")


if __name__ == "__main__":
    main()
