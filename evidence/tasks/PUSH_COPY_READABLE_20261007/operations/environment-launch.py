from pathlib import Path
import json, os, sys

metadata = Path('/home/ubuntu/growdesk/push-releases/web-push-20261006/environment-strip-names.json')
strip = json.loads(metadata.read_text())
assert all(isinstance(key, str) and not key.startswith('VAPID_') for key in strip)
env = dict(os.environ)
for key in strip:
    env.pop(key, None)
target = '/home/ubuntu/growdesk/push-releases/readable-notification-copy-20261007/server/bin/growdesk-worker'
assert len(sys.argv) > 1 and sys.argv[1] == target
os.execve(target, [target, *sys.argv[2:]], env)
