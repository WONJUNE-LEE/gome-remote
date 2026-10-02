"""Preflight collision tests without root, services, or host changes."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).parents[1] / "scripts/setup-headless.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_existing_resources_are_rejected_before_system_changes(self):
        destinations = [
            "/var/lib/gome-test", "/etc/gome-remote",
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
                    with patch.object(installer, "Path", side_effect=mapped), \
                         patch.object(installer.os, "geteuid", return_value=0), \
                         patch.object(installer.shutil, "which", return_value="/usr/bin/test-command"), \
                         patch.object(installer.pwd, "getpwnam", side_effect=KeyError), \
                         patch.object(installer, "run") as run, \
                         patch("sys.argv", ["setup-headless.py", "--user", "gome-test"]), \
                         patch("sys.stderr"):
                        with self.assertRaises(SystemExit) as raised:
                            installer.main()
                        self.assertEqual(raised.exception.code, 2)
                        run.assert_not_called()
                    if dangling:
                        self.assertTrue(collision.is_symlink())
                    else:
                        self.assertEqual(collision.read_text(), "preserve-existing-resource")

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


if __name__ == "__main__":
    unittest.main()
