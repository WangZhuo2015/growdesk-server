#!/usr/bin/python3
"""Keep the installed voice/TTS binary and select official API text inference."""
import os
from pathlib import Path
import stat

path = Path('/home/ubuntu/Github/growdesk-server/.gpt')
try:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError()
        raw = os.read(descriptor, 16_385)
        if len(raw) > 16_384:
            raise ValueError()
        key = raw.decode('utf-8').strip()
        if not key or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in key):
            raise ValueError()
    finally:
        os.close(descriptor)
except Exception:
    raise SystemExit('Official API key file is unavailable or invalid') from None

env = dict(os.environ)
# The retained binary uses Chat Completions for read-only structured proposals.
# Its voice renderer and independently selected audio models remain in place.
env.update({
    'GROWDESK_AI_PROVIDER': 'openai-compatible',
    'GROWDESK_AI_BASE_URL': 'https://api.openai.com/v1',
    'GROWDESK_AI_MODEL': 'gpt-6-luna',
    'GROWDESK_AI_API_KEY': key,
    'GROWDESK_AI_TIMEOUT_MS': '60000',
})
target = '/home/ubuntu/growdesk/voice-e2e-releases/20261024-warm-a03a2fe4911d-r3/warm-provider-launch.py'
os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', target], env)
