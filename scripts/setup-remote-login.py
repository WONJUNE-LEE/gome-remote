#!/usr/bin/env python3
"""Inspect Ubuntu Remote Login and migrate an app-owned legacy desktop.

Shared GDM/GRD, firewall policy and encrypted keyring contents are never changed.
Run inspect first; prepare only writes private recovery material. Migrating and
rolling back require an explicit session-stop option and a saved-work checkpoint.
"""
import argparse
import base64
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time

STATE_ROOT = Path("/var/lib/gome-remote-login")
RECEIPT = Path("/etc/gome-remote/headless.json")
UNITS = ("gome-remote-rdp.service", "gome-remote-rdp-proxy.socket",
         "gome-remote-rdp-proxy.service")
DCONF_KEYS = ("/org/gnome/desktop/session/idle-delay",
              "/org/gnome/desktop/screensaver/lock-enabled",
              "/org/gnome/desktop/remote-desktop/rdp/headless/enable")
STOP_RELATIONS = ("PropagatesStopTo", "ConsistsOf", "BoundBy", "RequiredBy", "RequisiteOf")


class Refuse(RuntimeError):
    pass


def run(args, *, input=None, ok=(0,)):
    """Never include command input or subprocess output in an exception."""
    result = subprocess.run(args, input=input, capture_output=True, text=True)
    if result.returncode not in ok:
        raise Refuse(f"{args[0]} failed (exit {result.returncode}); recovery state retained")
    return result.stdout.strip()


def require(condition, message):
    if not condition:
        raise Refuse(message)


def trusted_directory(path, *, create=False):
    if create and not os.path.lexists(path):
        path.mkdir(mode=0o700)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            stat.S_IMODE(info.st_mode) == 0o700,
            f"Expected a root-owned private directory: {path}")


def private_json(path, value):
    """Durable atomic receipt replacement inside an already trusted directory."""
    trusted_directory(path.parent)
    fd, name = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600,
                f"Expected root-owned mode 0600 file: {path}")
        return json.load(stream)


def fingerprint(path, owner):
    # Intermediate links can escape the account's home even with O_NOFOLLOW.
    for parent in path.parents:
        require(not parent.is_symlink(), f"Symlinked resource ancestor: {parent}")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == owner,
                f"Unexpected resource owner or type: {path}")
        data = stream.read()
    return {"sha256": hashlib.sha256(data).hexdigest(), "uid": info.st_uid,
            "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode),
            "data": base64.b64encode(data).decode()}


def shell_enablement(user):
    path = Path(user.pw_dir) / ".config/systemd/user/default.target.wants/gome-remote-shell.service"
    for parent in path.parents:
        require(not parent.is_symlink(), f"Symlinked enablement ancestor: {parent}")
    return path


def account(name):
    require(re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name), "Invalid account name")
    user = pwd.getpwnam(name)
    require(user.pw_uid >= 1000 and user.pw_dir == f"/home/{name}",
            "Expected a dedicated regular account under /home")
    home = Path(user.pw_dir)
    require(not home.is_symlink() and home.is_dir() and home.stat().st_uid == user.pw_uid,
            "Unexpected home directory type or ownership")
    groups = run(["id", "-Gn", name]).split()
    require(not set(groups) & {"sudo", "admin", "root", "docker", "lxd", "disk"},
            "The remote desktop account must not have administrative groups")
    return user


def sessions(uid):
    rows = json.loads(run(["loginctl", "list-sessions", "--json=short"]))
    return [r for r in rows if r.get("uid") == uid and
            r.get("class") not in ("manager", "manager-early")]


