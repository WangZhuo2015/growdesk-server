#!/usr/bin/env python3
"""Food catalog parity on disposable PostgreSQL/Redis and actual HTTP servers.

Uses the existing ownership-checked runner. Never accepts database overrides,
production users, a live Web endpoint, or external/paid provider credentials.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import re
import signal
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('food_domain_tools', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


class FoodScenario(DOMAIN.Scenario):
    def remember_item(self, item, label):
        assert re.fullmatch(r'custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', item['id'])
        self.ids[item['id']] = label
        assert set(item) in (
            {'id', 'name', 'category', 'allergenRisk', 'recommendedAgeMonths'},
            {'id', 'name', 'category', 'allergenRisk', 'recommendedAgeMonths', 'familyStatus'},
        ), 'POST must return the raw contract DTO, not an envelope or persistence fields'
        self.observations.append({'case': label, 'status': 201, 'body': self.normalize(item)})
        return item

    def error(self, method, path, status, code, body=None, token=None, label=''):
        value = self.call(method, path, status, body, token, observe=label or code)
        assert value['error']['code'] == code, (label, value['error']['code'])

    def rows(self, family):
        return json.loads(self.owned.sql(f"""SELECT jsonb_build_object(
            'items',(SELECT COUNT(*) FROM food_library_items WHERE family_id='{family}'),
            'statuses',(SELECT COUNT(*) FROM family_food_statuses WHERE family_id='{family}'))"""))

    def run(self, restart, interop_base=None):
        users = {}
        families = {}
        for name in ('owner', 'outsider'):
            users[name] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_food_' + name, 'displayName': 'Test Food ' + name,
                'password': 'test_food_password_8675309', 'deviceLabel': 'test_food_client',
            })['data']
            families[name] = self.alias(self.call('GET', '/api/v1/families', 200,
                token=users[name]['accessToken'])['data'][0]['id'], name + '_family')
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid, fid, other = users['owner']['user']['id'], families['owner'], families['outsider']
        self.alias(uid, 'owner')
        path = '/api/v1/food/items'
        explicit = path + '?familyId=' + fid
        body = {'name': 'test_food', 'category': 'fruit', 'allergenRisk': 'low', 'recommendedAgeMonths': 6}

        self.call('GET', path, 401, observe='catalog requires authentication')
        self.call('POST', path, 401, body, observe='create requires authentication')
        self.call('GET', '/api/v1/food/guidelines', 401, observe='guidelines require authentication')
        guidelines = self.call('GET', '/api/v1/food/guidelines', 200, token=owner, observe='exact reference guidelines')
        assert [row['monthAge'] for row in guidelines['data']] == [6, 8, 10, 12]
        initial = self.call('GET', path, 200, token=owner, observe='public seeded catalog')
        assert isinstance(initial['data'], list) and initial['data']
        assert all('familyStatus' not in item for item in initial['data'])

        # Same public food, deliberately different private statuses in each family.
        for family, tried, reaction in ((fid, 'true', 'test_owner_reaction'), (other, 'false', 'test_other_reaction')):
            self.owned.sql(f"""INSERT INTO family_food_statuses
                (id,family_id,food_item_id,tried,reaction,created_at,updated_at)
                VALUES('{uuid.uuid4()}','{family}','food_egg',{tried},'{reaction}',NOW(),NOW());""")
        for name, token, expected in (('owner', owner, True), ('outsider', outsider, False)):
            listing = self.call('GET', path, 200, token=token, observe=name + ' private status')
            egg = next(item for item in listing['data'] if item['id'] == 'food_egg')
            assert egg['familyStatus']['tried'] is expected
            assert egg['familyStatus']['reaction'] == ('test_owner_reaction' if name == 'owner' else 'test_other_reaction')

        for i, patch in enumerate(({}, {'tried': False}, {'tried': True})):
            payload = {**body, 'name': f'test_custom_{i}', 'recommendedAgeMonths': 0 if i == 0 else 8, **patch}
            item = self.remember_item(self.call('POST', path, 201, payload, owner), f'custom_{i}')
            if 'tried' in patch:
                assert item['familyStatus'] == {'tried': patch['tried'], 'reaction': None}
            else:
                assert 'familyStatus' not in item
            assert item['recommendedAgeMonths'] == payload['recommendedAgeMonths']
            stored = self.owned.sql(f"SELECT family_id,is_custom,name FROM food_library_items WHERE id='{item['id']}';")
            assert stored == fid + '|t|' + payload['name']
        assert self.rows(fid) == {'items': 3, 'statuses': 3}

        # Unknown persistence fields are removed like Fastify; bound SQL preserves quotes.
        payload = {**body, 'name': "test_quoted'蔬菜", 'familyId': fid,
                   'isCustom': False, 'userId': users['outsider']['user']['id'],
                   'familyStatus': {'tried': True}, 'recommendedAgeMonths': 7}
        item = self.remember_item(self.call('POST', path, 201, payload, owner), 'unknown fields stripped')
        assert item['name'] == payload['name'] and item['recommendedAgeMonths'] == 7
        assert 'familyStatus' not in item
        assert self.owned.sql(f"SELECT family_id,is_custom FROM food_library_items WHERE id='{item['id']}';") == fid + '|t'
        hidden = self.remember_item(self.call('POST', path, 201,
            {**body, 'name': 'test_other_private', 'tried': True}, outsider), 'outsider custom item')
        listing = self.call('GET', explicit, 200, token=owner, observe='custom and global catalog')
        assert hidden['id'] not in {item['id'] for item in listing['data']}
        controlled = [item for item in listing['data'] if item['name'].startswith('test_custom_')]
        assert [item['name'] for item in controlled] == ['test_custom_0', 'test_custom_1', 'test_custom_2']
        self.error('GET', explicit, 403, 'FAMILY_ACCESS_DENIED', token=outsider, label='foreign read')
        self.error('POST', path, 403, 'FAMILY_ACCESS_DENIED', {**body, 'familyId': fid}, outsider, 'foreign write')

        # Make the second INSERT fail: the preceding custom-item INSERT must roll back.
        before = self.rows(fid)
        self.owned.sql(f"""CREATE FUNCTION test_food_status_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test_food_status_failure'; END; $$;
            CREATE TRIGGER test_food_status_failure BEFORE INSERT ON family_food_statuses
            FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_food_status_failure();""")
        try:
            self.call('POST', path, 500, {**body, 'name': 'test_must_rollback', 'tried': True}, owner,
                      observe='status failure is not success')
            assert self.rows(fid) == before, 'item/status transaction leaked a partial write'
            assert self.owned.sql("SELECT COUNT(*) FROM food_library_items WHERE name='test_must_rollback';") == '0'
        finally:
            self.owned.sql('DROP TRIGGER test_food_status_failure ON family_food_statuses; DROP FUNCTION test_food_status_failure();')
        self.observations.append({'case': 'atomic rollback state', 'state': self.rows(fid)})

        second = self.call('POST', '/api/v1/families', 201,
            {'name': 'Test Food Second Family', 'timeZone': 'Asia/Tokyo'}, owner)['data']
        sid = self.alias(second['id'], 'second_family')
        self.error('GET', path, 400, 'FAMILY_SELECTION_REQUIRED', token=owner, label='ambiguous read')
        self.error('POST', path, 400, 'FAMILY_SELECTION_REQUIRED', body, owner, 'ambiguous write')
        second_list = self.call('GET', path + '?familyId=' + sid, 200, token=owner, observe='explicit second family')
        assert second_list == initial, 'custom food or private status leaked between own families'
        self.call('GET', explicit, 200, token=owner, observe='explicit original family')

        self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE user_id='{uid}' AND family_id='{fid}';")
        self.call('GET', explicit, 200, token=owner, observe='viewer may read')
        self.error('POST', path, 403, 'FAMILY_ACCESS_DENIED', {**body, 'familyId': fid}, owner, 'viewer cannot create')
        self.owned.sql(f"UPDATE family_members SET role='member' WHERE user_id='{uid}' AND family_id='{fid}';")
        self.remember_item(self.call('POST', path, 201, {**body, 'familyId': fid, 'name': 'test_member_food'}, owner), 'member may create')
        self.owned.sql(f"UPDATE family_members SET role='admin' WHERE user_id='{uid}' AND family_id='{fid}';")

        before = self.rows(fid)
        payloads = [{**body, 'familyId': fid, 'name': 'test_parallel_' + str(i), 'tried': bool(i % 2)} for i in range(6)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda payload: TOOLS.http(self.base, 'POST', path, payload, owner), payloads))
        self.calls += len(responses)
        assert all(code == 201 for code, _ in responses), 'concurrent catalog creates failed'
        assert len({value['id'] for _, value in responses}) == 6
        for i, (_, value) in enumerate(responses):
            self.remember_item(value, 'parallel_' + str(i))
            assert value['familyStatus'] == {'tried': bool(i % 2), 'reaction': None}
        assert self.rows(fid) == {'items': before['items'] + 6, 'statuses': before['statuses'] + 6}

        for patch in ({'name': ''}, {'allergenRisk': 'unknown'}, {'recommendedAgeMonths': -1}, {'recommendedAgeMonths': 1.5}, {'recommendedAgeMonths': '7'}, {'familyId': 'not-a-uuid'}):
            self.error('POST', path, 400, 'FST_ERR_VALIDATION', {**body, 'familyId': fid, **patch}, owner, 'malformed ' + next(iter(patch)))
        self.error('GET', path + '?familyId=invalid', 400, 'FST_ERR_VALIDATION', token=owner, label='malformed query')

        persisted = self.call('GET', explicit, 200, token=owner)
        self.base = restart()
        assert self.call('GET', explicit, 200, token=owner, observe='restart persistence') == persisted
        if interop_base:
            # Real Go reads reference-created rows using the same regular Bearer
            # session, then reference reads a Go-created row. Not BFF crypto parity.
            assert TOOLS.expect(interop_base, 'GET', explicit, 200, token=owner) == persisted
            interop = TOOLS.expect(interop_base, 'POST', path, 201,
                {**body, 'familyId': fid, 'name': 'test_interop_food', 'tried': True}, owner)
            assert interop in self.call('GET', explicit, 200, token=owner)['data']
            print('PASS Go/TypeScript bidirectional food-row interoperability', flush=True)

        self.owned.sql(f"UPDATE family_members SET status='revoked',deleted_at=NOW() WHERE family_id='{fid}' AND user_id='{uid}';")
        self.error('GET', explicit, 403, 'FAMILY_ACCESS_DENIED', token=owner, label='revoked token cannot read')
        self.error('POST', path, 403, 'FAMILY_ACCESS_DENIED', {**body, 'familyId': fid}, owner, 'revoked token cannot write')
        self.owned.sql(f"UPDATE family_members SET status='revoked',deleted_at=NOW() WHERE family_id='{other}';")
        self.error('GET', path, 403, 'FAMILY_ACCESS_DENIED', token=outsider, label='no remaining family')
        print('PASS food catalog DTOs, scope isolation, rollback, concurrent writes and restart persistence', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations}


def main():
    if not __debug__:
        raise RuntimeError('Assertions are required; do not run this suite with python -O')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not args.binary.is_file():
        raise RuntimeError('Build the native binary before running this suite')
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    report = {'scope': 'food library and reference guidelines; not whole-backend parity',
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'status': 'RUNNING', 'runtimes': {}}
    def save():
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    save()
    try:
        for runtime in (('go', 'typescript') if args.reference else ('go',)):
            owned = TOOLS.OwnedEnvironment()
            try:
                owned.start()
                native = owned.serve(args.binary)
                base = native if runtime == 'go' else DOMAIN.serve_reference(owned)
                process = owned.processes[-1]
                def restart():
                    process.terminate()
                    process.wait(timeout=10)
                    return owned.serve(args.binary) if runtime == 'go' else DOMAIN.serve_reference(owned)
                report['runtimes'][runtime] = FoodScenario(owned, base).run(
                    restart, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][r]['observations'] for r in ('go', 'typescript'))
            if left != right:
                diff = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    diff.append({'lengths': [len(left), len(right)]})
                raise AssertionError('Food HTTP/state parity differs: ' + json.dumps(diff, ensure_ascii=False))
            report['differentialObservations'] = len(left)
            print(f'PASS {len(left)} exact food response/state differential observations', flush=True)
        report['status'] = 'PASS'
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failureType'] = type(error).__name__
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
