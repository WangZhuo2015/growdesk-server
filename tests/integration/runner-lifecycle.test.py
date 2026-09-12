"""Real-process failure tests: never adopt or stop an unrelated listener."""
import json
import importlib.util
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parents[2] / 'scripts/test-integration.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class LifecycleTests(unittest.TestCase):
    def test_occupied_port_is_not_adopted(self):
        before = set(Path(tempfile.gettempdir()).glob('growdesk-integration-*'))
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            occupied = listener.getsockname()[1]
            with patch.object(runner, 'free_port', side_effect=[occupied, runner.free_port()]):
                with self.assertRaises(RuntimeError):
                    runner.main()
            # Unrelated listener still exists after runner failure/cleanup.
            with socket.create_connection(('127.0.0.1', occupied), timeout=1): pass
        self.assertEqual(set(Path(tempfile.gettempdir()).glob('growdesk-integration-*')), before)

    def test_check_failure_cleans_owned_children_and_data(self):
        before = set(Path(tempfile.gettempdir()).glob('growdesk-integration-*'))
        children = []
        original_popen, original_command = subprocess.Popen, runner.command
        def track(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child
        def fail_check(args, **kwargs):
            if args[:2] == ['node', '--import']:
                raise subprocess.CalledProcessError(7, 'synthetic-check-failure')
            return original_command(args, **kwargs)
        with patch.object(runner.subprocess, 'Popen', side_effect=track), patch.object(runner, 'command', side_effect=fail_check):
            with self.assertRaises(subprocess.CalledProcessError):
                runner.main()
        self.assertTrue(children)
        self.assertTrue(all(child.poll() is not None for child in children))
        self.assertEqual(set(Path(tempfile.gettempdir()).glob('growdesk-integration-*')), before)

    def test_wrong_instance_token_rejected_before_ddl(self):
        original_command = runner.command
        checked = []
        def wrong_token(args, **kwargs):
            if args == ['node', '--import', 'tsx', '--test', 'tests/integration/infrastructure.test.ts']:
                manifest = Path(kwargs['env']['BOOT02_RUN_FILE'])
                identity = json.loads(manifest.read_text())
                identity['token'] = '0' * 32
                manifest.write_text(json.dumps(identity))
                with self.assertRaises(subprocess.CalledProcessError):
                    original_command(args, **kwargs)
                psql = runner.executable('psql', 'PG_BIN', '/opt/homebrew/opt/postgresql@18/bin')
                result = subprocess.check_output([psql, '-h', identity['directory'], '-p', str(identity['pgPort']),
                    '-d', identity['database'], '-At', '-c', "SELECT to_regclass('public.test_records') IS NULL"],
                    text=True, env=kwargs['env'])
                self.assertEqual(result.strip(), 't')
                checked.append(True)
                raise subprocess.CalledProcessError(1, 'expected-identity-rejection')
            return original_command(args, **kwargs)
        with patch.object(runner, 'command', side_effect=wrong_token):
            with self.assertRaises(subprocess.CalledProcessError):
                runner.main()
        self.assertEqual(checked, [True])

if __name__ == '__main__': unittest.main()
