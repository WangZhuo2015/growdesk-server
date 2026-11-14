#!/usr/bin/env python3
"""Vaccine graph and completion state using owned test tenants and real HTTP."""
import importlib.util
import json
from concurrent.futures import ThreadPoolExecutor
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
        for label in ('owner', 'outsider', 'viewer'):
            users[label] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_vaccine_' + label, 'displayName': 'test_vaccine_' + label,
                'password': 'test_vaccine_password_8675309', 'deviceLabel': 'test_vaccine'})['data']
            self.alias(users[label]['user']['id'], label)
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        bid = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201,
            {'name': 'test_vaccine_baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']['id'], 'baby')
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
        # A changed appointment only moves the compatibility anchor; it never
        # creates a completed date or a vaccination timeline entry.
        plan = self.call('POST', base + '/records', 201, {
            'vaccineCode': 'TEST-PLAN', 'administeredDate': '2026-06-01',
            'scheduledDate': '2026-06-01', 'isCompleted': False}, owner)['data']
        plan_id = self.alias(plan['id'], 'rescheduled_plan')
        plan = self.call('PATCH', base + '/records/' + plan_id, 200,
            {'baseVersion': '1', 'scheduledDate': '2026-06-03'}, owner)['data']
        assert plan['scheduledDate'] == plan['administeredDate'] == '2026-06-03'
        assert plan['completedDate'] is None and plan['isCompleted'] is False
        assert self.owned.sql(f"SELECT COUNT(*) FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{plan_id}';") == '0'
        snapshot = self.snapshot(fid)
        self.call('DELETE', base + '/records/' + plan_id, 409, {'baseVersion': '1'}, owner)
        assert self.snapshot(fid) == snapshot
        self.call('DELETE', base + '/records/' + plan_id, 200, {'baseVersion': '2'}, owner)
        assert self.owned.sql(f"SELECT version FROM vaccine_records WHERE id='{plan_id}' AND deleted_at IS NOT NULL;") == '3'
        self.observations.append({'case': 'rescheduled plan and guarded body deletion', 'body': self.normalize(plan)})
        # The record is a source-backed fact or an explicit appointment; the
        # selection checkbox can never supply a clinical date on its behalf.
        body = {'vaccineCode': 'different-input-code', 'vaccineId': 'test_vaccine', 'doseNumber': 1,
                'legacyName': 'test_booklet_name', 'legacyDose': 'test_booklet_dose',
                'administeredDate': '2026-06-01', 'scheduledDate': '2026-06-01', 'completedDate': None,
                'isCompleted': False, 'clinic': 'test_clinic', 'batchNumber': 'test_batch',
                'manufacturer': 'test_manufacturer', 'productName': 'test_product',
                'traceabilityCode': '00000001234567890123', 'injectionSite': 'test_left_arm', 'notes': 'test pending'}
        record = self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending')
        rid = self.alias(record['data']['id'], 'pending_record')
        assert record['data']['completedDate'] is None and record['data']['isCompleted'] is False
        assert record['data']['vaccineCode'] == 'TEST-A'
        assert record['data']['traceabilityCode'] == body['traceabilityCode']
        self.observations.append({'case': 'booklet fields and pending state', 'body': self.normalize(record)})
        snapshot = self.snapshot(fid)
        assert self.call('POST', base + '/records', 201, body, owner, 'test_vaccine_pending') == record
        self.call('POST', base + '/records', 409, {**body, 'notes': 'changed'}, owner, 'test_vaccine_pending')
        assert self.snapshot(fid) == snapshot
        assert self.owned.sql(f"SELECT COUNT(*) FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}';").strip() == '0'
        selected = self.call('PUT', base + '/selections', 200, {'vaccineId': 'TEST-A', 'doseNumber': 1, 'selected': False, 'completed': False}, owner)
        self.alias(selected['data']['id'], 'selection')
        assert selected['data']['selected'] is False and selected['data']['version'] == 1
        self.observations.append({'case': 'selection resolves code without recording vaccination', 'body': self.normalize(selected)})
        snapshot = self.snapshot(fid)
        rejected = self.call('PUT', base + '/selections', 400, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'completed': True}, owner)
        assert rejected['error']['code'] == 'VACCINE_RECORD_REQUIRED'
        self.call('PATCH', base + '/records/' + rid, 400, {'baseVersion': '1', 'isCompleted': True}, owner)
        assert self.snapshot(fid) == snapshot

        completed = self.call('PATCH', base + '/records/' + rid, 200,
            {'baseVersion': '1', 'administeredDate': '2026-05-05', 'completedDate': '2026-05-05', 'isCompleted': True}, owner)
        assert completed['data']['id'] == rid and completed['data']['version'] == '2'
        assert completed['data']['scheduledDate'] == '2026-06-01'
        assert completed['data']['administeredDate'] == '2026-05-05'
        assert completed['data']['manufacturer'] == 'test_manufacturer'
        assert self.owned.sql(f"SELECT occurred_at::date FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}';").strip() == '2026-05-05'
        self.observations.append({'case': 'complete plan on explicit historical date', 'body': self.normalize(completed)})
        assert self.call('GET', base + '/selections', 200, token=owner)['data'][0]['completed'] is True
        snapshot = self.snapshot(fid)
        self.call('PATCH', base + '/records/' + rid, 409, {'baseVersion': '1', 'clinic': 'test_stale'}, owner)
        self.call('PATCH', base + '/records/' + rid, 403, {'baseVersion': '2', 'clinic': 'test_outsider'}, outsider)
        self.call('PATCH', base + '/records/' + rid, 400, {'clinic': 'test_no_version'}, owner)
        for version in ('0', '01', '2147483648'):
            self.call('PATCH', base + '/records/' + rid, 400, {'baseVersion': version, 'clinic': 'test_bad_version'}, owner)
        self.call('PATCH', base + '/records/' + rid, 400, {'baseVersion': '2', 'administeredDate': '2026-02-30'}, owner)
        self.call('PATCH', base + '/records/' + rid, 400, {'baseVersion': '2', 'completedDate': '2026-06-03'}, owner)
        assert self.snapshot(fid) == snapshot

        # Selecting or deselecting a product must leave every historical field,
        # timeline date, record version and creation receipt unchanged.
        before = self.snapshot(fid)
        self.call('PUT', base + '/selections', 200, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 1, 'selected': True}, owner)
        after = self.snapshot(fid)
        for name in ('records', 'timeline', 'receipts'):
            assert after[name] == before[name], name
        snapshot = after
        self.call('PUT', base + '/selections', 200, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'completed': True}, owner)
        assert self.snapshot(fid) == snapshot
        self.call('PUT', base + '/selections', 400, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'completed': False}, owner)
        assert self.snapshot(fid) == snapshot
        self.call('PUT', base + '/selections', 200, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 2, 'selected': False}, owner)
        assert self.snapshot(fid)['records'] == before['records']
        assert self.snapshot(fid)['timeline'] == before['timeline']
        self.observations.append({'case': 'selection never changes administration facts', 'unchanged': True})

        correction = self.call('PATCH', base + '/records/' + rid, 200,
            {'baseVersion': '2', 'administeredDate': '2026-05-06', 'scheduledDate': None, 'legacyName': 'test_corrected_booklet_name',
             'doseNumber': None, 'clinic': None, 'manufacturer': None, 'productName': None, 'traceabilityCode': None, 'injectionSite': None}, owner)
        assert correction['data']['id'] == rid and correction['data']['version'] == '3'
        assert correction['data']['completedDate'] == '2026-05-06' and correction['data']['scheduledDate'] is None
        for field in ('doseNumber', 'clinic', 'manufacturer', 'productName', 'traceabilityCode', 'injectionSite'):
            assert correction['data'][field] is None, field
        assert correction['data']['legacyDose'] == 'test_booklet_dose'
        assert self.call('GET', base + '/selections', 200, token=owner)['data'][0]['completed'] is False
        assert self.owned.sql(f"SELECT summary || '|' || occurred_at::date FROM timeline_entries WHERE entity_type='vaccine' AND entity_id='{rid}';").strip() == '接种疫苗: test_corrected_booklet_name|2026-05-06'
        self.observations.append({'case': 'correct in place, clear metadata and preserve raw dose', 'body': self.normalize(correction)})

        with ThreadPoolExecutor(max_workers=2) as pool:
            races = list(pool.map(lambda note: TOOLS.http(self.base, 'PATCH', base + '/records/' + rid,
                {'baseVersion': '3', 'notes': note}, owner), ['test_concurrent_a', 'test_concurrent_b']))
        assert sorted(status for status, _ in races) == [200, 409]
        assert [body for status, body in races if status == 200][0]['data']['version'] == '4'
        self.observations.append({'case': 'concurrent corrections have one winner', 'statuses': [200, 409]})

        # A failed cursor write must roll back record metadata, date, timeline,
        # selection, idempotency receipt and cursor together.
        self.owned.sql(f"""CREATE FUNCTION test_vaccine_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test_vaccine_cursor_failure'; END; $$;
          CREATE TRIGGER test_vaccine_failure BEFORE UPDATE ON family_sync_states
          FOR EACH ROW WHEN (NEW.family_id='{fid}') EXECUTE FUNCTION test_vaccine_failure();""")
        try:
            for method, path, payload in (
                ('PUT', base + '/selections', {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'baseVersion': 3, 'selected': True}),
                ('POST', base + '/records', {**body, 'doseNumber': 2}),
                ('PATCH', base + '/records/' + rid, {'baseVersion': '4', 'administeredDate': '2026-05-07', 'manufacturer': 'test_rollback'}),
                ('DELETE', base + '/records/' + rid, None),
            ):
                before = self.snapshot(fid)
                self.call(method, path, 500, payload, owner, 'test_vaccine_rollback')
                assert self.snapshot(fid) == before
        finally:
            self.owned.sql('DROP TRIGGER test_vaccine_failure ON family_sync_states; DROP FUNCTION test_vaccine_failure();')
        self.observations.append({'case': 'atomic vaccine mutation rollback', 'unchanged': True})

        # Unknown dose numbers and unmatched product names remain unknown.
        immediate = self.call('POST', base + '/records', 201, {'vaccineCode': 'TEST-UNLISTED', 'administeredDate': '2026-04-03', 'doseNumber': None}, owner, 'test_vaccine_completed')
        immediate_id = self.alias(immediate['data']['id'], 'completed_record')
        assert immediate['data']['vaccineId'] is None and immediate['data']['isCompleted'] is True
        assert immediate['data']['doseNumber'] is None and immediate['data']['scheduledDate'] is None
        assert immediate['data']['completedDate'] == '2026-04-03'
        self.observations.append({'case': 'unlisted vaccine with unknown dose', 'body': self.normalize(immediate)})
        persisted = self.call('GET', base + '/records', 200, token=owner)
        self.base = restart()
        assert self.call('GET', base + '/records', 200, token=owner) == persisted
        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', base + '/records', 200, token=owner) == persisted
            assert TOOLS.expect(interop_base, 'GET', base + '/selections', 200, token=owner) == self.call('GET', base + '/selections', 200, token=owner)

        self.call('PATCH', base + '/records/' + rid, 200, {'baseVersion': '4', 'doseNumber': 1}, owner)
        assert self.call('GET', base + '/selections', 200, token=owner)['data'][0]['completed'] is True
        snapshot = self.snapshot(fid)
        self.call('DELETE', base + '/records/' + rid, 409, {'baseVersion': '4'}, owner)
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=4', 409, token=owner)
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=0', 400, token=owner)
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=', 400, token=owner)
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=5&baseVersion=5', 400, token=owner)
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=5', 400, {'baseVersion': '4'}, owner)
        assert self.snapshot(fid) == snapshot
        self.call('DELETE', base + '/records/' + rid + '?baseVersion=5', 200, token=owner)
        assert self.owned.sql(f"SELECT version FROM vaccine_records WHERE id='{rid}' AND deleted_at IS NOT NULL;") == '6'
        assert self.call('GET', base + '/selections', 200, token=owner)['data'][0]['completed'] is False
        self.call('PATCH', base + '/records/' + rid, 404, {'baseVersion': '5', 'notes': 'test_deleted'}, owner)
        self.call('DELETE', base + '/records/' + immediate_id, 200, token=owner)
        assert self.owned.sql(f"SELECT version FROM vaccine_records WHERE id='{immediate_id}' AND deleted_at IS NOT NULL;") == '2'
        self.call('DELETE', base + '/records/' + immediate_id, 404, token=owner)
        assert self.call('GET', base + '/records', 200, token=owner)['data'] == []
        assert self.owned.sql(f"SELECT COUNT(*) FROM family_changes WHERE family_id='{fid}';").strip() == '0'

        viewer_id = users['viewer']['user']['id']
        self.owned.sql(f"""INSERT INTO family_members(id,family_id,user_id,role,status,updated_at) VALUES(gen_random_uuid()::text,'{fid}','{viewer_id}','member','active',NOW());
          INSERT INTO baby_members(id,family_id,baby_id,user_id,role,status,updated_at) VALUES(gen_random_uuid()::text,'{fid}','{bid}','{viewer_id}','viewer','active',NOW());""")
        viewer = self.call('POST', '/api/v1/auth/login', 200, {'username': 'test_go_vaccine_viewer', 'password': 'test_vaccine_password_8675309'})['data']['accessToken']
        self.call('GET', base + '/records', 200, token=viewer)
        self.call('POST', base + '/records', 403, body, viewer)
        self.call('PUT', base + '/selections', 403, {'vaccineId': 'test_vaccine', 'doseNumber': 1, 'selected': True}, viewer)
        self.owned.sql(f"UPDATE family_members SET status='revoked' WHERE family_id='{fid}' AND user_id='{uid}';")
        self.call('GET', base + '/records', 403, token=owner)
        self.call('PUT', base + '/selections', 403, {'vaccineId': 'test_vaccine', 'doseNumber': 1}, owner)
        print('PASS vaccine booklet metadata, dates, correction concurrency, selection isolation, rollback and scope', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations}


if __name__ == '__main__':
    SUPPORT.run_module(VaccineScenario, 'vaccine graph and completion state')
