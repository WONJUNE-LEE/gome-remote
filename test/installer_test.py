"""Preflight collision tests without root, services, or host changes."""
import importlib.util
import configparser
import io
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).parents[1] / "scripts/setup-headless.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_existing_resources_are_rejected_before_system_changes(self):
        destinations = [
            "/home/gome-test", "/var/lib/gome-test", "/etc/gome-remote",
            "/etc/systemd/system/gome-remote-firewall.service",
            "/etc/systemd/system/gome-remote-rdp.service",
            "/etc/systemd/system/gome-remote-rdp-proxy.service",
            "/etc/systemd/system/gome-remote-rdp-proxy.socket",
        ]
        for destination in destinations:
            for dangling in [False, True]:
                with self.subTest(path=destination, dangling=dangling), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    def mapped(value):
                        return root / str(value).lstrip("/")
                    collision = mapped(destination)
                    collision.parent.mkdir(parents=True)
                    if dangling:
                        collision.symlink_to("missing-target")
                    else:
                        collision.write_text("preserve-existing-resource")
                    proxy = mapped("/usr/lib/systemd/systemd-socket-proxyd")
                    proxy.parent.mkdir(parents=True)
                    proxy.write_text("#!/bin/sh\nexit 0\n")
                    proxy.chmod(0o700)
                    errors = io.StringIO()
                    with patch.object(installer, "Path", side_effect=mapped), \
                         patch.object(installer.os, "geteuid", return_value=0), \
                         patch.object(installer.shutil, "which", return_value="/usr/bin/test-command"), \
                         patch.object(installer.pwd, "getpwnam", side_effect=KeyError), \
                         patch.object(installer, "run") as run, \
                         patch("sys.argv", ["setup-headless.py", "--user", "gome-test"]), \
                         patch("sys.stderr", errors):
                        with self.assertRaises(SystemExit) as raised:
                            installer.main()
                        self.assertEqual(raised.exception.code, 2)
                        self.assertIn(f"Existing installation resource: {collision}. Refusing to overwrite it.", errors.getvalue())
                        run.assert_not_called()
                    if dangling:
                        self.assertTrue(collision.is_symlink())
                    else:
                        self.assertEqual(collision.read_text(), "preserve-existing-resource")

    def test_clean_destinations_reach_account_creation(self):
        class PreflightPassed(Exception):
            pass
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def mapped(value):
                return root / str(value).lstrip("/")
            proxy = mapped("/usr/lib/systemd/systemd-socket-proxyd")
            proxy.parent.mkdir(parents=True)
            proxy.write_text("#!/bin/sh\nexit 0\n")
            proxy.chmod(0o700)
            def stop_before_mutation(args, **kwargs):
                if args[0] == "useradd":
                    self.assertEqual(args[args.index("--home-dir") + 1], str(mapped("/home/gome-test")))
                    raise PreflightPassed()
                self.assertEqual(args, ["unshare", "--net", "true"])
            with patch.object(installer, "Path", side_effect=mapped), \
                 patch.object(installer.os, "geteuid", return_value=0), \
                 patch.object(installer.shutil, "which", return_value="/usr/bin/test-command"), \
                 patch.object(installer.pwd, "getpwnam", side_effect=KeyError), \
                 patch.object(installer.socket, "socket"), \
                 patch.object(installer, "run", side_effect=stop_before_mutation), \
                 patch("sys.argv", ["setup-headless.py", "--user", "gome-test"]):
                with self.assertRaises(PreflightPassed):
                    installer.main()

    def test_private_write_is_exclusive_and_does_not_follow_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            installer.private_write(target, "original", os.getuid(), os.getgid())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                installer.private_write(target, "replacement")
            link = Path(tmp) / "link"
            link.symlink_to(target)
            with self.assertRaises(FileExistsError):
                installer.private_write(link, "replacement")
            self.assertEqual(target.read_text(), "original")

    def test_generated_shell_unit_starts_an_ubuntu_graphical_session(self):
        class ShellCaptured(Exception):
            pass
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def mapped(value):
                return root / str(value).lstrip("/")
            home = mapped("/home/gome-test")
            mapped("/etc").mkdir()
            proxy = mapped("/usr/lib/systemd/systemd-socket-proxyd")
            proxy.parent.mkdir(parents=True)
            proxy.write_text("#!/bin/sh\nexit 0\n")
            proxy.chmod(0o700)
            def simulate(args, **kwargs):
                if args[0] == "useradd":
                    home.mkdir(parents=True)
                elif "mkdir" in args:
                    Path(args[-1]).mkdir(parents=True, exist_ok=True)
                elif "openssl" in args:
                    Path(args[args.index("-keyout") + 1]).touch()
            captured = {}
            def capture(path, content, *args):
                if path.name == "gome-remote-shell.service":
                    captured["shell"] = content
                    raise ShellCaptured()
            account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid(), pw_dir=str(home))
            with patch.object(installer, "Path", side_effect=lambda p: Path(p) if str(p).startswith(tmp) else mapped(p)), \
                 patch.object(installer.os, "geteuid", return_value=0), \
                 patch.object(installer.shutil, "which", return_value="/usr/bin/test-command"), \
                 patch.object(installer.pwd, "getpwnam", side_effect=[KeyError(), account]), \
                 patch.object(installer.socket, "socket"), \
                 patch.object(installer, "run", side_effect=simulate), \
                 patch.object(installer, "set_credentials"), \
                 patch.object(installer, "private_write", side_effect=capture), \
                 patch("sys.argv", ["setup-headless.py", "--user", "gome-test"]):
                with self.assertRaises(ShellCaptured):
                    installer.main()
            # systemd allows repeated Environment= directives; retain each assignment.
            lines = captured["shell"].splitlines()
            environment = dict(line.removeprefix("Environment=").split("=", 1)
                               for line in lines if line.startswith("Environment="))
            self.assertEqual(environment["XDG_CURRENT_DESKTOP"], "ubuntu:GNOME")
            self.assertEqual(environment["XDG_SESSION_TYPE"], "wayland")
            unit = configparser.ConfigParser(strict=False)
            unit.read_string(captured["shell"])
            self.assertIn("graphical-session.target", unit["Unit"]["BindsTo"].split())
            self.assertIn("graphical-session.target", unit["Unit"]["Before"].split())
            export = unit["Service"]["ExecStartPre"].split()
            self.assertEqual(export[0], "/usr/bin/dbus-update-activation-environment")
            self.assertEqual(set(export[1:]), {"--systemd", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"})
            self.assertEqual(unit["Service"]["Type"], "dbus")
            self.assertEqual(unit["Service"]["BusName"], "org.gnome.Shell")


if __name__ == "__main__":
    unittest.main()
