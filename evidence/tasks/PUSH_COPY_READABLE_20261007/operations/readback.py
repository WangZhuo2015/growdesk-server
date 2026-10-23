"""Production read-only operational verification; no household data is read."""
from pathlib import Path
import hashlib, json, subprocess, urllib.request, urllib.error

ROOT = Path('/home/ubuntu/growdesk/push-releases/readable-notification-copy-20261007')
receipt = json.loads((ROOT / 'deployment-receipt.json').read_text())
assert receipt['deployed']
result = {'sourceRevision': receipt['sourceRevision'], 'productionTestPushSent': False,
          'physicalDeviceReceiptVerified': False, 'schemaChanged': False, 'services': {}}
for unit, relative in (('growdesk-api', 'bin/growdesk-api'),
                       ('growdesk-notifications-worker', 'bin/growdesk-worker')):
    raw = subprocess.check_output(['sudo', '-n', 'systemctl', 'show',
                                  '--property=ActiveState', '--property=SubState',
                                  '--property=MainPID', '--property=NRestarts', unit]).decode()
    properties = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    assert properties['ActiveState'] == 'active' and properties['SubState'] == 'running'
    assert properties['NRestarts'] == '0' and int(properties['MainPID']) > 0
    actual = hashlib.sha256((Path('/proc') / properties['MainPID'] / 'exe').read_bytes()).hexdigest()
    assert actual == receipt['candidate']['files'][relative]
    properties['runningBinarySha256'] = actual
    result['services'][unit] = properties
worker_pid = result['services']['growdesk-notifications-worker']['MainPID']
assert b'--notifications-only' in (Path('/proc') / worker_pid / 'cmdline').read_bytes().split(b'\0')
web_raw = subprocess.check_output(['sudo', '-n', 'systemctl', 'show', '--property=MainPID', 'baby-panel']).decode().strip()
assert web_raw == 'MainPID=' + receipt['beforeServices']['baby-panel']['MainPID']
result['webPidUnchanged'] = True
result['workerProfile'] = 'notifications-only'
result['publicHttpStatuses'] = {}
urls = {
    'https://ampere.zwang.fun:8443/health/ready': 200,
    'https://ampere.zwang.fun:8443/api/v1/notifications': 401,
    'https://baby.zwang.fun/notifications': 200,
    'https://baby.zwang.fun/sw.js': 200,
    'https://baby.zwang.fun/api/push/vapid-key': 401,
}
for url, expected in urls.items():
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            code = response.status
            if url.endswith('/health/ready'):
                data = json.load(response)
                assert data['status'] == 'ok' and data['dependencies'] == {'postgres': 'ok', 'redis': 'ok'}
                result['readyHealth'] = data
    except urllib.error.HTTPError as error:
        code = error.code
    assert code == expected, url + ' returned unexpected status'
    result['publicHttpStatuses'][url] = code
result['passed'] = True
(ROOT / 'readback-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
