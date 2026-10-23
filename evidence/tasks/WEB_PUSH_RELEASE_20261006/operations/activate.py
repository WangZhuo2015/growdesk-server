from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.request
import urllib.error

ROOT=Path('/home/ubuntu/growdesk/push-releases/web-push-20261006')
LIVE=Path('/home/ubuntu/Github/baby_panel_for_cecilia')
API=Path('/home/ubuntu/growdesk/bin/growdesk-api')
SERVER=ROOT/'server'
ROLLBACK=ROOT/'rollback'
DROPIN=Path('/etc/systemd/system/growdesk-api.service.d/40-web-push.conf')
WORKER=Path('/etc/systemd/system/growdesk-notifications-worker.service')
receipt={'phase':'preflight','deployed':False,'physicalDeviceReceiptVerified':False}

def save():
    (ROOT/'deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')

def run(args, **kwargs):
    return subprocess.run(args,check=True,capture_output=True,**kwargs)

def ctl(*args):
    return run(['sudo','-n','systemctl',*args])

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def stats(p):
    s=p.stat()
    return {'size':s.st_size,'mtimeNs':s.st_mtime_ns,'mode':s.st_mode&0o777,'uid':s.st_uid,'gid':s.st_gid}

def digest(p):
    if p.is_file():return sha(p)
    h=hashlib.sha256()
    for f in sorted(p.rglob('*')):
        if f.is_file():h.update(str(f.relative_to(p)).encode()+b'\0'+f.read_bytes()+b'\0')
    return h.hexdigest()

def install(path, content):
    run(['sudo','-n','mkdir','-p',str(path.parent)])
    run(['sudo','-n','tee',str(path)],input=content.encode())

def health():
    with urllib.request.urlopen('http://127.0.0.1:3081/health/ready',timeout=5) as r:
        data=json.load(r)
        assert r.status==200 and data['dependencies']['postgres']=='ok' and data['dependencies']['redis']=='ok'
    return data

def code(url):
    try:
        with urllib.request.urlopen(url,timeout=10) as r:return r.status
    except urllib.error.HTTPError as e:return e.code
    except (urllib.error.URLError,TimeoutError):return 0

def wait_ready():
    error=None
    for _ in range(30):
        try:return health()
        except Exception as e:error=type(e).__name__;time.sleep(1)
    raise RuntimeError('API readiness failed: '+str(error))

def sql(text):
    return run(['sudo','-n','docker','exec','-i','growdesk-postgres-1','sh','-c','exec psql -X -U "$POSTGRES_USER" -d growdesk -At -v ON_ERROR_STOP=1'],input=text.encode(),timeout=120).stdout.decode()

