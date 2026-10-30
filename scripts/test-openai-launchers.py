#!/usr/bin/env python3
"""Verify launcher bindings using virtual keys; never open the real key file."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import tempfile
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
LAUNCHERS = ROOT / 'deploy/openai-defaults-20261030'


class Launchers(unittest.TestCase):
    def test_web_uses_file_reference_and_preserves_backend_and_catalogs(self):
        seen = {}
        def execute(target, arguments, env):
            seen.update(target=target, arguments=arguments, env=env)
            raise SystemExit(0)
        with patch.dict(os.environ, {'GROWDESK_AI_API_KEY': 'test_old_inline', 'OPENAI_API_KEY': 'test_old_other', 'LLM_PROFILE': 'test_old_profile'}, clear=True):
            with patch('os.execve', execute), patch('os.chdir'), self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(LAUNCHERS / 'launch-web.py'), run_name='__main__')
        self.assertEqual(stopped.exception.code, 0)
        env = seen['env']
        self.assertEqual(env['LLM_PROFILE'], 'openai-official')
        self.assertEqual(env['GROWDESK_AI_MODEL'], 'gpt-6-luna')
        self.assertTrue(env['GROWDESK_AI_API_KEY_FILE'].endswith('/.gpt'))
        self.assertNotIn('GROWDESK_AI_API_KEY', env)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertEqual(env['GROWDESK_API_URL'], 'http://127.0.0.1:3081')
        self.assertTrue(env['LLM_PROFILES_FILE'].endswith('/llm-profiles.json'))
        self.assertTrue(env['DATABASE_URL'].startswith('file:/proc/'))

    def run_api(self, contents):
        with tempfile.TemporaryDirectory(prefix='test_openai_launcher_') as directory:
            virtual = Path(directory) / 'test_key'
            virtual.write_bytes(contents)
            seen = {}
            real_open = os.open
            def safe_open(path, flags, *args, **kwargs):
                self.assertEqual(str(path), '/home/ubuntu/Github/growdesk-server/.gpt')
                return real_open(virtual, flags, *args, **kwargs)
            def execute(target, arguments, env):
                seen.update(target=target, arguments=arguments, env=env)
                raise SystemExit(0)
            output = io.StringIO()
            with patch.dict(os.environ, {'test_preserved': 'test_value'}, clear=True), patch('os.open', safe_open), patch('os.execve', execute), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                with self.assertRaises(SystemExit) as stopped:
                    runpy.run_path(str(LAUNCHERS / 'launch-api.py'), run_name='__main__')
            self.assertEqual(output.getvalue(), '')
            return stopped.exception.code, seen

    def test_api_injects_virtual_key_and_retains_warm_voice_launcher(self):
        code, seen = self.run_api(b'test_virtual_official_key\n')
        self.assertEqual(code, 0)
        self.assertEqual(seen['env']['GROWDESK_AI_API_KEY'], 'test_virtual_official_key')
        self.assertEqual(seen['env']['GROWDESK_AI_MODEL'], 'gpt-6-luna')
        self.assertEqual(seen['env']['GROWDESK_AI_BASE_URL'], 'https://api.openai.com/v1')
        self.assertEqual(seen['env']['test_preserved'], 'test_value')
        self.assertTrue(seen['arguments'][-1].endswith('/warm-provider-launch.py'))

    def test_api_rejects_unusable_key_files_with_opaque_error(self):
        for contents in (b'', b'  \n', b'test_key\ntest_other', b'x' * 16_385, b'\xff'):
            with self.subTest(length=len(contents)):
                code, seen = self.run_api(contents)
                self.assertEqual(code, 'Official API key file is unavailable or invalid')
                self.assertEqual(seen, {})

    def test_daily_reuses_only_existing_amd_environment_binding(self):
        for mode in ('--once', '--worker'):
            seen = {}
            def execute(target, arguments, env):
                seen.update(target=target, arguments=arguments, env=env)
                raise SystemExit(0)
            env = {'GROWDESK_AI_BASE_URL': 'https://developer.amd.com.cn/radeon/api/v1', 'GROWDESK_AI_API_KEY': 'test_existing_amd_key'}
            with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['launch-daily.py', mode]), patch('os.execve', execute), self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(LAUNCHERS / 'launch-daily.py'), run_name='__main__')
            self.assertEqual(stopped.exception.code, 0)
            self.assertEqual(seen['env']['GROWDESK_DAILY_SUMMARY_API_KEY'], 'test_existing_amd_key')
            self.assertEqual(seen['env']['GROWDESK_DAILY_SUMMARY_BASE_URL'], 'https://developer.amd.com.cn/radeon/api/v1')
            self.assertEqual(seen['arguments'][-1], mode)

    def test_daily_refuses_to_repurpose_other_provider_credentials(self):
        env = {'GROWDESK_AI_BASE_URL': 'https://api.openai.com/v1', 'GROWDESK_AI_API_KEY': 'test_official_key'}
        with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['launch-daily.py', '--worker']), patch('os.execve') as execute, self.assertRaises(SystemExit) as stopped:
            runpy.run_path(str(LAUNCHERS / 'launch-daily.py'), run_name='__main__')
        self.assertEqual(stopped.exception.code, 'An existing AMD environment credential is required for scheduled summaries')
        execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
