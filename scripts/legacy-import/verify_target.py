"""Owner-only verification on the target host; prints aggregate evidence only."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

def verify(archive):
    raw=Path(archive).read_bytes();data=json.loads(raw);checksum=hashlib.sha256(raw).hexdigest()
    def query(sql):
        p=subprocess.run(['docker','exec','-i','growdesk-postgres-1','psql','-X','-U','postgres','-d','growdesk','-At','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True)
        if p.returncode:raise RuntimeError('Target verification query failed')
        return json.loads(p.stdout)
    # Fetch sensitive rows only into memory; never print them or psql stderr.
    imported=query('SELECT coalesce(json_agg(r),\'[]\'::json) FROM (SELECT source_table,source_id,payload,payload_hash FROM legacy_import.import_rows) r;')
    expected={(t,row['id']):row for t,rows in data['tables'].items() for row in rows}
    assert len(imported)==len(expected)
    for row in imported:
        source=expected[(row['source_table'],row['source_id'])]
        assert row['payload']==source
        assert row['payload_hash']==hashlib.sha256(json.dumps(source,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    users=query('SELECT coalesce(json_agg(r),\'[]\'::json) FROM (SELECT id,username,password_hash,display_name FROM public.users) r;')
    source_users={r['id']:r for r in data['tables']['User']};assert len(users)==len(source_users)
    for row in users:
        source=source_users[row['id']]
        assert row['username']==source['username'] and row['password_hash']==source['passwordHash'] and row['display_name']==source['displayName']
    members=query('SELECT coalesce(json_agg(r),\'[]\'::json) FROM (SELECT user_id,baby_id,family_id,role,status FROM public.baby_members) r;')
    wanted={(m['userId'],b['id'],b['familyId'],m['role'],'active') for m in data['tables']['FamilyMember'] for b in data['tables']['Baby'] if b['familyId']==m['familyId']}
    assert {tuple(m[k] for k in ['user_id','baby_id','family_id','role','status']) for m in members}==wanted
    counts=query("SELECT json_build_object('users',(SELECT count(*) FROM public.users),'families',(SELECT count(*) FROM public.families),'babies',(SELECT count(*) FROM public.babies),'familyMembers',(SELECT count(*) FROM public.family_members),'babyMembers',(SELECT count(*) FROM public.baby_members),'archiveRows',(SELECT count(*) FROM legacy_import.import_rows),'apiCanReadUsers',has_table_privilege('growdesk','public.users','SELECT'),'apiCanReadArchive',has_table_privilege('growdesk','legacy_import.import_rows','SELECT'),'appliedMigrations',(SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL));")
    assert counts['families']==len(data['tables']['Family']) and counts['babies']==len(data['tables']['Baby']) and counts['familyMembers']==len(data['tables']['FamilyMember'])
    assert not counts['apiCanReadUsers'] and not counts['apiCanReadArchive']
    return dict(batchId=checksum,counts=counts,allArchivedRowsMatch=True,passwordHashesPreserved=True,babyMembershipBackfillMatches=True,businessHistoryReady=False,newLoginReady=False)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--archive',required=True);args=parser.parse_args()
    try:print(json.dumps(verify(args.archive),indent=2))
    except Exception as error:
        print(json.dumps({'error':type(error).__name__}));raise SystemExit(1)
