#!/usr/bin/env python3
"""Supplement products and schedules against owned databases and real HTTP."""
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('supplement_support', Path(__file__).with_name('go-parity-support.py'))
assert SPEC and SPEC.loader
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
DOMAIN, TOOLS = SUPPORT.DOMAIN, SUPPORT.TOOLS


class SupplementScenario(DOMAIN.Scenario):
    def normalize(self, value, key=''):
        if isinstance(value, dict) and isinstance(value.get('page'), dict) and value['page'].get('nextCursor'):
            raw = value['page']['nextCursor']
            clock, identity = base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)).decode().split('|')
            assert value['data'] and value['data'][-1]['id'] == identity
            assert value['data'][-1]['createdAt'] == clock, 'cursor must bind the returned row, not any generated clock'
        if key == 'nextCursor' and isinstance(value, str):
            clock, identity = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode().split('|')
            assert identity in self.ids
            return super().normalize(clock, 'createdAt') + '|<' + self.ids[identity] + '>'
        return super().normalize(value, key)

    def catalog_state(self, family):
        return json.loads(self.owned.sql(f"""SELECT jsonb_build_object(
          'sync',(SELECT to_jsonb(s) FROM family_sync_states s WHERE family_id='{family}'),
          'products',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM supplement_products p WHERE family_id='{family}'),'[]'),
          'schedules',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM supplement_schedules s WHERE family_id='{family}'),'[]'));"""))

    def cursor_only(self, before, family, steps=1):
        after = self.state(family)
        assert int(after['cursor']) == int(before['cursor']) + steps
        assert {k: v for k, v in after.items() if k != 'cursor'} == {k: v for k, v in before.items() if k != 'cursor'}

    def run(self, restart, runtime, interop_base=None):
        users = {}
        for label in ('owner', 'outsider'):
            users[label] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_supplement_' + label, 'displayName': 'Test Supplement ' + label,
                'password': 'test_supplement_password_8675309', 'deviceLabel': 'test_catalog'})['data']
            self.alias(users[label]['user']['id'], label)
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        bid = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201,
            {'name': 'Test Supplement Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']['id'], 'baby')
        path = f'/api/v1/families/{fid}/nutrition/supplement-products'
        schedules = f'/api/v1/babies/{bid}/nutrition/supplement-schedules'
        self.call('GET', path, 401, observe='catalog requires authentication')
        self.call('GET', path, 403, token=outsider, observe='catalog family isolation')
        self.call('GET', path, 200, token=owner, observe='empty product catalog')
        body = {'name': ' Test Vitamin ', 'brand': None, 'unitName': ' drop ', 'defaultDose': '1.25000',
                'nutrientsJson': {'test': [0, False, None, '1.00']}, 'notes': 'test metadata'}
        before = self.state(fid)
        first = self.call('POST', path, 201, body, owner)['data']
        pid = self.alias(first['id'], 'product')
        assert first['name'] == 'Test Vitamin' and first['unitName'] == 'drop'
        assert first['defaultDose'] == '1.25' and first['version'] == 1
        self.observations.append({'case': 'create product', 'body': self.normalize(first)})
        self.cursor_only(before, fid)
        self.call('PATCH', path + '/' + pid, 409, {'baseVersion': 9, 'notes': 'stale'}, owner, observe='product stale version')
        # Product/schedule doses are positive by the existing SQL constraints.
        # Nested JSON still tests zeros and false without weakening those rules.
        if runtime == 'go':
            for dose in ('0', '-1'):
                snapshot = self.catalog_state(fid)
                self.call('PATCH', path + '/' + pid, 400, {'baseVersion': 1, 'defaultDose': dose}, owner)
                assert self.catalog_state(fid) == snapshot
        self.call('PATCH', path + '/' + pid, 200, {'baseVersion': 1, 'isActive': False, 'defaultDose': '0.25'}, owner, observe='fractional dose and inactive product')
        assert self.call('GET', path, 200, token=owner)['data'] == []
        self.call('GET', path + '?includeArchived=true', 200, token=owner, observe='include inactive product')
        self.call('PATCH', path + '/' + pid, 200, {'baseVersion': 2, 'isActive': True, 'nutrientsJson': None}, owner, observe='reactivate and clear JSON')
        self.call('GET', path + '?cursor=bad', 400, token=owner, observe='bad cursor')
        second = self.call('POST', path, 201, {'name': 'Test Second', 'unitName': 'tablet'}, owner)['data']
        self.alias(second['id'], 'second_product')
        page = self.call('GET', path + '?limit=1', 200, token=owner, observe='catalog first page')
        assert len(page['data']) == 1 and page['page']['nextCursor']
        last = self.call('GET', path + '?limit=1&cursor=' + page['page']['nextCursor'], 200, token=owner, observe='catalog final page')
        assert len(last['data']) == 1 and last['page']['nextCursor'] is None
        assert {page['data'][0]['id'], last['data'][0]['id']} == {pid, second['id']}
        self.call('GET', schedules, 200, token=owner, observe='empty schedules')
        before = self.state(fid)
        schedule = self.call('POST', schedules, 201, {'productId': pid, 'customDays': [], 'targetDose': '0.5',
            'reminderTime': None, 'startDate': '2026-04-05', 'notes': 'test schedule'}, owner)['data']
        sid = self.alias(schedule['id'], 'schedule')
        assert schedule['targetDose'] == '0.5' and schedule['customDays'] == []
        self.observations.append({'case': 'create schedule', 'body': self.normalize(schedule)})
        self.cursor_only(before, fid)
        if runtime == 'go':
            snapshot = self.catalog_state(fid)
            self.call('POST', schedules, 400, {'id': sid, 'productId': pid, 'targetDose': '0'}, owner)
            assert self.catalog_state(fid) == snapshot
        self.call('POST', schedules, 409, {'id': sid, 'productId': pid, 'baseVersion': 8}, owner, observe='schedule stale version')
        self.call('POST', schedules, 200, {'productId': pid, 'baseVersion': 1, 'customDays': None}, owner, observe='upsert existing schedule')
        self.call('GET', schedules + '?date=2026-04-05', 200, token=owner, observe='uncompleted schedule')
        self.call('POST', f'/api/v1/babies/{bid}/records/supplement', 201, {
            'supplementName': 'Test Vitamin', 'productId': pid, 'occurredAt': '2026-04-05T23:59:59.999Z', 'dose': '1'}, owner, 'test_supplement_completion')
        observed = self.call('GET', schedules + '?date=2026-04-05', 200, token=owner, observe='completed schedule')
        assert observed['data'][0]['isCompletedToday'] is True
        assert self.call('GET', schedules + '?date=2026-04-06', 200, token=owner)['data'][0]['isCompletedToday'] is False
        self.owned.sql(f"""CREATE FUNCTION test_supplement_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test_catalog_cursor_failure'; END; $$;
          CREATE TRIGGER test_supplement_failure BEFORE UPDATE ON family_sync_states
          FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_supplement_failure();""")
        try:
            for method, endpoint, data in (
                ('POST', path, {'name': 'Test Must Rollback', 'unitName': 'drop'}),
                ('PATCH', path + '/' + pid, {'notes': 'must roll back'}),
                ('POST', schedules, {'id': sid, 'productId': pid, 'notes': 'must roll back'}),
                ('DELETE', schedules + '/' + sid, None),
                ('DELETE', path + '/' + pid, None),
            ):
                snapshot = self.catalog_state(fid)
                self.call(method, endpoint, 500, data, owner)
                assert self.catalog_state(fid) == snapshot
        finally:
            self.owned.sql('DROP TRIGGER test_supplement_failure ON family_sync_states; DROP FUNCTION test_supplement_failure();')
        self.observations.append({'case': 'catalog five failure rollback paths', 'unchanged': True})
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda i: TOOLS.http(self.base, 'POST', schedules,
                {'id': sid, 'productId': pid, 'baseVersion': 2, 'notes': 'test winner ' + str(i)}, owner), range(6)))
        assert sorted(code for code, _ in results) == [200, 409, 409, 409, 409, 409]
        self.observations.append({'case': 'schedule concurrent CAS', 'success': 1, 'conflict': 5})
        persisted = self.call('GET', schedules + '?date=2026-04-05', 200, token=owner)
        self.base = restart()
        assert self.call('GET', schedules + '?date=2026-04-05', 200, token=owner) == persisted
        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', schedules + '?date=2026-04-05', 200, token=owner) == persisted
            updated = TOOLS.expect(interop_base, 'POST', schedules, 200,
                {'id': sid, 'productId': pid, 'baseVersion': 3, 'notes': 'test cross runtime'}, owner)
            assert self.call('GET', schedules + '?date=2026-04-06', 200, token=owner)['data'][0] == updated['data']
        self.call('DELETE', path + '/' + pid, 200, token=owner, observe='delete product with active schedule')
        assert self.call('GET', schedules, 200, token=owner)['data'] == []
        self.call('DELETE', schedules + '/' + sid, 404, token=owner, observe='cascaded schedule stays deleted')
        self.call('DELETE', path + '/' + pid, 404, token=owner, observe='product deletion not repeated as success')
        if runtime == 'go':
            self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE family_id='{fid}' AND user_id='{uid}';")
            before = self.catalog_state(fid)
            self.call('POST', path, 403, {'name': 'Test Denied', 'unitName': 'drop'}, owner)
            assert self.catalog_state(fid) == before
            self.owned.sql(f"UPDATE family_members SET status='revoked' WHERE family_id='{fid}' AND user_id='{uid}';")
            self.call('GET', path, 403, token=owner)
            self.call('GET', schedules, 403, token=owner)
        print('PASS supplement products/schedules: CAS, rollback, restart and scope', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations}


if __name__ == '__main__':
    SUPPORT.run_module(SupplementScenario, 'supplement catalog and schedule operations')
