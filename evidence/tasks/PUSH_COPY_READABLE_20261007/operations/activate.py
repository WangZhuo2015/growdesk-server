from pathlib import Path
import hashlib, json, shutil, subprocess, time, urllib.request

ROOT = Path('/home/ubuntu/growdesk/push-releases/readable-notification-copy-20261007')
SERVER = ROOT / 'server'
ROLLBACK = ROOT / 'rollback'
API = Path('/home/ubuntu/growdesk/bin/growdesk-api')
OLD_WORKER = Path('/home/ubuntu/growdesk/push-releases/full-record-content-20261006/server/bin/growdesk-worker')
LIVE = Path('/home/ubuntu/Github/baby_panel_for_cecilia')
DROPIN = Path('/etc/systemd/system/growdesk-notifications-worker.service.d/60-readable-copy.conf')
API_HASH = '684afa52949eb01b7df88ab3883a1bf84981a14e5b29fac00835c1aae97349e4'
WORKER_HASH = '6c143450b3fa39708dbef99996931ac29a1ccc05df3ba3c6ac9d8e4e59bdf4fd'
BASE_REVISION = '8b9edd3be223c2e784bf3ba617d7f11eac27323a'
WEB_REVISION = '5fa673c23c8886a097477e01cf200d5279f98348'
CONFIG_HASHES = {
    '/home/ubuntu/growdesk/push-releases/web-push-20261006/environment-strip-names.json': '678f3a7be6fab990f9e9064d1f6bdb4b09fb691c7af8e0bbc479b7b7c74408c7',
    '/home/ubuntu/growdesk/push-releases/web-push-20261006/server/environment-launch.py': 'cc6defb08577854abdacc5994c86bc9425981f1443d14395e63106932b767f01',
    '/etc/systemd/system/growdesk-api.service.d/40-web-push.conf': '8ee41865ef5c0ba59e8eaa8afed54a7fd5bffc46c160d84cde45a9c982012163',
    '/etc/systemd/system/growdesk-notifications-worker.service.d/50-full-record-content.conf': '80981f113690b10620f3535fbb05046c46fec879d0811fb1cab47221e001277b',
    '/home/ubuntu/growdesk/push-releases/full-record-content-20261006/server/environment-launch.py': '6ee6dc8e56f6dba6d4bb901fe6cc20549f26c5d4168d1b649a5f222184bd076d',
}
UNITS = ('growdesk-api', 'growdesk-notifications-worker', 'baby-panel')
receipt = {'phase': 'preflight', 'deployed': False, 'schemaChanged': False,
           'noTestPushSent': True, 'physicalDeviceReceiptVerified': False}

def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw)

