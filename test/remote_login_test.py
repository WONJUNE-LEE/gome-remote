"""Unprivileged refusal checks; actual migration/recovery is rehearsed in a VM."""
import importlib.util
import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "remote_login", Path(__file__).parents[1] / "scripts/setup-remote-login.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RemoteLoginTests(unittest.TestCase):
    def test_failed_command_never_prints_password_or_subprocess_output(self):
        result = SimpleNamespace(returncode=1, stdout="private-password", stderr="private-password")
        with patch.object(m.subprocess, "run", return_value=result) as command:
            with self.assertRaises(m.Refuse) as caught:
                m.run(["chpasswd"], input="user:private-password\n")
        self.assertNotIn("private-password", str(caught.exception))
        self.assertEqual(command.call_args.kwargs["input"], "user:private-password\n")

    def test_receipt_and_resource_symlinks_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "original"
            target.write_text("preserve")
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                m.read_private(link)
            with self.assertRaises(OSError):
                m.fingerprint(link, os.getuid())
            real = root / "real"
            real.mkdir()
            (real / "unit").write_text("preserve")
            (root / "parent-link").symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(m.Refuse, "ancestor"):
                m.fingerprint(root / "parent-link/unit", os.getuid())
            self.assertEqual(target.read_text(), "preserve")

    def test_resource_drift_stops_migration_before_password_or_host_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            unit = Path(directory) / "unit"
            unit.write_text("original")
            state = {"phase": "prepared", "resources": {
                str(unit): m.fingerprint(unit, os.getuid())}}
            unit.write_text("changed by another administrator")
            with patch.object(m, "ssh_excluded"), \
                 patch.object(m, "password_hash", side_effect=AssertionError("Password requested after drift")), \
                 patch.object(m, "run", side_effect=AssertionError("Host command after drift")):
                with self.assertRaisesRegex(m.Refuse, "changed since preparation"):
                    m.migrate(SimpleNamespace(pw_name="example"), state, False)
            self.assertEqual(state["phase"], "prepared")
            self.assertEqual(unit.read_text(), "changed by another administrator")

    def test_ssh_policy_must_explicitly_exclude_account_and_have_no_match_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "sshd_config"
            included = root / "included.conf"
            config.write_text(f"Include {included}\n")
            included.write_text("AllowUsers owner\n")
            policies = [
                ("allowusers owner\n", True),
                ("denyusers remote\n", True),
                ("allowusers remote owner\n", False),
                ("allowusers own*\n", False),
                ("passwordauthentication no\n", False),
                ("denyusers another\n", False),
            ]
            with patch.object(m.shutil, "which", return_value="/bin/true"):
                for policy, accepted in policies:
                    with self.subTest(policy=policy), patch.object(m, "run", return_value=policy):
                        if accepted:
                            m.ssh_excluded("remote", config)
                        else:
                            with self.assertRaises(m.Refuse):
                                m.ssh_excluded("remote", config)
                included.write_text("Match Address 10.0.0.0/8\n PasswordAuthentication yes\n")
                with patch.object(m, "run", side_effect=AssertionError("Conditional policy accepted")):
                    with self.assertRaisesRegex(m.Refuse, "Conditional SSH"):
                        m.ssh_excluded("remote", config)

    def test_prepared_rollback_leaves_live_desktop_untouched(self):
        state = {"phase": "prepared", "user": "remote"}
        with patch.object(m, "save") as save, \
             patch.object(m, "stop_account", side_effect=AssertionError("Prepared desktop stopped")), \
             patch.object(m, "run", side_effect=AssertionError("Host mutated before cutover")):
            m.rollback(SimpleNamespace(pw_name="remote"), state)
        save.assert_called_once_with(state, "restored")

    def test_stop_waits_for_logind_children_without_killing_unknown_processes(self):
        user = SimpleNamespace(pw_name="remote", pw_uid=1234)
        polls = iter(["123 S", "123 Z", ""])
        commands = []

        def run(args, **kwargs):
            commands.append(args)
            if args[0] == "ps":
                return next(polls)
            if args[:2] == ["systemctl", "is-active"]:
                return "inactive"
            return ""

        with patch.object(m, "run", side_effect=run), \
             patch.object(m, "sessions", return_value=[]), \
             patch.object(m.time, "sleep") as sleep:
            m.stop_account(user)
        sleep.assert_called_once_with(0.2)
        self.assertEqual(sum(args[0] == "ps" for args in commands), 2)
        self.assertEqual([args for args in commands if args[0] == "loginctl"],
                         [["loginctl", "terminate-user", "remote"]])
        self.assertFalse(any(args[0] in ("kill", "pkill", "killall") for args in commands))

    def test_stop_refuses_when_unknown_work_does_not_exit(self):
        user = SimpleNamespace(pw_name="remote", pw_uid=1234)

        def run(args, **kwargs):
            return "123 S" if args[0] == "ps" else "inactive"

        with patch.object(m, "run", side_effect=run), \
             patch.object(m, "sessions", return_value=[]), \
             patch.object(m.time, "monotonic", side_effect=[0, 11]), \
             patch.object(m.time, "sleep", side_effect=AssertionError("Unbounded wait")):
            with self.assertRaisesRegex(m.Refuse, "unknown work"):
                m.stop_account(user)

    def test_stop_waits_and_times_out_for_manager_or_session_without_processes(self):
        user = SimpleNamespace(pw_name="remote", pw_uid=1234)
        for blocker in ("manager", "session"):
            for clears in (True, False):
                with self.subTest(blocker=blocker, clears=clears):
                    polls = 0

                    def run(args, **kwargs):
                        nonlocal polls
                        if args[:2] == ["systemctl", "is-active"]:
                            polls += 1
                            return "active" if blocker == "manager" and polls == 1 else "inactive"
                        return ""

                    def sessions(uid):
                        self.assertEqual(uid, 1234)
                        return [{"session": "still-closing"}] if blocker == "session" and polls == 1 else []

                    with patch.object(m, "run", side_effect=run), \
                         patch.object(m, "sessions", side_effect=sessions), \
                         patch.object(m.time, "monotonic", side_effect=[0, 1 if clears else 11]), \
                         patch.object(m.time, "sleep") as sleep:
                        if clears:
                            m.stop_account(user)
                            self.assertEqual(polls, 2)
                            sleep.assert_called_once_with(0.2)
                        else:
                            with self.assertRaisesRegex(m.Refuse, "unknown work"):
                                m.stop_account(user)
                            sleep.assert_not_called()

    def test_changed_metadata_is_refused_before_password_and_stop(self):
        before = {"shadow": ["remote", "!", "20000", "0", "99999", "7", "", "", ""],
                  "linger": "yes", "shell_link": "../gome-remote-shell.service",
                  "enabled": {"unit": "enabled"}, "preferences": {"Session": "ubuntu"},
                  "dconf": {"idle": "0"}}
        for field in before:
            with self.subTest(field=field):
                changed = copy.deepcopy(before)
                if field == "shadow":
                    changed[field][1] = "administrator-changed-password"
                elif isinstance(changed[field], dict):
                    changed[field][next(iter(changed[field]))] = "administrator-change"
                else:
                    changed[field] = "administrator-change"
                state = {"phase": "prepared", "before": before}
                with patch.object(m, "metadata", return_value=changed), \
                     patch.object(m, "ssh_excluded"), patch.object(m, "verify_resources"), \
                     patch.object(m, "password_hash", side_effect=AssertionError("Password requested after drift")), \
                     patch.object(m, "stop_account", side_effect=AssertionError("Stopped after drift")):
                    with self.assertRaisesRegex(m.Refuse, "changed since preparation"):
                        m.migrate(SimpleNamespace(pw_name="remote"), state, False)

    def test_initial_receipt_failure_never_publishes_an_empty_recovery_directory(self):
        for previous in (None, {"phase": "restored"}):
            with self.subTest(previous=previous), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                active = root / "remote"
                if previous:
                    active.mkdir(mode=0o700)
                    (active / "receipt.json").write_text("previous recovery")
                state = {"version": 2, "user": "remote"}
                with patch.object(m, "STATE_ROOT", root), patch.object(m, "trusted_directory"), \
                     patch.object(m, "private_json", side_effect=OSError("Injected first-write failure")):
                    with self.assertRaises(OSError):
                        m.publish_prepared(state, previous)
                if previous:
                    self.assertEqual((active / "receipt.json").read_text(), "previous recovery")
                else:
                    self.assertFalse(active.exists())
                with patch.object(m, "STATE_ROOT", root), patch.object(m, "trusted_directory"):
                    m.publish_prepared(state, previous)
                self.assertIn('"phase": "prepared"', (active / "receipt.json").read_text())
                self.assertEqual((active / "receipt.json").stat().st_mode & 0o777, 0o600)
                if previous:
                    self.assertEqual((Path(state["previous_recovery"]) / "receipt.json").read_text(), "previous recovery")

    def test_loaded_unit_overrides_and_outside_stop_dependencies_are_refused(self):
        user = SimpleNamespace(pw_name="remote", pw_uid=1234, pw_dir="/home/remote")
        variants = [(None, None), ("DropInPaths", "/etc/systemd/system/gome-remote-rdp.service.d/override.conf"),
                    ("FragmentPath", "/run/systemd/transient/other.service"),
                    ("NeedDaemonReload", "yes"), ("PropagatesStopTo", "gdm.service"),
                    ("ConsistsOf", "unrelated.service"), ("BoundBy", "unrelated.service")]
        with tempfile.TemporaryDirectory() as directory:
            for key, value in variants:
                with self.subTest(property=key):
                    def run(args, **kwargs):
                        if args[:2] == ["systemctl", "show"]:
                            unit = args[2]
                            props = {"Id": unit, "FragmentPath": "/etc/systemd/system/" + unit,
                                     "DropInPaths": "", "NeedDaemonReload": "no",
                                     "PropagatesStopTo": "", "ConsistsOf": "", "BoundBy": ""}
                            if key and unit == m.UNITS[0]:
                                props[key] = value
                            return "\n".join(f"{k}={v}" for k, v in props.items())
                        if args[:2] == ["systemctl", "is-active"]:
                            return "inactive"
                        self.assertEqual(args[-3:], ["systemd-analyze", "--user", "unit-paths"])
                        return directory
                    with patch.object(m, "run", side_effect=run):
                        if key:
                            with self.assertRaises(m.Refuse):
                                m.verify_loaded_units(user)
                        else:
                            m.verify_loaded_units(user)
            (Path(directory) / "gome-remote-shell.service.d").mkdir()
            key = None
            with patch.object(m, "run", side_effect=run):
                with self.assertRaisesRegex(m.Refuse, "drop-in"):
                    m.verify_loaded_units(user)

    def test_retired_installer_refuses_new_installations(self):
        result = subprocess.run([sys.executable, str(Path(__file__).parents[1] /
            "scripts/setup-headless.py"), "--user", "do-not-create"], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Direct-shell installation is retired", result.stderr)
        self.assertNotIn("Run with sudo", result.stderr)


if __name__ == "__main__":
    unittest.main()
