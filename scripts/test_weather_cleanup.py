#!/usr/bin/env python3
"""Regression tests for fail-closed cleanup of the owned weather-test PostgreSQL."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("weather_runner", ROOT / "scripts/go-weather-parity-integration.py")
assert SPEC is not None and SPEC.loader is not None
weather_runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(weather_runner)


class StoppedProcess:
    def poll(self):
        return 0


class WeatherCleanupTests(unittest.TestCase):
    def make_environment(self, startup_identity_override: str | None = None):
        owner = secrets.token_hex(8)
        root = Path(tempfile.mkdtemp(prefix="growdesk-weather-owned-" + owner + "-", dir="/private/tmp"))
        marker = root / "OWNER"
        marker.write_text("growdesk-weather-owned:" + owner + "\n")
        pg_data = root / "pgdata"
        pg_data.mkdir()
        identity_process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        postmaster_pid = identity_process.pid
        process_started_at = subprocess.run(
            ["ps", "-p", str(postmaster_pid), "-o", "lstart="],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        postmaster_start_time = "1700000000"
        (pg_data / "postmaster.pid").write_text(
            f"{postmaster_pid}\n{pg_data.resolve()}\n{postmaster_start_time}\n54321\n{root / 'socket'}\n"
        )
        pg_bin = root / "bin"
        pg_bin.mkdir()
        invocation_log = Path(tempfile.gettempdir()) / f"weather-cleanup-invocations-{owner}.txt"
        pg_ctl = pg_bin / "pg_ctl"
        pg_ctl.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$*\" >> {shlex.quote(str(invocation_log))}\n"
            "case \" $* \" in *' stop '*) exit 23;; esac\n"
            "exit 0\n"
        )
        pg_ctl.chmod(0o700)

        environment = weather_runner.LocalOwnedEnvironment.__new__(weather_runner.LocalOwnedEnvironment)
        environment.owner = owner
        environment.root = root
        environment.marker = marker
        environment.pg_data = pg_data
        environment.pg_bin = pg_bin
        environment.started_pg = True
        environment.pg_postmaster_pid = postmaster_pid
        environment.pg_startup_identity = {
            "postmasterPID": postmaster_pid,
            "dataDirectory": str(pg_data.resolve()),
            "postmasterStartTime": postmaster_start_time,
            "processStartedAt": startup_identity_override or process_started_at,
        }
        environment.pg_stop_verified = False
        environment.pg_cleanup_attempted = False
        environment.pg_stop_command_exit_code = None
        environment.pg_pid_termination_proven = False
        environment.pg_cleanup_failure = None
        environment.env = {"PATH": os.environ.get("PATH", "")}
        environment.containers = []
        environment.processes = []
        environment.files = []
        environment.redis_process = StoppedProcess()
        environment.invocation_log = invocation_log
        environment.test_identity_process = identity_process
        return environment

    def test_stop_failure_reports_false_and_preserves_owned_directory(self):
        environment = self.make_environment()
        root = environment.root
        pg_data = environment.pg_data
        try:
            environment.close()
            status = environment.cleanup_status()
            self.assertEqual(environment.invocation_log.read_text().count("stop"), 1)
            self.assertFalse(status["postgresStopped"], status)
            self.assertTrue(root.exists(), "failed pg_ctl stop must preserve the owned directory")

            # Directory disappearance cannot overwrite the recorded stop failure.
            shutil.rmtree(pg_data)
            self.assertFalse(environment.cleanup_status()["postgresStopped"])
        finally:
            if environment.test_identity_process.poll() is None:
                environment.test_identity_process.terminate()
            environment.test_identity_process.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)
            environment.invocation_log.unlink(missing_ok=True)

    def test_startup_identity_mismatch_does_not_run_pg_ctl_or_remove_directory(self):
        environment = self.make_environment("different-process-start-identity")
        root = environment.root
        try:
            environment.close()
            status = environment.cleanup_status()
            self.assertFalse(environment.invocation_log.exists(), "identity mismatch must not target a process")
            self.assertFalse(status["postgresStopped"], status)
            self.assertTrue(root.exists(), "identity mismatch must preserve the owned directory")
        finally:
            if environment.test_identity_process.poll() is None:
                environment.test_identity_process.terminate()
            environment.test_identity_process.wait(timeout=5)
            shutil.rmtree(root, ignore_errors=True)
            environment.invocation_log.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