try:
    assert not ROLLBACK.exists() and not DROPIN.exists() and not WORKER.exists()
    assert sha(API)=='80cc6c2f14932d13116b4d67fdf720365b71635031277083614c43cb58458562'
    bundle=json.loads((SERVER/'bundle-manifest.json').read_text())
    for rel,h in bundle['files'].items():assert sha(SERVER/rel)==h
    assert bundle['revision']=='65ccdaac9fb12b749795e7fcbbcd856a02830600'
    assert json.loads((ROOT/'web-build-verification.json').read_text())['provenance']['sourceGitSha']=='5c8156d464d0c6e8fd005d46fc9b6f097069da7b'
    flags=json.loads((ROOT/'runtime-flags.json').read_text())
    assert flags['growdeskEnabled'] and flags['usesGoBackend'] and flags['vapidSubjectPreservesWebValue']
    for scope in ('web','combined'):
        config=json.loads((ROOT/f'config-{scope}.json').read_text())['vapid']
        assert config['pairMatches'] and config['publicSha256']=='76792afefa401d2a6f0d8ddcc126ef9b14e05129e04f89b2cb8c726c6d5ffe61'
    receipt['environmentFilesBefore']={str(p):stats(p) for p in (LIVE/'.env',Path('/home/ubuntu/growdesk/api.env'))}
    receipt['previousPid']={u:int(ctl('show','--property=MainPID','--value',u).stdout) for u in ('growdesk-api','baby-panel')}
    assert all(receipt['previousPid'].values())
    receipt['beforeHealth']=health()
    ROLLBACK.mkdir(mode=0o700)
    shutil.copy2(API,ROLLBACK/'growdesk-api')
    assert sha(ROLLBACK/'growdesk-api')=='80cc6c2f14932d13116b4d67fdf720365b71635031277083614c43cb58458562'
    receipt['phase']='migration';save()
    sql((SERVER/'production-migration.sql').read_text())
    verification=json.loads(sql("SELECT json_build_object('checksum',(SELECT sha256 FROM native_go.migrations WHERE name='0004_family_notifications.sql'),'roleGone',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='growdesk_push_migrator_20261006'),'ownersRestored',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN('notifications','task_outbox','notification_preferences') AND tableowner='postgres')=3,'appStillNonSuper',NOT(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname='growdesk'),'appCrud',has_table_privilege('growdesk','public.notification_preferences','SELECT,INSERT,UPDATE,DELETE'),'indexesValid',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('family_record_notification_recipient_event','family_record_outbox_task_phase') AND i.indisvalid)=2);"))
    assert verification['checksum']=='1dcb0e81c4f4b0a44595b30129990325e69a82c79efc215f6ab4a19f742c4a88'
    assert all(verification[k] for k in ('roleGone','ownersRestored','appStillNonSuper','appCrud','indexesValid'))
    receipt['migration']=verification;receipt['phase']='switching';save()
    receipt['liveSwitchStarted']=True;save()
    ctl('stop','baby-panel','growdesk-api')
    candidate=ROOT/'web-source/.next'
    runtime_paths=('data/archive','public/uploads','backups','llm-profiles.json')
    preserved={}
    for rel in runtime_paths:
        src=LIVE/rel;dst=candidate/'standalone'/rel
        if not src.exists():continue
        if dst.exists():
            if dst.is_dir():shutil.rmtree(dst)
            else:dst.unlink()
        dst.parent.mkdir(parents=True,exist_ok=True)
        if src.is_dir():shutil.copytree(src,dst,symlinks=True)
        else:shutil.copy2(src,dst)
        assert digest(src)==digest(dst)
        preserved[rel]=digest(src)
    receipt['runtimePreservationSha256']=preserved
    (LIVE/'.next').rename(ROLLBACK/'web-next')
    candidate.rename(LIVE/'.next')
    staging=API.with_name('growdesk-api.push-new')
    shutil.copy2(SERVER/'bin/growdesk-api',staging);staging.chmod(0o755);staging.replace(API)
    install(DROPIN,'[Service]\nEnvironmentFile=\nEnvironmentFile=/home/ubuntu/Github/baby_panel_for_cecilia/.env\nEnvironmentFile=/home/ubuntu/growdesk/api.env\nExecStart=\nExecStart=/usr/bin/python3 '+str(SERVER/'environment-launch.py')+' '+str(API)+'\n')
    install(WORKER,'[Unit]\nDescription=GrowDesk family notification worker\nAfter=network-online.target growdesk-api.service\nWants=network-online.target\n[Service]\nType=simple\nUser=ubuntu\nWorkingDirectory=/home/ubuntu/growdesk\nEnvironmentFile=/home/ubuntu/Github/baby_panel_for_cecilia/.env\nEnvironmentFile=/home/ubuntu/growdesk/api.env\nEnvironment=GROWDESK_WORKER_CONCURRENCY=2\nExecStart=/usr/bin/python3 '+str(SERVER/'environment-launch.py')+' '+str(SERVER/'bin/growdesk-worker')+' --notifications-only\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=30s\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n')
    ctl('daemon-reload');ctl('start','growdesk-api','baby-panel')
    receipt['afterHealth']=wait_ready()
    for _ in range(30):
        if code('http://127.0.0.1:3088/notifications')==200:break
        time.sleep(1)
    else:raise RuntimeError('Web readiness failed')
    statuses={p:code('http://127.0.0.1:3088'+p) for p in ('/notifications','/family/passport','/sw.js','/api/push/vapid-key','/api/passport/devices')}
    assert statuses=={'/notifications':200,'/family/passport':200,'/sw.js':200,'/api/push/vapid-key':401,'/api/passport/devices':401}
    receipt['localStatus']=statuses
    ctl('enable','--now','growdesk-notifications-worker')
    time.sleep(3)
    assert ctl('is-active','growdesk-notifications-worker').stdout.strip()==b'active'
    receipt['pid']={u:int(ctl('show','--property=MainPID','--value',u).stdout) for u in ('growdesk-api','baby-panel','growdesk-notifications-worker')}
    for u,rel in (('growdesk-api','bin/growdesk-api'),('growdesk-notifications-worker','bin/growdesk-worker')):
        assert sha(Path('/proc')/str(receipt['pid'][u])/'exe')==bundle['files'][rel]
    cmdline=(Path('/proc')/str(receipt['pid']['growdesk-notifications-worker'])/'cmdline').read_bytes().split(b'\0')
    assert b'--notifications-only' in cmdline
    receipt['apiRevision']=json.loads(run([str(API),'--version']).stdout)
    receipt['workerRevision']=json.loads(run([str(SERVER/'bin/growdesk-worker'),'--version']).stdout)
    receipt['environmentFilesAfter']={p:stats(Path(p)) for p in receipt['environmentFilesBefore']}
    assert receipt['environmentFilesBefore']==receipt['environmentFilesAfter']
    receipt.update({'phase':'deployed','deployed':True,'apiSource':bundle['revision'],'webSource':'5c8156d464d0c6e8fd005d46fc9b6f097069da7b','workerProfile':'notifications-only','environmentFilesUnchanged':True,'noTestPushSent':True,'rollbackDirectory':str(ROLLBACK)})
    save();print(json.dumps(receipt))
except BaseException as error:
    receipt.update({'deployed':False,'failureClass':type(error).__name__,'failureMessage':str(error) if isinstance(error,(AssertionError,RuntimeError)) else 'operation failed'})
    if receipt.get('liveSwitchStarted'):
        try:
            if WORKER.exists():
                ctl('disable','--now','growdesk-notifications-worker')
                state=ctl('show','--property=ActiveState','--value','growdesk-notifications-worker').stdout.strip()
                worker_pid=int(ctl('show','--property=MainPID','--value','growdesk-notifications-worker').stdout)
                assert state in (b'inactive',b'failed') and worker_pid==0, 'notification worker rollback is incomplete'
            ctl('stop','baby-panel','growdesk-api')
            if (ROLLBACK/'web-next').exists():
                if (LIVE/'.next').exists():(LIVE/'.next').rename(ROOT/'failed-web-next')
                (ROLLBACK/'web-next').rename(LIVE/'.next')
            if (ROLLBACK/'growdesk-api').exists():
                staging=API.with_name('growdesk-api.push-rollback');shutil.copy2(ROLLBACK/'growdesk-api',staging);staging.chmod(0o755);staging.replace(API)
            run(['sudo','-n','rm','-f',str(DROPIN),str(WORKER)])
            ctl('daemon-reload');ctl('start','growdesk-api','baby-panel')
            receipt['rollbackHealth']=wait_ready();receipt['rolledBack']=True
        except BaseException as rollback_error:receipt['rollbackErrorClass']=type(rollback_error).__name__
    save();print(json.dumps(receipt));raise
