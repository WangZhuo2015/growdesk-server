#!/usr/bin/python3
"""Run the isolated daily task runtime with its existing AMD environment binding."""
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

if sys.argv[1:] not in (['--worker'], ['--once']):
    raise SystemExit(2)
env = dict(os.environ)
key = env.get('GROWDESK_DAILY_SUMMARY_API_KEY', '').strip() or env.get('AMD_API_KEY', '').strip()
if not key:
    # Reuse an existing environment key only when its existing endpoint is AMD.
    # Private profile files are never read or transferred by this launcher.
    for endpoint_name, key_names in (
        ('GROWDESK_AI_BASE_URL', ('GROWDESK_AI_API_KEY',)),
        ('AI_BASE_URL', ('AI_API_KEY',)),
    ):
        address = urlsplit(env.get(endpoint_name, ''))
        if address.scheme == 'https' and address.netloc == 'developer.amd.com.cn' and address.path.rstrip('/') in ('/radeon/api/v1', '/radeon/api/v1/chat/completions') and not address.query and not address.fragment:
            key = next((env.get(name, '').strip() for name in key_names if env.get(name, '').strip()), '')
            if key:
                break
if not key:
    raise SystemExit('An existing AMD environment credential is required for scheduled summaries')
env.update({
    'GROWDESK_ENV': 'production',
    'GROWDESK_DAILY_SUMMARY_API_KEY': key,
    'GROWDESK_DAILY_SUMMARY_BASE_URL': 'https://developer.amd.com.cn/radeon/api/v1',
    'GROWDESK_DAILY_SUMMARY_TIMEOUT_MS': '180000',
})
target = str(Path(__file__).resolve().parent / 'growdesk-daily-summary')
os.execve(target, [target, *sys.argv[1:]], env)
