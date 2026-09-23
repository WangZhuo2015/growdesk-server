#!/usr/bin/env python3
"""Public reference catalogs and private reading state on owned test services.

Runs real HTTP against the native binary and optionally the frozen TypeScript
reference. It accepts no database URL or production endpoint override.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
from urllib.parse import parse_qs, urlencode

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('knowledge_domain', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


class KnowledgeScenario(DOMAIN.Scenario):
    def exact(self, label, value):
        # Reference metadata is business data: do not erase nested timestamps,
        # source IDs, ordering, empty values, or category/age representations.
        self.observations.append({'case': label, 'body': value})
        return value

    def assert_book_effects(self, family, previous, mutations):
        current = self.state(family)
        assert int(current['cursor']) == int(previous['cursor']) + mutations
        assert current['changes'] == previous['changes'] + mutations
        for field in ('receipts', 'timeline', 'feeding', 'sleep', 'diaper'):
            assert current[field] == previous[field], (field, previous, current)

    def run(self, restart, runtime, interop_base=None):
        expected_config = {'data': {'timeZone': 'Asia/Shanghai', 'features': {'swDisabled': False, 'cloud': True},
                                    'serverVersion': '0.1.0', 'minClientVersion': '0.1.0'}}
        assert self.exact('public configuration', self.call('GET', '/api/v1/app-config', 200)) == expected_config
        users = {}
        for name in ('owner', 'outsider'):
            users[name] = self.call('POST', '/api/v1/auth/register', 201, {
                'username': 'test_go_catalog_' + name, 'password': 'test_catalog_password_8675309',
                'displayName': 'Test Catalog ' + name, 'deviceLabel': 'test_catalog_client'})['data']
        owner, outsider = (users[name]['accessToken'] for name in ('owner', 'outsider'))
        uid = users['owner']['user']['id']
        fid = self.alias(self.call('GET', '/api/v1/families', 200, token=owner)['data'][0]['id'], 'family')
        other_family = self.alias(self.call('GET', '/api/v1/families', 200, token=outsider)['data'][0]['id'], 'other_family')

        for kind in ('milestones', 'activities', 'warning-signs'):
            path = '/api/v1/development/' + kind
            self.call('GET', path, 401, observe=kind + ' requires authentication')
            source = self.exact(kind + ' full snapshot', self.call('GET', path, 200, token=owner))
            assert source['data'] and set(source) == ({'data', 'dataRelease'} if kind == 'milestones' else {'data'})
            expected_keys = {'milestones': {'id', 'monthAge', 'category', 'title', 'description', 'details'},
                             'activities': {'id', 'monthAge', 'title', 'content', 'details'},
                             'warning-signs': {'id', 'monthAge', 'signText', 'actionAdvice', 'details'}}[kind]
            for item in source['data']:
                assert set(item) == expected_keys, (kind, set(item))
                assert item['id'] == item['details']['id']
            for query in ('month=0', 'month=2', 'month=2.0', 'month=216',
                          'category=test_missing', 'month=2&category=social_emotional'):
                parameters = parse_qs(query)
                month = int(float(parameters['month'][0])) if 'month' in parameters else None
                category = parameters.get('category', [None])[0]
                def include(entry):
                    details = entry['details']
                    if category and details.get('category') != category:
                        return False
                    if month is None:
                        return True
                    if kind != 'activities':
                        return details['monthAge'] == month
                    lower, upper = details.get('ageMinMonths'), details.get('ageMaxMonths')
                    return (lower is None or float(lower) <= month) and (upper is None or float(upper) >= month)
                expected = {**source, 'data': [entry for entry in source['data'] if include(entry)]}
                actual = self.exact(kind + ' ' + query, self.call('GET', path + '?' + query, 200, token=owner))
                assert actual == expected, (kind, query)
            for query in ('month=-1', 'month=217', 'month=test_invalid'):
                self.call('GET', path + '?' + query, 400, token=owner, observe=kind + ' invalid month')
            # Run the same accepted/rejected wire inputs on both real servers;
            # Go's own numeric parser is not a substitute for this oracle.
            canonical = {month: self.call('GET', path + '?month=' + str(month), 200, token=owner)
                         for month in (0, 2)}
            for raw, month in (("\ufeff2\ufeff", 2), ("\u00a02\u00a0", 2), ("\u20282\u2029", 2),
                               ("\u30002\u3000", 2), ('0x2', 2), ('0o2', 2), ('0b10', 2),
                               ('+2.0', 2), ('.2e1', 2), ('2.e0', 2), ("\ufeff", 0),
                               ('1e-9999', 0), ('-1e-9999', 0)):
                query = urlencode({'month': raw})
                actual = self.exact(kind + ' numeric ' + query, self.call('GET', path + '?' + query, 200, token=owner))
                assert actual == canonical[month], (kind, query)
            for raw in ("\u00852\u0085", "\u0085", "\u180e2", "\u200b2", '+0x1p1', '-0x0p0',
                        '+0x2', '-0b0', '0x2p0', '2_0', '２', '0o8', '0b2', '0x', '.', '2e'):
                query = urlencode({'month': raw})
                self.call('GET', path + '?' + query, 400, token=owner, observe=kind + ' rejected numeric ' + query)
        print('PASS exact knowledge data, filtering, numeric grammar, response allowlists and configuration', flush=True)

        listing = f'/api/v1/books?familyId={fid}'
        self.call('GET', listing, 401, observe='books authentication')
        self.call('GET', '/api/v1/books', 400, token=owner, observe='books explicit family required')
        self.call('GET', listing, 403, token=outsider, observe='other family cannot read reading status')
        first = self.exact('initial book catalog', self.call('GET', listing, 200, token=owner))
        assert len(first['data']) >= 2
        assert self.call('GET', f'/api/v1/books?familyId={other_family}', 200, token=outsider) == first
        for book in first['data']:
            assert book['status'] == 'unread' and book['version'] == '0'
            assert book['details']['readCount'] == 0 and book['details']['isFavorite'] is False
        book_id, second_id = first['data'][0]['id'], first['data'][1]['id']
        assert all(isinstance(value, str) and '/' not in value for value in (book_id, second_id))
        path = '/api/v1/books/' + book_id
        self.call('PATCH', path, 403, {'familyId': fid, 'readCount': 1}, outsider, observe='other family cannot write reading status')
        self.call('PATCH', '/api/v1/books/test_unknown', 404, {'familyId': fid, 'readCount': 1}, owner, observe='unknown book rejected')
        self.call('PATCH', path, 400, {'familyId': fid}, owner, observe='empty update rejected')
        initial = self.state(fid)
        changed = self.exact('initial reading state', self.call('PATCH', path, 200,
            {'familyId': fid, 'baseVersion': '0', 'readCount': 1, 'isFavorite': True}, owner))
        book = changed['data']['book']
        assert changed['data']['success'] is True and book['version'] == '1' and book['status'] == 'finished'
        assert book['details']['status'] == 'finished' and book['details']['isFavorite'] is True
        self.assert_book_effects(fid, initial, 1)
        self.call('PATCH', path, 409, {'familyId': fid, 'baseVersion': '0', 'readCount': 9}, owner, observe='stale reading version')
        self.assert_book_effects(fid, initial, 1)
        # Explicit zeros and false must update state, not behave as omitted.
        reset = self.exact('zero count resets status', self.call('PATCH', path, 200,
            {'familyId': fid, 'baseVersion': '1', 'readCount': 0}, owner))
        assert reset['data']['book']['status'] == 'unread' and reset['data']['book']['details']['isFavorite'] is True
        changed = self.exact('explicit status and false favorite', self.call('PATCH', path, 200,
            {'familyId': fid, 'baseVersion': '2', 'status': 'reading', 'isFavorite': False}, owner))
        assert changed['data']['book']['version'] == '3' and changed['data']['book']['details']['readCount'] == 0
        self.assert_book_effects(fid, initial, 3)
        listing_value = self.exact('reading list projection', self.call('GET', listing, 200, token=owner))
        listed = next(book for book in listing_value['data'] if book['id'] == book_id)
        assert 'status' not in listed['details']
        assert self.call('GET', f'/api/v1/books?familyId={other_family}', 200, token=outsider) == first

        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda i: TOOLS.http(self.base, 'PATCH', path,
                {'familyId': fid, 'baseVersion': '3', 'readCount': i + 1}, owner), range(6)))
        self.calls += len(responses)
        assert [code for code, _ in responses].count(200) == 1
        assert [code for code, _ in responses].count(409) == 5
        assert all(value['error']['code'] == 'VERSION_CONFLICT' for code, value in responses if code == 409)
        self.observations.append({'case': 'reading CAS race', 'success': 1, 'conflict': 5})
        self.assert_book_effects(fid, initial, 4)
        self.exact('reset nondeterministic race winner', self.call('PATCH', path, 200,
            {'familyId': fid, 'baseVersion': '4', 'status': 'unread', 'readCount': 0, 'isFavorite': False}, owner))
        before_state, before_list = self.state(fid), self.call('GET', listing, 200, token=owner)
        self.owned.sql(f"""CREATE FUNCTION test_book_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test_book_failure'; END; $$;
            CREATE TRIGGER test_book_failure BEFORE INSERT ON family_changes
            FOR EACH ROW WHEN (NEW.family_id='{fid}' AND NEW.entity_type='book_status') EXECUTE FUNCTION test_book_failure();""")
        try:
            for target, version in ((book_id, '5'), (second_id, '0')):
                self.call('PATCH', '/api/v1/books/' + target, 500,
                    {'familyId': fid, 'baseVersion': version, 'readCount': 7}, owner, observe='failed change rolls back book and cursor')
                assert self.call('GET', listing, 200, token=owner) == before_list
                assert self.state(fid) == before_state
        finally:
            self.owned.sql('DROP TRIGGER test_book_failure ON family_changes; DROP FUNCTION test_book_failure();')
        changed = self.exact('retry after rollback', self.call('PATCH', path, 200,
            {'familyId': fid, 'baseVersion': '5', 'isFavorite': True}, owner))
        assert changed['data']['book']['version'] == '6'
        self.assert_book_effects(fid, initial, 6)
        before_list = self.call('GET', listing, 200, token=owner)
        self.owned.env['SW_DISABLED'] = '1'
        self.base = restart()
        assert self.call('GET', listing, 200, token=owner) == before_list
        self.exact('restart reading state', before_list)
        expected_config['data']['features']['swDisabled'] = True
        assert self.call('GET', '/api/v1/app-config', 200) == expected_config

        if interop_base:
            assert TOOLS.expect(interop_base, 'GET', listing, 200, token=owner) == before_list
            cross = TOOLS.expect(interop_base, 'PATCH', path, 200,
                {'familyId': fid, 'baseVersion': '6', 'isFavorite': False}, owner)
            assert cross['data']['book']['version'] == '7'
            updated_list = self.call('GET', listing, 200, token=owner)
            assert next(book for book in updated_list['data'] if book['id'] == book_id)['version'] == '7'
            self.call('PATCH', path, 200, {'familyId': fid, 'baseVersion': '7', 'readCount': 2}, owner)
            assert TOOLS.expect(interop_base, 'GET', listing, 200, token=owner) == self.call('GET', listing, 200, token=owner)
            print('PASS bidirectional native/reference reading state interoperability', flush=True)

        before_list, before_state = self.call('GET', listing, 200, token=owner), self.state(fid)
        self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE family_id='{fid}' AND user_id='{uid}';")
        assert self.call('GET', listing, 200, token=owner) == before_list
        self.call('PATCH', path, 403, {'familyId': fid, 'readCount': 9}, owner, observe='viewer cannot modify reading state')
        assert self.state(fid) == before_state
        self.owned.sql(f"UPDATE family_members SET role='admin',status='revoked',deleted_at=NOW() WHERE family_id='{fid}' AND user_id='{uid}';")
        self.call('GET', listing, 403, token=owner, observe='revoked reader with old bearer')
        self.call('PATCH', path, 403, {'familyId': fid, 'readCount': 9}, owner, observe='revoked writer with old bearer')
        assert self.state(fid) == before_state
        security = []
        if runtime == 'go':
            self.owned.sql(f"UPDATE family_members SET status='active',deleted_at=NULL WHERE family_id='{fid}' AND user_id='{uid}'; UPDATE families SET deleted_at=NOW() WHERE id='{fid}';")
            self.call('GET', listing, 403, token=owner)
            self.call('PATCH', path, 403, {'familyId': fid, 'readCount': 9}, owner)
            assert self.state(fid) == before_state
            security = ['soft-deleted family denied without changing state']
        print('PASS reading state, authorization, CAS race, atomic rollback, isolation and restart', flush=True)
        return {'httpAssertions': self.calls, 'observations': self.observations, 'nativeSecurityChecks': security}


def main():
    if not __debug__:
        raise RuntimeError('Do not run with python -O: assertions are required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise RuntimeError('Build the native binary first')
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    version = json.loads(subprocess.check_output([str(binary), '--version'], text=True))
    if version['revision'] != commit:
        raise RuntimeError('Binary revision must match the checkout being tested')
    report = {'scope': 'knowledge/configuration/reading operations, not whole-backend acceptance',
              'status': 'RUNNING', 'commit': commit, 'binary': version, 'runtimes': {}}
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
                owned.env['SW_DISABLED'] = '0'
                native = owned.serve(binary)
                base = native if runtime == 'go' else DOMAIN.serve_reference(owned)
                process = owned.processes[-1]
                def restart():
                    process.terminate()
                    process.wait(timeout=10)
                    return owned.serve(binary) if runtime == 'go' else DOMAIN.serve_reference(owned)
                report['runtimes'][runtime] = KnowledgeScenario(owned, base).run(restart, runtime, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][runtime]['observations'] for runtime in ('go', 'typescript'))
            if left != right:
                differences = [{'case': a.get('case'), 'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    differences.append({'lengths': [len(left), len(right)]})
                raise AssertionError('Knowledge/reading parity differs: ' + json.dumps(differences, ensure_ascii=False))
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
