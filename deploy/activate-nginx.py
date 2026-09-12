"""Activate only GrowDesk's new nginx include and 8443 firewall rule."""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
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

def best_effort_cleanup(label, action):
    try:
        action()
    except BaseException as cleanup_error:
        print(f'cleanup {label} failed: {type(cleanup_error).__name__}: {cleanup_error}',
              file=sys.stderr, flush=True)

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
def reload_target():
    # The existing custom instance has an empty PID file. Select its exact
    # running master, then send nginx's documented graceful-reload signal.
    expected = 'nginx: master process /usr/sbin/nginx -c /etc/sing-box/nginx.conf'
    matches = [int(line.strip().split(None, 1)[0]) for line in
               run(['ps', '-eo', 'pid=,args=']).stdout.splitlines()
               if len(line.strip().split(None, 1)) == 2
               and line.strip().split(None, 1)[1] == expected]
    if len(matches) != 1:
        raise RuntimeError('Cannot uniquely identify the sing-box nginx master')
    pid = matches[0]
    if Path(f'/proc/{pid}/exe').resolve() != Path('/usr/sbin/nginx').resolve():
        raise RuntimeError('nginx master executable changed')
    print(json.dumps({"nginxMaster": pid, "reloadRequestedAt": time.time()}), flush=True)
    os.kill(pid, signal.SIGHUP)

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
    reload_target()
    # This is a local loopback check only; it does not check external reachability.
    for attempt in range(10):
        checked = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '5',
            '--resolve', 'ampere.zwang.fun:8443:127.0.0.1',
            'https://ampere.zwang.fun:8443/health/ready'], capture_output=True, text=True)
        if checked.returncode == 0 and json.loads(checked.stdout) == payload: break
        time.sleep(0.5)
    else: raise RuntimeError('nginx local TLS readiness did not pass')
    print('GrowDesk nginx include validated, gracefully reloaded, local TLS readiness passed (external reachability not checked here)')
    print('Added only TCP 8443 firewall rule; existing nginx files preserved')
except BaseException:
    if created_include:
        best_effort_cleanup('nginx include removal', lambda: include.unlink(missing_ok=True))
    if reload_attempted:
        def reload_previous_config():
            run([*nginx, '-t'])
            reload_target()
        best_effort_cleanup('nginx rollback reload', reload_previous_config)
    if created_unit:
        best_effort_cleanup('firewall unit stop', lambda: subprocess.run(
            ['systemctl', 'disable', '--now', 'growdesk-firewall.service'],
            check=True, capture_output=True, text=True))
        best_effort_cleanup('firewall unit removal', lambda: unit.unlink(missing_ok=True))
        best_effort_cleanup('systemd daemon-reload', lambda: run(['systemctl', 'daemon-reload']))
    def remove_firewall_rule():
        if firewall_exists():
            run(['/usr/sbin/iptables', '-D', *rule])
    best_effort_cleanup('firewall rule removal', remove_firewall_rule)
    raise
