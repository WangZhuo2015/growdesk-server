"""One-shot identity migration + import on the explicitly owned GrowDesk stack.

Run as root on the deployment host; credentials remain in a private temp file.
Does not restart API/nginx or touch the old application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path('/home/ubuntu/growdesk')

def run(args,**kwargs):
    return subprocess.run(args,check=True,**kwargs)

def main(revision):
    if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision):raise ValueError('Invalid revision')
    release=ROOT/'releases'/revision
    snapshot=ROOT/'imports/legacy-20260912-01'
    manifest=json.loads((snapshot/'manifest.json').read_text())
    assert hashlib.sha256((snapshot/'legacy.json').read_bytes()).hexdigest()==manifest['archiveSha256']
    assert manifest['sourceId']=='baby-panel-161.33.201.230'
    image='growdesk-migration:'+revision
    # Only the new, explicitly named PostgreSQL container is an allowed target.
    meta=json.loads(subprocess.check_output(['docker','inspect','growdesk-postgres-1'],text=True))[0]
    assert meta['Config']['Labels']['com.docker.compose.project']=='growdesk'
    assert meta['Config']['Image'].startswith('postgres:18.6-bookworm@sha256:')
    assert not meta['HostConfig']['PortBindings']
    runtime={}
    for line in (ROOT/'shared/runtime.env').read_text().splitlines():
        if '=' in line:
            k,v=line.split('=',1);runtime[k]=v
    password=runtime['POSTGRES_SUPERUSER_PASSWORD']
    assert len(password)==64 and all(c in '0123456789abcdef' for c in password)
    environment={**os.environ,'DOCKER_CONFIG':str(ROOT/'docker-config')}
    run(['docker','build','-f',str(release/'deploy/Migration.Dockerfile'),'-t',image,str(release)],env=environment)
    # Never render credentials into command line arguments or stdout.
    with tempfile.TemporaryDirectory(prefix='migration-',dir=ROOT/'shared') as temp:
        envfile=Path(temp)/'migration.env'
        fd=os.open(envfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:f.write('DATABASE_URL=postgresql://postgres:'+password+'@postgres:5432/growdesk\n')
        run(['docker','run','--rm','--network','growdesk-db','--env-file',str(envfile),image],env=environment)
    # Use the committed generator, not an earlier ad-hoc SQL file.
    sql=snapshot/('identity-import-'+revision+'.sql')
    run(['python3',str(release/'scripts/legacy-import/import_sql.py'),'--archive',str(snapshot/'legacy.json'),'--sha256',manifest['archiveSha256'],'--output',str(sql)])
    with sql.open() as stream:
        result=subprocess.run(['docker','exec','-i','growdesk-postgres-1','psql','-X','-U','postgres','-d','growdesk','-v','ON_ERROR_STOP=1','-At'],stdin=stream,capture_output=True,text=True)
    if result.returncode:
        # PostgreSQL errors may quote source row values; never emit them.
        raise RuntimeError('Atomic identity import failed; inspect private snapshot, no source changes')
    print('Prisma migration and atomic identity import completed')
    run(['python3',str(release/'scripts/legacy-import/verify_target.py'),'--archive',str(snapshot/'legacy.json')])

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--revision',required=True);args=parser.parse_args()
    try:main(args.revision)
    except Exception as error:
        print(json.dumps({'error':type(error).__name__}));raise SystemExit(1)
