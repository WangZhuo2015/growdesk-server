from pathlib import Path
import json
import os
import sys

root = Path('/home/ubuntu/growdesk/push-releases/web-push-20261006')
strip = json.loads((root/'environment-strip-names.json').read_text())
assert all(isinstance(k,str) and not k.startswith('VAPID_') for k in strip)
env = dict(os.environ)
for key in strip:
    env.pop(key,None)
target = sys.argv[1]
assert target in ('/home/ubuntu/growdesk/bin/growdesk-api',str(root/'server/bin/growdesk-worker'))
os.execve(target,[target,*sys.argv[2:]],env)