def ssh_excluded(name, config=Path("/etc/ssh/sshd_config")):
    """Conservative global policy proof; ambiguous Match rules require review."""
    binary = shutil.which("sshd") or "/usr/sbin/sshd"
    require(Path(binary).is_file(), "Install/inspect SSH policy before provisioning a login password")
    pending = [config]
    seen = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        for line in path.read_text().splitlines():
            words = line.split("#", 1)[0].split()
            if not words:
                continue
            require(words[0].lower() != "match", "Conditional SSH policy needs an explicit account access review")
            if words[0].lower() == "include":
                import glob
                for pattern in words[1:]:
                    require(pattern.startswith("/"), "Relative SSH Include needs manual review")
                    pending.extend(Path(p) for p in glob.glob(pattern))
    policy = dict(line.split(" ", 1) for line in run([binary, "-T"]).splitlines() if " " in line)
    allow = policy.get("allowusers", "").split()
    deny = policy.get("denyusers", "").split()
    simple_allow = bool(allow) and all(re.fullmatch(r"[a-z][a-z0-9-]*", x) for x in allow)
    require(name in deny or (simple_allow and name not in allow),
            "SSH must explicitly exclude this account (DenyUsers or a simple AllowUsers list); no policy was changed")


def prerequisites():
    for binary in ("systemctl", "loginctl", "busctl", "grdctl", "runuser", "dconf",
                   "dbus-run-session", "xdg-user-dirs-update", "openssl", "chpasswd", "chage", "tar",
                   "ps", "id", "getent", "dpkg-query", "systemd-analyze"):
        require(shutil.which(binary), f"Missing command: {binary}")
    require(run(["dpkg-query", "-W", "-f=${db:Status-Status}", "ubuntu-desktop-minimal"], ok=(0, 1)) == "installed",
            "Install ubuntu-desktop-minimal to provide the complete Ubuntu session, theme and wallpaper")
    for service in ("gdm.service", "gnome-remote-desktop.service"):
        require(run(["systemctl", "is-active", service], ok=(0, 3)) == "active",
                f"Configure Ubuntu Remote Login first: {service} is not active")
    session = Path("/usr/share/wayland-sessions/ubuntu.desktop")
    require(session.is_file() and "X-GDM-CanRunHeadless=true" in session.read_text(),
            "The installed Ubuntu session must support headless login")
    require("pam_gnome_keyring.so" in Path("/etc/pam.d/gdm-password").read_text(),
            "Missing standard GDM keyring PAM integration")
    require(Path("/usr/share/gnome-shell/extensions/ubuntu-dock@ubuntu.com").is_dir(),
            "Install Ubuntu desktop components including Ubuntu Dock")


def user_command(user, command):
    return ["runuser", "-u", user.pw_name, "--", "env", "-u", "DBUS_SESSION_BUS_ADDRESS",
            "-u", "DISPLAY", "-u", "WAYLAND_DISPLAY", f"HOME={user.pw_dir}",
            "dbus-run-session", "--", *command]


def preference(user, prop, value=None):
    path = f"/org/freedesktop/Accounts/User{user.pw_uid}"
    if value is None:
        output = run(["busctl", "--json=short", "get-property", "org.freedesktop.Accounts",
                      path, "org.freedesktop.Accounts.User", prop])
        return json.loads(output)["data"]
    run(["busctl", "call", "org.freedesktop.Accounts", path,
         "org.freedesktop.Accounts.User", f"Set{prop}", "s", value])


def legacy_resources(user):
    receipt = read_private(RECEIPT)
    require(receipt.get("user") == user.pw_name and receipt.get("uid") == user.pw_uid,
            "Legacy receipt does not identify this account")
    paths = {str(RECEIPT): fingerprint(RECEIPT, 0)}
    for name in UNITS:
        path = Path("/etc/systemd/system") / name
        paths[str(path)] = fingerprint(path, 0)
    shell = Path(user.pw_dir) / ".config/systemd/user/gome-remote-shell.service"
    paths[str(shell)] = fingerprint(shell, user.pw_uid)
    handover_mask = shell.parent / "gnome-remote-desktop-handover.service"
    require(not os.path.lexists(handover_mask), "Unexpected user override of the stock handover service")
    require(type(receipt.get("port")) is int and 1024 <= receipt["port"] <= 65535,
            "Invalid legacy receipt port")
    # Exact frozen compatibility templates: never accept an arbitrary systemd
    # definition merely because a few familiar directives appear in its text.
    for path, resource in paths.items():
        if path == str(RECEIPT):
            continue
        template = Path(__file__).with_name("legacy-units") / (Path(path).name + ".in")
        expected = template.read_text().format(user=user.pw_name, uid=user.pw_uid,
                                               home=user.pw_dir, port=receipt["port"])
        require(base64.b64decode(resource["data"]).decode() == expected,
                f"Unsupported legacy unit definition: {path}")
    verify_loaded_units(user)
    return paths


