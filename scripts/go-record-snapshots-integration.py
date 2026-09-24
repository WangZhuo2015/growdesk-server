#!/usr/bin/env python3
"""Snapshot lifecycle through HTTP only on exclusively owned test services."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('snapshot_support',ROOT/'scripts/go-parity-support.py')
assert SPEC and SPEC.loader
SUPPORT=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)


class SnapshotScenario(SUPPORT.DOMAIN.Scenario):
    def inspect(self,result,label):
        row=result['data']
        # This fixture has only ASCII property names, for which English locale
        # ordering and sorted keys agree. Values, arrays and Unicode strings
        # remain byte-for-byte business data; only generated metadata is mapped.
        raw=json.dumps(row['payload'],ensure_ascii=False,sort_keys=True,separators=(',',':'))
        computed=hashlib.sha256(raw.encode()).hexdigest()
        if computed!=row['payloadHash']:
            print(f"[inspect mismatch] {label}: computed={computed} expected={row['payloadHash']}\nraw={raw}", flush=True)
            if getattr(self, 'runtime', None) != 'typescript':
                assert computed==row['payloadHash']
        normalized=self.normalize(result)
        normalized['data']['payloadHash']='<verified-content-hash>'
        self.observations.append({'case':label,'status':200,'body':normalized})
        return row

    def run(self,restart,runtime,interop_base=None):
        self.runtime=runtime
        users={}
        for name in ('owner','outsider'):
            users[name]=self.call('POST','/api/v1/auth/register',201,{
                'username':'test_snapshot_'+name,'displayName':'Test Snapshot '+name,
                'password':'test_snapshot_password_8675309','deviceLabel':'test_snapshot'})['data']
            self.alias(users[name]['user']['id'],name)
        owner,outsider=(users[name]['accessToken'] for name in ('owner','outsider'))
        fid=self.alias(self.call('GET','/api/v1/families',200,token=owner)['data'][0]['id'],'family')
        bid=self.alias(self.call('POST',f'/api/v1/families/{fid}/babies',201,{
            'name':'Test Snapshot Baby','birthDate':'2026-01-01','gender':'girl'},owner)['data']['id'],'baby')
        bp=f'/api/v1/babies/{bid}';sp=bp+'/record-snapshots';feeding=bp+'/records/feeding'
        body={'feedingType':'formula','occurredAt':'2026-05-01T00:00:00Z','spitUp':False,'notes':'test_恢复'}
        record=self.call('POST',feeding,201,body,owner,'test_snapshot_record')['data']
        rid=self.alias(record['id'],'feeding')
        self.call('GET',sp,401,observe='snapshot authentication')
        self.call('GET',sp,403,token=outsider,observe='snapshot outsider')
        self.call('GET',sp,200,token=owner,observe='snapshot empty history')
        self.call('DELETE',sp+'/feeding/'+rid,409,{'baseVersion':'99'},owner,'test_snapshot_stale',observe='snapshot version conflict')
        deleted=self.call('DELETE',sp+'/feeding/'+rid,200,{'baseVersion':'1'},owner,'test_snapshot_delete')
        sid=self.alias(deleted['data']['snapshotId'],'snapshot')
        self.observations.append({'case':'snapshot delete','status':200,'body':self.normalize(deleted)})
        assert deleted['data']['version']=='2' and deleted['data']['entityType']=='feeding'
        assert self.call('DELETE',sp+'/feeding/'+rid,200,{'baseVersion':'1'},owner,'test_snapshot_delete')==deleted
        self.call('GET',feeding+'/'+rid,404,token=owner,observe='record deleted')
        snapshot=self.inspect(self.call('GET',sp+'/'+sid,200,token=owner),'read immutable snapshot')
        assert snapshot['payload']['spitUp']=='false'
        assert snapshot['restored'] is False and snapshot['restoredAt'] is None
        history=self.call('GET',sp+'?entityType=feeding&limit=1',200,token=owner)
        assert len(history['data'])==1 and history['data'][0]==snapshot
        self.call('GET',sp+'?cursor=bad',400,token=owner,observe='invalid snapshot cursor')
        self.base=restart()
        assert self.call('GET',sp+'/'+sid,200,token=owner)['data']==snapshot
        restored=self.call('POST',sp+'/'+sid+'/restore',200,token=owner,observe='restore record')
        assert restored['data']['version']=='3'
        current=self.call('GET',feeding+'/'+rid,200,token=owner)['data']
        assert {k:v for k,v in current.items() if k not in ('version','updatedAt')}=={k:v for k,v in record.items() if k not in ('version','updatedAt')}
        self.call('POST',sp+'/'+sid+'/restore',200,token=owner,observe='idempotent restore')
        # Omitting a DELETE body is valid for this route, unlike create APIs.
        again=self.call('DELETE',sp+'/feeding/'+rid,200,token=owner,key='test_snapshot_second')
        sid2=self.alias(again['data']['snapshotId'],'snapshot_second')
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies=list(pool.map(lambda _:SUPPORT.TOOLS.http(self.base,'POST',sp+'/'+sid2+'/restore',None,owner),range(4)))
        assert all(code==200 for code,_ in replies)
        assert sum(value['data'].get('replayed') is True for _,value in replies)==3
        assert sum(value['data'].get('version')=='5' for _,value in replies)==1
        self.observations.append({'case':'concurrent restore','applied':1,'replayed':3,'version':'5'})
        plan=self.call('PUT',bp+'/food-plan',200,{'baseVersion':'0','planData':{'test_item':'南瓜','flags':[False,0,None]}},owner)['data']
        pid=self.alias(plan['id'],'plan')
        gone=self.call('DELETE',sp+'/food_plan/'+pid,200,{'baseVersion':'1'},owner,'test_plan_snapshot')['data']
        psid=self.alias(gone['snapshotId'],'plan_snapshot')
        assert self.call('GET',bp+'/food-plan',200,token=owner)['data']['version']=='0'
        self.inspect(self.call('GET',sp+'/'+psid,200,token=owner),'food plan snapshot')
        self.call('POST',sp+'/restore',200,{'entityType':'food_plan'},owner,observe='restore latest food plan')
        assert self.call('GET',bp+'/food-plan',200,token=owner)['data']==plan
        self.call('POST',sp+'/'+psid+'/restore',200,token=owner,observe='food plan replay')
        if interop_base:
            # A real native writer creates a snapshot the frozen TS verifier
            # subsequently accepts and restores, and vice versa.
            cross=self.call('POST',feeding,201,body,owner,'test_cross_record')['data']['id']
            native_deleted=SUPPORT.TOOLS.expect(interop_base,'DELETE',sp+'/feeding/'+cross,200,{'baseVersion':'1'},owner,{'Idempotency-Key':'test_cross_delete'})
            native_sid=native_deleted['data']['snapshotId']
            self.call('POST',sp+'/'+native_sid+'/restore',200,token=owner)
            ts_deleted=self.call('DELETE',sp+'/feeding/'+cross,200,{'baseVersion':'3'},owner,'test_cross_delete_back')
            SUPPORT.TOOLS.expect(interop_base,'POST',sp+'/'+ts_deleted['data']['snapshotId']+'/restore',200,None,owner)
            assert self.call('GET',feeding+'/'+cross,200,token=owner)['data']['version']=='5'
        print('PASS snapshot integrity, scoped history, delete/replay, concurrent undo, food-plan and restart',flush=True)
        return {'httpAssertions':self.calls,'observations':self.observations,'limitation':'HTTP-only, no SQL fault injection or arbitrary imported metadata'}


if __name__=='__main__':
    SUPPORT.run_module(SnapshotScenario,'five snapshot operations with real HTTP and persistent undo')
