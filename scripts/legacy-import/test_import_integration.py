"""Run only via the owned PG18 integration runner; all rows use test_ tenants."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

spec=importlib.util.spec_from_file_location('import_sql',Path(__file__).with_name('import_sql.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def main():
    manifest=Path(os.environ['BOOT02_RUN_FILE']).resolve()
    assert manifest.parent.parent==Path(tempfile.gettempdir()).resolve()
    assert manifest.parent.name.startswith('growdesk-integration-') and manifest.stat().st_mode & 0o077 == 0
    run=json.loads(manifest.read_text());assert run['database']=='test_growdesk_integration' and run['user']=='test_runner'
    binary=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@18/bin'))/'psql'
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['PGPASSWORD']=run['password']
    cmd=[str(binary),'-X','-h','127.0.0.1','-p',str(run['pgPort']),'-U',run['user'],'-d',run['database'],'-v','ON_ERROR_STOP=1','-At']
    def execute(sql,success=True):
        p=subprocess.run(cmd,input=sql,capture_output=True,text=True,env=env)
        assert (p.returncode==0)==success, p.stderr.replace(run['password'],'[redacted]')
        return p.stdout.strip()
    assert execute("SELECT current_user || '|' || current_setting('cluster_name')")==run['user']+'|'+run['token']
    if execute("SELECT to_regclass('public.users') IS NULL") == 't':
        execute(Path('prisma/migrations/202609120001_identity/migration.sql').read_text())
    date='2026-09-12T00:00:00Z'
    def metadata():return dict(createdAt=date,updatedAt=date)
    tables={'User':[dict(id='test_user_'+str(i),username='test_user_'+str(i),passwordHash='$2b$10$'+'a'*53,displayName='test_user',**metadata()) for i in [1,2]],
      'Family':[dict(id='test_family_'+str(i),name='test_family',**metadata()) for i in [1,2]],
      'Baby':[dict(id='test_baby_'+str(i),familyId='test_family_'+str(i),nickname='test_baby',gender='female',birthDate='2026-01-01',gestationalAge=38 if i==1 else None,**metadata()) for i in [1,2]],
      'FamilyMember':[dict(id='test_member_'+str(i),familyId='test_family_'+str(i),userId='test_user_'+str(i),role='admin',**metadata()) for i in [1,2]],
      'FeedingRecord':[dict(id='test_record',babyId='test_baby_1',notes="test_'\\; DROP TABLE users; --") ]}
    data=dict(formatVersion=1,timeZone='Asia/Shanghai',capturedAt=date,sourceId='test_source',sourceSha256='a'*64,tables=tables,excluded={})
    # A constraint failure in a later row must roll back the archive and prior identities.
    invalid=json.loads(json.dumps(data));invalid['tables']['Baby'][1]['gender']='test_invalid'
    execute(module.render_import(invalid,'b'*64),success=False)
    assert execute('SELECT count(*) FROM public.users')=='0'
    assert execute('SELECT count(*) FROM legacy_import.import_batches')=='0'
    sql=module.render_import(data,'c'*64);execute(sql);execute(sql)
    assert execute('SELECT count(*) FROM public.users')=='2'
    assert execute('SELECT count(*) FROM public.baby_members')=='2'
    assert execute("SELECT gestational_age FROM public.babies WHERE id='test_baby_1'")=='266'
    assert execute("SELECT gestational_age IS NULL FROM public.babies WHERE id='test_baby_2'")=='t'
    assert execute('SELECT count(*) FROM legacy_import.import_rows')==str(sum(map(len,tables.values())))
    execute(module.render_import(data,'d'*64),success=False)
    assert execute('SELECT count(*) FROM legacy_import.import_batches')=='1'
    execute("INSERT INTO public.baby_members(id,user_id,family_id,baby_id,updated_at) VALUES('test_cross','test_user_1','test_family_2','test_baby_1',now())",success=False)
    assert execute("SELECT count(*) FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspname='legacy_import' AND a.grantee=0 AND a.privilege_type='USAGE'")=='0'
    execute("DELETE FROM public.users WHERE id='test_user_1'")
    assert execute("SELECT count(*) FROM public.babies WHERE id='test_baby_1'")=='1'
    assert execute("SELECT count(*) FROM public.baby_members WHERE user_id='test_user_1'")=='0'
    print('Legacy import integration PASS: atomic rollback, same batch retry, changed batch refusal, multi-family composite FK, user deletion preserves shared baby, archive private.')

if __name__=='__main__':main()
