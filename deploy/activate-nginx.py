"""Activate only GrowDesk's new nginx include and 8443 firewall rule."""
from pathlib import Path
import json
import subprocess
import time
import urllib.request

root = Path('/home/ubuntu/growdesk')
source = root / 'artifacts/growdesk.ampere.conf'
include = Path('/etc/sing-box/nginx.d/growdesk.conf')
unit = Path('/etc/systemd/system/growdesk-firewall.service')
nginx = ['/usr/sbin/nginx', '-c', '/etc/sing-box/nginx.conf']
rule = ['INPUT', '-p', 'tcp', '--dport', '8443', '-m', 'comment', '--comment', 'GrowDesk HTTPS', '-j', 'ACCEPT']

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)

def firewall_exists():
    return subprocess.run(['/usr/sbin/iptables', '-C', *rule], capture_output=True).returncode == 0

if include.exists() or unit.exists() or firewall_exists():
    raise SystemExit('Refusing to overwrite an existing GrowDesk activation; inspect it first')
if '__' in source.read_text():
    raise SystemExit('Unresolved nginx template')
with urllib.request.urlopen('http://127.0.0.1:3180/health/ready', timeout=5) as response:
    payload = json.load(response)
if payload != {'status': 'ok', 'service': 'growdesk-api', 'stage': 'foundation',
               'dependencies': {'postgres': 'ok', 'redis': 'ok'}}:
    raise SystemExit('API dependency readiness has not passed')
run([*nginx, '-t'])
created_include = created_unit = reload_attempted = False
try:
    with include.open('x') as output: output.write(source.read_text())
    created_include = True
    include.chmod(0o644)
    run([*nginx, '-t'])
    unit_text = '''[Unit]
Description=GrowDesk dedicated HTTPS port rule
After=network-online.target sing-box.service docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -C INPUT -p tcp --dport 8443 -m comment --comment "GrowDesk HTTPS" -j ACCEPT || /usr/sbin/iptables -I INPUT 1 -p tcp --dport 8443 -m comment --comment "GrowDesk HTTPS" -j ACCEPT'

[Install]
WantedBy=multi-user.target
'''
    with unit.open('x') as output: output.write(unit_text)
    created_unit = True
    unit.chmod(0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'growdesk-firewall.service'])
    reload_attempted = True
    run([*nginx, '-s', 'reload'])
    for attempt in range(10):
        checked = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '5',
            '--resolve', 'ampere.zwang.fun:8443:127.0.0.1',
            'https://ampere.zwang.fun:8443/health/ready'], capture_output=True, text=True)
        if checked.returncode == 0 and json.loads(checked.stdout) == payload: break
        time.sleep(0.5)
    else: raise RuntimeError('nginx TLS readiness did not pass')
    print('GrowDesk nginx include validated, gracefully reloaded, TLS readiness passed')
    print('Added only TCP 8443 firewall rule; existing nginx files preserved')
except BaseException:
    if created_include: include.unlink(missing_ok=True)
    if reload_attempted:
        run([*nginx, '-t'])
        run([*nginx, '-s', 'reload'])
    if created_unit:
        subprocess.run(['systemctl', 'disable', '--now', 'growdesk-firewall.service'], capture_output=True)
        unit.unlink(missing_ok=True)
        run(['systemctl', 'daemon-reload'])
    if firewall_exists():
        run(['/usr/sbin/iptables', '-D', *rule])
    raise
