#!/usr/bin/env python3
"""Pinned OpenAI-defaults release publisher; additive units and automatic rollback."""
from __future__ import annotations
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'evidence/tasks/OPENAI_OFFICIAL_API_20261030/release-manifest.json'
PAYLOAD = Path('/tmp/growdesk-openai-defaults-release-20261030')
RELEASES = Path('/home/ubuntu/growdesk/openai-defaults-releases')
STATE = Path('/var/lib/growdesk-openai-defaults/20261030')
DROPIN = 'zzzzzzzz-openai-defaults-20261030.conf'
API_BINARY = Path('/home/ubuntu/growdesk/bin/growdesk-api')
WORKER = 'growdesk-daily-summary-worker.service'
ENV_FILES = ('/home/ubuntu/Github/baby_panel_for_cecilia/.env', '/home/ubuntu/growdesk/api.env')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def systemctl(*arguments):
    result = subprocess.run(['systemctl', *arguments], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('systemctl operation failed: ' + ' '.join(arguments[:2]))
    return result.stdout.strip()


def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0


def wait_http(port, path, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            response.read(1024)
            if response.status == 200:
                return
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(1)
    raise RuntimeError('readiness did not pass: ' + str(port))


def inspect(expected):
    if sha(MANIFEST) != expected:
        raise RuntimeError('manifest fingerprint does not match approval input')
    manifest = json.loads(MANIFEST.read_text())
    if manifest['payload'] != str(PAYLOAD) or manifest['privateRuntimeFilesCopied'] or manifest['mainApiBinaryReplaced'] or manifest['databaseMigrations']:
        raise RuntimeError('release scope does not match this publisher')
    actual_files, actual_links = {}, {}
    for path in PAYLOAD.rglob('*'):
        relative = path.relative_to(PAYLOAD).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(PAYLOAD):
                raise RuntimeError('artifact link escapes the payload')
            actual_links[relative] = path.readlink().as_posix()
        elif path.is_file():
            actual_files[relative] = sha(path)
        elif not path.is_dir():
            raise RuntimeError('unexpected filesystem type')
    if actual_files != manifest['files'] or actual_links != manifest['links']:
        raise RuntimeError('reviewed artifact has changed')
    return manifest


def unit_changes(release):
    environment = ''.join('EnvironmentFile=' + path + '\n' for path in ENV_FILES)
    changes = {}
    for unit, script in (('baby-panel.service', 'launch-web.py'), ('growdesk-api.service', 'launch-api.py')):
        path = Path('/etc/systemd/system') / (unit + '.d') / DROPIN
        changes[str(path)] = '[Service]\nExecStart=\nExecStart=/usr/bin/python3 ' + str(release / script) + '\n'
    path = Path('/etc/systemd/system/baby-panel-daily-summary.service.d') / DROPIN
    changes[str(path)] = '[Service]\n' + environment + 'ExecStart=\nExecStart=/usr/bin/python3 ' + str(release / 'launch-daily.py') + ' --once\nTimeoutStartSec=300\n'
    changes['/etc/systemd/system/' + WORKER] = (
        '[Unit]\nDescription=GrowDesk persistent AMD daily summary worker\nAfter=network-online.target growdesk-api.service\n'
        '[Service]\nType=simple\nUser=ubuntu\nWorkingDirectory=/home/ubuntu/growdesk\n' + environment +
        'ExecStart=/usr/bin/python3 ' + str(release / 'launch-daily.py') + ' --worker\n'
        'Restart=on-failure\nRestartSec=30\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\n'
        '[Install]\nWantedBy=multi-user.target\n')
    return changes


def write_private(path, value):
    temporary = path.with_name(path.name + '.new')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def restore(receipt):
    # Establish ownership before stopping or disabling anything. An operator's
    # independent unit edit must make rollback refuse without side effects.
    for name in receipt['createdUnits']:
        path = Path(name)
        if not path.is_file() or sha(path) != receipt['unitSha256'][name]:
            raise RuntimeError('refusing to change independently modified deployment files')
    if '/etc/systemd/system/' + WORKER in receipt['createdUnits']:
        systemctl('disable', '--now', WORKER)
    for name in receipt['createdUnits']:
        Path(name).unlink()
    systemctl('daemon-reload')
    systemctl('restart', 'growdesk-api.service')
    wait_http(3081, '/health/ready')
    systemctl('restart', 'baby-panel.service')
    wait_http(3088, '/settings')
    receipt['status'] = 'ROLLED_BACK'
    write_private(STATE / 'receipt.json', receipt)


def apply(expected):
    manifest = inspect(expected)
    if os.geteuid() != 0:
        raise RuntimeError('apply requires root')
    release = RELEASES / ('20261030-' + expected[:12])
    changes = unit_changes(release)
    if any(Path(name).exists() for name in changes):
        raise RuntimeError('refusing to overwrite pre-existing deployment files')
    if not active('growdesk-api.service') or not active('baby-panel.service'):
        raise RuntimeError('existing application services must be active before cutover')
    original_api = sha(API_BINARY)
    if STATE.is_symlink() or RELEASES.is_symlink():
        raise RuntimeError('deployment roots must be ordinary directories')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    RELEASES.mkdir(parents=True, exist_ok=True)
    if release.exists():
        raise RuntimeError('refusing to overwrite a prepared release')
    shutil.copytree(PAYLOAD, release, symlinks=True)
    for path in release.rglob('*'):
        if not path.is_symlink():
            executable = bool(path.stat().st_mode & 0o111)
            path.chmod(0o755 if path.is_dir() or executable else 0o644)
    receipt = {'status': 'PREPARED', 'release': str(release), 'manifestSha256': expected,
               'createdUnits': [], 'unitSha256': {}, 'originalApiBinarySha256': original_api,
               'webBuildId': manifest['webBuildId'], 'databaseMigrations': False,
               'privateRuntimeFilesCopied': False, 'mainApiBinaryReplaced': False}
    write_private(STATE / 'receipt.json', receipt)
    try:
        for name, text in changes.items():
            path = Path(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('x') as handle:
                handle.write(text)
            path.chmod(0o644)
            receipt['createdUnits'].append(name)
            receipt['unitSha256'][name] = sha(path)
            write_private(STATE / 'receipt.json', receipt)
        systemctl('daemon-reload')
        systemctl('restart', 'growdesk-api.service')
        wait_http(3081, '/health/ready')
        if sha(API_BINARY) != original_api:
            raise RuntimeError('main API binary changed unexpectedly')
        systemctl('restart', 'baby-panel.service')
        wait_http(3088, '/settings')
        systemctl('enable', '--now', WORKER)
        time.sleep(3)
        if not active(WORKER):
            raise RuntimeError('daily worker did not stay active; verify its existing AMD environment binding')
        systemctl('start', 'baby-panel-daily-summary.service')
        receipt['status'] = 'DEPLOYED'
        write_private(STATE / 'receipt.json', receipt)
        print(json.dumps({k: receipt[k] for k in ('status', 'release', 'webBuildId', 'mainApiBinaryReplaced', 'databaseMigrations')}))
    except Exception:
        restore(receipt)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('audit', 'apply', 'rollback'))
    parser.add_argument('--manifest-sha256')
    args = parser.parse_args()
    if args.action == 'rollback':
        if os.geteuid() != 0:
            raise RuntimeError('rollback requires root')
        restore(json.loads((STATE / 'receipt.json').read_text()))
        print(json.dumps({'status': 'ROLLED_BACK'}))
    else:
        if not args.manifest_sha256 or len(args.manifest_sha256) != 64:
            raise RuntimeError('an exact reviewed manifest fingerprint is required')
        if args.action == 'audit':
            manifest = inspect(args.manifest_sha256)
            print(json.dumps({'status': 'AUDITED', 'files': len(manifest['files']), 'privateRuntimeFilesCopied': False}))
        else:
            apply(args.manifest_sha256)


if __name__ == '__main__':
    main()
