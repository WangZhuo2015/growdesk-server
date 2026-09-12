"""Render an atomic import from a private archive. Output contains secrets.

No database connections. Send output only to a private file/psql stdin.
Production application tables are never updated by a repeat import.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import uuid

CORE_TABLES = ('User','Family','FamilyMember','Baby')

def literal(value):
    if value is None:return 'NULL'
    if isinstance(value,bool):return 'TRUE' if value else 'FALSE'
    if isinstance(value,(int,float)):return str(value)
    return "'"+str(value).replace("'","''")+"'"

def instant(value):
    if isinstance(value,(int,float)):
        return datetime.datetime.fromtimestamp(value/1000,datetime.timezone.utc).isoformat()
    parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Ambiguous legacy timestamp')
    return parsed.astimezone(datetime.timezone.utc).isoformat()

def load_archive(path):
    raw=Path(path).read_bytes();data=json.loads(raw)
    if data.get('formatVersion')!=1 or data.get('timeZone')!='Asia/Shanghai':raise ValueError('Unsupported archive')
    for name in CORE_TABLES:
        if name not in data['tables']:raise ValueError('Missing core table')
    users={r['id']:r for r in data['tables']['User']}
    families={r['id']:r for r in data['tables']['Family']}
    babies={r['id']:r for r in data['tables']['Baby']}
    for baby in babies.values():
        if baby['familyId'] not in families:raise ValueError('Orphan baby')
        datetime.date.fromisoformat(baby['birthDate'])
    pairs=set()
    for member in data['tables']['FamilyMember']:
        pair=(member['userId'],member['familyId'])
        if pair in pairs or member['userId'] not in users or member['familyId'] not in families or member['role'] not in ('admin','member','viewer'):raise ValueError('Invalid legacy membership')
        pairs.add(pair)
    for family in families:
        if not any(r['familyId']==family and r['role']=='admin' for r in data['tables']['FamilyMember']):raise ValueError('Family has no administrator')
    for user in users.values():
        if not user['passwordHash'].startswith(('$2a$','$2b$','$2y$')):raise ValueError('Unsupported password hash')
    return data,hashlib.sha256(raw).hexdigest()

# render_import is filled with the checked schema contract below.
def render_import(data, checksum):
    tables=data['tables'];now=instant(data['capturedAt'])
    counts={t:len(rows) for t,rows in tables.items()};total=sum(counts.values())
    inserts=[]
    def insert(table,values):
        inserts.append('INSERT INTO '+table+' ('+','.join('"'+key+'"' for key in values)+') VALUES ('+','.join(literal(v) for v in values.values())+');')
    def metadata(row):
        return dict(created_at=instant(row['createdAt']),updated_at=instant(row.get('updatedAt',row['createdAt'])))
    insert('legacy_import.import_batches',dict(batch_id=checksum,source_system=data['sourceId'],source_snapshot=data['sourceSha256'],checksum=checksum,mapping_version='identity-v1',row_count=total,table_counts=json.dumps(counts),metadata=json.dumps({'historyState':'preserved_not_business_tables','timeZone':data['timeZone'],'excluded':data['excluded']})))
    for table,rows in sorted(tables.items()):
        ids=set()
        for row in rows:
            if not isinstance(row['id'],str) or row['id'] in ids:raise ValueError('Duplicate/missing source ID')
            ids.add(row['id'])
            payload=json.dumps(row,sort_keys=True,ensure_ascii=False,separators=(',',':'))
            insert('legacy_import.import_rows',dict(batch_id=checksum,source_table=table,source_id=row['id'],user_id=row.get('userId'),family_id=row.get('familyId'),baby_id=row.get('babyId'),payload=payload,payload_hash=hashlib.sha256(payload.encode()).hexdigest(),captured_at=now))
    for row in tables['User']:
        insert('public.users',dict(id=row['id'],username=row['username'],password_hash=row['passwordHash'],password_hash_algorithm='bcrypt',password_hash_needs_rehash=True,display_name=row['displayName'],timezone=data['timeZone'],**metadata(row)))
        insert('public.user_sync_states',dict(user_id=row['id'],epoch=str(uuid.uuid5(uuid.NAMESPACE_URL,checksum+'/user/'+row['id'])),created_at=now,updated_at=now))
    for row in tables['Family']:
        insert('public.families',dict(id=row['id'],name=row['name'],timezone=data['timeZone'],**metadata(row)))
        insert('public.family_sync_states',dict(family_id=row['id'],epoch=str(uuid.uuid5(uuid.NAMESPACE_URL,checksum+'/family/'+row['id'])),created_at=now,updated_at=now))
    for row in tables['Baby']:
        # Legacy URLs are provenance, not authorized public object URLs.
        insert('public.babies',dict(id=row['id'],family_id=row['familyId'],nickname=row['nickname'],birth_date=row['birthDate'],gender=row['gender'],gestational_age=row.get('gestationalAge'),avatar_metadata=json.dumps({'legacyUrl':row.get('avatarUrl'),'state':'pending_private_attachment_mapping'}),**metadata(row)))
    for row in tables['FamilyMember']:
        insert('public.family_members',dict(id=row['id'],family_id=row['familyId'],user_id=row['userId'],role=row['role'],relation=row.get('relation','parent'),status='active',**metadata(row)))
        for baby in tables['Baby']:
            if baby['familyId']==row['familyId']:
                insert('public.baby_members',dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL,data['sourceId']+'/baby-member/'+row['userId']+'/'+baby['id'])),family_id=row['familyId'],baby_id=baby['id'],user_id=row['userId'],role=row['role'],status='active',created_at=now,updated_at=now))
    body='\n'.join(inserts)
    delimiter='$import_'+checksum+'$'
    if delimiter in body:raise ValueError('SQL delimiter collision')
    sql=f'''BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(724019231);
DO {delimiter}
BEGIN
IF EXISTS (SELECT 1 FROM legacy_import.import_batches WHERE batch_id={literal(checksum)} AND checksum={literal(checksum)} AND row_count={total}) THEN
  IF (SELECT count(*) FROM legacy_import.import_rows WHERE batch_id={literal(checksum)}) <> {total} THEN
    RAISE EXCEPTION 'Prior batch count mismatch';
  END IF;
  RETURN;
END IF;
IF EXISTS (SELECT 1 FROM public.users) OR EXISTS (SELECT 1 FROM public.families) OR EXISTS (SELECT 1 FROM public.babies) OR EXISTS (SELECT 1 FROM legacy_import.import_batches) THEN
  RAISE EXCEPTION 'Initial import requires empty identity tables; refuses to overwrite existing data';
END IF;
{body}
END;
{delimiter};
COMMIT;
SELECT json_build_object('users',(SELECT count(*) FROM public.users),'families',(SELECT count(*) FROM public.families),'babies',(SELECT count(*) FROM public.babies),'familyMembers',(SELECT count(*) FROM public.family_members),'babyMembers',(SELECT count(*) FROM public.baby_members),'archivedRows',(SELECT count(*) FROM legacy_import.import_rows),'batchId',{literal(checksum)});
'''
    return sql

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True)
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        data,checksum=load_archive(args.archive)
        if checksum!=args.sha256:raise ValueError('Archive checksum mismatch')
        sql=render_import(data,checksum)
        import os
        fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as output:output.write(sql)
        print(json.dumps({'status':'prepared','tableCounts':{t:len(r) for t,r in data['tables'].items()}}))
    except Exception as error:
        print(json.dumps({'error':type(error).__name__}))
        raise SystemExit(1)
