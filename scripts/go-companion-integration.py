#!/usr/bin/env python3
"""Companion API regression on real, exclusively owned PostgreSQL/Redis.

Runs identical scenarios against the native executable and optionally the frozen
TypeScript server. Never accepts a database URL, real identity, AI key or push
provider. Existing owned-environment guards and SQL migrations are reused.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('go_domain_harness', ROOT / 'scripts/go-domain-integration.py')
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('Missing owned integration harness')
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


def fixed(number):
    return f'a0000000-0000-4000-8000-{number:012d}'


class CompanionScenario(DOMAIN.Scenario):
    def __init__(self, owned, base):
        super().__init__(owned, base)
        self.durable_checks = []

    def normalize(self, value, key=''):
        if key == 'readAt' and isinstance(value, str):
            if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value):
                raise AssertionError('Noncanonical readAt')
            datetime.fromisoformat(value.replace('Z', '+00:00'))
            return '<generated-time>'
        return super().normalize(value, key)

    def observe(self, case, result, status=200):
        self.observations.append({'case': case, 'status': status, 'body': self.normalize(result)})

    def identity(self, label):
        data = self.call('POST', '/api/v1/auth/register', 201, {
            'username': 'test_go_companion_' + label,
            'password': 'test_companion_password_8675309', 'displayName': 'Test ' + label,
            'deviceLabel': 'test_companion'})['data']
        self.alias(data['user']['id'], label)
        return data['user']['id'], data['accessToken']

    def run(self, restart_base):
        uid, owner = self.identity('owner')
        oid, outsider = self.identity('outsider')
        vid, viewer = self.identity('viewer')
        family = self.call('POST', '/api/v1/families', 201,
                           {'name': 'Test Companion Family', 'timeZone': 'Asia/Tokyo'}, owner)['data']
        fid = self.alias(family['id'], 'family')
        baby = self.call('POST', f'/api/v1/families/{fid}/babies', 201,
                         {'name': 'Test Companion Baby', 'birthDate': '2026-01-02', 'gender': 'girl'}, owner)['data']
        bid = self.alias(baby['id'], 'baby')
        invite = self.call('POST', f'/api/v1/families/{fid}/invites', 201, {'expiresInDays': 1}, owner)['data']
        self.call('POST', '/api/v1/families/join', 200, {'inviteCode': invite['inviteCode']}, viewer)
        self.call('POST', f'/api/v1/babies/{bid}/members', 201, {'userId': vid, 'role': 'viewer'}, owner)
        # The read model allows a family viewer, but management mutations only
        # accept admin/member. Test that distinction, then seed a historical
        # read-only membership directly in this exclusively owned fixture DB.
        self.call('PATCH', f'/api/v1/families/{fid}/members/{vid}', 400, {'role': 'viewer'}, owner,
                  observe='family management does not accept viewer role mutation')
        self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE family_id='{fid}' AND user_id='{vid}';")
        assert self.owned.sql(f"SELECT role FROM family_members WHERE family_id='{fid}' AND user_id='{vid}';") == 'viewer'
        self.notifications(uid, owner, oid, outsider)
        voice_id = self.voice_logs(bid, uid, owner, outsider, viewer)
        formula_id = self.formulas(fid, owner, outsider, viewer)
        session_id = self.sessions(fid, bid, uid, owner, outsider, viewer)

        # Terminate the owned process, then use the new endpoint for all further
        # checks. Existing bearer credentials and state must survive that restart.
        self.base = restart_base()
        self.call('GET', f'/api/v1/voice/logs/{voice_id}', 200, token=owner, observe='voice survives process restart')
        self.call('GET', f'/api/v1/web/ai/sessions/{session_id}', 200, token=owner, observe='conversation survives process restart')
        self.call('GET', f'/api/v1/families/{fid}/nutrition/products?includeArchived=true', 200, token=owner,
                  observe='formula survives process restart')
        self.durable_checks.append('fresh process reads committed state with existing credentials')

        self.call('DELETE', f'/api/v1/babies/{bid}/members/{vid}', 200, token=owner)
        self.call('GET', '/api/v1/voice/logs', 200, token=viewer, observe='voice hidden after caregiver revocation')
        self.call('GET', '/api/v1/web/ai/sessions', 200, token=viewer, observe='conversation hidden after caregiver revocation')
        self.call('POST', '/api/v1/voice/logs', 403, {'babyId': bid, 'prompt': 'test_revoked', 'reply': 'test_revoked'}, viewer,
                  observe='revoked voice create denied')
        self.call('POST', '/api/v1/web/ai/sessions', 403, {'babyId': bid}, viewer, observe='revoked conversation create denied')
        self.durable_checks.append('revocation enforced for previously issued bearer tokens')
        return {'uid': uid, 'owner': owner, 'fid': fid, 'bid': bid,
                'voice_id': voice_id, 'formula_id': formula_id, 'session_id': session_id}

    def notifications(self, uid, owner, oid, outsider):
        self.call('GET', '/api/v1/notifications', 200, token=owner, observe='empty notifications')
        self.call('GET', '/api/v1/notifications', 401, observe='notifications require auth')
        for i in range(1, 5):
            identity = self.alias(fixed(i), 'notification_' + str(i))
            actor = uid if i < 4 else oid
            data = "NULL" if i == 1 else "'{}'::jsonb" if i == 2 else "'{\"type\":\"test\",\"count\":0}'::jsonb"
            self.owned.sql(f"INSERT INTO notifications(id,user_id,event_key,title,body,data,created_at) VALUES "
                           f"('{identity}','{actor}','test_event','Test notification','test_body',{data},'2026-08-01T00:00:00Z');")
        first = self.call('GET', '/api/v1/notifications?limit=2', 200, token=owner, observe='notification first keyset page')
        assert [r['id'] for r in first['data']] == [fixed(3), fixed(2)]
        cursor = first['page']['nextCursor']
        second = self.call('GET', '/api/v1/notifications?limit=2&cursor=' + cursor, 200, token=owner, observe='notification second keyset page')
        assert [r['id'] for r in second['data']] == [fixed(1)] and 'data' not in second['data'][0]
        assert second['page']['nextCursor'] is None
        self.call('GET', '/api/v1/notifications?cursor=invalid', 400, token=owner, observe='notification invalid cursor')
        self.call('POST', f'/api/v1/notifications/{fixed(3)}/read', 404, token=outsider, observe='notification cross-user read denied')
        self.call('POST', f'/api/v1/notifications/{fixed(3)}/read', 200, token=owner, observe='notification mark read')
        timestamp = self.owned.sql(f"SELECT read_at FROM notifications WHERE id='{fixed(3)}';")
        self.call('POST', f'/api/v1/notifications/{fixed(3)}/read', 200, token=owner, observe='notification repeated mark read')
        assert self.owned.sql(f"SELECT read_at FROM notifications WHERE id='{fixed(3)}';") == timestamp
        self.call('GET', '/api/v1/notifications?limit=1', 200, token=owner, observe='notification readAt projection')
        self.call('POST', f'/api/v1/notifications/{fixed(99)}/read', 404, token=owner, observe='notification missing read')
        path = f'/api/v1/devices/{fixed(20)}/push'
        self.call('PUT', path, 200, {'platform': 'web', 'environment': 'sandbox', 'token': 'test_push_a', 'deviceLabel': 'test_label'}, owner,
                  observe='register push device')
        self.call('PUT', path, 200, {'platform': 'ios', 'environment': 'sandbox', 'token': 'test_push_b'}, owner,
                  observe='replace push device')
        row = self.owned.sql(f"SELECT token,COALESCE(device_label,'NULL') FROM push_devices WHERE user_id='{uid}' AND installation_id='{fixed(20)}';")
        assert row == 'test_push_b|NULL'
        self.call('PUT', path, 200, {'platform': 'web', 'environment': 'sandbox', 'token': 'test_other'}, outsider)
        self.call('DELETE', path, 200, token=owner, observe='unregister push device')
        self.call('DELETE', path, 200, token=owner, observe='repeat unregister push device')
        assert self.owned.sql(f"SELECT count(*) FROM push_devices WHERE user_id='{oid}' AND installation_id='{fixed(20)}';") == '1'
        self.durable_checks.append('device upsert/delete isolated by user and notification first read preserved')
        print('PASS companion notifications and push device persistence', flush=True)

    def voice_logs(self, bid, uid, owner, outsider, viewer):
        path = '/api/v1/voice/logs'
        self.call('GET', path, 200, token=owner, observe='empty voice page')
        self.call('GET', path + '?unreadAsync=true', 200, token=owner, observe='empty unread voice is null')
        body = {'babyId': bid, 'prompt': 'test_prompt 中文', 'reply': 'test_reply'}
        result = self.call('POST', path, 201, body, owner)
        identity = self.alias(result['data']['id'], 'voice_sync')
        self.observe('create synchronous voice', result, 201)
        self.call('GET', path + '/' + identity, 200, token=owner, observe='get own voice')
        self.call('GET', path + '/' + identity, 404, token=outsider, observe='cross-user voice hidden')
        self.call('PATCH', path + '/' + identity, 404, {'acknowledged': True}, outsider, observe='cross-user voice acknowledgement denied')
        async_result = self.call('POST', path, 201, {**body, 'isAsync': True, 'isFastPath': True}, owner)
        async_id = self.alias(async_result['data']['id'], 'voice_async')
        self.observe('create asynchronous voice', async_result, 201)
        unread = self.call('GET', path + '?unreadAsync=true', 200, token=owner, observe='unread voice returns object')
        assert unread['data']['id'] == async_id and 'page' not in unread
        self.call('PATCH', path + '/' + async_id, 200, {'acknowledged': True}, owner, observe='acknowledge voice')
        self.call('GET', path + '?unreadAsync=true', 200, token=owner, observe='acknowledged voice excluded')
        self.call('PATCH', path + '/' + async_id, 200, {'acknowledged': False}, owner, observe='unacknowledge voice')
        self.owned.sql(f"UPDATE agent_voice_logs SET created_at=NOW()-INTERVAL '25 hours' WHERE id='{async_id}';")
        assert self.call('GET', path + '?unreadAsync=true', 200, token=owner, observe='expired unread window')['data'] is None
        self.owned.sql(f"UPDATE agent_voice_logs SET created_at='2026-08-02T00:00:00Z' WHERE id='{identity}';")
        self.call('GET', path + '?limit=1', 200, token=owner, observe='voice bounded page')
        self.call('GET', path + '?limit=51', 400, token=owner, observe='voice limit validation')
        viewer_result = self.call('POST', path, 201, {**body, 'isAsync': True}, viewer)
        self.alias(viewer_result['data']['id'], 'viewer_voice')
        self.observe('viewer may save private voice history', viewer_result, 201)
        self.call('POST', path, 403, body, outsider, observe='unrelated voice create denied')
        assert self.owned.sql(f"SELECT count(*) FROM agent_voice_logs WHERE user_id='{uid}';") == '2'
        self.durable_checks.append('voice unread window, ownership and acknowledgement persisted')
        print('PASS companion voice history', flush=True)
        return identity

    def formulas(self, fid, owner, outsider, viewer):
        path = f'/api/v1/families/{fid}/nutrition/products'
        self.call('GET', path, 200, token=owner, observe='empty formula catalog')
        result = self.call('POST', path, 201, {'brand': 'test_brand', 'name': 'test_formula', 'stage': '1',
                           'scoopGrams': '4.50000', 'waterMlPerScoop': '30.00000'}, owner)
        identity = self.alias(result['data']['id'], 'formula_one')
        assert result['data']['scoopGrams'] == '4.5' and result['data']['waterMlPerScoop'] == '30'
        self.observe('create decimal formula', result, 201)
        second = self.call('POST', path, 201, {'brand': 'test_brand', 'name': 'test_minimal'}, owner)
        second_id = self.alias(second['data']['id'], 'formula_two')
        self.observe('create minimal formula with nulls', second, 201)
        self.owned.sql(f"UPDATE formula_products SET created_at='2026-08-01T00:00:00Z' WHERE id='{identity}';"
                       f"UPDATE formula_products SET created_at='2026-08-02T00:00:00Z' WHERE id='{second_id}';")
        first = self.call('GET', path + '?limit=1', 200, token=owner, observe='formula first page')
        assert first['data'][0]['id'] == second_id
        tail = self.call('GET', path + '?limit=1&cursor=' + first['page']['nextCursor'], 200, token=owner, observe='formula second page')
        assert tail['data'][0]['id'] == identity and tail['page']['nextCursor'] is None
        self.call('GET', path + '?cursor=invalid', 400, token=owner, observe='formula invalid cursor')
        patched = self.call('PATCH', path + '/' + identity, 200,
                            {'stage': None, 'scoopGrams': '0', 'waterMlPerScoop': None}, owner, observe='formula zero versus null patch')
        assert patched['data']['scoopGrams'] == '0' and patched['data']['waterMlPerScoop'] is None
        self.call('PATCH', path + '/' + identity, 200, {}, owner, observe='formula empty patch preserves fields')
        self.call('PATCH', path + '/' + identity, 200, {'isArchived': True}, owner, observe='archive formula')
        visible = self.call('GET', path, 200, token=viewer, observe='viewer reads active formula catalog')
        assert [r['id'] for r in visible['data']] == [second_id]
        self.call('GET', path + '?includeArchived=true', 200, token=owner, observe='include archived formula')
        self.call('POST', path, 403, {'brand': 'test', 'name': 'test'}, viewer, observe='viewer formula write denied')
        self.call('GET', path, 403, token=outsider, observe='formula cross-family list denied')
        self.call('PATCH', path + '/' + identity, 403, {'name': 'test_attack'}, outsider, observe='formula cross-family update denied')
        self.call('DELETE', path + '/' + second_id, 200, token=owner, observe='delete formula')
        self.call('DELETE', path + '/' + second_id, 404, token=owner, observe='repeat formula delete not found')
        self.call('PATCH', path + '/' + second_id, 404, {'name': 'test_gone'}, owner, observe='deleted formula cannot be edited')
        assert self.owned.sql(f"SELECT is_archived,deleted_at IS NOT NULL FROM formula_products WHERE id='{second_id}';") == 't|t'
        assert self.owned.sql(f"SELECT version FROM formula_products WHERE id='{identity}';") == '1'
        self.owned.sql(f"UPDATE formula_products SET notes='test_historical_metadata',nutrients_json='{{\"iron\":1.2}}',"
                       f"reconstitution_ratio=13.00000 WHERE id='{identity}';")
        self.call('GET', path + '?includeArchived=true', 200, token=owner, observe='read historical formula metadata')
        self.durable_checks.append('formula decimal/null, archive, soft-delete and reference version semantics')
        print('PASS companion formula catalog', flush=True)
        return identity

    def sessions(self, fid, bid, uid, owner, outsider, viewer):
        path = '/api/v1/web/ai/sessions'
        self.call('GET', path, 200, token=owner, observe='empty conversation page')
        result = self.call('POST', path, 201, {'title': '  test_conversation  ', 'contextType': ' general '}, owner)
        identity = self.alias(result['data']['id'], 'session_private')
        self.observe('create private conversation', result, 201)
        assert result['data']['title'] == 'test_conversation' and result['data']['babyId'] is None
        item = path + '/' + identity
        self.call('GET', item, 200, token=owner, observe='get empty conversation')
        for method, body in [('GET', None), ('PATCH', {'title': 'test_attack'}), ('DELETE', None)]:
            self.call(method, item, 404, body, outsider, observe=method + ' conversation cross-user hidden')
        scoped = self.call('POST', path, 201, {'babyId': bid, 'title': ' ', 'contextType': 'test_baby'}, owner)
        scoped_id = self.alias(scoped['data']['id'], 'session_baby')
        self.observe('create baby conversation defaults', scoped, 201)
        self.call('POST', path, 403, {'babyId': bid}, outsider, observe='conversation unrelated baby denied')
        viewed = self.call('POST', path, 201, {'babyId': bid}, viewer)
        self.alias(viewed['data']['id'], 'session_viewer')
        self.observe('viewer saves own conversation', viewed, 201)
        body = {'id': fixed(40), 'role': 'user', 'content': 'test 中文 😀\u2028<&>', 'toolsJson': '{}'}
        self.alias(body['id'], 'message_one')
        first = self.call('POST', item + '/messages', 201, body, owner, observe='append conversation message')
        clock = self.owned.sql(f"SELECT updated_at FROM ai_sessions WHERE id='{identity}';")
        repeated = self.call('POST', item + '/messages', 201, body, owner, observe='replay identical conversation message')
        assert repeated == first and self.owned.sql(f"SELECT updated_at FROM ai_sessions WHERE id='{identity}';") == clock
        self.call('POST', item + '/messages', 409, {**body, 'content': 'test_changed'}, owner, observe='changed message ID conflicts')
        self.call('POST', path + '/' + scoped_id + '/messages', 409, body, owner, observe='message ID belongs to one session')
        self.call('POST', item + '/messages', 404, body, outsider, observe='message cross-user append denied')
        long_body = {'id': fixed(41), 'role': 'assistant', 'content': '测' * 5000, 'image': 'data:image/png;base64,dGVzdA==', 'toolsJson': '{"test":true}'}
        self.alias(long_body['id'], 'message_long')
        long_result = self.call('POST', item + '/messages', 201, long_body, owner)
        assert long_result['data']['content'] == long_body['content']
        full = self.call('GET', item, 200, token=owner, observe='complete conversation history')
        assert full['data']['messageCount'] == 2 and len(full['data']['messages']) == 2
        assert [r['id'] for r in full['data']['messages']] == [fixed(40), fixed(41)]
        assert full['data']['messages'][0]['createdAt'] < full['data']['messages'][1]['createdAt']
        with ThreadPoolExecutor(max_workers=6) as pool:
            replies = list(pool.map(lambda _: TOOLS.expect(self.base, 'POST', item + '/messages', 201, long_body, owner), range(6)))
        assert all(value == long_result for value in replies)
        assert self.owned.sql(f"SELECT count(*) FROM ai_messages WHERE session_id='{identity}';") == '2'
        self.owned.sql(f"UPDATE ai_sessions SET updated_at='2026-08-02T00:00:00Z' WHERE id='{identity}';"
                       f"UPDATE ai_sessions SET updated_at='2026-08-01T00:00:00Z' WHERE id='{scoped_id}';")
        listing = self.call('GET', path + '?limit=1', 200, token=owner, observe='bounded conversation summary')
        summary = listing['data']['sessions'][0]
        assert listing['data']['total'] == 2 and summary['messages'] == [] and summary['messageCount'] == 2
        assert summary['lastMessage']['content'] == '测' * 4096
        assert summary['lastMessage']['image'] is None and summary['lastMessage']['toolsJson'] is None
        self.call('GET', path + '?limit=1&offset=1', 200, token=owner, observe='conversation offset page')
        self.call('GET', path + '?babyId=' + bid, 200, token=owner, observe='conversation baby filter')
        self.call('GET', path + '?contextType=general', 200, token=owner, observe='conversation context filter')
        self.call('GET', path + '?limit=101', 400, token=owner, observe='conversation limit validation')
        self.call('PATCH', item, 200, {'title': '  test_renamed  '}, owner, observe='rename metadata does not return history')
        assert self.call('GET', item, 200, token=owner)['data']['messageCount'] == 2
        image_body = {'id': fixed(42), 'role': 'user', 'content': 'test_image', 'image': '/api/attachments/' + fixed(60)}
        self.call('POST', path + '/' + scoped_id + '/messages', 409, image_body, owner, observe='missing protected AI image denied')
        self.owned.sql(f"INSERT INTO attachments(id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at) "
                       f"VALUES('{fixed(60)}','{fid}','{bid}','{uid}','ai_input','image/png',1,'{'a'*64}','test_companion/image','ready',NOW()+INTERVAL '1 day');")
        self.alias(image_body['id'], 'message_image')
        self.call('POST', item + '/messages', 409, image_body, owner, observe='protected image wrong conversation scope denied')
        self.call('POST', path + '/' + scoped_id + '/messages', 201, image_body, owner, observe='authorized protected image reference')

        self.owned.sql(f"CREATE FUNCTION test_companion_fail_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                       f"IF NEW.id='{identity}' THEN RAISE EXCEPTION 'test_companion_rollback'; END IF; RETURN NEW; END $$;"
                       "CREATE TRIGGER test_companion_parent BEFORE UPDATE ON ai_sessions FOR EACH ROW EXECUTE FUNCTION test_companion_fail_parent();")
        rollback_body = {'id': fixed(43), 'role': 'user', 'content': 'test_atomic'}
        self.call('POST', item + '/messages', 500, rollback_body, owner)
        assert self.owned.sql(f"SELECT count(*) FROM ai_messages WHERE id='{fixed(43)}';") == '0'
        self.owned.sql('DROP TRIGGER test_companion_parent ON ai_sessions; DROP FUNCTION test_companion_fail_parent();')
        self.alias(rollback_body['id'], 'message_atomic')
        self.call('POST', item + '/messages', 201, rollback_body, owner, observe='append after rollback recovers cleanly')

        self.owned.sql(f"INSERT INTO task_executions(id,kind,owner_scope,status,updated_at) VALUES "
                       f"('{fixed(70)}','ai_chat_run','test_companion','queued',NOW());"
                       f"INSERT INTO ai_runs(id,session_id,user_id,baby_id) VALUES('{fixed(70)}','{scoped_id}','{uid}','{bid}');")
        self.call('DELETE', path + '/' + scoped_id, 409, token=owner, observe='active AI run blocks conversation deletion')
        self.owned.sql(f"UPDATE task_executions SET status='cancelled' WHERE id='{fixed(70)}';")
        self.call('DELETE', path + '/' + scoped_id, 200, token=owner, observe='inactive conversation deletion')
        assert self.owned.sql(f"SELECT count(*) FROM ai_messages WHERE session_id='{scoped_id}';") == '0'
        self.call('GET', path + '/' + scoped_id, 404, token=owner, observe='deleted conversation hidden')
        large = self.call('POST', path, 201, {'title': 'test_history_limits'}, owner)['data']['id']
        self.owned.sql(f"INSERT INTO ai_messages(id,session_id,role,content) SELECT md5('test_companion_limit_'||n::text)::uuid::text,"
                       f"'{large}','user','test' FROM generate_series(1,5000) n;")
        self.call('POST', path + '/' + large + '/messages', 413, {'id': fixed(80), 'role': 'user', 'content': 'test_limit'}, owner,
                  observe='message count limit fails without truncation')
        self.owned.sql(f"INSERT INTO ai_messages(id,session_id,role,content) VALUES('{fixed(81)}','{large}','user','test');")
        self.call('GET', path + '/' + large, 413, token=owner, observe='oversized history is not truncated')
        assert self.owned.sql(f"SELECT count(*) FROM ai_messages WHERE session_id='{large}';") == '5001'
        self.call('DELETE', path + '/' + large, 200, token=owner)
        self.durable_checks.extend(['concurrent message replay creates one row', 'parent update failure rolls back message insert',
                                    'history limit preserves stored messages', 'active task blocks conversation deletion'])
        print('PASS companion transactional AI conversation history', flush=True)
        return identity

    def interoperate(self, native_base, result):
        owner, item = result['owner'], '/api/v1/web/ai/sessions/' + result['session_id']
        before = self.call('GET', item, 200, token=owner)
        assert TOOLS.expect(native_base, 'GET', item, 200, token=owner) == before
        body = {'id': fixed(90), 'role': 'user', 'content': 'test_cross_runtime_append'}
        written = TOOLS.expect(native_base, 'POST', item + '/messages', 201, body, owner)
        assert self.call('POST', item + '/messages', 201, body, owner) == written
        assert self.call('GET', item, 200, token=owner) == TOOLS.expect(native_base, 'GET', item, 200, token=owner)
        vp = '/api/v1/voice/logs/' + result['voice_id']
        assert self.call('GET', vp, 200, token=owner) == TOOLS.expect(native_base, 'GET', vp, 200, token=owner)
        TOOLS.expect(native_base, 'PATCH', vp, 200, {'acknowledged': True}, owner)
        assert self.call('GET', vp, 200, token=owner)['data']['acknowledged'] is True
        fp = f"/api/v1/families/{result['fid']}/nutrition/products"
        TOOLS.expect(native_base, 'PATCH', fp + '/' + result['formula_id'], 200, {'scoopGrams': '3.25'}, owner)
        assert self.call('GET', fp + '?includeArchived=true', 200, token=owner) == TOOLS.expect(native_base, 'GET', fp + '?includeArchived=true', 200, token=owner)
        first = self.call('GET', '/api/v1/notifications?limit=1', 200, token=owner)
        assert first == TOOLS.expect(native_base, 'GET', '/api/v1/notifications?limit=1', 200, token=owner)
        cursor = first['page']['nextCursor']
        assert self.call('GET', '/api/v1/notifications?limit=1&cursor=' + cursor, 200, token=owner) == TOOLS.expect(native_base, 'GET', '/api/v1/notifications?limit=1&cursor=' + cursor, 200, token=owner)
        self.durable_checks.append('reference bearer, messages, cursors, voice and formula interoperate on the same isolated database')
        print('PASS reference/native cross-runtime committed-state interoperability', flush=True)


def execute(binary, reference):
    owned = TOOLS.OwnedEnvironment()
    try:
        owned.start()
        start = (lambda: DOMAIN.serve_reference(owned)) if reference else (lambda: owned.serve(binary))
        scenario = CompanionScenario(owned, start())
        def restart():
            proc = owned.processes[-1]
            proc.terminate()
            proc.wait(timeout=10)
            return start()
        result = scenario.run(restart)
        if reference:
            scenario.interoperate(owned.serve(binary), result)
        return {'calls': scenario.calls, 'observations': scenario.observations, 'durableChecks': scenario.durable_checks}
    finally:
        owned.close()


def main():
    if not __debug__:
        raise RuntimeError('Assertions must remain enabled; do not use python -O')
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.binary.is_file():
        raise RuntimeError('Native executable does not exist')
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    report = {'passed': False, 'referenceRequested': args.reference,
              'sourceGitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}
    try:
        native = execute(args.binary, False)
        report['native'] = native
        if args.reference:
            reference = execute(args.binary, True)
            report['reference'] = reference
            if native['observations'] != reference['observations']:
                for left, right in zip(native['observations'], reference['observations']):
                    if left != right:
                        report['firstDifference'] = {'native': left, 'reference': right}
                        raise AssertionError('HTTP parity mismatch: ' + left['case'])
                raise AssertionError('Different observation counts')
            report['matchedObservations'] = len(native['observations'])
        report['passed'] = True
        print('PASS companion integration; HTTP observations:', len(native['observations']), flush=True)
    except BaseException as error:
        report['failure'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
