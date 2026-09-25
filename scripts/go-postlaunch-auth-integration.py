#!/usr/bin/env python3
"""Post-launch auth regressions on owned loopback PostgreSQL/Redis only."""
from __future__ import annotations
import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('postlaunch_tools', ROOT / 'scripts/go-integration.py')
assert SPEC and SPEC.loader
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)


def main():
    if not __debug__:
        raise RuntimeError('Assertions must remain enabled')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise RuntimeError('Refusing to replace an existing report')
    owned = TOOLS.OwnedEnvironment()
    report = {'status': 'FAIL', 'scope': 'owned native HTTP and database auth regression',
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'binarySha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(), 'assertions': 0, 'cases': []}
    contract = json.loads((ROOT / 'contracts/openapi.json').read_text())
    routes = {operation['operationId']: path for path, item in contract['paths'].items()
              for method, operation in item.items() if method in ('get', 'post', 'patch', 'put', 'delete')}
    def route(operation, **params):
        path = routes[operation]
        for name, value in params.items():
            path = path.replace('{' + name + '}', value)
        assert '{' not in path
        return path
    def call(method, path, expected, body=None, token=None, headers=None):
        status, payload = TOOLS.http(native, method, path, body, token, headers)
        report['assertions'] += 1
        if status != expected:
            raise AssertionError(f'{method} {path.split("?", 1)[0]}: expected {expected}, received {status}')
        return payload
    def signed(claims):
        encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
        message = encode({'alg': 'HS256'}) + b'.' + encode(claims)
        signature = hmac.new(owned.jwt.encode(), message, hashlib.sha256).digest()
        return (message + b'.' + base64.urlsafe_b64encode(signature).rstrip(b'=')).decode()
    def counts():
        return owned.sql('SELECT (SELECT count(*) FROM device_sessions),(SELECT count(*) FROM bff_sessions),(SELECT count(*) FROM refresh_credentials);')
    try:
        owned.start()
        native = owned.serve(args.binary)
        username = 'test_postlaunch_' + owned.owner
        password = 'test_password_' + secrets.token_hex(12)
        original = call('POST', '/api/v1/auth/register', 201, {'username': username, 'password': password, 'displayName': 'Test Owner'})['data']
        uid = original['user']['id']
        now = int(time.time())
        legacy_claims = {'userId': uid, 'username': username, 'iat': now - 60, 'exp': now + 3600}
        secret_hash = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        bff = '/api/v1/auth/bff/session'
        bound = call('POST', bff, 200, {'sessionSecretHash': secret_hash, 'legacyAuthToken': signed(legacy_claims)})['data']
        token = bound['accessToken']
        assert call('GET', '/api/v1/me', 200, token=token)['data']['id'] == uid
        report['cases'].append('original legacy profile creates a persistent usable session')

        call('POST', '/api/v1/auth/logout', 200, token=original['accessToken'])
        call('GET', '/api/v1/me', 401, token=original['accessToken'])
        before = counts()
        denied = call('POST', bff, 401, {'sessionSecretHash': hashlib.sha256(secrets.token_bytes(32)).hexdigest(), 'legacyAuthToken': original['accessToken']})
        assert denied['error']['code'] == 'INVALID_LEGACY_TOKEN'
        assert counts() == before
        for patch in ({'typ': 'mcp'}, {'typ': 'at+jwt'}, {'sid': 'test_session'}, {'exp': now - 1}):
            call('POST', bff, 401, {'sessionSecretHash': secret_hash, 'legacyAuthToken': signed({**legacy_claims, **patch})})
        missing_exp = dict(legacy_claims)
        del missing_exp['exp']
        call('POST', bff, 401, {'sessionSecretHash': secret_hash, 'legacyAuthToken': signed(missing_exp)})
        assert counts() == before
        report['cases'].append('rejected credential profiles do not create, revoke or rotate sessions')

        family = call('GET', '/api/v1/families', 200, token=token)['data'][0]['id']
        baby = call('POST', f'/api/v1/families/{family}/babies', 201, {'name': 'Test Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, token)['data']['id']
        measurement = call('POST', route('createGrowthMeasurement', babyId=baby), 201,
                           {'measurementDate': '2026-09-24', 'weightKg': '8.25', 'notes': 'test private note'}, token,
                           {'Idempotency-Key': str(uuid.uuid4())})['data']
        rid = measurement['id']
        sample = route('getGrowthRecord', id=rid)
        call('GET', sample, 401)
        actual = call('GET', sample, 200, token=token)['data']
        canonical = call('GET', route('getGrowthMeasurement', babyId=baby, id=rid), 200, token=token)['data']
        assert actual == canonical and actual['weightKg'] == '8.25'
        outsider = call('POST', '/api/v1/auth/register', 201, {'username': 'test_other_' + owned.owner, 'password': password, 'displayName': 'Test Other'})['data']['accessToken']
        call('GET', sample, 404, token=outsider)
        call('GET', route('getGrowthRecord', id=str(uuid.uuid4())), 404, token=outsider)
        owned.sql(f"UPDATE baby_members SET status='revoked' WHERE baby_id='{baby}' AND user_id='{uid}';")
        call('GET', sample, 404, token=token)
        owned.sql(f"UPDATE baby_members SET status='active' WHERE baby_id='{baby}' AND user_id='{uid}';")
        call('GET', sample, 200, token=token)
        owned.sql(f"UPDATE growth_measurements SET deleted_at=NOW() WHERE id='{rid}';")
        call('GET', sample, 404, token=token)
        report['cases'].append('sample enforces anonymous, foreign, revoked and deleted-record boundaries and canonical projection')
        call('DELETE', bff, 200, {'sessionSecretHash': secret_hash})
        call('GET', '/api/v1/me', 401, token=token)
        report['status'] = 'PASS'
    finally:
        owned.close()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
    print('PASS post-launch auth and sample privacy regression', flush=True)


if __name__ == '__main__':
    main()
