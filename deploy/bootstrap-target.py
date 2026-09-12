"""Prepare only the owned GrowDesk directory; run as ubuntu, never as root."""
from pathlib import Path
import hashlib
import json
import os
import re
import secrets
import socket
import sys
import urllib.request

root = Path('/home/ubuntu/growdesk')
revision = sys.argv[1]
if os.getuid() == 0 or not re.fullmatch(r'[a-f0-9]{40}', revision):
    raise SystemExit('Run as ubuntu with a full release Git SHA')
marker = root / 'ownership.json'
if root.exists():
    if root.is_symlink() or root.stat().st_uid != os.getuid() or not marker.is_file():
        raise SystemExit('Refusing to adopt an existing unowned deployment directory')
    if json.loads(marker.read_text()).get('project') != 'growdesk':
        raise SystemExit('Deployment ownership mismatch')
else:
    for port in (3180, 8443):
        with socket.socket() as check:
            check.bind(('127.0.0.1', port))
    root.mkdir(mode=0o700)
    marker.write_text(json.dumps({'project': 'growdesk', 'host': '161.33.201.230'}) + '\n')
    marker.chmod(0o600)

for relative in ('bin', 'docker-config/cli-plugins', 'shared', 'artifacts', f'releases/{revision}'):
    (root / relative).mkdir(parents=True, exist_ok=True, mode=0o700)

tools = [
    ('bin/docker-compose', 'https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-aarch64',
     '732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7'),
    ('docker-config/cli-plugins/docker-buildx', 'https://github.com/docker/buildx/releases/download/v0.37.1/buildx-v0.37.1.linux-arm64',
     'e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2'),
]
for relative, url, expected in tools:
    destination = root / relative
    if not destination.exists():
        temporary = destination.with_suffix('.download')
        urllib.request.urlretrieve(url, temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            temporary.unlink()
            raise SystemExit('Tool checksum mismatch')
        temporary.chmod(0o700)
        temporary.replace(destination)
    elif hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        raise SystemExit('Installed tool does not match pinned release')
    print('Verified', relative)

env_file = root / 'shared/runtime.env'
if not env_file.exists():
    values = {key: secrets.token_hex(32) for key in (
        'POSTGRES_SUPERUSER_PASSWORD', 'GROWDESK_DB_PASSWORD', 'REDIS_PASSWORD')}
    values.update(GROWDESK_IMAGE_TAG=revision, GROWDESK_HOST_PORT='3180')
    with os.fdopen(os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.write(''.join(f'{key}={value}\n' for key, value in values.items()))
    print('Created private runtime configuration; credentials not printed')
else:
    if env_file.stat().st_mode & 0o077:
        raise SystemExit('Runtime environment file has unsafe permissions')
    print('Preserved existing runtime configuration')
print('Prepared release directory', revision)
