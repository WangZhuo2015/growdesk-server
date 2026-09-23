#!/usr/bin/env python3
"""Food-plan HTTP/CAS tests using exclusively owned PostgreSQL and Redis.

No database override, production endpoint, real account or paid provider is
accepted. Reference comparisons preserve all nested business JSON exactly.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('food_plan_domain', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


class FoodPlanScenario(DOMAIN.Scenario):
    def observe_plan(self, label, result):
        assert set(result) == {'data'}
        value = result['data']
        assert set(value) == {'id', 'babyId', 'planData', 'version', 'createdAt', 'updatedAt'}
        # Only metadata is normalized. A user's planData.createdAt is business
        # data, not permission to erase a difference in the response.
        projected = {key: self.normalize(item, key) if key != 'planData' else item
                     for key, item in value.items()}
        self.observations.append({'case': label, 'status': 200, 'body': {'data': projected}})
        return value

    def run(self, restart, runtime, interop_base=None):
        users = {}
        for name in ('owner', 'outsider'):
            users[name] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_plan_' + name, 'displayName': 'Test Plan ' + name,
                'password': 'test_plan_password_8675309', 'deviceLabel': 'test_plan_client',
            })['data']
        owner = users['owner']['accessToken']
        outsider = users['outsider']['accessToken']
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        bid = self.alias(self.call('POST', f'/api/v1/families/{fid}/babies', 201, {
            'name': 'Test Plan Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']['id'], 'baby')
        path = f'/api/v1/babies/{bid}/food-plan'
        initial_state = self.state(fid)
        self.call('GET', path, 401, observe='authentication required')
        self.call('GET', path, 403, token=outsider)
        initial = self.observe_plan('absent plan', self.call('GET', path, 200, token=owner))
        assert initial['id'] is None and initial['createdAt'] is None
        assert initial['planData'] == {} and initial['version'] == '0'
        for invalid in ({'planData': {}}, {'planData': {}, 'baseVersion': None},
                        {'planData': {}, 'baseVersion': 0}, {'planData': {}, 'baseVersion': False}):
            result = self.call('PUT', path, 409, invalid, owner, observe='missing string precondition')
            assert result['error']['code'] == 'CONCURRENCY_CONFLICT'
        for invalid in ({'baseVersion': '0', 'planData': None}, {'baseVersion': '-1', 'planData': {}},
                        {'baseVersion': '1.5', 'planData': {}}, {'baseVersion': '9223372036854775808', 'planData': {}}):
            self.call('PUT', path, 400, invalid, owner, observe='malformed precondition or document')
        self.call('PUT', path, 409, {'baseVersion': '1', 'planData': {}}, owner, observe='missing plan rejects update version')

        document = {'createdAt': 'business-value-not-server-time', 'flags': [False, 0, None, []],
                    'decimal': '120.00', 'nested': {'name': "test_辅食'计划", 'enabled': False}}
        saved = self.call('PUT', path, 200, {'baseVersion': '0', 'planData': document}, owner)
        self.alias(saved['data']['id'], 'food_plan')
        first = self.observe_plan('create plan', saved)
        assert first['version'] == '1' and first['planData'] == document
        self.observe_plan('read persisted plan', self.call('GET', path, 200, token=owner))
        for version in ('0', '2'):
            self.call('PUT', path, 409, {'baseVersion': version, 'planData': {'stale': True}}, owner, observe='stale create or update')
        assert self.call('GET', path, 200, token=owner) == saved

        # Failed UPDATE must preserve both the document and its CAS version.
        self.owned.sql(f"""CREATE FUNCTION test_plan_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test_plan_failure'; END; $$;
            CREATE TRIGGER test_plan_failure BEFORE UPDATE ON baby_food_plans
            FOR EACH ROW WHEN (NEW.baby_id='{bid}') EXECUTE FUNCTION test_plan_failure();""")
        try:
            self.call('PUT', path, 500, {'baseVersion': '1', 'planData': {'leak': True}}, owner, observe='failed update is not success')
            assert self.call('GET', path, 200, token=owner) == saved
            assert self.state(fid) == initial_state
        finally:
            self.owned.sql('DROP TRIGGER test_plan_failure ON baby_food_plans; DROP FUNCTION test_plan_failure();')

        changed = {'planData': {'revision': 2, 'empty': {}, 'clear': None}, 'baseVersion': '1'}
        updated = self.call('PUT', path, 200, changed, owner)
        second = self.observe_plan('replace document', updated)
        assert second['id'] == first['id'] and second['createdAt'] == first['createdAt']
        assert second['version'] == '2' and second['planData'] == changed['planData']
        assert 'nested' not in second['planData'], 'PUT must replace rather than merge stale keys'

        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda i: TOOLS.http(self.base, 'PUT', path,
                {'baseVersion': '2', 'planData': {'winner': i}}, owner), range(6)))
        self.calls += len(responses)
        assert [code for code, _ in responses].count(200) == 1
        assert [code for code, _ in responses].count(409) == 5
        for code, value in responses:
            if code == 409:
                assert value['error']['code'] == 'CONCURRENCY_CONFLICT'
        winner = next(value for code, value in responses if code == 200)
        assert self.call('GET', path, 200, token=owner) == winner
        assert winner['data']['version'] == '3'
        self.observations.append({'case': 'concurrent CAS', 'success': 1, 'conflict': 5, 'version': '3'})

        # Keep bigint versions as strings beyond JavaScript's safe integer range.
        self.owned.sql(f"UPDATE baby_food_plans SET version=9007199254740993 WHERE baby_id='{bid}';")
        large = self.call('PUT', path, 200, {'baseVersion': '9007199254740993', 'planData': document}, owner)
        assert self.observe_plan('lossless bigint CAS', large)['version'] == '9007199254740994'
        assert self.state(fid) == initial_state, 'food plans must not invent care cursor/change/receipt effects'
        self.base = restart()
        assert self.call('GET', path, 200, token=owner) == large
        self.observe_plan('restart persistence', large)

        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', path, 200, token=owner) == large
            interop = TOOLS.expect(interop_base, 'PUT', path, 200,
                {'baseVersion': large['data']['version'], 'planData': {'from': 'test_go'}}, owner)
            assert self.call('GET', path, 200, token=owner) == interop
            print('PASS real TS/Go bidirectional food-plan state interoperability', flush=True)

        # These explicit authorization tightenings are NOT claimed as parity
        # with the reference's membership-only food-plan write check.
        security = []
        if runtime == 'go':
            before = self.call('GET', path, 200, token=owner)
            self.owned.sql(f"UPDATE baby_members SET role='viewer' WHERE baby_id='{bid}' AND user_id='{uid}';")
            self.call('GET', path, 200, token=owner)
            self.call('PUT', path, 403, {'baseVersion': before['data']['version'], 'planData': {}}, owner)
            self.owned.sql(f"UPDATE baby_members SET role='admin' WHERE baby_id='{bid}' AND user_id='{uid}';")
            assert self.call('GET', path, 200, token=owner) == before
            self.owned.sql(f"UPDATE family_members SET status='revoked',deleted_at=NOW() WHERE family_id='{fid}' AND user_id='{uid}';")
            self.call('GET', path, 403, token=owner)
            self.call('PUT', path, 403, {'baseVersion': before['data']['version'], 'planData': {}}, owner)
            security = ['viewer write denied without mutation', 'revoked family denied with preexisting bearer']
        print('PASS food plan JSON, CAS, race, rollback and restart', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations, 'nativeSecurityChecks': security}


def main():
    if not __debug__:
        raise RuntimeError('Do not run with python -O: assertions are required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not args.binary.is_file():
        raise RuntimeError('Build the native binary first')
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    report = {'scope': 'food-plan operations, not whole-backend acceptance', 'status': 'RUNNING',
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'runtimes': {}}
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
                report['runtimes'][runtime] = FoodPlanScenario(owned, base).run(restart, runtime, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][runtime]['observations'] for runtime in ('go', 'typescript'))
            if left != right:
                differences = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    differences.append({'lengths': [len(left), len(right)]})
                raise AssertionError('Food plan parity differs: ' + json.dumps(differences, ensure_ascii=False))
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
