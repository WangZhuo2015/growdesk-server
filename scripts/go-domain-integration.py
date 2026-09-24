#!/usr/bin/env python3
"""Native domain regression and optional real TypeScript/Go HTTP differential.

Only creates disposable test_ databases/roles and owner-labelled loopback Docker
containers. No externally supplied database or production account is accepted.
The TypeScript reference is the unchanged implementation in this checkout.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('owned_go_tests', ROOT / 'scripts/go-integration.py')
assert SPEC and SPEC.loader
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)
http, expect = TOOLS.http, TOOLS.expect


def serve_reference(owned):
    entry = ROOT / 'apps/api/dist/server.js'
    if not entry.is_file():
        raise RuntimeError('Build the reference with npm run backend:build first')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    if port in (3080, 3081, 3088, 3089):
        raise RuntimeError('Refusing a reserved application port')
    log = tempfile.TemporaryFile(mode='w+t')
    owned.files.append(log)
    env = {**owned.env, 'PORT': str(port), 'S3_BUCKET': 'test-go-domain-unused',
           'S3_ENDPOINT': 'http://127.0.0.1:1', 'S3_REGION': 'us-east-1',
           'AWS_ACCESS_KEY_ID': 'test_unused', 'AWS_SECRET_ACCESS_KEY': 'test_unused',
           'AWS_EC2_METADATA_DISABLED': 'true'}
    proc = subprocess.Popen(['node', str(entry)], cwd=ROOT, env=env, stdout=log, stderr=log)
    owned.processes.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(200):
        if proc.poll() is not None:
            log.seek(0)
            raise RuntimeError('reference startup failed: ' + log.read()[-3000:])
        try:
            if http(base, 'GET', '/health/ready')[0] == 200:
                return base
        except OSError:
            pass
        time.sleep(.1)
    raise RuntimeError('reference readiness timed out')


class Scenario:
    def __init__(self, owned, base):
        self.owned, self.base = owned, base
        self.ids, self.observations = {}, []
        self.calls = 0

    def alias(self, value, label):
        if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value):
            raise AssertionError('Response did not return a UUID for ' + label)
        self.ids[value] = label
        return value

    def normalize(self, value, key=''):
        # Only generated identifiers and server-generated timestamps vary. Business
        # time, null/absent, decimal representation, arrays and versions stay exact.
        if isinstance(value, list):
            return [self.normalize(item) for item in value]
        if isinstance(value, dict):
            return {k: self.normalize(v, k) for k, v in value.items()}
        if isinstance(value, str):
            if key in ('createdAt', 'updatedAt', 'joinedAt', 'expiresAt'):
                if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value):
                    raise AssertionError('Noncanonical server timestamp in ' + key)
                datetime.fromisoformat(value.replace('Z', '+00:00'))
                return '<generated-time>'
            if value in self.ids:
                return '<' + self.ids[value] + '>'
            if key == 'nextCursor':
                decoded = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode()
                date, identity = decoded.split('|')
                if identity not in self.ids:
                    raise AssertionError('Cursor does not target an observed record')
                return date + '|<' + self.ids[identity] + '>'
        return value

    def call(self, method, path, status, body=None, token=None, key=None, observe=None):
        self.calls += 1
        headers = {'Idempotency-Key': key} if key else None
        result = expect(self.base, method, path, status, body, token, headers)
        if observe:
            payload = result if status < 400 else {'error': {'code': result['error']['code']}}
            self.observations.append({'case': observe, 'status': status, 'body': self.normalize(payload)})
        return result

    def state(self, family):
        result = self.owned.sql(f"""SELECT jsonb_build_object(
            'cursor',(SELECT cursor::text FROM family_sync_states WHERE family_id='{family}'),
            'changes',(SELECT COUNT(*) FROM family_changes WHERE family_id='{family}'),
            'receipts',(SELECT COUNT(*) FROM idempotency_receipts WHERE scope_id='{family}'),
            'timeline',(SELECT COUNT(*) FROM timeline_entries WHERE family_id='{family}'),
            'feeding',(SELECT COUNT(*) FROM feeding_records WHERE family_id='{family}'),
            'sleep',(SELECT COUNT(*) FROM sleep_records WHERE family_id='{family}'),
            'diaper',(SELECT COUNT(*) FROM diaper_records WHERE family_id='{family}'));""")
        return json.loads(result)

    def run(self, interop_base=None):
        users = {}
        for label in ('owner', 'caregiver', 'outsider'):
            value = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_domain_' + label, 'password': 'test_domain_password_8675309',
                'displayName': 'Test ' + label, 'deviceLabel': 'test_browser'})['data']
            users[label] = value
            self.alias(value['user']['id'], label)
        owner, caregiver, outsider = (users[n]['accessToken'] for n in ('owner', 'caregiver', 'outsider'))
        uid, cid = users['owner']['user']['id'], users['caregiver']['user']['id']
        initial = self.call('GET', '/api/v1/families', 200, token=owner)
        assert len(initial['data']) == 1, 'registration must create one default family'
        self.alias(initial['data'][0]['id'], 'default_family')
        self.observations.append({'case': 'registration default family', 'status': 200, 'body': self.normalize(initial)})
        family = self.call('POST', '/api/v1/families', 201, {'name': 'Test Family', 'timeZone': 'Asia/Tokyo'}, owner)['data']
        fid = self.alias(family['id'], 'family')
        self.observations.append({'case': 'create family', 'status': 201, 'body': self.normalize({'data': family})})
        self.call('GET', '/api/v1/families/' + fid, 200, token=owner, observe='get family')
        self.call('PATCH', '/api/v1/families/' + fid, 200, {'name': 'Test Family Updated'}, owner, observe='update family')
        self.call('GET', '/api/v1/families/' + fid, 404, token=outsider, observe='hide other family')
        invite = self.call('POST', f'/api/v1/families/{fid}/invites', 201, {'expiresInDays': 1}, owner)['data']
        assert re.fullmatch('[0-9A-F]{12}', invite['inviteCode'])
        self.call('GET', '/api/v1/families/invites/preview?code=' + invite['inviteCode'], 200, observe='preview invite')
        self.call('POST', '/api/v1/families/join', 200, {'inviteCode': invite['inviteCode']}, caregiver, observe='join family')
        self.call('POST', '/api/v1/families/join', 404, {'inviteCode': invite['inviteCode']}, outsider, observe='single use invite')
        members = self.call('GET', f'/api/v1/families/{fid}/members', 200, token=owner)
        assert {row['userId'] for row in members['data']} == {uid, cid}
        for member in members['data']:
            self.alias(member['id'], 'membership_' + self.ids[member['userId']])
        self.observations.append({'case': 'list family members', 'status': 200, 'body': self.normalize(members)})
        self.call('PATCH', f'/api/v1/families/{fid}/members/{cid}', 200, {'role': 'admin'}, owner, observe='promote family member')
        self.call('PATCH', f'/api/v1/families/{fid}/members/{cid}', 200, {'role': 'member'}, owner, observe='demote family member')
        baby = self.call('POST', f'/api/v1/families/{fid}/babies', 201, {
            'name': 'Test Baby', 'birthDate': '2026-01-02', 'gender': 'girl', 'gestationalWeeks': 36, 'gestationalDays': 3}, owner)['data']
        bid = self.alias(baby['id'], 'baby')
        self.observations.append({'case': 'create baby', 'status': 201, 'body': self.normalize({'data': baby})})
        bp = '/api/v1/babies/' + bid
        self.call('GET', f'/api/v1/families/{fid}/babies', 200, token=caregiver, observe='family membership does not grant baby access')
        self.call('GET', bp, 404, token=caregiver, observe='baby hidden until explicit membership')
        self.call('POST', bp + '/members', 201, {'userId': cid, 'role': 'member'}, owner, observe='grant caregiver')
        self.call('GET', bp, 200, token=caregiver, observe='caregiver reads baby')
        self.call('PATCH', bp, 200, {'gestationalDays': 5, 'avatarUrl': None}, owner, observe='partial baby update')
        self.call('GET', bp + '/members', 200, token=owner, observe='list baby members')
        self.call('DELETE', bp + '/members/' + uid, 409, token=owner, observe='last baby admin protection')
        self.call('PATCH', f'/api/v1/families/{fid}/members/{uid}', 409, {'role': 'member'}, owner, observe='last family admin protection')
        self.call('POST', bp + '/members', 400, {'userId': users['outsider']['user']['id'], 'role': 'member'}, owner, observe='target must belong to family')
        print('PASS native family/invite/baby membership boundaries', flush=True)

        fixture = {
            'feeding': {'feedingType': 'formula', 'occurredAt': '2026-05-02T12:04:05+09:00', 'amountMl': '120.00', 'leftMinutes': 0, 'spitUp': False, 'notes': 'test 记录\u2028line\u2029<&>\\u2028'},
            'sleep': {'sleepType': 'nap', 'startedAt': '2026-05-02T04:00:00Z', 'endedAt': '2026-05-02T05:00:00Z', 'nightWakingCount': 0},
            'diaper': {'diaperType': 'both', 'occurredAt': '2026-05-02T06:00:00Z', 'poopColor': 'yellow', 'poopConsistency': 'soft', 'notes': None},
        }
        replay = None
        for kind, body in fixture.items():
            path = f'{bp}/records/{kind}'
            self.call('GET', path, 200, token=owner, observe=kind + ' empty page')
            before = self.state(fid)
            key = 'test_go_create_' + kind
            record = self.call('POST', path, 201, body, owner, key)['data']
            rid = self.alias(record['id'], kind)
            self.observations.append({'case': kind + ' create', 'status': 201, 'body': self.normalize({'data': record})})
            assert record['version'] == '1'
            after = self.state(fid)
            assert int(after['cursor']) == int(before['cursor']) + 1
            for field in ('changes', 'receipts', 'timeline', kind): assert after[field] == before[field] + 1, field
            assert self.call('POST', path, 201, body, owner, key)['data'] == record
            assert self.state(fid) == after, 'replay modified durable state'
            self.call('POST', path, 409, {**body, 'notes': 'different'}, owner, key, kind + ' conflicting create replay')
            self.call('GET', path + '/' + rid, 200, token=caregiver, observe=kind + ' read')
            self.call('GET', path + '/' + rid, 403, token=outsider, observe=kind + ' cross-family denied')
            if interop_base:
                # Reference-created receipt must replay through Go without a new mutation.
                assert expect(interop_base, 'POST', path, 201, body, owner, {'Idempotency-Key': key})['data'] == record
                assert self.state(fid) == after
            update = {'baseVersion': '1', 'notes': None}
            if kind == 'feeding': update['amountMl'] = '0'
            updated = self.call('PATCH', path + '/' + rid, 200, update, owner, 'test_go_update_' + kind)['data']
            assert updated['version'] == '2' and updated['notes'] is None
            self.observations.append({'case': kind + ' update', 'status': 200, 'body': self.normalize({'data': updated})})
            updated_state = self.state(fid)
            assert self.call('PATCH', path + '/' + rid, 200, update, owner, 'test_go_update_' + kind)['data'] == updated
            assert self.state(fid) == updated_state
            self.call('PATCH', path + '/' + rid, 409, {'baseVersion': '1', 'notes': 'stale'}, owner, 'test_go_stale_' + kind, kind + ' stale version')
            self.call('DELETE', path + '/' + rid + '?baseVersion=1', 409, token=owner, observe=kind + ' stale delete')
            timeline = self.call('GET', bp + '/timeline?entityType=' + kind, 200, token=owner)
            assert len(timeline['data']) == 1 and timeline['data'][0]['entityId'] == rid
            self.alias(timeline['data'][0]['id'], kind + '_timeline')
            self.observations.append({'case': kind + ' timeline', 'status': 200, 'body': self.normalize(timeline)})
            deleted = self.call('DELETE', path + '/' + rid + '?baseVersion=2', 200, token=owner, key='test_go_delete_' + kind, observe=kind + ' delete')
            assert deleted == {'data': {'id': rid, 'deleted': True}}
            deleted_state = self.state(fid)
            assert self.call('DELETE', path + '/' + rid + '?baseVersion=2', 200, token=owner, key='test_go_delete_' + kind) == deleted
            assert self.state(fid) == deleted_state
            self.call('GET', path + '/' + rid, 404, token=owner, observe=kind + ' deleted invisible')
            self.call('GET', bp + '/timeline?entityType=' + kind, 200, token=owner, observe=kind + ' deleted timeline invisible')
            replay = (path, body, key, record)
        print('PASS care CRUD/null/decimal/version/receipt/timeline contracts', flush=True)

        path = bp + '/records/feeding'
        body = {'feedingType': 'formula', 'occurredAt': '2026-05-02T07:00:00Z', 'amountMl': '100'}
        state = self.state(fid)
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: http(self.base, 'POST', path, body, owner, {'Idempotency-Key': 'test_go_concurrent'}), range(6)))
        assert all(code == 201 and payload == results[0][1] for code, payload in results), 'same key race was not replayed'
        assert int(self.state(fid)['cursor']) == int(state['cursor']) + 1
        concurrent_id = results[0][1]['data']['id']
        self.alias(concurrent_id, 'concurrent_feeding')
        second = self.call('POST', path, 201, {**body, 'occurredAt': '2026-05-02T08:00:00Z'}, owner, 'test_go_page_second')['data']
        self.alias(second['id'], 'page_feeding')
        first_page = self.call('GET', path + '?limit=1', 200, token=owner, observe='keyset first page')
        assert len(first_page['data']) == 1 and first_page['page']['nextCursor']
        self.call('GET', path + '?limit=1&cursor=' + first_page['page']['nextCursor'], 200, token=owner, observe='keyset second page')
        self.call('GET', path + '?cursor=!invalid', 200, token=owner, observe='malformed cursor follows reference fallback')

        # The transaction must roll back the main row, timeline, cursor and receipt
        # when the family change append fails. Trigger exists only in owned DB.
        self.owned.sql("""CREATE FUNCTION test_go_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test injected append failure'; END; $$;
          CREATE TRIGGER test_go_reject_change BEFORE INSERT ON family_changes FOR EACH ROW EXECUTE FUNCTION test_go_reject_change();""")
        state = self.state(fid)
        self.call('POST', path, 500, body, owner, 'test_go_atomic_rollback')
        assert self.state(fid) == state, 'failed append leaked partial mutation'
        self.owned.sql('DROP TRIGGER test_go_reject_change ON family_changes; DROP FUNCTION test_go_reject_change();')
        self.call('POST', path, 201, body, owner, 'test_go_atomic_rollback')
        print('PASS concurrent receipt, keyset pagination and injected rollback', flush=True)

        sleep_path = bp + '/records/sleep'
        active = {'sleepType': 'nap', 'startedAt': '2026-05-02T09:00:00Z'}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda key: http(self.base, 'POST', sleep_path, active, owner, {'Idempotency-Key': key}), ['test_go_sleep_a', 'test_go_sleep_b']))
        assert sorted(status for status, _ in results) == [201, 409]
        winner = next(data['data'] for status, data in results if status == 201)
        self.call('PATCH', sleep_path + '/' + winner['id'], 400, {'baseVersion': '1', 'endedAt': '2026-05-02T08:00:00Z'}, owner, observe='negative sleep interval')
        self.call('PATCH', sleep_path + '/' + winner['id'], 200, {'baseVersion': '1', 'endedAt': '2026-05-02T10:00:00Z'}, owner)
        self.call('POST', sleep_path, 201, active, owner)
        self.call('PATCH', sleep_path + '/' + winner['id'], 409, {'baseVersion': '2', 'endedAt': None}, owner, observe='cannot reopen second active sleep')

        self.call('POST', bp + '/members', 201, {'userId': cid, 'role': 'viewer'}, owner)
        self.call('POST', path, 403, body, caregiver, observe='baby viewer cannot write')
        self.call('POST', bp + '/members', 201, {'userId': cid, 'role': 'member'}, owner)
        self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE family_id='{fid}' AND user_id='{cid}';")
        self.call('POST', path, 403, body, caregiver, observe='family viewer cannot write')
        self.owned.sql(f"UPDATE family_members SET role='member' WHERE family_id='{fid}' AND user_id='{cid}';")
        self.call('DELETE', bp + '/members/' + cid, 200, token=owner, observe='revoke baby caregiver')
        self.call('GET', path, 403, token=caregiver, observe='revoked token cannot read baby records')
        self.call('POST', path, 403, body, caregiver, observe='revoked token cannot write baby records')
        self.call('POST', bp + '/members', 201, {'userId': cid, 'role': 'member'}, owner)
        self.call('DELETE', f'/api/v1/families/{fid}/members/{cid}', 200, token=owner, observe='remove family member cascades')
        self.call('GET', path, 403, token=caregiver, observe='removed family rejects old token')
        assert self.owned.sql(f"SELECT COUNT(*) FROM baby_members WHERE baby_id='{bid}' AND user_id='{cid}' AND status='active' AND deleted_at IS NULL;") == '0'
        # Even a previously successful receipt cannot be replayed after revocation.
        assert replay
        replay_path, replay_body, replay_key, _ = replay
        self.owned.sql(f"UPDATE baby_members SET status='revoked',deleted_at=NOW() WHERE baby_id='{bid}' AND user_id='{uid}';")
        self.call('POST', replay_path, 403, replay_body, owner, replay_key, 'revoked principal cannot replay receipt')
        self.observations.append({'case': 'final durable state', 'state': self.state(fid)})
        print('PASS active sleep constraints, viewer roles and revocation/replay isolation', flush=True)
        return {'httpAssertions': self.calls + 8, 'observations': self.observations}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true', help='Also run the real TypeScript API and compare observed contracts')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    results = {}
    for runtime in (('go', 'typescript') if args.reference else ('go',)):
        owned = TOOLS.OwnedEnvironment()
        try:
            owned.start()
            native = owned.serve(args.binary)
            base = native if runtime == 'go' else serve_reference(owned)
            results[runtime] = Scenario(owned, base).run(native if runtime == 'typescript' else None)
        finally:
            owned.close()
    if args.reference:
        left, right = results['go']['observations'], results['typescript']['observations']
        if left != right:
            differences = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
            if len(left) != len(right): differences.append({'lengths': [len(left), len(right)]})
            raise AssertionError('HTTP/state parity differs: ' + json.dumps(differences, ensure_ascii=False))
        print(f'PASS {len(left)} real Go/TypeScript response/state differential observations', flush=True)
    report = {'scope': 'families/babies/feeding/sleep/diaper/timeline; not whole-backend parity',
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'status': 'PASS', 'runtimes': results}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__':
    main()
