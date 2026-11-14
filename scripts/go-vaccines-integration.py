#!/usr/bin/env python3
"""Vaccine graph and completion state using owned test tenants and real HTTP."""
import importlib.util
import json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('vaccine_support', Path(__file__).with_name('go-parity-support.py'))
assert SPEC and SPEC.loader
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
DOMAIN, TOOLS = SUPPORT.DOMAIN, SUPPORT.TOOLS


class VaccineScenario(DOMAIN.Scenario):
    def snapshot(self, family):
        return json.loads(self.owned.sql(f"""SELECT jsonb_build_object(
          'state',(SELECT to_jsonb(s) FROM family_sync_states s WHERE family_id='{family}'),
          'records',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM vaccine_records v WHERE family_id='{family}'),'[]'),
          'selections',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM vaccine_selections v WHERE family_id='{family}'),'[]'),
          'timeline',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM timeline_entries t WHERE family_id='{family}'),'[]'),
          'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY command_id) FROM idempotency_receipts i WHERE scope_id='{family}'),'[]'));"""))

    def run(self, restart, runtime, interop_base=None):
        fallback = self.call('GET', '/api/v1/vaccines/schedule', 200)
        assert len(fallback['data']) == 9
        self.observations.append({'case': 'frozen default vaccine schedule', 'body': fallback})
        self.call('GET', '/api/v1/vaccines/catalog', 401, observe='catalog requires authentication')
        users = {}
        for label in ('owner', 'outsider'):
            users[label] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_vaccine_' + label, 'displayName': 'Test Vaccine ' + label,
                'password': 'test_vaccine_password_8675309', 'deviceLabel': 'test_vaccine'})['data']
            self.alias(users[label]['user']['id'], label)
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        bid = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201,
            {'name': 'Test Vaccine Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']['id'], 'baby')
        base = f'/api/v1/babies/{bid}/vaccines'
        assert self.call('GET', base + '/schedule', 200) == fallback
        self.owned.sql("""INSERT INTO vaccines(id,vaccine_code,name,program_type,china_national,source_refs_json,legacy_metadata)
          VALUES('test_vaccine','TEST-A','Test Vaccine','national_immunization_program',true,'["test_source"]','{"private":"omit"}'),
                ('test_non_program','TEST-B','Test Non Program','non_program',false,NULL,NULL);
          INSERT INTO vaccine_doses(id,vaccine_id,dose_number,dose_label,dose_volume_ml)
          VALUES('test_dose','test_vaccine',1,'Test Dose',0.50000);
          INSERT INTO vaccine_strategy_groups(id,strategy_id,vaccine_id,name,options_json)
          VALUES('test_group','test_strategy','test_vaccine','Test Strategy','[0,false,null]');
          INSERT INTO vaccine_schedule_entries(id,vaccine_id,age_months,dose_number,priority,is_optional)
          VALUES('test_schedule_entry','test_vaccine',0,1,'test_priority',false);
          INSERT INTO vaccine_schedules(id,vaccine_code,name,recommended_age_months,dose_number,mandatory)
          VALUES('test_schedule','TEST-A','Test Schedule',0,1,false);""")
        graph = self.call('GET', '/api/v1/vaccines/catalog', 200, token=owner)
        assert len(graph['national']) == 1 and len(graph['nonProgram']) == 1
        assert graph['national'][0]['doses'][0]['doseVolumeMl'] == '0.5'
        assert 'legacyMetadata' not in graph['national'][0] and 'legacy_metadata' not in graph['national'][0]
        self.observations.append({'case': 'full pinned graph rules and release', 'body': graph})
        self.call('GET', '/api/v1/vaccines/schedule', 200, observe='stored public schedule')
        self.call('GET', base + '/records', 403, token=outsider, observe='vaccine baby isolation')
        self.call('GET', base + '/records', 200, token=owner, observe='empty records')
        self.call('GET', base + '/selections', 200, token=owner, observe='empty selections')
        body = {'vaccineCode': 'test_vaccine', 'vaccineId': 'test_vaccine', 'doseNumber': 1,
                'administeredDate': '2026-06-01', 'isCompleted': False,
                'clinic': None, 'notes': 'test pending'}
        record = self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending')
        rid = self.alias(record['data']['id'], 'pending_record')
        assert record['data']['recordStatus'] == 'planned'
        assert record['data']['administeredDate'] == '2026-06-01'
        assert record['data']['completedDate'] is None and record['data']['isCompleted'] is False
        assert record['data']['vaccineCode'] == 'TEST-A'
        snapshot = self.snapshot(fid)
        assert self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending') == record
        assert self.snapshot(fid) == snapshot
        assert self.owned.sql(f"SELECT COUNT(*) FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}';").strip() == '0'
        if runtime == 'go':
            self.call('POST', base + '/records', 409, {**body, 'notes': 'changed'}, owner, 'test_vaccine_pending')
            ledger = self.call('GET', base + '/records', 200, token=owner,
                               headers={'x-growdesk-representation': 'ledger'})
            assert len(ledger['data']) == 1
            assert ledger['data'][0]['administeredDate'] is None
            assert ledger['data'][0]['scheduledDate'] == '2026-06-01'
            assert ledger['data'][0]['recordStatus'] == 'planned'
            assert self.snapshot(fid) == snapshot
        if interop_base:
            assert TOOLS.expect(interop_base, 'POST', base + '/records', 201, body, owner, {'Idempotency-Key': 'test_vaccine_pending'}) == record
        selected = self.call('PUT', base + '/selections', 200, {'vaccineId': 'TEST-A', 'doseNumber': 1, 'selected': False}, owner)
        sid = self.alias(selected['data']['id'], 'selection')
        assert selected['data']['selected'] is False and selected['data']['completed'] is False
        assert selected['data']['version'] == 1
        self.call('PUT', base + '/selections', 400,
                  {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'completed': True},
                  owner, observe='selection completion is read only')
        assert self.call('GET', base + '/records', 200, token=owner)['data'][0]['version'] == '1'

        # Changes to the selection flag cannot mutate or delete the record.
        # A trigger simulates a cursor failure after a write and proves rollback.
        self.owned.sql(f"""CREATE FUNCTION test_vaccine_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test_vaccine_cursor_failure'; END; $$;
          CREATE TRIGGER test_vaccine_failure BEFORE UPDATE ON family_sync_states
          FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_vaccine_failure();""")
        try:
            before = self.snapshot(fid)
            self.call('PUT', base + '/selections', 500,
                      {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'selected': True}, owner)
            assert self.snapshot(fid) == before
            if runtime == 'go':
                self.call('PATCH', base + '/records/' + rid, 500, {
                    'baseVersion': '1', 'recordStatus': 'completed', 'isCompleted': True,
                    'administeredDate': '2026-06-12', 'completedDate': '2026-06-12'}, owner,
                    headers={'x-growdesk-representation': 'ledger'})
                assert self.snapshot(fid) == before
        finally:
            self.owned.sql('DROP TRIGGER test_vaccine_failure ON family_sync_states; DROP FUNCTION test_vaccine_failure();')

        # Canonical completed records are the only source for completion.
        if runtime == 'go':
            completed_id = rid
            updated = self.call('PATCH', base + '/records/' + rid, 200, {
                'baseVersion': '1', 'recordStatus': 'completed', 'isCompleted': True,
                'administeredDate': '2026-06-12', 'completedDate': '2026-06-12',
                'manufacturer': 'Test Manufacturer', 'batchNumber': 'TEST-BATCH',
                'traceCode': 'TEST-TRACE', 'administrationRoute': 'intramuscular',
                'injectionSite': 'left_thigh', 'notes': 'test completed'}, owner,
                headers={'x-growdesk-representation': 'ledger'})
            assert updated['data']['version'] == '2'
            assert updated['data']['administeredDate'] == '2026-06-12'
            assert updated['data']['scheduledDate'] == '2026-06-01'
            assert updated['data']['manufacturer'] == 'Test Manufacturer'
        else:
            completed = self.call('POST', base + '/records', 201, {
                'vaccineCode': 'TEST-A', 'vaccineId': 'test_vaccine', 'doseNumber': 1,
                'recordStatus': 'completed', 'isCompleted': True,
                'administeredDate': '2026-06-12', 'completedDate': '2026-06-12',
                'manufacturer': 'Test Manufacturer', 'batchNumber': 'TEST-BATCH',
                'traceCode': 'TEST-TRACE', 'administrationRoute': 'intramuscular',
                'injectionSite': 'left_thigh', 'notes': 'test completed'}, owner, 'test_vaccine_completed')
            completed_id = self.alias(completed['data']['id'], 'completed_record')
        selected = self.call('GET', base + '/selections', 200, token=owner)
        assert selected['data'][0]['completed'] is True and selected['data'][0]['selected'] is False
        self.call('PUT', base + '/selections', 200,
                  {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'selected': True}, owner)
        selected = self.call('GET', base + '/selections', 200, token=owner)
        assert selected['data'][0]['completed'] is True and selected['data'][0]['selected'] is True
        self.call('PUT', base + '/selections', 200,
                  {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'selected': False}, owner)
        selected = self.call('GET', base + '/selections', 200, token=owner)
        assert selected['data'][0]['completed'] is True and selected['data'][0]['selected'] is False

        review = None
        if runtime == 'go':
            review = self.call('POST', base + '/records', 201, {
                'vaccineCode': 'TEST-UNCERTAIN', 'vaccineId': None,
                'recordStatus': 'needs_review', 'administeredDate': None,
                'scheduledDate': None, 'completedDate': None, 'isCompleted': False,
                'sourceText': 'Test source row without a confirmed date'}, owner,
                'test_vaccine_review', headers={'x-growdesk-representation': 'ledger'})
            assert review['data']['recordStatus'] == 'needs_review'
            assert review['data']['vaccineId'] is None and review['data']['administeredDate'] is None
            assert review['data']['scheduledDate'] is None and review['data']['isCompleted'] is False
            legacy_rows = self.call('GET', base + '/records', 200, token=owner)
            assert all(row['recordStatus'] != 'needs_review' for row in legacy_rows['data'])
            ledger_rows = self.call('GET', base + '/records', 200, token=owner,
                                    headers={'x-growdesk-representation': 'ledger'})
            assert any(row['id'] == review['data']['id'] for row in ledger_rows['data'])

        self.call('DELETE', base + '/records/' + completed_id, 200,
                  token=owner, headers={'x-growdesk-representation': 'ledger'} if runtime == 'go' else None)
        selected = self.call('GET', base + '/selections', 200, token=owner)
        assert selected['data'][0]['completed'] is False and selected['data'][0]['selected'] is False
        self.call('DELETE', base + '/records/' + completed_id, 404, token=owner)
        unknown = self.call('POST', base + '/records', 201, {
            'vaccineCode': 'TEST-UNLISTED', 'doseNumber': None,
            'recordStatus': 'completed', 'administeredDate': '2026-04-03',
            'completedDate': '2026-04-03', 'isCompleted': True}, owner, 'test_vaccine_unknown')
        unknown_id = self.alias(unknown['data']['id'], 'unknown_record')
        assert unknown['data']['vaccineId'] is None
        assert unknown['data']['vaccineCode'] == 'TEST-UNLISTED'
        assert unknown['data']['legacyName'] == 'TEST-UNLISTED'
        self.call('DELETE', base + '/records/' + unknown_id, 200, token=owner)
        if runtime == 'go' and review:
            self.call('DELETE', base + '/records/' + self.alias(review['data']['id'], 'review_record'),
                      200, token=owner, headers={'x-growdesk-representation': 'ledger'})
        persisted = self.call('GET', base + '/selections', 200, token=owner)
        self.base = restart()
        assert self.call('GET', base + '/selections', 200, token=owner) == persisted
        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', base + '/selections', 200, token=owner) == persisted
            updated = TOOLS.expect(interop_base, 'PUT', base + '/selections', 200,
                {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 3, 'selected': True}, owner)
            assert self.call('GET', base + '/selections', 200, token=owner)['data'][0] == updated['data']
        assert self.owned.sql(f"SELECT COUNT(*) FROM family_changes WHERE family_id='{fid}';").strip() == '0'
        if runtime == 'go':
            self.owned.sql(f"UPDATE family_members SET status='revoked' WHERE family_id='{fid}' AND user_id='{uid}';")
            self.call('GET', base + '/records', 403, token=owner)
            self.call('PUT', base + '/selections', 403, {'vaccineId': 'test_vaccine', 'doseNumber': 1}, owner)
        print('PASS vaccine graph, selection effects, tombstones, restart and scope', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations}


if __name__ == '__main__':
    SUPPORT.run_module(VaccineScenario, 'vaccine graph and completion state')
