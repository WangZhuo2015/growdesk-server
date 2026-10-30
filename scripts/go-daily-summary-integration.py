#!/usr/bin/env python3
"""Durable scheduled daily summaries on owned PostgreSQL/Redis and local AMD stub."""
from __future__ import annotations
import contextlib
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('owned_go_tests', ROOT / 'scripts/go-integration.py')
assert SPEC and SPEC.loader
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)
OwnedEnvironment, expect = TOOLS.OwnedEnvironment, TOOLS.expect

VIRTUAL_KEY = 'test_virtual_daily_summary_amd_key'

class AMDStub(BaseHTTPRequestHandler):
    state = {'status': 429, 'requests': 0, 'errors': []}
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        request = json.loads(self.rfile.read(length))
        with self.lock:
            self.state['requests'] += 1
            if self.path != '/chat/completions':
                self.state['errors'].append('unexpected_path')
            authorized = self.headers.get('Authorization') == 'Bearer ' + VIRTUAL_KEY
            if not authorized:
                self.state.setdefault('auth_failures', 0)
                self.state['auth_failures'] += 1
            if request.get('model') != 'DeepSeek-V4.1-Flash' or request.get('stream') is not True:
                self.state['errors'].append('unexpected_request_schema')
            system = request.get('messages', [{}])[0].get('content', '')
            if 'suggestedQuestions' not in system or 'metrics' not in system:
                self.state['errors'].append('missing_report_contract')
            metadata = request.get('metadata', {})
            if not metadata or set(metadata) != {'sessionId', 'babyId'} or not all(isinstance(value, str) and value for value in metadata.values()):
                self.state['errors'].append('invalid_metadata')
            status = 401 if not authorized else self.state['status']
        if status == 401:
            body = b'{"error":{"message":"test virtual key rejected"}}'
            self.send_response(status)
        elif status == 429:
            body = b'{"error":{"message":"test throttle"}}'
            self.send_response(status)
            self.send_header('Retry-After', '20')
        else:
            report = {
                'overallScore': '记录平稳', 'overallRating': 4.2, 'statusLevel': 'good',
                'headline': '今天的记录已整理。',
                'highlights': ['已有喂养记录', '已有睡眠记录'],
                'sections': {
                    'feeding': '按已有喂养记录整理。', 'sleep': '按已有睡眠记录整理。',
                    'diaper': '按已有尿布记录整理。', 'growthAndCare': '只总结现有护理记录。',
                    'tomorrowTips': '根据宝宝状态继续观察。',
                },
                'suggestedQuestions': ['问题一？', '问题二？', '问题三？'],
                'disclaimer': '仅供日常照护参考，不构成医疗诊断。',
            }
            payload = {'model': 'DeepSeek-V4.1-Flash', 'choices': [
                {'message': {'role': 'assistant', 'content': json.dumps(report, ensure_ascii=False, separators=(',', ':'))}, 'finish_reason': 'stop'}
            ], 'usage': {'prompt_tokens': 200, 'completion_tokens': 100, 'total_tokens': 300}}
            body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
            self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def invoke(binary: Path, mode: str, env: dict[str, str]):
    if mode == 'scheduler':
        args = [str(binary.resolve()), '--once']
    elif mode == 'worker':
        args = [str(binary.resolve()), '--worker', '--once']
    else:
        args = [str(binary.resolve()), '--once']
    result = subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
    if result.returncode != 0:
        # Do not surface process environment or provider request data in assertion output.
        raise AssertionError(f'daily {mode} exited {result.returncode}')


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--api-binary', type=Path, required=True)
    parser.add_argument('--daily-binary', type=Path, required=True)
    parser.add_argument('--worker-binary', type=Path, required=True)
    args = parser.parse_args()
    owned = OwnedEnvironment()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), AMDStub)
    provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    try:
        owned.start()
        base = owned.serve(args.api_binary)
        owner = expect(base, 'POST', '/api/v1/auth/register', 201, {
            'username': 'test_daily_summary_' + owned.owner,
            'password': 'test_password_' + owned.owner,
            'displayName': 'Test Daily Summary', 'deviceLabel': 'test_daily_summary',
        })['data']
        token = owner['accessToken']
        family = expect(base, 'POST', '/api/v1/families', 201, {'name': 'Test Daily Family', 'timeZone': 'UTC'}, token)['data']
        babies = []
        for name in ('Test Daily Baby A', 'Test Daily Baby B'):
            baby = expect(base, 'POST', f"/api/v1/families/{family['id']}/babies", 201, {
                'name': name, 'birthDate': '2026-10-01', 'gender': 'girl',
                'gestationalWeeks': 36, 'gestationalDays': 3,
            }, token)['data']
            babies.append(baby['id'])

        env = {**owned.env,
               'GROWDESK_DAILY_SUMMARY_API_KEY': VIRTUAL_KEY,
               'GROWDESK_DAILY_SUMMARY_BASE_URL': f'http://127.0.0.1:{provider.server_port}',
               'GROWDESK_DAILY_SUMMARY_TIMEOUT_MS': '5000'}

        # Two concurrent scheduler processes exercise the family lock and stable receipt.
        errors = []
        def invoke_scheduler():
            try:
                invoke(args.daily_binary, 'scheduler', env)
            except Exception as error:
                errors.append(error)
                raise
        threads = [threading.Thread(target=invoke_scheduler) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if errors:
            raise AssertionError('concurrent scheduler invocation failed') from errors[0]
        task_rows = owned.sql(f"""SELECT count(*) FROM task_executions t
            JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}';""")
        assert task_rows == '2', 'concurrent scheduler passes must create one job per baby/date'

        targets = owned.sql(f"""SELECT string_agg(o.payload->'__native'->>'targetDate', ',' ORDER BY b.id)
            FROM babies b JOIN task_outbox o ON o.payload->'__native'->>'babyId'=b.id
            JOIN task_executions t ON t.id=o.aggregate_id AND t.kind='daily_summary_synthesis'
            WHERE b.id IN ('{babies[0]}','{babies[1]}') AND o.payload->'__native'->>'scheduled'='true';""")
        assert targets.count(',') == 1, 'scheduler must enqueue one completed-local-day date per baby'

        # Insert both an ordinary interactive daily task and an unrelated chat task.
        fake_chat = '00000000-0000-4000-8000-0000000000a1'
        fake_interactive = '00000000-0000-4000-8000-0000000000a2'
        payload = json.dumps({'__native': {'version': 1, 'userId': owner['user']['id'],
                            'familyId': family['id'], 'babyId': babies[0],
                            'targetDate': targets.split(',')[0]}}, separators=(',', ':'))
        for identity, kind in ((fake_chat, 'ai_chat_run'), (fake_interactive, 'daily_summary_synthesis')):
            escaped = payload.replace("'", "''")
            owned.sql(f"""INSERT INTO task_executions(id,kind,owner_scope,status,attempt,max_attempts,fence_token,next_event_seq,created_at,updated_at)
                VALUES('{identity}','{kind}','user:{owner['user']['id']}','queued',0,3,0,0,NOW(),NOW());
                INSERT INTO task_outbox(id,type,aggregate_id,payload_version,payload,phase_key,dispatch_state,next_dispatch_at,created_at)
                VALUES('{identity}-outbox','{kind}','{identity}',1,'{escaped}'::jsonb,'native-initial','active',NOW(),NOW());""")

        # Fail each scheduled job once. Retry-After must be persisted and the first
        # throttled baby must not block a second eligible baby.
        invoke(args.daily_binary, 'worker', env)
        invoke(args.daily_binary, 'worker', env)
        failed = owned.sql(f"""SELECT string_agg(t.status||':'||t.attempt::text, ',' ORDER BY t.created_at,t.id)
            FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}';""")
        assert failed == 'queued:2,queued:2', '429 should persist retries for both due summaries'
        delay = float(owned.sql(f"""SELECT EXTRACT(EPOCH FROM (MIN(o.next_dispatch_at)-clock_timestamp()))
            FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}';"""))
        assert 18.0 <= delay <= 20.5, f'429 Retry-After was not honored: {delay}'

        # Cross the old three-attempt boundary and prove the retained queue remains retryable.
        first_id = owned.sql(f"""SELECT t.id FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}' ORDER BY t.created_at,t.id LIMIT 1;""")
        owned.sql(f"""UPDATE task_executions SET attempt=4 WHERE id='{first_id}';
            UPDATE task_outbox SET next_dispatch_at=NOW() WHERE aggregate_id='{first_id}';""")
        invoke(args.worker_binary, 'general-worker', env)
        generic_filter = owned.sql(f"SELECT attempt||':'||status FROM task_executions WHERE id='{first_id}';")
        assert generic_filter == '4:queued', 'general worker claimed a scheduled AMD daily task'
        invoke(args.daily_binary, 'worker', env)
        attempt = owned.sql(f"SELECT attempt||':'||status FROM task_executions WHERE id='{first_id}';")
        assert attempt == '5:queued', 'scheduled daily retry must continue after max_attempts'

        # An invalid provider key must not exhaust the task or retry quickly.
        # Replacing the key later resumes the same retained task/date.
        bad_key_env = {**env, 'GROWDESK_DAILY_SUMMARY_API_KEY': 'test_virtual_bad_amd_key'}
        owned.sql(f"UPDATE task_outbox SET next_dispatch_at=NOW() WHERE aggregate_id='{first_id}';")
        invoke(args.daily_binary, 'worker', bad_key_env)
        after_auth = owned.sql(f"SELECT attempt||':'||status FROM task_executions WHERE id='{first_id}';")
        assert after_auth == '6:queued', 'provider key rejection must keep the same scheduled task queued: ' + after_auth
        auth_delay = float(owned.sql(f"SELECT EXTRACT(EPOCH FROM (o.next_dispatch_at-clock_timestamp())) FROM task_outbox o WHERE o.aggregate_id='{first_id}';"))
        assert 599.0 <= auth_delay <= 660.5, f'provider auth retry must wait 10 to 11 minutes: {auth_delay}'
        with AMDStub.lock:
            AMDStub.state['status'] = 200
        owned.sql(f"UPDATE task_outbox SET next_dispatch_at=NOW() WHERE aggregate_id='{first_id}';")
        invoke(args.daily_binary, 'worker', env)
        repaired = owned.sql(f"SELECT attempt||':'||status FROM task_executions WHERE id='{first_id}';")
        assert repaired == '6:succeeded', 'corrected credentials must resume the same retained task: ' + repaired
        owned.sql(f"""UPDATE task_outbox SET next_dispatch_at=NOW()
            WHERE aggregate_id IN (SELECT t.id FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id
                WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
                  AND o.payload->'__native'->>'familyId'='{family['id']}' AND t.status='queued');""")
        invoke(args.daily_binary, 'worker', env)
        summaries = owned.sql(f"""SELECT count(*) FROM daily_summaries d
            WHERE d.family_id='{family['id']}' AND d.baby_id IN ('{babies[0]}','{babies[1]}')
              AND d.content::jsonb->>'kind'='scheduled_daily_summary'
              AND d.content::jsonb->>'schemaVersion'='1'
              AND d.content::jsonb ? 'overallRating'
              AND NOT (d.content::jsonb ? 'rating')
              AND d.content::jsonb->'llm'->>'model'='DeepSeek-V4.1-Flash';""")
        assert summaries == '2', 'successful reports must persist with the server-owned schema and AMD model'
        deltas = owned.sql(f"""SELECT count(*) FROM ai_run_events e
            JOIN task_executions t ON t.id=e.run_id
            JOIN task_outbox o ON o.aggregate_id=t.id AND o.phase_key='native-initial'
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}' AND e.event_type='text_delta';""")
        assert deltas == '0', 'partial structured JSON leaked into scheduled run text events'
        untouched = owned.sql(f"SELECT status FROM task_executions WHERE id IN ('{fake_chat}','{fake_interactive}') ORDER BY id;")
        assert untouched == 'failed\nqueued', 'worker task-kind isolation did not hold'
        with AMDStub.lock:
            assert not AMDStub.state['errors'], 'local AMD stub received an invalid request: ' + ','.join(AMDStub.state['errors'])
            assert AMDStub.state.get('auth_failures', 0) == 1, 'expected one virtual provider key failure'

        # A completed local date never creates another task on a later same-day pass.
        invoke(args.daily_binary, 'scheduler', env)
        final_tasks = owned.sql(f"""SELECT count(*) FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id
            WHERE t.kind='daily_summary_synthesis' AND o.payload->'__native'->>'scheduled'='true'
              AND o.payload->'__native'->>'familyId'='{family['id']}';""")
        assert final_tasks == '2', 'successful daily summaries must not be enqueued again'
        print('PASS owned daily scheduler idempotency, AMD-only worker filter, Retry-After, unlimited retry, and report persistence', flush=True)
    finally:
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=2)
        owned.close()


if __name__ == '__main__':
    main()
