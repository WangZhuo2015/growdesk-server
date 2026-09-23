#!/usr/bin/env python3
"""HTTP-only regressions on the existing owned test harness.

This suite does not issue SQL, inject database faults, accept remote endpoints,
read production configuration, or contact AI providers. It verifies API behavior
and restart persistence; database fault-injection coverage is separate.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('expansion_support', ROOT / 'scripts/go-parity-support.py')
assert SPEC and SPEC.loader
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)


class ExpansionScenario(SUPPORT.DOMAIN.Scenario):
    def inspect_feed(self, result, runtime, scope, identity):
        assert set(result) == {'scope','epoch','changes','nextCursor','highWater','hasMore'}
        data, signature = result['nextCursor'].split('.')
        raw = base64.urlsafe_b64decode(data + '=' * (-len(data) % 4))
        # The public fallback is checked only on the frozen reference. Native
        # signing must instead use this harness's randomly generated JWT key.
        key = self.owned.env.get('SESSION_SECRET') or (
            self.owned.env['JWT_SECRET'] if runtime == 'go' else 'growdesk-default-sync-cursor-hmac-secret-32ch')
        assert hmac.compare_digest(signature, hmac.new(key.encode(),raw,hashlib.sha256).hexdigest())
        cursor = json.loads(raw)
        assert cursor['scope'] == scope and cursor['scopeId'] == identity
        assert cursor['epoch'] == result['epoch'] and cursor['highWater'] == result['highWater']
        assert 0 <= int(cursor['position']) <= int(cursor['highWater'])
        assert cursor['mode'] in ('page','tail') and cursor['schemaVersion'] == 1
        uuid.UUID(result['epoch'])
        return cursor

    def run(self, restart, runtime, interop_base=None):
        users = {}
        for name in ('owner','outsider'):
            users[name] = self.call('POST','/api/v1/auth/register',201,{
                'username':'test_go_expansion_'+name,'displayName':'Test Expansion '+name,
                'password':'test_expansion_password_8675309','deviceLabel':'test_expansion'})['data']
            self.alias(users[name]['user']['id'],name)
        owner,outsider = users['owner']['accessToken'],users['outsider']['accessToken']
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET','/api/v1/families',200,token=owner)['data'][0]['id'],'family')
        bid = self.alias(self.call('POST',f'/api/v1/families/{fid}/babies',201,{
            'name':'Test Expansion Baby','birthDate':'2026-01-02','gender':'girl'},owner)['data']['id'],'baby')
        bp = f'/api/v1/babies/{bid}'
        path = bp+'/growth-measurements'
        self.call('GET',path,401,observe='growth authentication')
        self.call('GET',path,403,token=outsider,observe='growth outsider')
        self.call('GET',path,200,token=owner,observe='growth empty')
        self.call('GET',bp+'/growth-chart',200,token=owner,observe='full empty chart')
        body = {'measurementDate':'2026-05-01','weightKg':'9.40','heightCm':'75.5','headCircumferenceCm':None,'notes':'test_成长'}
        first = self.call('POST',path,201,body,owner,'test_growth_first')
        rid = self.alias(first['data']['id'],'measurement')
        self.observations.append({'case':'growth create','status':201,'body':self.normalize(first)})
        assert first['data']['weightKg']=='9.40' and first['data']['heightCm']=='75.5'
        assert first['data']['attachmentId'] is None and 'legacyDate' not in first['data']
        assert self.call('POST',path,201,body,owner,'test_growth_first') == first
        self.call('POST',path,409,{**body,'notes':'different'},owner,'test_growth_first',observe='growth reused key')
        self.call('PATCH',path+'/'+rid,409,{'baseVersion':'99','notes':'test_stale'},owner,'test_growth_stale',observe='growth stale version')
        patch = {'baseVersion':'1','weightKg':'0','heightCm':None}
        second = self.call('PATCH',path+'/'+rid,200,patch,owner,'test_growth_patch',observe='growth zero null patch')
        assert second['data']['weightKg']=='0.00' and second['data']['heightCm'] is None
        assert second['data']['notes']==body['notes']
        assert self.call('PATCH',path+'/'+rid,200,patch,owner,'test_growth_patch')==second
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda i: SUPPORT.TOOLS.http(self.base,'PATCH',path+'/'+rid,
                {'baseVersion':'2','notes':'test_race_'+str(i)},owner,{'Idempotency-Key':'test_race_'+str(i)}),range(4)))
        assert sum(code==200 for code,_ in replies)==1
        assert sum(code==409 for code,_ in replies)==3
        self.observations.append({'case':'growth concurrent CAS','success':1,'conflicts':3})
        self.call('PATCH',path+'/'+rid,200,{'baseVersion':'3','notes':'test_stable'},owner,'test_stable')
        stable = self.call('GET',path+'/'+rid,200,token=owner,observe='growth stable')
        self.base = restart()
        assert self.call('GET',path+'/'+rid,200,token=owner)==stable
        self.call('GET',bp+'/growth-chart',200,token=owner,observe='full populated chart')
        later = self.call('POST',path,201,{**body,'measurementDate':'2026-06-01'},owner,'test_growth_second')
        later_id=self.alias(later['data']['id'],'second_measurement')
        page=self.call('GET',path+'?limit=1',200,token=owner,observe='growth page one')
        assert page['data'][0]['id']==later_id and page['page']['nextCursor']
        page2=self.call('GET',path+'?limit=1&cursor='+page['page']['nextCursor'],200,token=owner,observe='growth page two')
        assert page2['data'][0]['id']==rid and page2['page']['nextCursor'] is None
        self.call('DELETE',path+'/'+later_id+'?baseVersion=1',200,token=owner,key='test_delete',observe='growth delete')
        self.call('GET',path+'/'+later_id,404,token=owner,observe='growth deleted hidden')
        if interop_base:
            assert SUPPORT.TOOLS.expect(interop_base,'GET',path+'/'+rid,200,token=owner)==stable
            assert SUPPORT.TOOLS.expect(interop_base,'POST',path,201,body,owner,{'Idempotency-Key':'test_growth_first'})==first

        ai = self.call('POST','/api/v1/ai/sessions',201,{'babyId':bid,'title':'Test Core AI'},owner)
        sid=self.alias(ai['data']['id'],'ai_session')
        self.observations.append({'case':'AI session create','status':201,'body':self.normalize(ai)})
        self.call('GET','/api/v1/ai/sessions',200,token=owner,observe='AI session list')
        mp=f'/api/v1/ai/sessions/{sid}/messages'
        self.call('GET',mp,200,token=owner,observe='AI messages empty')
        self.call('GET',mp,404,token=outsider,observe='AI private owner')
        for i in range(3):
            mid=self.alias(str(uuid.uuid4()),'message_'+str(i))
            self.call('POST',f'/api/v1/web/ai/sessions/{sid}/messages',201,{
                'id':mid,'role':'user' if i%2==0 else 'assistant','content':'test_message_'+str(i)},owner)
        messages=self.call('GET',mp+'?limit=2',200,token=owner,observe='AI message first page')
        assert len(messages['data'])==2 and messages['page']['nextCursor']
        remaining=self.call('GET',mp+'?limit=2&cursor='+messages['page']['nextCursor'],200,token=owner,observe='AI message next page')
        assert len(remaining['data'])==1 and remaining['page']['nextCursor'] is None
        assert all(m['attachmentIds']==[] for m in messages['data'])
        self.base=restart()
        assert self.call('GET',mp+'?limit=2',200,token=owner)==messages
        self.call('GET',bp+'/daily-summaries',200,token=owner,observe='daily summaries empty')
        self.call('GET',bp+'/daily-summaries',403,token=outsider,observe='daily summaries scoped')

        feed_path=f'/api/v1/sync/families/{fid}/changes'
        self.call('GET',feed_path,403,token=outsider,observe='family feed owner')
        cursor=None; entries=[]; pages=0
        while pages<20:
            result=self.call('GET',feed_path+'?limit=2'+('&cursor='+cursor if cursor else ''),200,token=owner)
            decoded=self.inspect_feed(result,runtime,'family',fid)
            entries.extend(result['changes']);pages+=1;cursor=result['nextCursor']
            if not result['hasMore']:
                assert decoded['mode']=='tail'
                break
        else:
            raise AssertionError('change feed pagination did not terminate')
        assert entries and all(e['entityType']=='growth' for e in entries)
        assert len({e['cursor'] for e in entries})==len(entries)
        assert [int(e['cursor']) for e in entries]==sorted(int(e['cursor']) for e in entries)
        tail=self.call('GET',feed_path+'?cursor='+cursor,200,token=owner)
        self.inspect_feed(tail,runtime,'family',fid)
        assert tail['changes']==[] and tail['hasMore'] is False
        forged=cursor[:-1]+('0' if cursor[-1]!='0' else '1')
        self.call('GET',feed_path+'?cursor='+forged,400,token=owner,observe='tampered feed cursor')
        user_feed=self.call('GET','/api/v1/sync/me/changes',200,token=owner)
        self.inspect_feed(user_feed,runtime,'user',uid)
        self.call('GET','/api/v1/sync/me/changes?cursor='+cursor,400,token=owner,observe='cross-scope cursor')
        self.observations.append({'case':'bounded change feed','entries':len(entries),'pages':pages,'highWater':tail['highWater']})
        print('PASS HTTP growth, charts, CAS, core AI history, restart and signed feeds',flush=True)
        return {'httpAssertions':self.calls,'observations':self.observations,'limitation':'HTTP-only; no database fault injection or attachment byte lifecycle'}


if __name__=='__main__':
    SUPPORT.run_module(ExpansionScenario,'growth, core AI history and sync-feed HTTP regressions')
