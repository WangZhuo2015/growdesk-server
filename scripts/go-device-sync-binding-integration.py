#!/usr/bin/env python3
"""Real HTTP protocol tests for principal-bound device sync on an owned stack."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

if not __debug__:
    raise RuntimeError('Refusing optimized Python: assertions must remain enabled')

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / 'evidence/tasks/IOS_WEB_PARITY_20261002/device-sync-binding'
RUN_ID = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
EVIDENCE = EVIDENCE_DIR / f'http-result-{RUN_ID}.json'
BASE_COMMIT = 'ff967e876616f0a03367c1c5f1d639b211fd7d54'
MANIFEST_PREFIX = 'growdesk-device-sync-import-v1\n'

_spec = importlib.util.spec_from_file_location('owned_local_stack_harness', ROOT / 'scripts/go-me-reauth-integration.py')
if _spec is None or _spec.loader is None:
    raise RuntimeError('private local stack harness is unavailable')
_harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_harness)
OwnedLocalStack = _harness.OwnedLocalStack
clean_environment = _harness.clean_environment


def uid() -> str:
    return str(uuid.uuid4())


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def compact_json(value: object) -> bytes:
    # Matches OwnedLocalStack.request byte-for-byte: this is what the Go HTTP
    # handler hashes for approved import chunks.
    return json.dumps(value, separators=(',', ':')).encode()


def manifest_hash(chunks: list[dict]) -> str:
    lines = ''.join(f"{row['index']}:{row['chunkId']}:{row['requestHash']}:{row['itemCount']}\n" for row in chunks)
    return digest((MANIFEST_PREFIX + lines).encode())


def build_binary(temp_root: Path) -> tuple[Path, str]:
    go = shutil.which('go')
    if go is None:
        raise RuntimeError('Go toolchain is unavailable')
    binary = temp_root / 'growdesk-api'
    env = clean_environment()
    env['GOTOOLCHAIN'] = 'auto'
    result = subprocess.run([go, 'build', '-trimpath', '-ldflags=-X=main.revision=' + BASE_COMMIT,
                             '-o', str(binary), './cmd/growdesk-api'], cwd=ROOT, env=env,
                            text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError('isolated API build failed; compiler output withheld')
    return binary, digest(binary.read_bytes())


def dropped_post_response(stack: OwnedLocalStack, path: str, token: str, body: dict, key: str) -> int:
    """Forward a real POST, drain its committed response, and drop it at the client."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    upstream_status: list[int] = []
    done = threading.Event()
    target_port = int(stack.api_base.rsplit(':', 1)[1])

    class DropHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in {'host', 'connection', 'content-length'}}
            upstream = http.client.HTTPConnection('127.0.0.1', target_port, timeout=20)
            try:
                upstream.request('POST', self.path, body=raw, headers=headers)
                response = upstream.getresponse()
                response.read()
                upstream_status.append(response.status)
            finally:
                upstream.close()
                done.set()
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()

        def log_message(self, _format: str, *_args) -> None:
            return

    proxy = ThreadingHTTPServer(('127.0.0.1', 0), DropHandler)
    proxy.daemon_threads = True
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    client_lost_response = False
    try:
        req = urllib.request.Request(
            f'http://127.0.0.1:{proxy.server_port}{path}', data=compact_json(body),
            headers={'Accept': 'application/json', 'Content-Type': 'application/json',
                     'Authorization': 'Bearer ' + token, 'Idempotency-Key': key}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                response.read()
        except (OSError, http.client.HTTPException, urllib.error.URLError):
            client_lost_response = True
        if not done.wait(20):
            raise AssertionError('the response-drop proxy did not finish forwarding the API call')
        if not client_lost_response or len(upstream_status) != 1:
            raise AssertionError('activation response was not lost after exactly one upstream request')
        if upstream_status[0] != 200:
            raise AssertionError(f'activation did not commit before response loss (HTTP {upstream_status[0]})')
        return upstream_status[0]
    finally:
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=5)


