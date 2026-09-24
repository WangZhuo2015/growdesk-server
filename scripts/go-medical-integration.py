#!/usr/bin/env python3
"""Medical HTTP and PostgreSQL regressions; attachment metadata is not S3 E2E."""
import importlib.util
import json
from pathlib import Path
import uuid

SPEC = importlib.util.spec_from_file_location('medical_support', Path(__file__).with_name('go-parity-support.py'))
assert SPEC and SPEC.loader
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
DOMAIN, TOOLS = SUPPORT.DOMAIN, SUPPORT.TOOLS


class MedicalScenario(DOMAIN.Scenario):
    def durable_state(self, family):
        return json.loads(self.owned.sql(f"""SELECT jsonb_build_object(
          'sync',(SELECT to_jsonb(s) FROM family_sync_states s WHERE family_id='{family}'),
          'reports',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM medical_reports r WHERE family_id='{family}'),'[]'),
          'links',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM medical_report_attachments a JOIN medical_reports r ON r.id=a.report_id WHERE r.family_id='{family}'),'[]'),
          'growth',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM growth_measurements g WHERE family_id='{family}'),'[]'),
          'timeline',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM timeline_entries t WHERE family_id='{family}'),'[]'),
          'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY command_id) FROM idempotency_receipts i WHERE scope_id='{family}'),'[]'));"""))

    def run(self, restart, runtime, interop_base=None):
        users = {}
        for label in ('owner', 'outsider'):
            users[label] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_medical_' + label, 'displayName': 'Test Medical ' + label,
                'password': 'test_medical_password_8675309', 'deviceLabel': 'test_medical'})['data']
            self.alias(users[label]['user']['id'], label)
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        bid = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201,
            {'name': 'Test Medical Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']['id'], 'baby')
        second_baby = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201,
            {'name': 'Test Other Medical Baby', 'birthDate': '2026-01-03', 'gender': 'boy'}, owner)['data']['id'], 'other_baby')
        base = f'/api/v1/babies/{bid}'
        path, alias = base + '/medical-reports', base + '/medical/reports'
        attachment = self.alias(str(uuid.uuid4()), 'attachment')
        self.owned.sql(f"""INSERT INTO attachments(id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at)
          VALUES('{attachment}','{fid}','{bid}','{uid}','medical_report','image/png',8,repeat('0',64),'test_medical_metadata','ready',NOW()+INTERVAL '1 day');""")
        self.call('GET', path, 401, observe='medical requires authentication')
        self.call('GET', alias, 403, token=outsider, observe='alias family isolation')
        self.call('GET', path, 200, token=owner, observe='medical empty list')
        body = {'title': 'Test 检查', 'reportDate': '2026-05-02', 'hospital': 'Test Hospital', 'department': None,
                'diagnosis': None, 'attachmentIds': [attachment], 'notes': 'test\u2028\u2029<&>',
                'items': [{'id': 'test_item', 'name': 'Test Measurement', 'value': 0, 'status': 'normal', 'unit': ''}]}
        first = self.call('POST', alias, 201, body, owner, 'test_medical_create')
        rid = self.alias(first['data']['id'], 'report')
        self.observations.append({'case': 'medical create', 'body': self.normalize(first)})
        assert first['data']['version'] == '1' and first['data']['items'][0]['value'] == 0
        assert first['data']['attachmentIds'] == [attachment]
        assert self.call('POST', path, 201, body, owner, 'test_medical_create') == first
        assert self.call('GET', path + '/' + rid, 200, token=owner) == first
        assert self.call('GET', alias + '/' + rid, 200, token=owner) == first
        self.call('GET', f'/api/v1/babies/{second_baby}/medical-reports/{rid}', 404, token=owner, observe='same family different baby cannot read report')
        if runtime == 'go':
            snapshot = self.durable_state(fid)
            self.call('POST', path, 409, {**body, 'title': 'test changed'}, owner, 'test_medical_create')
            self.call('POST', f'/api/v1/babies/{second_baby}/medical-reports', 409, body, owner, 'test_medical_create')
            assert self.durable_state(fid) == snapshot
        if interop_base:
            assert TOOLS.expect(interop_base, 'POST', path, 201, body, owner, {'Idempotency-Key': 'test_medical_create'}) == first
        snapshot = self.durable_state(fid)
        self.call('POST', path, 404, {**body, 'attachmentIds': [str(uuid.uuid4())]}, owner, 'test_medical_bad_attachment')
        assert self.durable_state(fid) == snapshot
        # Current report fields and link clearing are an atomic replacement.
        updated = self.call('PATCH', alias + '/' + rid, 200, {'baseVersion': '1', 'hospital': None,
            'items': [], 'attachmentIds': [], 'reportDate': '2026-05-03', 'notes': None}, owner, observe='medical partial update clears values')
        assert updated['data']['version'] == '2' and updated['data']['items'] == [] and updated['data']['attachmentIds'] == []
        self.call('PATCH', path + '/' + rid, 409, {'baseVersion': '1', 'title': 'stale'}, owner, observe='medical stale update')
        self.call('DELETE', path + '/' + rid + '?baseVersion=1', 409, token=owner, observe='medical stale delete')
        self.call('DELETE', path + '/' + rid, 400, token=owner, observe='medical delete requires explicit version')
        self.owned.sql(f"""CREATE FUNCTION test_medical_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test_medical_cursor_failure'; END; $$;
          CREATE TRIGGER test_medical_failure BEFORE UPDATE ON family_sync_states
          FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_medical_failure();""")
        growth_body = {**body, 'reportDate': '2026-06-01', 'growthData': {'weightKg': '7.25', 'heightCm': '65.2'}}
        try:
            for method, endpoint, data in (
                ('POST', path, growth_body),
                ('PATCH', path + '/' + rid, {'baseVersion': '2', 'attachmentIds': [attachment], 'title': 'test rollback'}),
                ('DELETE', path + '/' + rid + '?baseVersion=2', None),
            ):
                snapshot = self.durable_state(fid)
                self.call(method, endpoint, 500, data, owner, 'test_medical_rollback')
                assert self.durable_state(fid) == snapshot
        finally:
            self.owned.sql('DROP TRIGGER test_medical_failure ON family_sync_states; DROP FUNCTION test_medical_failure();')
        self.observations.append({'case': 'medical and growth full transaction rollback', 'unchanged': True})
        second = self.call('POST', path, 201, growth_body, owner, 'test_medical_growth')
        gid = self.alias(second['data']['id'], 'growth_report')
        self.observations.append({'case': 'medical with growth', 'body': self.normalize(second)})
        growth = json.loads(self.owned.sql(f"SELECT jsonb_build_object('weight',weight_kg::text,'height',height_cm::text,'date',measurement_date::text) FROM growth_measurements WHERE baby_id='{bid}' AND notes='Medical report: {gid}';"))
        assert growth == {'weight': '7.25', 'height': '65.2', 'date': '2026-06-01'}
        first_page = self.call('GET', path + '?limit=1', 200, token=owner, observe='medical first page')
        assert first_page['data'][0]['id'] == gid and first_page['page']['nextCursor']
        last_page = self.call('GET', path + '?limit=1&cursor=' + first_page['page']['nextCursor'], 200, token=owner, observe='medical final page')
        assert last_page['data'][0]['id'] == rid and last_page['page']['nextCursor'] is None
        self.call('DELETE', alias + '/' + rid + '?baseVersion=2', 200, token=owner, observe='medical delete through alias')
        self.call('GET', path + '/' + rid, 404, token=owner, observe='medical deleted read denied')
        assert self.owned.sql(f"SELECT version FROM medical_reports WHERE id='{rid}';").strip() == '2'
        assert self.owned.sql(f"SELECT version FROM timeline_entries WHERE entity_type='medical' AND entity_id='{rid}';").strip() == '3'
        persisted = self.call('GET', path, 200, token=owner)
        self.base = restart()
        assert self.call('GET', alias, 200, token=owner) == persisted
        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', path, 200, token=owner) == persisted
            update = TOOLS.expect(interop_base, 'PATCH', path + '/' + gid, 200, {'baseVersion': '1', 'notes': 'test interop'}, owner)
            assert self.call('GET', path + '/' + gid, 200, token=owner) == update
        assert self.owned.sql(f"SELECT COUNT(*) FROM family_changes WHERE family_id='{fid}';").strip() == '0'
        if runtime == 'go':
            self.owned.sql(f"UPDATE baby_members SET role='viewer' WHERE baby_id='{bid}' AND user_id='{uid}';")
            snapshot = self.durable_state(fid)
            self.call('POST', path, 403, body, owner)
            assert self.durable_state(fid) == snapshot
            self.owned.sql(f"UPDATE family_members SET status='revoked' WHERE family_id='{fid}' AND user_id='{uid}';")
            self.call('GET', path, 403, token=owner)
        print('PASS medical reports: aliases, scope, attachments, replay, rollback and restart', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations}


if __name__ == '__main__':
    SUPPORT.run_module(MedicalScenario, 'medical reports and coupled observations; metadata fixtures are not S3 E2E')
