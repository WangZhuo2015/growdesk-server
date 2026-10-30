#!/usr/bin/python3
"""Run the reviewed Web artifact; credentials remain private file references."""
import os
from pathlib import Path

root = Path(__file__).resolve().parent
source = '/home/ubuntu/Github/baby_panel_for_cecilia'
env = dict(os.environ)
env.update({
    'NODE_ENV': 'production', 'HOST': '127.0.0.1', 'HOSTNAME': '127.0.0.1', 'PORT': '3088',
    'GROWDESK_ENV': 'production', 'GROWDESK_ENABLED': 'true', 'GROWDESK_BACKEND': 'go',
    'GROWDESK_API_URL': 'http://127.0.0.1:3081', 'GROWDESK_GO_API_URL': 'http://127.0.0.1:3081',
    'GROWDESK_AI_SETTINGS_API_URL': 'http://127.0.0.1:3092',
    'GROWDESK_PASSPORT_API_URL': 'http://127.0.0.1:3081',
    'GROWDESK_WEB_ORIGIN': 'https://baby.zwang.fun', 'PUBLIC_BASE_URL': 'https://baby.zwang.fun',
    'NEXT_PUBLIC_APP_URL': 'https://baby.zwang.fun', 'APP_URL': 'https://baby.zwang.fun',
    'BABY_PANEL_URL': 'https://baby.zwang.fun',
    'DATABASE_URL': 'file:/proc/growdesk-llm-web-legacy-disabled.sqlite',
    'LLM_PROFILES_FILE': source + '/llm-profiles.json',
    'CHATGPT_PLAN_FILE': source + '/.data/chatgpt-plan.json',
    'LLM_PROFILE': 'openai-official',
    'GROWDESK_AI_PROVIDER': 'openai', 'GROWDESK_AI_MODEL': 'gpt-6-luna',
    'GROWDESK_AI_API_KEY_FILE': '/home/ubuntu/Github/growdesk-server/.gpt',
})
for name in ('GROWDESK_AI_API_KEY', 'OPENAI_API_KEY', 'GROWDESK_AI_BASE_URL'):
    env.pop(name, None)
os.chdir(root / 'web')
os.execve('/usr/bin/node', ['/usr/bin/node', str(root / 'web/server.js')], env)
