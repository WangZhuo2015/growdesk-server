#!/usr/bin/env python3
"""Session lifecycle review on owned databases; no external service overrides.

The TS handoff test is intentionally one-way. The frozen reference cannot read
Go ciphertext; this suite does not claim mixed-runtime refresh compatibility.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import signal
import subprocess

if not __debug__:
    raise RuntimeError('Regression assertions must remain enabled')

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('session_review_tools', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS
http, expect = TOOLS.http, TOOLS.expect
BFF = '/api/v1/auth/bff/session'
LABEL = 'test_bff_review'


def hash_secret():
    return hashlib.sha256(secrets.token_bytes(32)).hexdigest()


def state(owned, secret_hash):
    # Raw credentials remain in local assertion memory, never reports or logs.
    return owned.sql(f"""SELECT jsonb_build_object(
        'binding',(SELECT to_jsonb(b) FROM bff_sessions b WHERE session_secret_hash='{secret_hash}'),
        'sessions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM device_sessions d WHERE device_label='{LABEL}'),
        'credentials',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.token_hash) FROM refresh_credentials c
            JOIN device_sessions d ON d.id=c.session_id WHERE d.device_label='{LABEL}'));""")


def live_count(owned):
    return int(owned.sql(f"SELECT COUNT(*) FROM device_sessions WHERE device_label='{LABEL}' AND revoked_at IS NULL;"))


def expire_access(owned, secret_hash):
    owned.sql(f"UPDATE bff_sessions SET access_token_expires_at=NOW()-INTERVAL '1 minute' WHERE session_secret_hash='{secret_hash}';")


def run_native(owned, base, binary):
    credentials, ordinary = [], []
    for name in ('one', 'two'):
        body = {'username': 'test_session_review_' + name,
                'password': 'test_password_' + secrets.token_hex(16),
                'displayName': 'Test session review ' + name, 'deviceLabel': 'test_ordinary'}
        registered = expect(base, 'POST', '/api/v1/auth/register', 201, body)['data']
        ordinary.append(registered['accessToken'])
        credentials.append({'username': body['username'], 'password': body['password'], 'deviceLabel': LABEL})
    secret_hash = hash_secret()
    bodies = [{**body, 'sessionSecretHash': secret_hash} for body in credentials]
    first = expect(base, 'POST', BFF, 200, bodies[0])['data']
    second = expect(base, 'POST', BFF, 200, bodies[0])['data']
    expect(base, 'GET', '/api/v1/me', 401, token=first['accessToken'])
    expect(base, 'GET', '/api/v1/me', 200, token=second['accessToken'])
    assert live_count(owned) == 1, 'same-user rebind left an orphan live session'
    old_live_credentials = owned.sql(f"""SELECT COUNT(*) FROM refresh_credentials c JOIN device_sessions d ON d.id=c.session_id
        WHERE d.device_label='{LABEL}' AND d.revoked_at IS NOT NULL AND c.revoked_at IS NULL;""")
    assert old_live_credentials == '0', 'superseded refresh credentials remain live'

    before = state(owned, secret_hash)
    owned.sql(f"""CREATE FUNCTION test_fail_bff_binding() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test binding update failure'; END $$;
        CREATE TRIGGER test_fail_bff_binding BEFORE UPDATE ON bff_sessions FOR EACH ROW
        WHEN (OLD.session_secret_hash='{secret_hash}') EXECUTE FUNCTION test_fail_bff_binding();""")
    try:
        expect(base, 'POST', BFF, 500, bodies[1])
        assert state(owned, secret_hash) == before, 'failed rebind did not roll back revocation, credentials and binding'
        expect(base, 'GET', '/api/v1/me', 200, token=second['accessToken'])
    finally:
        owned.sql('DROP TRIGGER test_fail_bff_binding ON bff_sessions; DROP FUNCTION test_fail_bff_binding();')

    with ThreadPoolExecutor(max_workers=6) as workers:
        results = list(workers.map(lambda i: http(base, 'POST', BFF, bodies[i % 2]), range(6)))
    assert any(status == 200 for status, _ in results), 'no rebind succeeded'
    for status, payload in results:
        assert status in (200, 409), 'rebind race produced a non-retryable failure'
        if status == 409:
            assert payload['error']['code'] == 'CONCURRENT_MODIFICATION'
    current = expect(base, 'POST', BFF, 200, {'sessionSecretHash': secret_hash})['data']
    assert live_count(owned) == 1, 'concurrent/cross-user binding leaked active sessions'
    for status, payload in results:
        if status == 200 and payload['data']['accessToken'] != current['accessToken']:
            expect(base, 'GET', '/api/v1/me', 401, token=payload['data']['accessToken'])
    expect(base, 'GET', '/api/v1/me', 401, token=second['accessToken'])
    for token in ordinary:
        expect(base, 'GET', '/api/v1/me', 200, token=token)

    # Fresh-process persistence, not a second client talking to the same process.
    proc = owned.processes[-1]
    proc.kill()
    proc.wait(timeout=5)
    base = owned.serve(binary)
    recovered = expect(base, 'POST', BFF, 200, {'sessionSecretHash': secret_hash})['data']
    assert recovered['accessToken'] == current['accessToken'], 'restart lost the binding'

    # Authenticated ciphertext is bound to the BFF secret, not interchangeable
    # between rows. Decryption failure must not rotate or revoke any credential.
    other_hash = hash_secret()
    expect(base, 'POST', BFF, 200, {**credentials[0], 'sessionSecretHash': other_hash})
    owned.sql(f"""UPDATE bff_sessions SET encrypted_refresh_token=(SELECT encrypted_refresh_token
        FROM bff_sessions WHERE session_secret_hash='{secret_hash}'),access_token_expires_at=NOW()-INTERVAL '1 minute'
        WHERE session_secret_hash='{other_hash}';""")
    before = state(owned, other_hash)
    denied = expect(base, 'POST', BFF, 503, {'sessionSecretHash': other_hash})
    assert denied['error']['code'] == 'SESSION_KEY_UNAVAILABLE'
    assert state(owned, other_hash) == before, 'failed decryption mutated durable credentials'
    expect(base, 'DELETE', BFF, 200, {'sessionSecretHash': other_hash})
    expect(base, 'DELETE', BFF, 200, {'sessionSecretHash': secret_hash})
    expect(base, 'GET', '/api/v1/me', 401, token=current['accessToken'])
    expect(base, 'POST', BFF, 401, {'sessionSecretHash': secret_hash})
    assert live_count(owned) == 0
    print('PASS atomic BFF rebind, rollback, cross-user races, restart, ciphertext binding and revocation', flush=True)
    return base


def run_reference_handoff(owned, native):
    reference = DOMAIN.serve_reference(owned)
    username, password = 'test_reference_bff_handoff', 'test_password_' + secrets.token_hex(16)
    expect(reference, 'POST', '/api/v1/auth/register', 201,
           {'username': username, 'password': password, 'displayName': 'Test reference handoff'})
    secret_hash = hash_secret()
    original = expect(reference, 'POST', BFF, 200,
                      {'username': username, 'password': password, 'sessionSecretHash': secret_hash})['data']
    raw = owned.sql(f"SELECT encrypted_refresh_token FROM bff_sessions WHERE session_secret_hash='{secret_hash}';")
    assert len(raw) == 64 and all(c in '0123456789abcdef' for c in raw), 'reference representation changed'
    cached = expect(native, 'POST', BFF, 200, {'sessionSecretHash': secret_hash})['data']
    assert cached['accessToken'] == original['accessToken']
    expire_access(owned, secret_hash)
    rotated = expect(native, 'POST', BFF, 200, {'sessionSecretHash': secret_hash})['data']
    stored = owned.sql(f"SELECT encrypted_refresh_token FROM bff_sessions WHERE session_secret_hash='{secret_hash}';")
    assert stored.startswith('go:v1:') and stored != raw
    expect(reference, 'GET', '/api/v1/me', 200, token=rotated['accessToken'])
    expire_access(owned, secret_hash)
    # Explicitly lock down the NON-supported reverse direction, rather than
    # claiming cached-token success proves bidirectional refresh compatibility.
    unsupported = expect(reference, 'POST', BFF, 401, {'sessionSecretHash': secret_hash})
    assert unsupported['error']['code'] == 'INVALID_REFRESH_TOKEN'
    recovered = expect(native, 'POST', BFF, 200, {'sessionSecretHash': secret_hash})['data']
    expect(native, 'DELETE', BFF, 200, {'sessionSecretHash': secret_hash})
    expect(reference, 'GET', '/api/v1/me', 401, token=recovered['accessToken'])
    print('PASS real TS-to-Go BFF handoff; reverse refresh remains explicitly unsupported', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if args.report:
        args.report.unlink(missing_ok=True)
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    owned = TOOLS.OwnedEnvironment()
    try:
        owned.start()
        native = run_native(owned, owned.serve(args.binary), args.binary)
        if args.reference:
            run_reference_handoff(owned, native)
    finally:
        owned.close()
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({
            'status': 'PASS', 'scope': 'BFF lifecycle review; not whole-backend acceptance',
            'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'realReferenceHandoff': args.reference, 'bidirectionalRefreshSupported': False,
        }, indent=2) + '\n')

if __name__ == '__main__':
    main()