def ctl(*args):
    return run(['sudo', '-n', 'systemctl', *args])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save():
    (ROOT / 'deployment-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

def stats(path):
    s = path.stat()
    return {'size': s.st_size, 'mtimeNs': s.st_mtime_ns, 'mode': s.st_mode & 0o777,
            'uid': s.st_uid, 'gid': s.st_gid}

def props(unit):
    keys = ('ActiveState', 'SubState', 'MainPID', 'NRestarts')
    raw = ctl('show', *[f'--property={key}' for key in keys], unit).stdout.decode()
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

def health():
    with urllib.request.urlopen('http://127.0.0.1:3081/health/ready', timeout=5) as response:
        data = json.load(response)
    assert data['status'] == 'ok' and data['dependencies'] == {'postgres': 'ok', 'redis': 'ok'}
    return data

def wait_api():
    for _ in range(30):
        try:
            return health()
        except (OSError, ValueError, AssertionError):
            time.sleep(1)
    raise RuntimeError('API readiness failed')

def version(path):
    return json.loads(run([str(path), '--version']).stdout)

def verify_process(unit, expected_hash):
    p = props(unit)
    assert p['ActiveState'] == 'active' and p['SubState'] == 'running' and int(p['MainPID']) > 0
    assert p['NRestarts'] == '0', unit + ' restarted'
    assert sha(Path('/proc') / p['MainPID'] / 'exe') == expected_hash, unit + ' process hash mismatch'
    if unit == 'growdesk-notifications-worker':
        assert b'--notifications-only' in (Path('/proc') / p['MainPID'] / 'cmdline').read_bytes().split(b'\0')
    return p

def unchanged_assets():
    assert props('baby-panel') == receipt['beforeServices']['baby-panel'], 'Web process changed'
    assert json.loads((LIVE / '.next/standalone/build-provenance.json').read_text()) == receipt['beforeWebProvenance']
    after = {name: stats(Path(name)) for name in receipt['environmentFilesBefore']}
    assert after == receipt['environmentFilesBefore'], 'environment file metadata changed'
    for name, expected in CONFIG_HASHES.items():
        assert sha(Path(name)) == expected, 'existing configuration changed'
    return after

def install(path, content):
    run(['sudo', '-n', 'mkdir', '-p', str(path.parent)])
    run(['sudo', '-n', 'tee', str(path)], input=content.encode())

def replace_api(source, suffix):
    stage = API.with_name('growdesk-api.' + suffix)
    shutil.copy2(source, stage)
    stage.chmod(0o755)
    stage.replace(API)

def stop_worker():
    ctl('stop', 'growdesk-notifications-worker')
    p = props('growdesk-notifications-worker')
    assert p['ActiveState'] in ('inactive', 'failed') and p['MainPID'] == '0', 'worker stop incomplete'

try:
    assert not ROLLBACK.exists() and not DROPIN.exists(), 'release already switched'
    bundle = json.loads((SERVER / 'bundle-manifest.json').read_text())
    assert bundle['baselineRevision'] == BASE_REVISION
    assert bundle['revision'] != BASE_REVISION
    for relative, expected in bundle['files'].items():
        assert relative in ('bin/growdesk-api', 'bin/growdesk-worker', 'environment-launch.py')
        assert sha(SERVER / relative) == expected, relative + ' hash mismatch'
    assert set(bundle['files']) == {'bin/growdesk-api', 'bin/growdesk-worker', 'environment-launch.py'}
    assert sha(API) == API_HASH and sha(OLD_WORKER) == WORKER_HASH, 'baseline binaries changed'
    for name, expected in CONFIG_HASHES.items():
        assert sha(Path(name)) == expected, 'baseline configuration changed'
    receipt['beforeServices'] = {u: props(u) for u in UNITS}
    verify_process('growdesk-api', API_HASH)
    verify_process('growdesk-notifications-worker', WORKER_HASH)
    assert receipt['beforeServices']['baby-panel']['ActiveState'] == 'active'
    assert receipt['beforeServices']['baby-panel']['NRestarts'] == '0'
    assert version(API)['revision'] == BASE_REVISION and version(OLD_WORKER)['revision'] == BASE_REVISION
    receipt['beforeHealth'] = health()
    receipt['beforeWebProvenance'] = json.loads((LIVE / '.next/standalone/build-provenance.json').read_text())
    assert receipt['beforeWebProvenance']['sourceGitSha'] == WEB_REVISION
    receipt['environmentFilesBefore'] = {str(p): stats(p) for p in (LIVE / '.env', Path('/home/ubuntu/growdesk/api.env'))}
    ROLLBACK.mkdir(mode=0o700)
    receipt['rollbackDirectoryCreated'] = True
    shutil.copy2(API, ROLLBACK / 'growdesk-api')
    assert sha(ROLLBACK / 'growdesk-api') == API_HASH
    receipt.update({'phase': 'switching', 'liveSwitchStarted': True, 'candidate': bundle})
    save()
    stop_worker()
    ctl('stop', 'growdesk-api')
    replace_api(SERVER / 'bin/growdesk-api', 'readable-new')
    install(DROPIN, '[Service]\nExecStart=\nExecStart=/usr/bin/python3 ' + str(SERVER / 'environment-launch.py') + ' ' + str(SERVER / 'bin/growdesk-worker') + ' --notifications-only\n')
    ctl('daemon-reload')
    ctl('start', 'growdesk-api')
    receipt['afterHealth'] = wait_api()
    ctl('start', 'growdesk-notifications-worker')
    time.sleep(3)
    receipt['afterServices'] = {
        'growdesk-api': verify_process('growdesk-api', bundle['files']['bin/growdesk-api']),
        'growdesk-notifications-worker': verify_process('growdesk-notifications-worker', bundle['files']['bin/growdesk-worker']),
        'baby-panel': props('baby-panel'),
    }
    receipt['apiVersion'] = version(API)
    receipt['workerVersion'] = version(SERVER / 'bin/growdesk-worker')
    assert receipt['apiVersion']['revision'] == bundle['revision'] == receipt['workerVersion']['revision']
    receipt['environmentFilesAfter'] = unchanged_assets()
    receipt.update({'phase': 'deployed', 'deployed': True, 'sourceRevision': bundle['revision'],
                    'webSource': WEB_REVISION, 'workerProfile': 'notifications-only',
                    'environmentFilesUnchanged': True, 'webProcessUnchanged': True,
                    'rollbackDirectory': str(ROLLBACK)})
    save()
    print(json.dumps(receipt))
except BaseException as error:
    receipt.update({'deployed': False, 'failureClass': type(error).__name__,
                    'failureMessage': str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'operation failed'})
    if not receipt.get('liveSwitchStarted') and receipt.get('rollbackDirectoryCreated'):
        shutil.rmtree(ROLLBACK)
        receipt['preflightBackupCleaned'] = True
    if receipt.get('liveSwitchStarted'):
        try:
            stop_worker()
            ctl('stop', 'growdesk-api')
            replace_api(ROLLBACK / 'growdesk-api', 'readable-rollback')
            run(['sudo', '-n', 'rm', '-f', str(DROPIN)])
            ctl('daemon-reload')
            ctl('start', 'growdesk-api')
            receipt['rollbackHealth'] = wait_api()
            ctl('start', 'growdesk-notifications-worker')
            time.sleep(3)
            receipt['rollbackServices'] = {
                'growdesk-api': verify_process('growdesk-api', API_HASH),
                'growdesk-notifications-worker': verify_process('growdesk-notifications-worker', WORKER_HASH),
                'baby-panel': props('baby-panel'),
            }
            unchanged_assets()
            receipt['rolledBack'] = True
            receipt['rollbackBinaryHashesVerified'] = True
        except BaseException as rollback_error:
            receipt['rollbackErrorClass'] = type(rollback_error).__name__
    save()
    print(json.dumps(receipt))
    raise
