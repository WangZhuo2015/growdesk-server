#!/usr/bin/env python3
"""MCP write/replay races on exclusively owned loopback test services.

Uses signed test credentials to isolate mutation authorization, not to certify
OAuth authorization-code issuance or PAT provisioning. Never accepts a live URL.
"""
from __future__ import annotations
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mcp_lock_owned', ROOT / 'scripts/go-integration.py')
assert SPEC and SPEC.loader
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)


class FamilyLock:
    def __init__(self, owned, family):
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen([
            'docker', 'exec', '-i', '-e', 'PGPASSWORD=' + owned.password, owned.pg,
            'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', owned.role, '-d', owned.database,
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=owned.env)
        self.closed = False
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(("BEGIN;\nSET LOCAL lock_timeout='5s';\n"
            f"SELECT cursor FROM family_sync_states WHERE family_id='{family}' FOR UPDATE;\n"
            "\\echo TEST_FAMILY_LOCKED\n").encode())
        self.process.stdin.flush()
        collected = b''
        try:
            with selectors.DefaultSelector() as watcher:
                watcher.register(self.process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 10
                while b'TEST_FAMILY_LOCKED' not in collected:
                    if time.monotonic() > deadline or self.process.poll() is not None:
                        raise RuntimeError('Owned lock holder did not become ready')
                    if watcher.select(.1):
                        chunk = os.read(self.process.stdout.fileno(), 4096)
                        if not chunk:
                            raise RuntimeError('Owned lock holder closed before readiness')
                        collected += chunk
        except BaseException:
            self.close()
            raise

    def commit(self, mutation):
        assert self.process.stdin
        self.process.stdin.write((mutation + '\nCOMMIT;\n\\q\n').encode())
        self.process.stdin.flush()
        self.process.wait(timeout=10)
        if self.process.returncode:
            raise RuntimeError('Owned revocation transaction failed')
        self.closed = True

    def close(self):
        try:
            if not self.closed and self.process.poll() is None:
                assert self.process.stdin
                try:
                    self.process.stdin.write(b'ROLLBACK;\n\\q\n')
                    self.process.stdin.flush()
                    self.process.wait(timeout=5)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            for stream in (self.process.stdin, self.process.stdout):
                if stream:
                    stream.close()
            self.log.close()


def main():
    if not __debug__:
        raise RuntimeError('Assertions must remain enabled')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise RuntimeError('Refusing to replace a report')
    binary = args.binary.resolve()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    identity = json.loads(subprocess.check_output([str(binary), '--version'], text=True))
    if identity.get('revision') != commit:
        raise RuntimeError('Binary does not match the tested source revision')
    owned = TOOLS.OwnedEnvironment()
    report = {'status': 'FAIL', 'commit': commit,
              'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'scope': 'real HTTP and owned PostgreSQL lock races, not OAuth grant acceptance',
              'cases': []}
    try:
        owned.start()
        audience = 'urn:test:mcp-lock:' + owned.owner
        owned.env['MCP_RESOURCE_AUDIENCE'] = audience
        base = owned.serve(binary)
        registered = TOOLS.expect(base, 'POST', '/api/v1/auth/register', 201, {
            'username': 'test_mcp_lock_' + owned.owner,
            'password': 'test_password_' + secrets.token_hex(16), 'displayName': 'Test MCP Lock Owner',
        })['data']
        access, user, session = registered['accessToken'], registered['user']['id'], registered['sessionId']
        family = TOOLS.expect(base, 'GET', '/api/v1/families', 200, token=access)['data'][0]['id']
        baby = TOOLS.expect(base, 'POST', f'/api/v1/families/{family}/babies', 201, {
            'name': 'Test MCP Lock Baby', 'birthDate': '2026-01-02', 'gender': 'girl',
        }, access)['data']['id']
        for value in (user, session, family, baby):
            assert isinstance(value, str) and re.fullmatch(r'[0-9a-f-]{36}', value)

        def signed(expires=None):
            encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
            claims = {'sub': user, 'sid': session, 'aud': audience, 'iss': 'growdesk-api',
                      'scope': 'baby:write', 'baby_id': baby, 'iat': int(time.time()) - 10,
                      'exp': expires or int(time.time()) + 3600}
            raw = encode({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + encode(claims)
            return (raw + b'.' + base64.urlsafe_b64encode(hmac.new(owned.jwt.encode(), raw, hashlib.sha256).digest()).rstrip(b'=')).decode()

        def payload(label):
            return {'jsonrpc': '2.0', 'id': 'test_' + label, 'method': 'tools/call', 'params': {
                'name': 'create_supplement_product', 'arguments': {
                    'name': 'Test MCP Product ' + label, 'babyId': baby, 'familyId': family,
                    'defaultDose': 1, 'idempotencyKey': 'test_' + owned.owner + '_' + label,
                    'nutrients': {'vitamin_d': {'amount': 400, 'unit': 'IU'}},
                },
            }}

        def state():
            return owned.sql(f"""SELECT json_build_array(
                (SELECT count(*) FROM supplement_products WHERE family_id='{family}'),
                (SELECT coalesce(sum(version),0) FROM supplement_products WHERE family_id='{family}'),
                (SELECT cursor FROM family_sync_states WHERE family_id='{family}'),
                (SELECT count(*) FROM family_changes WHERE family_id='{family}'),
                (SELECT count(*) FROM idempotency_receipts WHERE actor_id='{user}' AND scope_id='{family}')
            )::text;""")

        seed = payload('seed')
        first = TOOLS.expect(base, 'POST', '/mcp', 200, seed, signed())
        assert 'result' in first and 'error' not in first
        before = state()
        replay = TOOLS.expect(base, 'POST', '/mcp', 200, seed, signed())
        content = json.loads(replay['result']['content'][0]['text'])
        assert content['success'] is True and content['replayed'] is True
        assert state() == before
        report['cases'].append('authorized creation and idempotent replay preserve one durable write')

        transitions = [
            ('baby-revoked', f"UPDATE baby_members SET status='revoked' WHERE baby_id='{baby}' AND user_id='{user}';", 200),
            ('baby-viewer', f"UPDATE baby_members SET role='viewer' WHERE baby_id='{baby}' AND user_id='{user}';", 200),
            ('family-revoked', f"UPDATE family_members SET status='revoked' WHERE family_id='{family}' AND user_id='{user}';", 200),
            ('family-viewer', f"UPDATE family_members SET role='viewer' WHERE family_id='{family}' AND user_id='{user}';", 200),
            ('user-deleted', f"UPDATE users SET deleted_at=clock_timestamp() WHERE id='{user}';", 401),
            ('session-revoked', f"UPDATE device_sessions SET revoked_at=clock_timestamp() WHERE id='{session}';", 401),
            ('session-expired', f"UPDATE device_sessions SET absolute_expires_at=clock_timestamp()-INTERVAL '1 millisecond' WHERE id='{session}';", 401),
            ('token-expired', 'SELECT 1;', 401),
        ]
        for label, mutation, expected_status in transitions:
            for replaying in (False, True):
                owned.sql(f"""UPDATE users SET deleted_at=NULL WHERE id='{user}';
                    UPDATE family_members SET role='admin',status='active' WHERE family_id='{family}' AND user_id='{user}';
                    UPDATE baby_members SET role='admin',status='active' WHERE baby_id='{baby}' AND user_id='{user}';
                    UPDATE device_sessions SET revoked_at=NULL,absolute_expires_at=clock_timestamp()+INTERVAL '1 day' WHERE id='{session}';""")
                before = state()
                request = seed if replaying else payload(label)
                expiry = int(time.time()) + 5 if label == 'token-expired' else None
                holder = FamilyLock(owned, family)
                executor = ThreadPoolExecutor(max_workers=1)
                try:
                    future = executor.submit(TOOLS.http, base, 'POST', '/mcp', request, signed(expiry))
                    deadline = time.monotonic() + 10
                    while True:
                        waiting = int(owned.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                            "AND usename=current_user AND wait_event_type='Lock' AND query LIKE '%family_sync_states%';"))
                        if waiting:
                            break
                        if future.done() or time.monotonic() > deadline:
                            raise AssertionError('MCP request never reached the held family lock')
                        time.sleep(.05)
                    if expiry:
                        while time.time() <= expiry + .1:
                            time.sleep(.05)
                    holder.commit(mutation)
                    status, response = future.result(timeout=10)
                    assert status == expected_status, (label, replaying, status)
                    assert 'result' not in response, 'revoked request exposed a result or cached private product'
                    assert response['error']['code'] == (-32003 if status == 200 else 'SESSION_REVOKED' if label != 'token-expired' else 'UNAUTHORIZED')
                    assert state() == before, 'denied request changed product, version, cursor, change log or receipt'
                    report['cases'].append(label + (' denies cached replay' if replaying else ' denies fresh write'))
                finally:
                    holder.close()
                    executor.shutdown(wait=True, cancel_futures=True)
        report['status'] = 'PASS'
    finally:
        owned.close()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(report, output, indent=2)
            output.write('\n')
    print('PASS MCP mutation authorization:', len(report['cases']), 'cases', flush=True)


if __name__ == '__main__':
    main()