def run_checks(stack: OwnedLocalStack, report: dict) -> None:
    cases: list[str] = []
    checks = 0

    def call(method: str, path: str, expected: int, *, body=None, token=None,
             code: str | None = None, headers=None):
        nonlocal checks
        status, payload = stack.request(method, path, body, token, extra_headers=headers)
        checks += 1
        actual = payload.get('error', {}).get('code') if isinstance(payload, dict) else None
        if status != expected or (code is not None and actual != code):
            raise AssertionError(f'{method} endpoint expected HTTP {expected}/{code or "success"}, got {status}/{actual or "success"}')
        return payload

    suffix = stack.owner
    owner = _harness.register(stack, suffix + '_owner', label='test_device_sync')
    collaborator = _harness.register(stack, suffix + '_member', label='test_device_sync')
    outsider = _harness.register(stack, suffix + '_outsider', label='test_device_sync')
    family = call('POST', '/api/v1/families', 201,
                  body={'name': 'test_family_device_sync_' + suffix}, token=owner['accessToken'])['data']
    family_id = family['id']
    baby = call('POST', f'/api/v1/families/{family_id}/babies', 201,
                body={'name': 'test_baby_device_sync_' + suffix,
                      'birthDate': '2025-01-02', 'gender': 'other'}, token=owner['accessToken'])['data']
    baby_id = baby['id']
    invite = call('POST', f'/api/v1/families/{family_id}/invites', 201,
                  body={'expiresInDays': 1}, token=owner['accessToken'])['data']['inviteCode']
    call('POST', '/api/v1/families/join', 200,
         body={'inviteCode': invite}, token=collaborator['accessToken'])
    call('POST', f'/api/v1/babies/{baby_id}/members', 201,
         body={'userId': collaborator['_userId'], 'role': 'admin'}, token=owner['accessToken'])
    call('PATCH', f'/api/v1/families/{family_id}/members/{collaborator["_userId"]}', 200,
         body={'role': 'admin'}, token=owner['accessToken'])
    profiled_food = call('POST', '/api/v1/food/items', 201, token=owner['accessToken'],
                         body={'familyId': family_id, 'name': 'test sync food ' + suffix,
                               'category': 'other', 'allergenRisk': 'low',
                               'recommendedAgeMonths': 6, 'nutritionBasis': 'per_100g',
                               'nutrientsJson': {'energy_kcal': {'amount': 70, 'unit': 'kcal'},
                                                 'protein': {'amount': 2.4, 'unit': 'g'}}})

    def enroll(token: str, installation: str, vault: str, target_family: str = family_id):
        return call('POST', '/api/v1/sync/device-bindings', 201, token=token,
                    body={'installationId': installation, 'localVaultId': vault,
                          'familyId': target_family, 'consentVersion': 'plan07-v1'})['data']

    def binding_headers(binding_id: str, generation: str) -> dict[str, str]:
        return {'X-Device-Sync-Binding-ID': binding_id,
                'X-Device-Sync-Generation': generation}

    def command(entity_type: str, payload: dict, *, entity_id: str | None = None,
                family: str = family_id, baby: str = baby_id) -> dict:
        return {'commandId': uid(), 'familyId': family, 'babyId': baby,
                'entityType': entity_type, 'entityId': entity_id or uid(),
                'operation': 'create', 'baseVersion': None,
                'clientCreatedAt': '2025-01-03T12:00:00.000Z', 'payload': payload}

    def plan_body(binding_id: str, generation: str, chunks: list[dict]) -> dict:
        descriptors = []
        for index, chunk in enumerate(chunks):
            descriptors.append({'chunkId': chunk['chunkId'], 'index': index,
                                'requestHash': digest(compact_json(chunk)),
                                'itemCount': len(chunk['commands'])})
        return {'importId': uid(), 'generation': generation,
                'consentVersion': 'plan07-v1', 'manifestHash': manifest_hash(descriptors),
                'chunks': descriptors}

    def create_plan(binding: dict, chunks: list[dict]) -> tuple[str, dict]:
        body = plan_body(binding['id'], binding['generation'], chunks)
        response = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/import-plans", 201,
                        body=body, token=owner['accessToken'],
                        headers=binding_headers(binding['id'], binding['generation']))['data']
        if response['id'] != body['importId'] or response['manifestHash'] != body['manifestHash']:
            raise AssertionError('server did not persist the approved import ID and manifest')
        return body['importId'], body

    def activate(binding: dict, import_id: str, generation: str, key: str):
        return call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/activate", 200,
                    body={'importId': import_id, 'generation': generation}, token=owner['accessToken'],
                    headers={'Idempotency-Key': key})['data']

    def concurrent_enrollment_transition(binding: dict, action: str, generation: str,
                                         key: str, consent_version: str | None = None) -> dict:
        """Race repeated read-only enrollment against one real binding mutation."""
        path = f"/api/v1/sync/device-bindings/{binding['id']}/{action}"
        body = {'generation': generation}
        if action == 'resume':
            body['consentVersion'] = consent_version or 'plan07-v1'
        enroll_count, action_count = 12, 4
        gate = threading.Barrier(enroll_count + action_count)

        def read_enrollment(_index: int):
            gate.wait(timeout=10)
            return stack.request('POST', '/api/v1/sync/device-bindings', enroll_body_for(binding),
                                 owner['accessToken'])

        def transition(_index: int):
            gate.wait(timeout=10)
            return stack.request('POST', path, body, owner['accessToken'],
                                 extra_headers={'Idempotency-Key': key})

        with ThreadPoolExecutor(max_workers=enroll_count + action_count) as pool:
            enroll_futures = [pool.submit(read_enrollment, i) for i in range(enroll_count)]
            action_futures = [pool.submit(transition, i) for i in range(action_count)]
            enrollment_results = [future.result(timeout=45) for future in enroll_futures]
            action_results = [future.result(timeout=45) for future in action_futures]
        nonlocal checks
        checks += len(enrollment_results) + len(action_results)
        for status, payload in enrollment_results:
            data = payload.get('data', {}) if isinstance(payload, dict) else {}
            if status not in (200, 201) or data.get('id') != binding['id'] or \
                    data.get('userId') != owner['_userId']:
                error_code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'invalid-response'
                raise AssertionError(f'concurrent enrollment/{action} returned HTTP {status}/{error_code} or the wrong binding')
        expected_status = 'paused' if action == 'pause' else 'active'
        expected_generation = str(int(generation) + 1)
        for status, payload in action_results:
            data = payload.get('data', {}) if isinstance(payload, dict) else {}
            if status != 200 or data.get('status') != expected_status or \
                    data.get('generation') != expected_generation:
                raise AssertionError(f'enrollment/ {action} race returned HTTP {status} instead of the same committed receipt')
        return action_results[0][1]['data']

    def enroll_body_for(binding: dict) -> dict:
        return {'installationId': binding['installationId'], 'localVaultId': binding['localVaultId'],
                'familyId': binding['familyId'], 'consentVersion': binding['consentVersion']}

    # Repeated concurrent enrollment calls under one principal converge on the
    # server-owned, family-authorized binding rather than a caller-picked ID.
    concurrent_installation, concurrent_vault = 'test-install-' + suffix, 'test-vault-' + suffix
    enroll_body = {'installationId': concurrent_installation, 'localVaultId': concurrent_vault,
                   'familyId': family_id, 'consentVersion': 'plan07-v1'}
    gate = threading.Barrier(6)

    def concurrent_enroll(_index: int):
        gate.wait(timeout=10)
        return stack.request('POST', '/api/v1/sync/device-bindings', enroll_body,
                             owner['accessToken'])

    with ThreadPoolExecutor(max_workers=6) as pool:
        enroll_results = list(pool.map(concurrent_enroll, range(6)))
    checks += len(enroll_results)
    enroll_ids: set[str] = set()
    for status, payload in enroll_results:
        if status not in (200, 201) or not isinstance(payload, dict):
            raise AssertionError('concurrent duplicate enrollment did not return a binding')
        data = payload.get('data', {})
        if data.get('status') != 'pending' or data.get('userId') != owner['_userId']:
            raise AssertionError('concurrent enrollment returned the wrong principal or non-pending status')
        enroll_ids.add(data.get('id', ''))
    if len(enroll_ids) != 1:
        raise AssertionError('concurrent duplicate enrollment produced multiple binding IDs')
    concurrent_binding_id = next(iter(enroll_ids))
    duplicate_count = stack.sql(
        f"SELECT count(*) FROM device_sync_bindings WHERE user_id='{owner['_userId']}' "
        f"AND installation_id='{concurrent_installation}' AND local_vault_id='{concurrent_vault}' AND family_id='{family_id}';")
    if duplicate_count != '1':
        raise AssertionError('concurrent enrollment persisted more than one principal/vault/family binding')
    cases.append('six concurrent enrollment requests for one test principal converge on one server-assigned pending binding')

    # A zero-record import still needs an explicit, durable plan and activation
    # receipt; drop only the response bytes to exercise authoritative readback.
    empty_binding = enroll(owner['accessToken'], 'test-empty-install-' + suffix,
                          'test-empty-vault-' + suffix)
    if empty_binding['status'] != 'pending' or empty_binding['generation'] != '1':
        raise AssertionError('enrollment did not start pending at server generation one')
    listed = call('GET', '/api/v1/sync/device-bindings', 200, token=owner['accessToken'])['data']
    if not any(row['id'] == empty_binding['id'] for row in listed):
        raise AssertionError('principal binding list omitted its own pending binding')
    call('GET', f"/api/v1/sync/device-bindings/{empty_binding['id']}", 200,
         token=owner['accessToken'])
    call('GET', f"/api/v1/sync/device-bindings/{empty_binding['id']}", 404,
         token=collaborator['accessToken'], code='DEVICE_SYNC_BINDING_NOT_FOUND')
    call('GET', f"/api/v1/sync/device-bindings/{empty_binding['id']}", 404,
         token=outsider['accessToken'], code='DEVICE_SYNC_BINDING_NOT_FOUND')
    call('POST', '/api/v1/sync/device-bindings', 403, token=outsider['accessToken'],
         body={'installationId': 'test-foreign-install-' + suffix,
               'localVaultId': 'test-foreign-vault-' + suffix,
               'familyId': family_id, 'consentVersion': 'plan07-v1'},
         code='DEVICE_SYNC_FAMILY_ACCESS_DENIED')
    empty_plan_id, empty_plan = create_plan(empty_binding, [])
    empty_path = f"/api/v1/sync/device-bindings/{empty_binding['id']}/import-plans/{empty_plan_id}"
    saved_empty_plan = call('GET', empty_path, 200, token=owner['accessToken'])['data']
    if saved_empty_plan['chunks'] or saved_empty_plan['status'] != 'pending':
        raise AssertionError('explicit empty import plan was not durably persisted')
    empty_activation = {'importId': empty_plan_id, 'generation': '1'}
    empty_key = 'activate-empty-' + suffix
    dropped_post_response(stack, f"/api/v1/sync/device-bindings/{empty_binding['id']}/activate",
                          owner['accessToken'], empty_activation, empty_key)
    checks += 1
    empty_after_loss = call('GET', f"/api/v1/sync/device-bindings/{empty_binding['id']}", 200,
                            token=owner['accessToken'])['data']
    if empty_after_loss['status'] != 'active' or empty_after_loss['generation'] != '2':
        raise AssertionError('lost activation response was not recoverable from binding readback')
    replayed_empty = activate(empty_binding, empty_plan_id, '1', empty_key)
    if replayed_empty['id'] != empty_binding['id'] or replayed_empty['generation'] != '2':
        raise AssertionError('same-key activation retry did not return the original activation receipt')
    call('POST', f"/api/v1/sync/device-bindings/{empty_binding['id']}/activate", 409,
         body={'importId': uid(), 'generation': '1'}, token=owner['accessToken'],
         headers={'Idempotency-Key': empty_key}, code='IDEMPOTENCY_KEY_REUSED')
    cases.append('explicit zero-record plan activates durably; a deliberately lost HTTP 200 is read back and same-key activation replays')

    # Enroll takes the family lock. Pause/resume take the binding lock before
    # the family lock. Repeated real HTTP races verify read-only enrollment
    # never creates the reverse lock edge or a database-deadlock 500.
    transition_binding = empty_binding
    transition_generation = empty_after_loss['generation']
    transition_cycles = 3
    for cycle in range(transition_cycles):
        transition_binding = concurrent_enrollment_transition(
            transition_binding, 'pause', transition_generation,
            f'enroll-pause-{cycle}-{suffix}')
        transition_generation = transition_binding['generation']
        transition_binding = concurrent_enrollment_transition(
            transition_binding, 'resume', transition_generation,
            f'enroll-resume-{cycle}-{suffix}', 'plan07-v1')
        transition_generation = transition_binding['generation']
    transition_readback = call('GET', f"/api/v1/sync/device-bindings/{transition_binding['id']}",
                               200, token=owner['accessToken'])['data']
    if transition_readback['status'] != 'active' or transition_readback['generation'] != transition_generation:
        raise AssertionError('concurrent enrollment transitions did not leave the last committed generation active')
    cases.append('six 12-enrollment/4-transition HTTP races across pause and resume complete without deadlock, wrong receipt, or duplicate binding')

    # One chunk per three existing domain command kinds covers all six record
    # tables through the same import transaction and validators as sync.
    binding = enroll(owner['accessToken'], 'test-import-install-' + suffix,
                     'test-import-vault-' + suffix)
    valid_commands = [
        command('feeding', {'feedingType': 'formula', 'occurredAt': '2025-01-03T10:00:00.000Z',
                            'amountMl': '120', 'spitUp': False, 'notes': 'test binding import'}),
        command('sleep', {'sleepType': 'nap', 'startedAt': '2025-01-03T11:00:00.000Z',
                          'endedAt': '2025-01-03T11:30:00.000Z', 'nightWakingCount': 0}),
        command('diaper', {'diaperType': 'pee', 'occurredAt': '2025-01-03T11:40:00.000Z'}),
        command('foodLog', {'recordDate': '2025-01-03', 'mealType': 'lunch',
                            'foodItemIds': [profiled_food['id']], 'foodAmountGrams': '32.5',
                            'portionDescription': '32.5 g test portion'}),
        command('supplementRecord', {'supplementName': 'test vitamin',
                                     'occurredAt': '2025-01-03T12:00:00.000Z',
                                     'dose': '1', 'unitName': 'ml'}),
        command('growthMeasurement', {'measurementDate': '2025-01-03', 'weightKg': '5.2',
                                      'heightCm': '58.1', 'headCircumferenceCm': '38.0'}),
    ]
    chunks = [{'chunkId': uid(), 'commands': valid_commands[:3]},
              {'chunkId': uid(), 'commands': valid_commands[3:]}]
    import_id, plan_request = create_plan(binding, chunks)
    # Creation retries are keyed by the stable importId + immutable manifest.
    replay_plan = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/import-plans", 200,
                       body=plan_request, token=owner['accessToken'],
                       headers=binding_headers(binding['id'], '1'))['data']
    if replay_plan['id'] != import_id or len(replay_plan['chunks']) != 2:
        raise AssertionError('same manifest retry did not return the original import plan')
    activation_key = 'activate-import-' + suffix
    call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/activate", 409,
         body={'importId': import_id, 'generation': '1'}, token=owner['accessToken'],
         headers={'Idempotency-Key': activation_key}, code='DEVICE_SYNC_IMPORT_INCOMPLETE')

    chunk_path = f"/api/v1/sync/device-bindings/{binding['id']}/import-plans/{import_id}/chunks"
    first_body = chunks[0]
    before_import = stack.sql(
        f"SELECT (SELECT count(*) FROM feeding_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM sleep_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM diaper_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM food_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM supplement_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM growth_measurements WHERE baby_id='{baby_id}');")
    import_enroll_count, concurrent_chunk_count = 12, 5
    gate = threading.Barrier(import_enroll_count + concurrent_chunk_count)

    def apply_first(_index: int):
        gate.wait(timeout=10)
        return stack.request('POST', chunk_path, first_body, owner['accessToken'],
                             extra_headers=binding_headers(binding['id'], '1'))

    def enroll_during_import(_index: int):
        gate.wait(timeout=10)
        return stack.request('POST', '/api/v1/sync/device-bindings', enroll_body_for(binding),
                             owner['accessToken'])

    with ThreadPoolExecutor(max_workers=import_enroll_count + concurrent_chunk_count) as pool:
        chunk_futures = [pool.submit(apply_first, i) for i in range(concurrent_chunk_count)]
        enroll_futures = [pool.submit(enroll_during_import, i) for i in range(import_enroll_count)]
        chunk_results = [future.result(timeout=45) for future in chunk_futures]
        import_enroll_results = [future.result(timeout=45) for future in enroll_futures]
    checks += len(chunk_results) + len(import_enroll_results)
    for status, payload in import_enroll_results:
        data = payload.get('data', {}) if isinstance(payload, dict) else {}
        if status not in (200, 201) or data.get('id') != binding['id']:
            code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'invalid-response'
            raise AssertionError(f'enrollment racing import chunk returned HTTP {status}/{code}')
    first_statuses = []
    for status, payload in chunk_results:
        if status != 200:
            code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'unknown'
            raise AssertionError(f'concurrent first-chunk request returned HTTP {status}/{code}')
        first_statuses.append(payload.get('data', {}).get('status'))
    if first_statuses.count('applied') != 1 or first_statuses.count('replayed') != concurrent_chunk_count - 1:
        raise AssertionError('concurrent same-chunk submissions did not share one applied receipt')
    after_first = stack.sql(
        f"SELECT (SELECT count(*) FROM feeding_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM sleep_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM diaper_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM food_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM supplement_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM growth_measurements WHERE baby_id='{baby_id}');")
    if after_first != '1|1|1|0|0|0' or before_import != '0|0|0|0|0|0':
        raise AssertionError('first import chunk was not atomic or duplicate submissions created duplicate records')
    call('POST', chunk_path, 409, body={**first_body, 'commands': [
         {**first_body['commands'][0], 'payload': {**first_body['commands'][0]['payload'], 'notes': 'changed'}}]},
         token=owner['accessToken'], headers=binding_headers(binding['id'], '1'),
         code='DEVICE_SYNC_IMPORT_CHUNK_MISMATCH')
    second_body = chunks[1]
    second_result = call('POST', chunk_path, 200, body=second_body, token=owner['accessToken'],
                         headers=binding_headers(binding['id'], '1'))['data']
    if second_result['status'] != 'applied' or len(second_result['results']) != 3:
        raise AssertionError('second import chunk did not apply the remaining supported record kinds')
    second_replay = call('POST', chunk_path, 200, body=second_body, token=owner['accessToken'],
                         headers=binding_headers(binding['id'], '1'))['data']
    if second_replay['status'] != 'replayed' or len(second_replay['results']) != 3:
        raise AssertionError('second import chunk replay did not return the stored receipt')
    counts_after_import = stack.sql(
        f"SELECT (SELECT count(*) FROM feeding_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM sleep_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM diaper_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM food_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM supplement_records WHERE baby_id='{baby_id}')::text||'|'||"
        f"(SELECT count(*) FROM growth_measurements WHERE baby_id='{baby_id}');")
    if counts_after_import != '1|1|1|1|1|1':
        raise AssertionError('the two approved chunks did not produce exactly one row of each supported type')
    current_plan = call('GET', f"/api/v1/sync/device-bindings/{binding['id']}/import-plans/{import_id}",
                        200, token=owner['accessToken'])['data']
    if [row['status'] for row in current_plan['chunks']] != ['applied', 'applied']:
        raise AssertionError('server import plan did not durably checkpoint both chunks')
    activated = activate(binding, import_id, '1', activation_key)
    if activated['status'] != 'active' or activated['generation'] != '2':
        raise AssertionError('complete two-chunk import did not activate the binding at next generation')
    cases.append('two approved chunks import feeding/sleep/diaper/food/supplement/growth atomically, checkpoint and replay without duplicates')

    # Existing IDs are never overwritten by an import create. The failed chunk
    # leaves the existing row and all sibling writes untouched.
    conflict_binding = enroll(owner['accessToken'], 'test-conflict-install-' + suffix,
                              'test-conflict-vault-' + suffix)
    existing_feeding = valid_commands[0]['entityId']
    conflict_command = command('feeding', {'feedingType': 'formula',
                                           'occurredAt': '2025-01-03T10:00:00.000Z',
                                           'amountMl': '999', 'spitUp': False,
                                           'notes': 'must not overwrite'}, entity_id=existing_feeding)
    conflict_chunk = {'chunkId': uid(), 'commands': [conflict_command]}
    conflict_import_id, _ = create_plan(conflict_binding, [conflict_chunk])
    before_row = stack.sql(f"SELECT amount_ml::text||'|'||notes FROM feeding_records WHERE id='{existing_feeding}';")
    call('POST', f"/api/v1/sync/device-bindings/{conflict_binding['id']}/import-plans/{conflict_import_id}/chunks",
         409, body=conflict_chunk, token=owner['accessToken'],
         headers=binding_headers(conflict_binding['id'], '1'), code='DEVICE_SYNC_IMPORT_ID_CONFLICT')
    after_row = stack.sql(f"SELECT amount_ml::text||'|'||notes FROM feeding_records WHERE id='{existing_feeding}';")
    if before_row != after_row:
        raise AssertionError('conflicting import mutated the already-existing server record')
    cases.append('import ID conflict returns 409 and preserves the existing server row byte-for-byte')

    # The fixed measured-food contract is shared by normal HTTP writes and the
    # sync/import command path: grams are accepted only for a single
    # family-owned custom food with an actual server-side per-100g profile.
    no_profile_binding = enroll(owner['accessToken'], 'test-no-profile-install-' + suffix,
                                'test-no-profile-vault-' + suffix)
    no_profile_command = command('foodLog', {'recordDate': '2025-01-03', 'mealType': 'lunch',
                                             'foodItemIds': ['food_egg'], 'foodAmountGrams': '24.5'})
    no_profile_chunk = {'chunkId': uid(), 'commands': [no_profile_command]}
    no_profile_import_id, _ = create_plan(no_profile_binding, [no_profile_chunk])
    food_count_before = stack.sql(f"SELECT count(*) FROM food_records WHERE baby_id='{baby_id}';")
    call('POST', f"/api/v1/sync/device-bindings/{no_profile_binding['id']}/import-plans/{no_profile_import_id}/chunks",
         400, body=no_profile_chunk, token=owner['accessToken'],
         headers=binding_headers(no_profile_binding['id'], '1'), code='BAD_REQUEST')
    food_count_after = stack.sql(f"SELECT count(*) FROM food_records WHERE baby_id='{baby_id}';")
    if food_count_before != food_count_after:
        raise AssertionError('measured food sync accepted grams without a family-owned nutrient profile')
    cases.append('foodAmountGrams sync admission uses the pinned per-100g family profile validator and rejects unsupported library items')

    # Attachment-bearing plans are explicitly rejected before record creation;
    # no “migration complete” state can be inferred from the partial import.
    attachment_binding = enroll(owner['accessToken'], 'test-attachment-install-' + suffix,
                                'test-attachment-vault-' + suffix)
    attachment_command = command('growthMeasurement', {
        'measurementDate': '2025-01-03', 'weightKg': '5.2', 'attachmentId': 'test_unimported_attachment'})
    attachment_chunk = {'chunkId': uid(), 'commands': [attachment_command]}
    attachment_import_id, _ = create_plan(attachment_binding, [attachment_chunk])
    before_attachment_reject = stack.sql(f"SELECT count(*) FROM growth_measurements WHERE baby_id='{baby_id}';")
    call('POST', f"/api/v1/sync/device-bindings/{attachment_binding['id']}/import-plans/{attachment_import_id}/chunks",
         422, body=attachment_chunk, token=owner['accessToken'],
         headers=binding_headers(attachment_binding['id'], '1'),
         code='DEVICE_SYNC_IMPORT_ATTACHMENT_UNSUPPORTED')
    after_attachment_reject = stack.sql(f"SELECT count(*) FROM growth_measurements WHERE baby_id='{baby_id}';")
    if before_attachment_reject != after_attachment_reject or before_attachment_reject != '1':
        raise AssertionError('unsupported attachment import created a growth record')
    cases.append('attachment references in initial import are rejected before record mutation')

    # Sync admission is owner + family + current binding generation; headers
    # can scope a request but cannot authorize a foreign principal.
    active_command = command('feeding', {'feedingType': 'formula',
                                         'occurredAt': '2025-01-04T10:00:00.000Z',
                                         'amountMl': '90', 'spitUp': False,
                                         'notes': 'sync command test'})
    sync_body = {'commands': [active_command]}
    sync_path = '/api/v1/sync/commands'
    sync_headers = binding_headers(binding['id'], '2')
    missing_context = call('POST', sync_path, 400, body=sync_body,
                           token=owner['accessToken'], code='FST_ERR_VALIDATION')
    collaborator_status, collaborator_denied = stack.request('POST', sync_path, sync_body,
        collaborator['accessToken'], extra_headers=sync_headers)
    checks += 1
    if collaborator_status != 404 or collaborator_denied.get('error', {}).get('code') != 'DEVICE_SYNC_BINDING_NOT_FOUND':
        raise AssertionError('same-family collaborator could use another principal binding')
    outsider_status, outsider_denied = stack.request('POST', sync_path, sync_body,
        outsider['accessToken'], extra_headers=sync_headers)
    checks += 1
    if outsider_status != 404 or outsider_denied.get('error', {}).get('code') != 'DEVICE_SYNC_BINDING_NOT_FOUND':
        raise AssertionError('foreign principal could use a test binding ID')
    created = call('POST', sync_path, 200, body=sync_body, token=owner['accessToken'],
                   headers=sync_headers)['data']['results'][0]
    replay = call('POST', sync_path, 200, body=sync_body, token=owner['accessToken'],
                  headers=sync_headers)['data']['results'][0]
    if created['status'] != 'applied' or replay['status'] != 'replayed' or created['entityId'] != replay['entityId']:
        raise AssertionError('current binding generation did not replay one original sync command')
    changed_sync = {'commands': [{**active_command,
                                  'payload': {**active_command['payload'], 'notes': 'different payload'}}]}
    changed = call('POST', sync_path, 200, body=changed_sync, token=owner['accessToken'],
                   headers=sync_headers)['data']['results'][0]
    if changed['status'] != 'error' or changed.get('error', {}).get('code') != 'IDEMPOTENCY_KEY_REUSED':
        raise AssertionError('changed command body did not conflict with its original receipt')
    stale = call('POST', sync_path, 409, body={'commands': [command('feeding', active_command['payload'])]},
                 token=owner['accessToken'], headers=binding_headers(binding['id'], '1'),
                 code='DEVICE_SYNC_BINDING_STALE')
    mismatch_command = command('feeding', active_command['payload'], family=uid())
    mismatch = call('POST', sync_path, 200, body={'commands': [mismatch_command]},
                    token=owner['accessToken'], headers=sync_headers)['data']['results'][0]
    if mismatch['status'] != 'error' or mismatch.get('error', {}).get('code') != 'DEVICE_SYNC_BINDING_SCOPE_MISMATCH':
        raise AssertionError('binding accepted a command that claimed another family')
    call('POST', sync_path, 400, body=sync_body, token=owner['accessToken'],
         headers={'X-Device-Sync-Binding-ID': binding['id']}, code='FST_ERR_VALIDATION')
    # Admission and apply both lock binding before family. Race duplicate
    # enrollment against real sync commands, then prove their one record receipt.
    enroll_pressure_count, sync_pressure_count = 12, 4
    pressure_gate = threading.Barrier(enroll_pressure_count + sync_pressure_count)
    pressure_command = command('feeding', {'feedingType': 'formula',
                                           'occurredAt': '2025-01-03T13:00:00.000Z',
                                           'amountMl': '65', 'spitUp': False,
                                           'notes': 'enrollment command lock race'})
    pressure_body = {'commands': [pressure_command]}

    def pressure_enroll(_index: int):
        pressure_gate.wait(timeout=10)
        return stack.request('POST', '/api/v1/sync/device-bindings', enroll_body_for(binding),
                             owner['accessToken'])

    def pressure_sync(_index: int):
        pressure_gate.wait(timeout=10)
        return stack.request('POST', sync_path, pressure_body, owner['accessToken'],
                             extra_headers=sync_headers)

    with ThreadPoolExecutor(max_workers=enroll_pressure_count + sync_pressure_count) as pool:
        enrollment_futures = [pool.submit(pressure_enroll, i) for i in range(enroll_pressure_count)]
        sync_futures = [pool.submit(pressure_sync, i) for i in range(sync_pressure_count)]
        pressure_enrollment_results = [future.result(timeout=45) for future in enrollment_futures]
        pressure_sync_results = [future.result(timeout=45) for future in sync_futures]
    checks += len(pressure_enrollment_results) + len(pressure_sync_results)
    for status, payload in pressure_enrollment_results:
        data = payload.get('data', {}) if isinstance(payload, dict) else {}
        if status not in (200, 201) or data.get('id') != binding['id']:
            code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'invalid-response'
            raise AssertionError(f'enrollment racing sync command returned HTTP {status}/{code}')
    pressure_statuses = []
    for status, payload in pressure_sync_results:
        if status != 200:
            code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'invalid-response'
            raise AssertionError(f'sync command racing enrollment returned HTTP {status}/{code}')
        results = payload.get('data', {}).get('results', [])
        if len(results) != 1 or results[0].get('status') not in ('applied', 'replayed'):
            raise AssertionError('sync/enrollment race did not converge on one command receipt')
        pressure_statuses.append(results[0]['status'])
    pressure_row_count = stack.sql(
        f"SELECT count(*) FROM feeding_records WHERE id='{pressure_command['entityId']}' AND baby_id='{baby_id}';")
    if pressure_statuses.count('applied') != 1 or pressure_statuses.count('replayed') != sync_pressure_count - 1 or pressure_row_count != '1':
        raise AssertionError('concurrent sync/enrollment requests created an invalid or duplicate record receipt')
    cases.append('twelve duplicate enrollment requests raced five real import chunks and four sync commands without lock errors or duplicate writes')
    cases.append('sync commands require current owner binding/generation; same-principal replay works and foreign owner/family or stale generation is denied')

    # Binding state transitions are CAS/idempotent and monotonically advance
    # the generation. Stale command admissions stop after every transition.
    pause_key = 'pause-' + suffix
    paused = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/pause", 200,
                  body={'generation': '2'}, token=owner['accessToken'],
                  headers={'Idempotency-Key': pause_key})['data']
    if paused['status'] != 'paused' or paused['generation'] != '3':
        raise AssertionError('pause did not advance the binding generation')
    pause_replay = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/pause", 200,
                        body={'generation': '2'}, token=owner['accessToken'],
                        headers={'Idempotency-Key': pause_key})['data']
    if pause_replay['generation'] != '3':
        raise AssertionError('same-key pause did not return its original receipt')
    call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/pause", 409,
         body={'generation': '3'}, token=owner['accessToken'],
         headers={'Idempotency-Key': pause_key}, code='IDEMPOTENCY_KEY_REUSED')
    call('POST', sync_path, 409, body=sync_body, token=owner['accessToken'],
         headers=binding_headers(binding['id'], '2'), code='DEVICE_SYNC_BINDING_STALE')
    resumed = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/resume", 200,
                   body={'generation': '3', 'consentVersion': 'plan07-v2'}, token=owner['accessToken'],
                   headers={'Idempotency-Key': 'resume-' + suffix})['data']
    if resumed['status'] != 'active' or resumed['generation'] != '4' or resumed['consentVersion'] != 'plan07-v2':
        raise AssertionError('resume did not require renewed consent and advance generation')
    call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/pause", 409,
         body={'generation': '2'}, token=owner['accessToken'],
         headers={'Idempotency-Key': pause_key}, code='DEVICE_SYNC_ACTION_SUPERSEDED')
    revoke_key = 'revoke-' + suffix
    revoked = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/revoke", 200,
                   body={'generation': '4'}, token=owner['accessToken'],
                   headers={'Idempotency-Key': revoke_key})['data']
    if revoked['status'] != 'revoked' or revoked['generation'] != '5':
        raise AssertionError('revoke did not advance the generation and become terminal')
    revoke_replay = call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/revoke", 200,
                         body={'generation': '4'}, token=owner['accessToken'],
                         headers={'Idempotency-Key': revoke_key})['data']
    if revoke_replay['status'] != 'revoked' or revoke_replay['generation'] != '5':
        raise AssertionError('revoke receipt replay did not return the committed terminal state')
    call('POST', f"/api/v1/sync/device-bindings/{binding['id']}/revoke", 409,
         body={'generation': '5'}, token=owner['accessToken'],
         headers={'Idempotency-Key': revoke_key}, code='IDEMPOTENCY_KEY_REUSED')
    call('POST', sync_path, 409, body=sync_body, token=owner['accessToken'],
         headers=binding_headers(binding['id'], '4'), code='DEVICE_SYNC_BINDING_STALE')
    cases.append('pause/resume/revoke require idempotency receipts, explicit renewed consent, and monotonically reject every stale generation')

    # A command racing an active binding revoke may linearize before revoke or
    # be rejected after it, but cannot write after the revoked generation.
    race_binding = enroll(owner['accessToken'], 'test-race-install-' + suffix,
                          'test-race-vault-' + suffix)
    race_import_id, _ = create_plan(race_binding, [])
    race_binding = activate(race_binding, race_import_id, '1', 'race-activate-' + suffix)
    race_command = command('feeding', {'feedingType': 'formula',
                                       'occurredAt': '2025-01-05T10:00:00.000Z',
                                       'amountMl': '75', 'spitUp': False,
                                       'notes': 'command revoke race'})
    race_body = {'commands': [race_command]}
    race_headers = binding_headers(race_binding['id'], race_binding['generation'])
    race_gate = threading.Barrier(2)

    def race_sync():
        race_gate.wait(timeout=10)
        return stack.request('POST', sync_path, race_body, owner['accessToken'], extra_headers=race_headers)

    def race_revoke():
        race_gate.wait(timeout=10)
        return stack.request('POST', f"/api/v1/sync/device-bindings/{race_binding['id']}/revoke",
                             {'generation': race_binding['generation']}, owner['accessToken'],
                             extra_headers={'Idempotency-Key': 'race-revoke-' + suffix})

    with ThreadPoolExecutor(max_workers=2) as pool:
        sync_future = pool.submit(race_sync)
        revoke_future = pool.submit(race_revoke)
        sync_status, sync_payload = sync_future.result(timeout=30)
        revoke_status, revoke_payload = revoke_future.result(timeout=30)
    checks += 2
    if revoke_status != 200 or revoke_payload.get('data', {}).get('status') != 'revoked':
        raise AssertionError('concurrent revoke failed to commit its terminal binding state')
    race_after = call('GET', f"/api/v1/sync/device-bindings/{race_binding['id']}", 200,
                      token=owner['accessToken'])['data']
    if race_after['status'] != 'revoked':
        raise AssertionError('binding race left the binding active after revoke')
    race_result_status = None
    if sync_status == 200:
        race_results = sync_payload.get('data', {}).get('results', [])
        if len(race_results) != 1:
            raise AssertionError('command/revoke race returned a malformed result batch')
        race_result_status = race_results[0].get('status')
        if race_result_status not in ('applied', 'error'):
            raise AssertionError('command/revoke race returned an unexpected result')
        if race_result_status == 'error' and race_results[0].get('error', {}).get('code') != 'DEVICE_SYNC_BINDING_STALE':
            raise AssertionError('command race failed for a reason other than stale binding admission')
    elif sync_status != 409 or sync_payload.get('error', {}).get('code') != 'DEVICE_SYNC_BINDING_STALE':
        raise AssertionError('command/revoke race was neither admitted before revoke nor denied as stale')
    race_record_count = stack.sql(f"SELECT count(*) FROM feeding_records WHERE id='{race_command['entityId']}' AND baby_id='{baby_id}';")
    if (race_result_status == 'applied' and race_record_count != '1') or \
       (race_result_status != 'applied' and race_record_count != '0'):
        raise AssertionError('command/revoke race outcome did not match the single-transaction write result')
    cases.append('actual concurrent sync-command/revoke requests linearize to either one pre-revoke write or a stale denial; no post-revoke write occurs')

    report['assertionCount'] = checks
    report['cases'] = cases
    report['tenant'] = {'usersCreated': 3, 'allUsernamesUseTestPrefix': True,
                        'familyNameUsesTestPrefix': True, 'babyNameUsesTestPrefix': True,
                        'allBusinessWritesUsedHTTP': True, 'directSQLUsedOnlyForReadAssertions': True}
    report['recordCounts'] = {'importedEntityKinds': 6, 'firstImportChunkRows': 3,
                              'secondImportChunkRows': 3, 'replayedChunkDuplicates': 0,
                              'measuredFoodGrams': '32.5', 'foodWithoutFamilyProfileRejected': True,
                              'idConflictOverwrite': False, 'attachmentImported': False}
    report['deviceSyncGenerationExample'] = ['pending:1', 'active:2', 'paused:3', 'active:4', 'revoked:5']
    report['onlineRESTAdmission'] = 'not implemented by this change; existing generic REST routes remain unchanged'
    report['workerStarted'] = False
    report['databaseDiagnostics'] = []