def verify_loaded_units(user):
    allowed = set(UNITS) | {f"user@{user.pw_uid}.service"}
    properties = "Id,FragmentPath,DropInPaths,NeedDaemonReload," + ",".join(STOP_RELATIONS)
    for unit in (*UNITS, f"user@{user.pw_uid}.service"):
        values = dict(line.split("=", 1) for line in run(
            ["systemctl", "show", unit, f"--property={properties}"]).splitlines())
        require(values.get("Id") == unit and values.get("NeedDaemonReload") == "no",
                f"Unexpected or stale loaded unit: {unit}")
        if unit in UNITS:
            require(values.get("FragmentPath") == f"/etc/systemd/system/{unit}" and
                    values.get("DropInPaths") == "", f"Unsupported unit override: {unit}")
        for key in STOP_RELATIONS:
            require(key in values, f"Missing stop-dependency information: {unit}/{key}")
            require(set(values[key].split()) <= allowed,
                    f"Unit stop would propagate outside this account: {unit}")
    # A stopped user manager has no loaded unit to inspect. Examine all its
    # search paths as well, including runtime/global and dash-prefix drop-ins.
    prefix = ["runuser", "-u", user.pw_name, "--", "env", f"HOME={user.pw_dir}",
              f"XDG_RUNTIME_DIR=/run/user/{user.pw_uid}"]
    paths = run(prefix + ["systemd-analyze", "--user", "unit-paths"]).splitlines()
    expected = Path(user.pw_dir) / ".config/systemd/user/gome-remote-shell.service"
    for directory in map(Path, paths):
        candidate = directory / expected.name
        require(candidate == expected or not os.path.lexists(candidate),
                f"Unexpected shell unit override: {candidate}")
        for name in ("service.d", "gome-.service.d", "gome-remote-.service.d",
                     "gome-remote-shell.service.d"):
            dropins = directory / name
            require(not os.path.lexists(dropins), f"Unsupported user unit drop-in: {dropins}")
    if run(["systemctl", "is-active", f"user@{user.pw_uid}.service"], ok=(0, 3)) == "active":
        values = dict(line.split("=", 1) for line in run(prefix + [
            "systemctl", "--user", "show", expected.name,
            "--property=FragmentPath,DropInPaths,NeedDaemonReload"]).splitlines())
        require(values == {"FragmentPath": str(expected), "DropInPaths": "", "NeedDaemonReload": "no"},
                "Unexpected loaded shell definition")


def state_dir(name):
    return STATE_ROOT / name


def read_state(name):
    trusted_directory(STATE_ROOT)
    trusted_directory(state_dir(name))
    state = read_private(state_dir(name) / "receipt.json")
    require(state.get("version") == 2 and state.get("user") == name,
            "Unknown migration receipt")
    user = account(name)
    require(user.pw_uid == state["uid"] and user.pw_dir == state["home"],
            "Account identity changed since preparation")
    return user, state


def save(state, phase):
    state["phase"] = phase
    private_json(state_dir(state["user"]) / "receipt.json", state)


def verify_resources(state):
    for path, expected in state["resources"].items():
        require(fingerprint(Path(path), expected["uid"]) == expected,
                f"Resource changed since preparation: {path}")
    verify_loaded_units(account(state["user"]))


