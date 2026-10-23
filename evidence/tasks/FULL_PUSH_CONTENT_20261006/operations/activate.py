from pathlib import Path
import hashlib, json, shutil, subprocess, time, urllib.request, urllib.error
ROOT=Path('/home/ubuntu/growdesk/push-releases/full-record-content-20261006')
LIVE=Path('/home/ubuntu/Github/baby_panel_for_cecilia')
API=Path('/home/ubuntu/growdesk/bin/growdesk-api')
OLD=Path('/home/ubuntu/growdesk/push-releases/web-push-20261006')
SERVER=ROOT/'server'
ROLLBACK=ROOT/'rollback'
DROPIN=Path('/etc/systemd/system/growdesk-notifications-worker.service.d/50-full-record-content.conf')
UNITS=('growdesk-api','baby-panel','growdesk-notifications-worker')
receipt={'phase':'preflight','deployed':False,'physicalDeviceReceiptVerified':False,'schemaChanged':False,'noTestPushSent':True}
def save(): (ROOT/'deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
def run(args,**kw): return subprocess.run(args,check=True,capture_output=True,**kw)
def ctl(*args): return run(['sudo','-n','systemctl',*args])
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def stats(p):
    s=p.stat();return {'size':s.st_size,'mtimeNs':s.st_mtime_ns,'mode':s.st_mode&0o777,'uid':s.st_uid,'gid':s.st_gid}
def props(u):
    keys=('ActiveState','SubState','MainPID','NRestarts');raw=ctl('show',*[f'--property={k}' for k in keys],u).stdout.decode()
    return dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
def status(url):
    try:
        with urllib.request.urlopen(url,timeout=5) as r:return r.status
    except urllib.error.HTTPError as e:return e.code
    except (urllib.error.URLError,TimeoutError):return 0
def health():
    with urllib.request.urlopen('http://127.0.0.1:3081/health/ready',timeout=5) as r: data=json.load(r)
    assert data['status']=='ok' and data['dependencies']=={'postgres':'ok','redis':'ok'};return data
def wait_api():
    for _ in range(30):
        try:return health()
        except (OSError,ValueError,AssertionError):time.sleep(1)
    raise RuntimeError('API readiness failed')
def wait_web():
    for _ in range(30):
        if status('http://127.0.0.1:3088/notifications')==200:return
        time.sleep(1)
    raise RuntimeError('Web readiness failed')
def install(path,content):
    run(['sudo','-n','mkdir','-p',str(path.parent)]);run(['sudo','-n','tee',str(path)],input=content.encode())
def copy_api(src,suffix):
    stage=API.with_name('growdesk-api.'+suffix);shutil.copy2(src,stage);stage.chmod(0o755);stage.replace(API)
def stop_worker():
    ctl('stop','growdesk-notifications-worker');p=props('growdesk-notifications-worker')
    assert p['ActiveState'] in ('inactive','failed') and p['MainPID']=='0','worker stop incomplete'
try:
    assert not ROLLBACK.exists() and not DROPIN.exists(),'release already switched'
    assert sha(API)=='3068befb3594b38bbd851c5737877f9db407905c7294905b1a1d12c68a59f63b','API baseline changed'
    assert sha(OLD/'server/bin/growdesk-worker')=='499253bf1acb7fab7895bee54c804a3052abd7a39b1227da5dae84fe9a5334d3','worker baseline changed'
    bundle=json.loads((SERVER/'bundle-manifest.json').read_text())
    for rel,h in bundle['files'].items():assert sha(SERVER/rel)==h,rel+' hash mismatch'
    web=json.loads((ROOT/'web-build-verification.json').read_text())
    assert web['provenance']['sourceGitSha']=='c366c6818887fb400d541dc679fc5c5b936392b0' and web['completeNotificationBodySource']
    receipt['beforeServices']={u:props(u) for u in UNITS}
    assert all(v['ActiveState']=='active' and int(v['MainPID'])>0 for v in receipt['beforeServices'].values())
    for unit,path in (('growdesk-api',API),('growdesk-notifications-worker',OLD/'server/bin/growdesk-worker')):
        assert sha(Path('/proc')/receipt['beforeServices'][unit]['MainPID']/'exe')==sha(path),'running binary baseline changed'
    receipt['beforeHealth']=health()
    receipt['beforeWebProvenance']=json.loads((LIVE/'.next/standalone/build-provenance.json').read_text())
    receipt['sourcePageBefore']=sha(LIVE/'app/notifications/page.tsx')
    assert receipt['sourcePageBefore']=='a18f90face26d50df8cada8f041f5decdd4042c0d2480f074ec9f9701521d4c5','live Web source changed; preserve additional edits'
    receipt['environmentFilesBefore']={str(p):stats(p) for p in (LIVE/'.env',Path('/home/ubuntu/growdesk/api.env'))}
    ROLLBACK.mkdir(mode=0o700);shutil.copy2(API,ROLLBACK/'growdesk-api');shutil.copy2(LIVE/'app/notifications/page.tsx',ROLLBACK/'notifications-page.tsx')
    receipt['phase']='switching';receipt['liveSwitchStarted']=True;save()
    stop_worker();ctl('stop','growdesk-api','baby-panel')
    candidate=ROOT/'web-source/.next'
    preserved=[]
    # Keep mutable Web runtime files in their current locations. The fallback
    # handles a directory which has not been used by the standalone process.
    for rel in ('data/archive','public/uploads','backups','llm-profiles.json'):
        src=LIVE/'.next/standalone'/rel
        if not src.exists():src=LIVE/rel
        if not src.exists():continue
        dst=candidate/'standalone'/rel
        if dst.exists():
            if dst.is_dir():shutil.rmtree(dst)
            else:dst.unlink()
        dst.parent.mkdir(parents=True,exist_ok=True)
        if src.is_dir():shutil.copytree(src,dst,symlinks=True)
        else:shutil.copy2(src,dst)
        preserved.append(rel)
    receipt['preservedRuntimePaths']=preserved
    (LIVE/'.next').rename(ROLLBACK/'web-next');candidate.rename(LIVE/'.next')
    page=LIVE/'app/notifications/page.tsx';text=page.read_text()
    replacements=(('text-xs text-text-secondary mt-0.5 leading-relaxed line-clamp-2','text-xs text-text-secondary mt-0.5 leading-relaxed whitespace-pre-wrap break-words'),('text-text-primary truncate`}','text-text-primary break-words`}'))
    for before,after in replacements:
        assert text.count(before)==1,'live source CSS differs from inspected source'
        text=text.replace(before,after)
    page.write_text(text);receipt['sourcePageAfter']=sha(page)
    receipt['serverSourcePatchOnly']=True
    copy_api(SERVER/'bin/growdesk-api','full-content-new')
    install(DROPIN,'[Service]\nExecStart=\nExecStart=/usr/bin/python3 '+str(SERVER/'environment-launch.py')+' '+str(SERVER/'bin/growdesk-worker')+' --notifications-only\n')
    ctl('daemon-reload');ctl('start','growdesk-api','baby-panel')
    receipt['afterHealth']=wait_api();wait_web()
    paths=('/notifications','/family/passport','/sw.js','/api/push/vapid-key','/api/passport/devices')
    receipt['localStatus']={p:status('http://127.0.0.1:3088'+p) for p in paths}
    assert receipt['localStatus']==dict(zip(paths,(200,200,200,401,401)))
    ctl('start','growdesk-notifications-worker');time.sleep(3)
    receipt['afterServices']={u:props(u) for u in UNITS}
    assert all(v['ActiveState']=='active' and int(v['MainPID'])>0 and v['NRestarts']=='0' for v in receipt['afterServices'].values())
    for unit,rel in (('growdesk-api','bin/growdesk-api'),('growdesk-notifications-worker','bin/growdesk-worker')):
        pid=receipt['afterServices'][unit]['MainPID'];assert sha(Path('/proc')/pid/'exe')==bundle['files'][rel]
    pid=receipt['afterServices']['growdesk-notifications-worker']['MainPID']
    assert b'--notifications-only' in (Path('/proc')/pid/'cmdline').read_bytes().split(b'\0')
    receipt['apiVersion']=json.loads(run([str(API),'--version']).stdout)
    receipt['workerVersion']=json.loads(run([str(SERVER/'bin/growdesk-worker'),'--version']).stdout)
    assert receipt['apiVersion']['revision']==bundle['revision'] and receipt['workerVersion']['revision']==bundle['revision']
    receipt['environmentFilesAfter']={p:stats(Path(p)) for p in receipt['environmentFilesBefore']}
    assert receipt['environmentFilesAfter']==receipt['environmentFilesBefore']
    assert json.loads((LIVE/'.next/standalone/build-provenance.json').read_text())==web['provenance']
    receipt.update({'phase':'deployed','deployed':True,'sourceRevision':bundle['revision'],'webSource':web['provenance']['sourceGitSha'],'workerProfile':'notifications-only','environmentFilesUnchanged':True,'rollbackDirectory':str(ROLLBACK)})
    save();print(json.dumps(receipt))
except BaseException as error:
    receipt.update({'deployed':False,'failureClass':type(error).__name__,'failureMessage':str(error) if isinstance(error,(AssertionError,RuntimeError)) else 'operation failed'})
    if receipt.get('liveSwitchStarted'):
        try:
            stop_worker();ctl('stop','growdesk-api','baby-panel')
            if (ROLLBACK/'web-next').exists():
                if (LIVE/'.next').exists():(LIVE/'.next').rename(ROOT/'failed-web-next')
                (ROLLBACK/'web-next').rename(LIVE/'.next')
            shutil.copy2(ROLLBACK/'notifications-page.tsx',LIVE/'app/notifications/page.tsx')
            copy_api(ROLLBACK/'growdesk-api','full-content-rollback')
            run(['sudo','-n','rm','-f',str(DROPIN)]);ctl('daemon-reload');ctl('start','growdesk-api','baby-panel')
            receipt['rollbackHealth']=wait_api();wait_web();ctl('start','growdesk-notifications-worker')
            time.sleep(3)
            receipt['rollbackServices']={u:props(u) for u in UNITS}
            for unit,expected in (('growdesk-api','3068befb3594b38bbd851c5737877f9db407905c7294905b1a1d12c68a59f63b'),('growdesk-notifications-worker','499253bf1acb7fab7895bee54c804a3052abd7a39b1227da5dae84fe9a5334d3')):
                properties=receipt['rollbackServices'][unit]
                assert properties['ActiveState']=='active' and int(properties['MainPID'])>0,'rollback service inactive'
                assert sha(Path('/proc')/properties['MainPID']/'exe')==expected,'rollback binary mismatch'
            assert sha(LIVE/'app/notifications/page.tsx')==receipt['sourcePageBefore'],'rollback source page mismatch'
            assert json.loads((LIVE/'.next/standalone/build-provenance.json').read_text())==receipt['beforeWebProvenance'],'rollback Web provenance mismatch'
            receipt['rolledBack']=True;receipt['rollbackBinaryHashesVerified']=True
        except BaseException as rollback_error:receipt['rollbackErrorClass']=type(rollback_error).__name__
    save();print(json.dumps(receipt));raise
