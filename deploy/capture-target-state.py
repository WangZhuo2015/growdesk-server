"""Read-only comparison evidence. No service environments or nginx content."""
import hashlib
import json
import subprocess
from pathlib import Path

def run(args):
    return subprocess.check_output(args, text=True).strip()

services = run(['systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain']).splitlines()
service_state = {}
for line in services:
    name = line.split()[0]
    if name.startswith('growdesk'): continue
    values = run(['systemctl', 'show', name, '--property=MainPID', '--property=ActiveState', '--property=ExecMainStartTimestampMonotonic'])
    service_state[name] = dict(value.split('=', 1) for value in values.splitlines())
containers = {}
for container in run(['docker','ps','-q','--no-trunc']).splitlines():
    values = run(['docker','inspect','--format','{{.Id}}|{{.Name}}|{{.State.Running}}|{{.State.StartedAt}}',container]).split('|')
    if values[1].startswith('/growdesk-'): continue
    containers[values[1]] = dict(id=values[0], running=values[2], startedAt=values[3])
configs = {}
for file in [Path('/etc/sing-box/nginx.conf'), *Path('/etc/sing-box/nginx.d').glob('*.conf')]:
    if file.name.startswith('growdesk'): continue
    configs[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
http = {}
for host in ['ampere.zwang.fun', 'ampere-cf.zwang.fun', 'baby.zwang.fun']:
    response = subprocess.run(['curl','--silent','--output','/dev/null','--write-out','%{http_code}',
        '--head','--max-time','10','--resolve',host+':443:127.0.0.1','https://'+host+'/'],capture_output=True,text=True)
    http[host] = dict(code=response.stdout, exitCode=response.returncode)
print(json.dumps(dict(services=service_state,containers=containers,nginxConfigHashes=configs,
    nginxMaster=Path('/var/run/nginx.pid').read_text().strip(),http=http),indent=2))
