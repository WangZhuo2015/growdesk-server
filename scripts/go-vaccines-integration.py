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
        body = {'vaccineCode': 'different-input-code', 'vaccineId': 'test_vaccine', 'doseNumber': 1,
                'administeredDate': '2026-05-02', 'scheduledDate': '2026-06-01', 'completedDate': '2026-05-02',
                'isCompleted': False, 'clinic': None, 'notes': 'test pending'}
        record = self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending')
        rid = self.alias(record['data']['id'], 'pending_record')
        assert record['data']['completedDate'] is None and record['data']['isCompleted'] is False
        assert record['data']['vaccineCode'] == 'TEST-A'
        self.observations.append({'case': 'pending vaccine record', 'body': self.normalize(record)})
        snapshot = self.snapshot(fid)
        assert self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending') == record
        assert self.snapshot(fid) == snapshot
        assert self.owned.sql(f"SELECT COUNT(*) FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}';").strip() == '0'
        if runtime == 'go':
            self.call('POST', base + '/records', 409, {**body, 'notes': 'changed'}, owner, 'test_vaccine_pending')
            assert self.snapshot(fid) == snapshot
        if interop_base:
            assert TOOLS.expect(interop_base, 'POST', base + '/records', 201, body, owner, {'Idempotency-Key': 'test_vaccine_pending'}) == record
        selected = self.call('PUT', base + '/selections', 200, {'vaccineId': 'TEST-A', 'doseNumber': 1, 'selected': False, 'completed': False}, owner)
        sid = self.alias(selected['data']['id'], 'selection')
        assert selected['data']['selected'] is False and selected['data']['version'] == 1
        self.observations.append({'case': 'selection code resolves stable ID', 'body': self.normalize(selected)})
        self.call('PUT', base + '/selections', 200, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'completed': True}, owner, observe='complete pending vaccination')
        completed = self.call('GET', base + '/records', 200, token=owner)
        assert len(completed['data']) == 1 and completed['data'][0]['id'] == rid
        assert completed['data'][0]['version'] == '2' and completed['data'][0]['isCompleted'] is True
        assert completed['data'][0]['scheduledDate'] == '2026-06-01'
        assert completed['data'][0]['legacyName'] == 'Test Vaccine' and completed['data'][0]['legacyDose'] == '第1剂'
        self.observations.append({'case': 'selection completes existing record', 'body': self.normalize(completed)})
        self.call('PUT', base + '/selections', 409, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'completed': False}, owner, observe='stale selection')
        # Failure after all record/projection changes must roll everything back.
        self.owned.sql(f"""CREATE FUNCTION test_vaccine_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test_vaccine_cursor_failure'; END; $$;
          CREATE TRIGGER test_vaccine_failure BEFORE UPDATE ON family_sync_states
          FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_vaccine_failure();""")
        try:
            for method, path, payload in (
                ('PUT', base + '/selections', {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'completed': False}),
                ('POST', base + '/records', {**body, 'doseNumber': 2, 'isCompleted': True}),
                ('DELETE', base + '/records/' + rid, None),
            ):
                before = self.snapshot(fid)
                self.call(method, path, 500, payload, owner, 'test_vaccine_rollback')
                assert self.snapshot(fid) == before
        finally:
            self.owned.sql('DROP TRIGGER test_vaccine_failure ON family_sync_states; DROP FUNCTION test_vaccine_failure();')
        self.observations.append({'case': 'vaccine completion and record rollback', 'unchanged': True})
        self.call('PUT', base + '/selections', 200, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'completed': False}, owner, observe='uncomplete vaccination')
        assert self.call('GET', base + '/records', 200, token=owner)['data'] == []
        assert self.owned.sql(f"SELECT version FROM vaccine_records WHERE id='{rid}' AND deleted_at IS NOT NULL;").strip() == '3'
        assert self.owned.sql(f"SELECT version FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}' AND deleted_at IS NOT NULL;").strip() == '2'
        immediate = self.call('POST', base + '/records', 201, {'vaccineCode': 'TEST-UNLISTED', 'administeredDate': '2026-04-03'}, owner, 'test_vaccine_completed')
        immediate_id = self.alias(immediate['data']['id'], 'completed_record')
        assert immediate['data']['vaccineId'] is None and immediate['data']['isCompleted'] is True
        self.observations.append({'case': 'unlisted legacy vaccine code', 'body': self.normalize(immediate)})
        self.call('DELETE', base + '/records/' + immediate_id, 200, token=owner, observe='delete vaccine record')
        self.call('DELETE', base + '/records/' + immediate_id, 404, token=owner, observe='deleted vaccine cannot repeat delete')
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