def metadata(user):
    link = shell_enablement(user)
    require(not os.path.lexists(link) or link.is_symlink(), "Shell enablement is not a symlink")
    linger = Path("/var/lib/systemd/linger") / user.pw_name
    require(not linger.is_symlink(), "Unexpected linger symlink")
    shadow = run(["getent", "shadow", user.pw_name]).split(":")
    require(len(shadow) == 9 and shadow[0] == user.pw_name, "Invalid account metadata")
    return {"shadow": shadow, "linger": "yes" if linger.exists() else "no",
            "enabled": {u: run(["systemctl", "is-enabled", u], ok=(0, 1)) for u in UNITS},
            "preferences": {p: preference(user, p) for p in ("Session", "SessionType")},
            "dconf": {k: run(user_command(user, ["dconf", "read", k])) for k in DCONF_KEYS},
            "shell_link": os.readlink(link) if os.path.lexists(link) else None}


def verify_metadata(user, state):
    current = metadata(user)
    before = state["before"]
    phase = state["phase"]
    if phase in ("prepared", "stopping", "stopped", "restored"):
        require(current == before, "Account or enablement changed since preparation")
        return
    if phase == "ready":
        require(current == state["configured"], "Configured account state changed; inspect before recovery")
        return
    # An interrupted configuration/rollback can contain a mixture of its before
    # and intended after values. Anything else belongs to an unknown writer.
    after = state.get("configured", state["desired"])
    for key in ("linger", "shell_link"):
        require(current[key] in (before[key], after[key]), f"Unexpected account setting: {key}")
    for section in ("enabled", "preferences", "dconf"):
        for key, value in current[section].items():
            require(value in (before[section][key], after[section][key]),
                    f"Unexpected account setting: {section}/{key}")
    shadow = current["shadow"]
    old = before["shadow"]
    # chpasswd changes the hash and last-change day together. A retry on a later
    # day is legitimate; other aging changes and foreign hashes are not.
    new_password = (shadow[1] in (old[1], state["new_hash"]) and shadow[:1] == old[:1] and
                    shadow[3:] == old[3:] and shadow[2].isdigit() and
                    state["password_day"] <= int(shadow[2]) <= int(time.time() // 86400))
    require(shadow == old or new_password, "Account password or aging changed outside this migration")


def publish_prepared(state, previous):
    trusted_directory(STATE_ROOT, create=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{state['user']}-prepare-", dir=STATE_ROOT))
    # Build and fsync the entire initial receipt before publishing its directory.
    # An interrupted private staging directory never blocks a new prepare.
    state["phase"] = "prepared"
    if previous is not None:
        archive = STATE_ROOT / f"{state['user']}-restored-{secrets.token_hex(8)}"
        require(not os.path.lexists(archive), "Archive destination already exists")
        state["previous_recovery"] = str(archive)
    private_json(staging / "receipt.json", state)
    if previous is not None:
        state_dir(state["user"]).rename(archive)
    staging.rename(state_dir(state["user"]))
    fd = os.open(STATE_ROOT, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prepare(user):
    ssh_excluded(user.pw_name)
    require(not sessions(user.pw_uid), "Account has login sessions; save work and inspect before migrating")
    resources = legacy_resources(user)
    shadow = run(["getent", "shadow", user.pw_name]).split(":")
    require(len(shadow) == 9 and shadow[0] == user.pw_name and shadow[1].startswith(("!", "*")),
            "Expected the legacy password-locked account; existing passwords require a separate migration")
    previous = None
    if os.path.lexists(state_dir(user.pw_name)):
        _, previous = read_state(user.pw_name)
        require(previous["phase"] == "restored", "Recovery directory already exists; inspect/resume it")
    before = metadata(user)
    require(before["shadow"] == shadow, "Account changed during preparation")
    state = {"version": 2, "user": user.pw_name, "uid": user.pw_uid, "home": user.pw_dir,
             "resources": resources, "before": before}
    require(all(x in ("enabled", "disabled", "static") for x in before["enabled"].values()),
            "Unexpected legacy service enablement")
    shell_link = shell_enablement(user)
    require(shell_link.is_symlink() and shell_link.resolve() ==
            Path(user.pw_dir) / ".config/systemd/user/gome-remote-shell.service",
            "Unexpected legacy shell enablement")
    publish_prepared(state, previous)


def stop_account(user):
    # The caller has explicitly acknowledged closing this account's applications.
    for unit in (UNITS[1], UNITS[2], UNITS[0]):
        run(["systemctl", "stop", unit])
    run(["loginctl", "terminate-user", user.pw_name], ok=(0, 1))
    # logind acknowledges termination before all children have finished exiting.
    deadline = time.monotonic() + 10
    while True:
        manager = run(["systemctl", "is-active", f"user@{user.pw_uid}.service"], ok=(0, 3))
        processes = run(["ps", "-u", str(user.pw_uid), "-o", "pid=,stat="], ok=(0, 1))
        alive = [line for line in processes.splitlines() if not line.split()[-1].startswith("Z")]
        if manager in ("inactive", "failed") and not alive and not sessions(user.pw_uid):
            return
        require(time.monotonic() < deadline,
                "The account still has sessions/processes; inspect rather than killing unknown work")
        time.sleep(0.2)


def password_hash(stdin):
    if stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("New Ubuntu account password: ")
        require(password == getpass.getpass("Repeat password: "), "Passwords do not match")
    require(len(password) >= 16 and len(password) <= 1024 and
            not any(c in password for c in "\n\r\x00"), "Use a password of 16–1024 characters")
    return run(["openssl", "passwd", "-6", "-stdin"], input=password + "\n")


def migrate(user, state, stdin):
    require(state["phase"] in ("prepared", "stopping", "stopped", "configuring", "ready"),
            "This migration is in rollback; finish rollback first")
    ssh_excluded(user.pw_name)
    verify_resources(state)
    verify_metadata(user, state)
    if state["phase"] == "ready":
        return
    require(not sessions(user.pw_uid), "Unexpected login session; preserve it and inspect before resuming")
    if state["phase"] == "prepared":
        state["new_hash"] = password_hash(stdin)
        # The interactive password prompt may remain open while an administrator
        # changes units. Revalidate files and loaded definitions before stopping.
        verify_resources(state)
        state["password_day"] = int(time.time() // 86400)
        state["desired"] = {"linger": "no", "shell_link": None,
            "enabled": {u: "static" if v == "static" else "disabled"
                        for u, v in state["before"]["enabled"].items()},
            "preferences": {"Session": "ubuntu", "SessionType": "wayland"},
            "dconf": {k: "" for k in DCONF_KEYS}}
        verify_metadata(user, state)
        save(state, "stopping")
    if state["phase"] == "stopping":
        stop_account(user)
        verify_resources(state)
        verify_metadata(user, state)
        backup = state_dir(user.pw_name) / "home.tar"
        require(not backup.is_symlink(), "Unexpected backup symlink")
        # A partial archive from this operation can be replaced before completion.
        run(["tar", "--create", "--acls", "--xattrs", "--sparse", "--numeric-owner",
             "--one-file-system", "--file", str(backup), "--directory", "/home", user.pw_name])
        os.chmod(backup, 0o600)
        with backup.open("rb") as stream:
            os.fsync(stream.fileno())
        save(state, "stopped")
    if state["phase"] == "stopped":
        save(state, "configuring")
    if state["phase"] == "configuring":
        # Resume must reestablish quiescence after a host reboot or interrupted run.
        stop_account(user)
        verify_resources(state)
        verify_metadata(user, state)
        for unit in UNITS:
            run(["systemctl", "disable", unit])
        link = shell_enablement(user)
        if os.path.lexists(link):
            require(link.is_symlink() and os.readlink(link) == state["before"]["shell_link"],
                    "Shell enablement changed")
            link.unlink()
        run(["loginctl", "disable-linger", user.pw_name])
        for key in DCONF_KEYS:
            run(user_command(user, ["dconf", "reset", key]))
        run(user_command(user, ["xdg-user-dirs-update"]))
        preference(user, "Session", "ubuntu")
        preference(user, "SessionType", "wayland")
        run(["chpasswd", "--encrypted"], input=f"{user.pw_name}:{state['new_hash']}\n")
        verify_metadata(user, state)
        state["configured"] = metadata(user)
        save(state, "ready")


def rollback(user, state):
    require(state["phase"] in ("prepared", "stopping", "stopped", "configuring", "ready", "restoring", "restored"),
            "Unknown recovery phase")
    if state["phase"] == "restored":
        return
    if state["phase"] == "prepared":
        save(state, "restored")
        return
    verify_resources(state)
    verify_metadata(user, state)
    save(state, "restoring")
    stop_account(user)
    verify_resources(state)
    verify_metadata(user, state)
    # Restore service/account settings, never overwrite the home or keyrings.
    before = state["before"]
    for key, value in before["dconf"].items():
        run(user_command(user, ["dconf", "write", key, value] if value else ["dconf", "reset", key]))
    for prop, value in before["preferences"].items():
        preference(user, prop, value)
    old = before["shadow"]
    run(["chpasswd", "--encrypted"], input=f"{user.pw_name}:{old[1]}\n")
    args = ["chage"]
    for flag, value in zip(("-d", "-m", "-M", "-W", "-I", "-E"), old[2:8]):
        args.extend((flag, value or "-1"))
    run(args + [user.pw_name])
    link = shell_enablement(user)
    if os.path.lexists(link):
        require(link.is_symlink() and os.readlink(link) == before["shell_link"], "Shell enablement changed")
    else:
        os.symlink(before["shell_link"], link)
        os.lchown(link, user.pw_uid, user.pw_gid)
    run(["loginctl", "enable-linger" if before["linger"] == "yes" else "disable-linger", user.pw_name])
    for unit, enabled in before["enabled"].items():
        if enabled in ("enabled", "disabled"):
            run(["systemctl", "enable" if enabled == "enabled" else "disable", unit])
    run(["systemctl", "start", f"user@{user.pw_uid}.service"])
    run(["systemctl", "start", UNITS[0], UNITS[1]])
    require(metadata(user) == before, "Restored metadata differs; recovery state retained")
    save(state, "restored")


@contextlib.contextmanager
def operation_lock():
    fd = os.open("/run/gome-remote-login.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and
                stat.S_IMODE(info.st_mode) == 0o600, "Unexpected migration lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "prepare", "migrate", "rollback"))
    parser.add_argument("--user", required=True)
    parser.add_argument("--stop-session", action="store_true", help="Acknowledge closing this account's applications; save work first")
    parser.add_argument("--password-stdin", action="store_true", help="Read a new OS password privately from stdin")
    args = parser.parse_args()
    require(os.geteuid() == 0, "Run with sudo")
    user = account(args.user)
    if args.command == "inspect":
        prerequisites()
        ssh_excluded(args.user)
        phase = read_state(args.user)[1]["phase"] if os.path.lexists(state_dir(args.user)) else "not-prepared"
        print(json.dumps({"user": args.user, "uid": user.pw_uid, "home": user.pw_dir,
                          "phase": phase, "sessions": sessions(user.pw_uid),
                          "systemRdp": "existing service, unchanged", "profile": "gnome-remote-login"}, indent=2))
        return
    require(args.command == "prepare" or args.stop_session,
            "Save user work, then explicitly supply --stop-session")
    with operation_lock():
        if args.command != "rollback":
            prerequisites()
        if args.command == "prepare":
            prepare(user)
        else:
            user, state = read_state(args.user)
            if args.command == "migrate":
                migrate(user, state, args.password_stdin)
            else:
                rollback(user, state)
    print(f"{args.command} completed for {args.user}; recovery material: {state_dir(args.user)}")
    if args.command == "migrate":
        print("Account configured; verify actual GDM login before switching the gateway target. Shared services unchanged.")


if __name__ == "__main__":
    try:
        main()
    except (Refuse, OSError, KeyError, ValueError, EOFError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        sys.exit(1)