def main() -> int:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    if EVIDENCE.exists():
        raise RuntimeError('Refusing to replace existing unique device sync evidence')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if head != BASE_COMMIT:
        raise RuntimeError('worktree is not at the reviewed fixed delivery; update the recorded source baseline before running')
    report = {'status': 'FAIL', 'scope': 'DeviceSyncBinding admission, approved first-import receipts, sync command lifecycle and isolation',
              'sourceBaseCommit': head, 'sourceFileHashes': {}, 'assertionCount': 0, 'cases': []}
    source_files = [
        'go.mod', 'go.sum', 'packages/contracts/src/sync.ts', 'packages/contracts/src/routes.ts',
        'scripts/contract-generator.mjs', 'contracts/openapi.json', 'prisma/schema.prisma',
        'prisma/migrations/202609210028_device_sync_binding/migration.sql',
        'packages/contracts/src/nutrition.ts', 'packages/contracts/src/records.ts',
        'internal/backend/nutrition_records.go', 'internal/backend/nutrition_profile.go',
        'internal/backend/device_sync_binding.go', 'internal/backend/sync_commands.go',
        'internal/backend/device_sync_binding_test.go',
        'internal/backend/record_mutation.go', 'internal/backend/register.go',
        'internal/backend/server.go', 'internal/backend/foundation_test.go',
        'internal/backend/native_sync_test.go', 'scripts/go-device-sync-binding-integration.py',
    ]
    for relative in source_files:
        path = ROOT / relative
        if path.is_file():
            report['sourceFileHashes'][relative] = digest(path.read_bytes())
    stack = None
    temp_root = Path(tempfile.mkdtemp(prefix='growdesk-device-sync-build-'))
    temp_root.chmod(0o700)
    try:
        binary, binary_hash = build_binary(temp_root)
        report['binarySha256'] = binary_hash
        stack = OwnedLocalStack(report)
        stack.start()
        stack.report['ownedEnvironment'].update({
            'tenantUsernamePrefix': 'test_device_sync_',
            'familyPrefix': 'test_family_device_sync_',
            'babyPrefix': 'test_baby_device_sync_',
        })
        stack.serve(binary)
        run_checks(stack, report)
        report['status'] = 'PASS'
    except BaseException as error:
        # The evidence deliberately omits URLs, IDs, tokens, passwords, SQL,
        # server payloads and compiler output.
        report['failureClass'] = type(error).__name__
        report['failureStage'] = 'isolated_http_protocol_checks'
        raise
    finally:
        if stack is not None:
            stack.close()
            report['cleanup'] = stack.cleanup
        shutil.rmtree(temp_root, ignore_errors=True)
        report['buildDirectoryRemoved'] = not temp_root.exists()
        report['evidenceRunId'] = RUN_ID
        report['finishedAtUtc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        report['cleanupPassed'] = bool(report.get('cleanup', {}).get('privateTempDirectoryRemoved') and
                                       report.get('cleanup', {}).get('apiStopped') and
                                       report.get('cleanup', {}).get('postgresStopped') and
                                       report.get('cleanup', {}).get('redisStopped') and
                                       report.get('cleanup', {}).get('minioStopped') and
                                       report.get('buildDirectoryRemoved'))
        descriptor = os.open(EVIDENCE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    if not report['cleanupPassed']:
        raise RuntimeError('owned isolated stack cleanup was incomplete')
    print(f"{report['status']} assertions={report['assertionCount']} evidence={EVIDENCE}")
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
