#!/usr/bin/env python3
"""Food/supplement HTTP and durable-state parity on exclusively owned services."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('nutrition_domain_tools', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


def record_path(baby_id, kind):
    return f'/api/v1/babies/{baby_id}/records/{kind}'


class NutritionScenario(DOMAIN.Scenario):
    def state(self, family):
        state = super().state(family)
        for kind, table in (('food', 'food_records'), ('supplement', 'supplement_records')):
            state[kind] = int(self.owned.sql(f"SELECT COUNT(*) FROM {table} WHERE family_id='{family}';"))
        return state

    def remember(self, result, label, status=201):
        assert set(result) == {'data'}
        record = result['data']
        self.alias(record['id'], label)
        self.observations.append({'case': label, 'status': status, 'body': self.normalize(result)})
        return record

    def assert_commit(self, before, after, kind, create=False):
        assert int(after['cursor']) == int(before['cursor']) + 1
        assert after['changes'] == before['changes'] + 1
        assert after['receipts'] == before['receipts'] + 1
        assert after['timeline'] == before['timeline'] + int(create)
        assert after[kind] == before[kind] + int(create)

    def run(self, restart, runtime, interop_base=None):
        users = {}
        for name in ('owner', 'outsider'):
            users[name] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_nutrition_' + name, 'displayName': 'Test Nutrition ' + name,
                'password': 'test_nutrition_password_8675309', 'deviceLabel': 'test_nutrition_client'})['data']
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = self.alias(users['owner']['user']['id'], 'owner')
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        babies = []
        for index in range(2):
            baby = self.call('POST', f'/api/v1/families/{fid}/babies', 201,
                {'name': 'Test Nutrition Baby ' + str(index), 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']
            babies.append(self.alias(baby['id'], 'baby_' + str(index)))
        bid, other_bid = babies
        fixtures = {
            'food': {'recordDate': '2026-05-02', 'mealType': 'lunch', 'occurredAt': None,
                     'foodItemIds': ['food_rice', 'food_egg'], 'portionDescription': 'test_half bowl',
                     'reaction': 'like', 'notes': "test_辅食'记录\u2028"},
            'supplement': {'supplementName': 'test_vitamin', 'productId': None,
                           'occurredAt': '2026-05-02T15:30:00+09:00', 'amount': 'test_one dose',
                           'dose': '1.2500', 'unitName': 'drops', 'notes': None},
        }
        live = {}
        for kind, fixture in fixtures.items():
            path = record_path(bid, kind)
            self.call('GET', path, 401, observe=kind + ' authentication required')
            self.call('GET', path, 200, token=owner, observe=kind + ' empty list')
            self.call('GET', path, 403, token=outsider)
            self.call('POST', path, 403, fixture, outsider)
            before = self.state(fid)
            key = 'test_' + kind + '_create'
            created = self.call('POST', path, 201, fixture, owner, key)
            value = self.remember(created, kind + '_first')
            assert value['version'] == '1'
            if kind == 'food':
                assert value['occurredAt'] is None and value['foodItemIds'] == fixture['foodItemIds']
            else:
                assert value['dose'] == '1.25' and value['occurredAt'] == '2026-05-02T06:30:00.000Z'
                assert value['recordedByUserId'] == uid
            self.assert_commit(before, self.state(fid), kind, create=True)
            current = self.state(fid)
            assert self.call('POST', path, 201, fixture, owner, key) == created
            assert self.state(fid) == current, 'create replay duplicated durable effects'
            conflict = self.call('POST', path, 409, {**fixture, 'notes': 'test_different'}, owner, key,
                                 observe=kind + ' reused payload rejected')
            assert conflict['error']['code'] == 'IDEMPOTENCY_KEY_REUSED'
            rid = value['id']
            item = path + '/' + rid
            assert self.call('GET', item, 200, token=owner, observe=kind + ' get') == created
            self.call('GET', record_path(other_bid, kind) + '/' + rid, 404, token=owner,
                      observe=kind + ' other baby cannot address record')
            patch = {'baseVersion': '1', 'notes': None}
            if kind == 'food':
                patch.update({'foodItemIds': [], 'occurredAt': '2026-05-03T09:10:00+09:00', 'reaction': None})
            else:
                patch.update({'dose': None, 'unitName': None, 'amount': None})
            updated = self.call('PATCH', item, 200, patch, owner, 'test_' + kind + '_update')
            self.remember(updated, kind + '_first', 200)
            assert updated['data']['version'] == '2' and updated['data']['notes'] is None
            self.assert_commit(current, self.state(fid), kind)
            stable = self.state(fid)
            assert self.call('PATCH', item, 200, patch, owner, 'test_' + kind + '_update') == updated
            assert self.state(fid) == stable
            stale = self.call('PATCH', item, 409, {'baseVersion': '1', 'notes': 'test_stale'}, owner,
                              'test_' + kind + '_stale', observe=kind + ' stale version')
            assert stale['error']['code'] == 'CONCURRENCY_CONFLICT'

            # Fail the final receipt INSERT. Everything before it must roll back,
            # including the record, timeline, cursor and family change rows.
            self.owned.sql(f"""CREATE FUNCTION test_nutrition_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'test_nutrition_receipt_failure'; END; $$;
                CREATE TRIGGER test_nutrition_receipt_failure BEFORE INSERT ON idempotency_receipts
                FOR EACH ROW WHEN (NEW.actor_id='{uid}' AND NEW.scope_id='{fid}')
                EXECUTE FUNCTION test_nutrition_receipt_failure();""")
            try:
                self.call('POST', path, 500, fixture, owner, 'test_' + kind + '_rollback',
                          observe=kind + ' final receipt failure')
                assert self.state(fid) == stable, 'partial mutation escaped failed transaction'
                assert self.call('GET', item, 200, token=owner) == updated
            finally:
                self.owned.sql('DROP TRIGGER test_nutrition_receipt_failure ON idempotency_receipts; DROP FUNCTION test_nutrition_receipt_failure();')
            self.observations.append({'case': kind + ' rollback state', 'state': stable})

            payload = {**fixture, 'notes': 'test_parallel'}
            headers = {'Idempotency-Key': 'test_' + kind + '_parallel'}
            before = self.state(fid)
            with ThreadPoolExecutor(max_workers=6) as pool:
                responses = list(pool.map(lambda _: TOOLS.http(self.base, 'POST', path, payload, owner, headers), range(6)))
            self.calls += len(responses)
            assert all(code == 201 for code, _ in responses)
            assert len({body['data']['id'] for _, body in responses}) == 1
            parallel = self.remember(responses[0][1], kind + '_parallel')
            assert all(body == responses[0][1] for _, body in responses)
            self.assert_commit(before, self.state(fid), kind, create=True)
            # Both records have the same list clock; UUID order must break ties.
            listing = self.call('GET', path + '?limit=1', 200, token=owner)
            assert len(listing['data']) == 1 and listing['page']['nextCursor']
            self.observations.append({'case': kind + ' first page', 'count': 1, 'hasCursor': True})
            next_page = self.call('GET', path + '?limit=1&cursor=' + listing['page']['nextCursor'], 200, token=owner)
            assert len(next_page['data']) == 1 and next_page['page']['nextCursor'] is None
            assert {listing['data'][0]['id'], next_page['data'][0]['id']} == {rid, parallel['id']}
            decoded = base64.urlsafe_b64decode(listing['page']['nextCursor'] + '=' * (-len(listing['page']['nextCursor']) % 4)).decode()
            assert decoded.split('|')[1] == listing['data'][0]['id']
            live[kind] = {'path': path, 'fixture': fixture, 'key': key, 'created': created, 'item': item,
                          'updated': updated, 'parallel': parallel}

            for invalid in ({'baseVersion': '2', 'notes': 'x' * 1001}, {'baseVersion': 2}, {'baseVersion': '2', 'occurredAt': 'invalid'}):
                self.call('PATCH', item, 400, invalid, owner, observe=kind + ' malformed update')

        persisted = {kind: self.call('GET', row['path'], 200, token=owner) for kind, row in live.items()}
        self.base = restart()
        for kind, row in live.items():
            assert self.call('GET', row['path'], 200, token=owner) == persisted[kind]
            # Go and TS must replay ordinary receipts produced by the other
            # runtime, not merely read matching business rows.
            if interop_base:
                assert TOOLS.expect(interop_base, 'GET', row['path'], 200, token=owner) == persisted[kind]
                assert TOOLS.expect(interop_base, 'POST', row['path'], 201, row['fixture'], owner,
                                    {'Idempotency-Key': row['key']}) == row['created']
                other_payload = {**row['fixture'], 'notes': 'test_native_interop'}
                other_key = 'test_' + kind + '_interop'
                other = TOOLS.expect(interop_base, 'POST', row['path'], 201, other_payload, owner,
                                     {'Idempotency-Key': other_key})
                assert self.call('POST', row['path'], 201, other_payload, owner, other_key) == other
            before = self.state(fid)
            deleted = self.call('DELETE', row['item'] + '?baseVersion=2', 200, token=owner,
                                key='test_' + kind + '_delete', observe=kind + ' delete')
            assert deleted['data'] == {'id': row['created']['data']['id'], 'deleted': True}
            self.assert_commit(before, self.state(fid), kind)
            after = self.state(fid)
            assert self.call('DELETE', row['item'] + '?baseVersion=2', 200, token=owner,
                             key='test_' + kind + '_delete') == deleted
            assert self.state(fid) == after
            self.call('GET', row['item'], 404, token=owner, observe=kind + ' deleted hidden')
            self.owned.sql(f"UPDATE baby_members SET role='viewer' WHERE baby_id='{bid}' AND user_id='{uid}';")
            self.call('POST', row['path'], 403, row['fixture'], owner, 'test_' + kind + '_viewer')
            self.owned.sql(f"UPDATE baby_members SET role='admin' WHERE baby_id='{bid}' AND user_id='{uid}';")

        native_checks = []
        if runtime == 'go':
            # Explicit null and omission have the same reference primary hash,
            # but may have different effects. Native receipts keep a second
            # digest so those requests cannot accidentally share a result.
            row = live['food']
            item = row['path'] + '/' + row['parallel']['id']
            cleared = self.call('PATCH', item, 200, {'baseVersion': '1', 'occurredAt': None}, owner, 'test_null_clear')
            assert cleared['data']['occurredAt'] is None
            conflict = self.call('PATCH', item, 409, {'baseVersion': '1'}, owner, 'test_null_clear')
            assert conflict['error']['code'] == 'IDEMPOTENCY_KEY_REUSED'
            native_checks.append('explicit null cannot replay omitted-field native receipt')
        self.owned.sql(f"UPDATE family_members SET status='revoked',deleted_at=NOW() WHERE family_id='{fid}' AND user_id='{uid}';")
        for row in live.values():
            self.call('POST', row['path'], 403, row['fixture'], owner, row['key'])
            self.call('GET', row['path'], 403, token=owner)
        print('PASS nutrition HTTP, atomic rollback, CAS, concurrent replay, restart and authorization', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations, 'nativeSecurityChecks': native_checks}


def main():
    if not __debug__:
        raise RuntimeError('Assertions are required; do not use python -O')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not args.binary.is_file():
        raise RuntimeError('Build the native executable first')
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    report = {'scope': 'food and supplement record transactions, not complete backend acceptance',
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
                report['runtimes'][runtime] = NutritionScenario(owned, base).run(restart, runtime, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][runtime]['observations'] for runtime in ('go', 'typescript'))
            if left != right:
                differences = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    differences.append({'lengths': [len(left), len(right)]})
                raise AssertionError('Nutrition HTTP/state parity differs: ' + json.dumps(differences, ensure_ascii=False))
            report['differentialObservations'] = len(left)
        report['status'] = 'PASS'
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failureType'] = type(error).__name__
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
