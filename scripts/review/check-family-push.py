#!/usr/bin/env python3
"""Real HTTP/PG/native-worker acceptance with an exclusively owned push fixture.

Only the external push provider is simulated. Authorization, mutations,
idempotency, task ownership, leasing and transactions execute actual Go code.
Production environment files are never loaded. A baseline failure exits 1.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TASK_ID = "PUSH_COPY_READABLE_20261007"
ROOT = Path(__file__).resolve().parents[2]
KIND = "family_record_notification"


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def parse_db_time(value):
    value = re.sub(r"\.(\d{1,5})(?=(?:[+-]\d{2}:\d{2}|Z)$)", lambda match: "." + match.group(1).ljust(6, "0"), value)
    return dt.datetime.fromisoformat(value)


class PushFixture:
    def __init__(self):
        self.requests = []
        self.statuses = {}
        self.lock = threading.Lock()
        self.decrypt_config = None
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                self.connection.settimeout(5)
                size = int(self.headers.get("Content-Length", "0"))
                if not self.path.startswith("/test_") or size <= 0 or size > 8192:
                    self.send_error(400)
                    return
                body = self.rfile.read(size)
                valid = (len(body) == size and self.headers.get("Content-Encoding") == "aes128gcm"
                         and self.headers.get("Authorization", "").startswith("vapid "))
                payload = fixture.inspect_payload(body) if valid else None
                valid = valid and payload is not None
                with fixture.lock:
                    status = fixture.statuses.get(self.path, 201) if valid else 400
                    fixture.requests.append({"path": self.path, "bytes": size, "encrypted": valid,
                                             "topic": self.headers.get("Topic"), "status": status,
                                             "payload": payload})
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        assert self.port not in (3088, 3089, 5432, 6379)
        self.origin = "http://127.0.0.1:" + str(self.port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def count(self, path=None):
        with self.lock:
            return len([r for r in self.requests if path is None or r["path"] == path])

    def inspect_payload(self, body):
        # Decrypt only with this run's generated receiver key. Persist booleans
        # and public event metadata, never ciphertext, auth or private records.
        if self.decrypt_config is None:
            return None
        runtime, keys = self.decrypt_config
        script = r"""
          import {createECDH, createDecipheriv, hkdfSync} from 'node:crypto';
          let raw=''; for await (const chunk of process.stdin) raw += chunk;
          const input=JSON.parse(raw), b=Buffer.from(input.body,'base64');
          const salt=b.subarray(0,16), size=b.readUInt32BE(16), n=b[20];
          if(size!==4096 || n!==65 || b.length!==4096) process.exit(1);
          const server=b.subarray(21,21+n), ciphertext=b.subarray(21+n);
          const receiver=createECDH('prime256v1');
          receiver.setPrivateKey(Buffer.from(input.receiverPrivate,'base64url'));
          const shared=receiver.computeSecret(server);
          const info=Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),server]);
          const ikm=hkdfSync('sha256',shared,Buffer.from(input.auth,'base64url'),info,32);
          const key=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16);
          const nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
          const decipher=createDecipheriv('aes-128-gcm',key,nonce);
          decipher.setAuthTag(ciphertext.subarray(-16));
          const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);
          let end=plain.length-1; while(end>=0 && plain[end]===0) end--;
          if(plain[end]!==2) process.exit(1);
          const json=plain.subarray(0,end).toString('utf8');
          const payload=JSON.parse(json);
          const allowed=['eventKind','familyId','babyId','actorId','entityType','entityId','operation','recordVersion','eventKey','url'];
          const privateFree=Object.keys(payload.data).every(k=>allowed.includes(k));
          process.stdout.write(JSON.stringify({decrypted:true,privacySafe:privateFree,
            title:payload.title,body:payload.body,wireBytes:Buffer.byteLength(json,'utf8'),
            url:payload.url,data:payload.data,tag:payload.tag}));
        """
        try:
            value = runtime.command(["node", "--input-type=module", "-e", script], env=runtime.clean_env(),
                                    input_text=json.dumps({"body": base64.b64encode(body).decode(),
                                        "receiverPrivate": keys["receiverPrivate"], "auth": keys["subscriptionKeys"]["auth"]}), timeout=5)
            return json.loads(value)
        except Exception:
            return None

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        assert not self.thread.is_alive(), "owned_push_fixture_not_stopped"


class Journey:
    def __init__(self, runtime, runner, fixture, worker, environment, report, ai_empty_replay_status=409):
        self.runtime, self.runner, self.fixture = runtime, runner, fixture
        self.worker, self.environment, self.report = worker, environment, report
        self.ai_empty_replay_status = ai_empty_replay_status
        self.prefix = "test_family_push_" + runner.run_id
        self.http = runtime.Smoke(runner.api_url, runner.run_id, runner)
        self.worker_runs = 0
        self.worker_processes = []
        self.active_case = None
        self.test_users = 0
        self.eligible_peer_requests = 0
        self.baseline_mode = False

    def call(self, method, path, status, body=None, account=None, key=None):
        data = self.http.expect(method, path, status, body, token=account and account["accessToken"], key=key,
                                case=self.active_case or (method + " " + urllib.parse.urlsplit(path).path))
        return data.get("data", data)

    def account(self, label):
        name = self.prefix + "_" + label
        assert name.startswith("test_")
        account = self.call("POST", "/api/v1/auth/register", 201, {
            "username": name, "password": "test_password_" + secrets.token_hex(16),
            "displayName": name, "deviceLabel": "test_family_push"})
        account["id"] = account["user"]["id"]
        account["expectedDisplayName"] = name
        assert uuid.UUID(account["id"]).version == 4
        self.test_users += 1
        return account

    def setup(self):
        self.actor, self.recipient, self.unassigned = [self.account(label) for label in ("actor", "reader", "unassigned")]
        self.family = self.call("POST", "/api/v1/families", 201, {"name": self.prefix + "_family", "timeZone": "America/Los_Angeles"}, self.actor)
        self.baby = self.call("POST", "/api/v1/families/" + self.family["id"] + "/babies", 201, {
            "name": self.prefix + "_baby", "birthDate": "2025-01-01", "gender": "girl"}, self.actor)
        self.baby["expectedDisplayName"] = self.prefix + "_baby"
        for account in (self.recipient, self.unassigned):
            invite = self.call("POST", "/api/v1/families/" + self.family["id"] + "/invites", 201, {}, self.actor)
            self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite["inviteCode"]}, account)
        self.grant(self.recipient)
        for account, label in ((self.actor, "actor"), (self.recipient, "reader"), (self.unassigned, "unassigned")):
            self.device(account, label)
        self.report["setup"] = {"realHttpRegistration": True, "realFamilyJoin": True, "realBabyGrant": True,
                                "testUsers": 3, "deviceRows": 3}

    def grant(self, account, role="member", grantor=None):
        return self.call("POST", "/api/v1/babies/" + self.baby["id"] + "/members", 201,
                         {"userId": account["id"], "role": role}, grantor or self.actor, "test_grant_" + str(uuid.uuid4()))

    def revoke(self, account, grantor=None):
        return self.call("DELETE", "/api/v1/babies/" + self.baby["id"] + "/members/" + account["id"], 200,
                         account=grantor or self.actor, key="test_revoke_" + str(uuid.uuid4()))

    def device(self, account, label):
        account["pushPath"] = "/test_" + self.runner.run_id + "_" + label
        account["installation"] = str(uuid.uuid4())
        sub = {"endpoint": self.fixture.origin + account["pushPath"], "keys": self.environment["subscriptionKeys"]}
        self.call("PUT", "/api/v1/devices/" + account["installation"] + "/push", 200, {
            "platform": "web", "environment": "production", "token": json.dumps(sub), "deviceLabel": "test_family_push"}, account)
        saved = int(self.runner.psql("SELECT count(*) FROM push_devices WHERE user_id=" + quote(account["id"]) +
                                   " AND token::jsonb->>'endpoint'=" + quote(sub["endpoint"]) + ";"))
        assert saved == 1, "complete_subscription_not_persisted"

    def inventory(self):
        family, baby = quote(self.family["id"]), quote(self.baby["id"])
        fields = {
            "records": "SELECT count(*) FROM feeding_records WHERE baby_id=" + baby,
            "changes": "SELECT count(*) FROM family_changes WHERE family_id=" + family,
            "familyTasks": "SELECT count(*) FROM task_executions WHERE kind=" + quote(KIND) + " AND owner_scope=" + quote("family:" + self.family["id"]),
            "deliveries": "SELECT count(*) FROM task_executions WHERE kind='push_delivery'",
            "notifications": "SELECT count(*) FROM notifications",
            "outbox": "SELECT count(*) FROM task_outbox",
            "timeline": "SELECT count(*) FROM timeline_entries WHERE baby_id=" + baby,
            "receipts": "SELECT count(*) FROM idempotency_receipts WHERE scope_id=" + family,
            "supplementRecords": "SELECT count(*) FROM supplement_records WHERE baby_id=" + baby,
            "growthRecords": "SELECT count(*) FROM growth_measurements WHERE baby_id=" + baby,
            "familyCursor": "SELECT cursor FROM family_sync_states WHERE family_id=" + family,
        }
        return {name: int(self.runner.psql(sql + ";")) for name, sql in fields.items()}

    def feeding(self, label, key=None):
        return self.call("POST", self.baby_path("/records/feeding"), 201, self.feeding_body(label),
                         self.actor, key or "test_record_" + str(uuid.uuid4()))

    def feeding_body(self, label):
        return {
            "feedingType": "bottle", "occurredAt": "2026-10-05T12:00:00Z", "amountMl": "120", "notes": "test_private_record_" + label,
        }

    def baby_path(self, suffix):
        return "/api/v1/babies/" + self.baby["id"] + suffix

    def sql_json(self, sql):
        return json.loads(self.runner.psql(sql))

    def task(self, task_id):
        return self.sql_json("SELECT to_jsonb(t)||jsonb_build_object('dispatch',(SELECT o.dispatch_state FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' ORDER BY (o.payload #> '{__native,familyRecord}') IS NULL,o.created_at,o.id LIMIT 1),"
                             "'due',(SELECT o.next_dispatch_at FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' ORDER BY (o.payload #> '{__native,familyRecord}') IS NULL,o.created_at,o.id LIMIT 1),"
                             "'input',(SELECT o.payload->'__native' FROM task_outbox o WHERE o.aggregate_id=t.id AND o.phase_key='native-initial' ORDER BY (o.payload #> '{__native,familyRecord}') IS NULL,o.created_at,o.id LIMIT 1)) "
                             "FROM task_executions t WHERE t.id=" + quote(task_id) + ";")

    def task_state(self, task_id):
        return self.sql_json("SELECT jsonb_build_object('execution',to_jsonb(t),'outboxes',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM task_outbox o WHERE o.aggregate_id=t.id),'[]'::jsonb),"
                             "'aiRun',(SELECT to_jsonb(r) FROM ai_runs r WHERE r.id=t.id),'snapshot',(SELECT to_jsonb(ss) FROM sync_snapshots ss WHERE ss.id=t.id)) "
                             "FROM task_executions t WHERE t.id=" + quote(task_id) + ";")

    def queue_unrelated_task(self, kind, user, extra=None, expired=False):
        task_id, outbox_id = str(uuid.uuid4()), str(uuid.uuid4())
        native = {"version": 1, "userId": user["id"], **(extra or {})}
        payload = json.dumps({"__native": native}, separators=(",", ":"))
        status, attempt, fence, lease = "queued", 0, 0, "NULL"
        if expired:
            status, attempt, fence, lease = "running", 1, 7, "NOW()-INTERVAL '1 second'"
        self.runner.psql(
            "INSERT INTO task_executions(id,kind,owner_scope,status,attempt,max_attempts,fence_token,lease_owner,lease_expires_at,next_event_seq,created_at,updated_at) "
            "VALUES(" + quote(task_id) + "," + quote(kind) + "," + quote("user:" + user["id"]) + "," + quote(status) + "," + str(attempt) + ",3," + str(fence) + "," +
            (quote("test_expired_worker_lease") if expired else "NULL") + "," + lease + ",0,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour');"
            "INSERT INTO task_outbox(id,type,aggregate_id,payload_version,payload,phase_key,dispatch_state,next_dispatch_at,created_at) VALUES(" +
            quote(outbox_id) + "," + quote(kind) + "," + quote(task_id) + ",1," + quote(payload) + "::jsonb,'native-initial','active',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour');")
        return task_id

    def event(self, record_id, kind="feeding", version=1, operation="create", allow_legacy=False):
        rows = self.sql_json("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'input',o.payload->'__native')),'[]'::jsonb) "
                             "FROM task_executions t JOIN task_outbox o ON o.aggregate_id=t.id WHERE t.kind=" + quote(KIND) +
                             " AND o.payload->'__native'->'familyRecord'->>'recordId'=" + quote(record_id) +
                             " AND o.payload->'__native'->'familyRecord'->>'kind'=" + quote(kind) +
                             " AND o.payload->'__native'->'familyRecord'->>'version'=" + quote(version) +
                             " AND o.payload->'__native'->'familyRecord'->>'operation'=" + quote(operation) + ";")
        assert len(rows) == 1, "committed_event_task_not_unique"
        event = rows[0]
        head = self.task(event["id"])
        assert head["owner_scope"] == "family:" + event["input"]["familyId"], "event_owner_not_family"
        assert head["input"].get("userId", "") == "", "event_depends_on_actor_session"
        family_record = head["input"]["familyRecord"]
        snapshot = family_record.get("contentSnapshot")
        if snapshot is not None:
            assert snapshot.get("version") == 1 and isinstance(snapshot.get("title"), str) and snapshot["title"], "event_content_snapshot_invalid"
            assert isinstance(snapshot.get("body"), str) and snapshot["body"], "event_content_snapshot_invalid"
        else:
            assert self.baseline_mode or allow_legacy, "new_event_missing_content_snapshot"
        allowed_fields = {"actorId", "kind", "recordId", "operation", "version", "eventKey", "contentSnapshot"}
        assert set(family_record).issubset(allowed_fields), "record_fields_leaked_outside_snapshot"
        return event

    def children(self, event):
        event_key = event["input"]["familyRecord"]["eventKey"]
        ids = self.sql_json("SELECT COALESCE(jsonb_agg(t.id ORDER BY t.created_at,t.id),'[]'::jsonb) FROM task_executions t "
                            "JOIN task_outbox o ON o.aggregate_id=t.id WHERE t.kind='push_delivery' "
                            "AND o.payload->'__native'->'familyRecord'->>'eventKey'=" + quote(event_key) + ";")
        return [self.task(task_id) for task_id in ids]

    def notification_rows(self, event):
        return self.sql_json("SELECT COALESCE(jsonb_agg(to_jsonb(n)),'[]'::jsonb) FROM notifications n WHERE event_key=" +
                             quote(event["input"]["familyRecord"]["eventKey"]) + ";")

    def fanout(self, event, recipients=1, recipient=None, notifications_only=False):
        self.once(notifications_only=notifications_only)
        return self.assert_fanout(event, recipients=recipients, recipient=recipient)

    def assert_fanout(self, event, recipients=1, recipient=None):
        recipient = recipient or self.recipient
        head = self.task(event["id"])
        if head["status"] != "succeeded":
            self.report.setdefault("fanoutFailureDiagnostics", []).append({
                "eventKey": event["input"]["familyRecord"]["eventKey"],
                "task": head,
                "state": self.task_state(event["id"]),
                "notifications": self.notification_rows(event),
                "children": self.children(event),
            })
        assert head["status"] == "succeeded", "family_fanout_not_succeeded"
        assert head["dispatch"] == "closed", "fanout_outbox_not_closed"
        notes = self.notification_rows(event)
        children = self.children(event)
        assert len(notes) == recipients and len(children) == recipients, "unexpected_fanout_count"
        if recipients == 0:
            return children
        snapshot = children[0]["input"]["familyRecord"].get("contentSnapshot")
        for note in notes:
            assert note["user_id"] == recipient["id"], "actor_or_unassigned_received_notification"
            if snapshot is None:
                if event.get("allowLegacySnapshot"):
                    assert "旧记录版本" in note["body"] and "当前记录版本" in note["body"], "legacy_notification_fallback_missing_version_context"
                else:
                    assert self.baseline_mode and note["title"] == "家庭动态" and note["body"] == "有新的照护记录", "legacy_notification_without_snapshot_unexpected"
            else:
                assert note["title"] == snapshot["title"] and note["body"] == snapshot["body"], "inbox_content_does_not_match_frozen_snapshot"
            assert note["data"]["entityId"] == event["input"]["familyRecord"]["recordId"], "notification_record_mismatch"
            assert note["data"]["url"] == "/notifications", "notification_route_missing"
            changes = int(self.runner.psql("SELECT count(*) FROM user_changes WHERE user_id=" + quote(note["user_id"]) +
                                         " AND entity_type='notification' AND entity_id=" + quote(note["id"]) + ";"))
            assert changes == 1, "notification_user_change_not_unique"
        for child in children:
            assert child["owner_scope"] == "user:" + recipient["id"], "delivery_owner_not_recipient"
            assert child["input"]["userId"] == recipient["id"], "delivery_input_owner_mismatch"
        return children

    def delivered(self, event, recipient=None, notifications_only=False):
        recipient = recipient or self.recipient
        children = self.fanout(event, recipient=recipient, notifications_only=notifications_only)
        before = self.fixture.count(recipient["pushPath"])
        self.once(notifications_only=notifications_only)
        child = self.task(children[0]["id"])
        assert self.fixture.count(recipient["pushPath"]) == before + 1, "provider_request_missing_or_duplicate"
        self.assert_delivery(event, child, recipient)
        return child

    def assert_delivery(self, event, child, recipient=None):
        recipient = recipient or self.recipient
        assert child["status"] == "succeeded" and child["result_ref"]["delivered"] is True, "provider_acceptance_not_recorded"
        event_key = event["input"]["familyRecord"]["eventKey"]
        receipt = next(item for item in reversed(self.fixture.requests)
                       if item["path"] == recipient["pushPath"] and item["payload"]["data"]["eventKey"] == event_key)
        assert receipt["encrypted"] and receipt["status"] == 201, "actual_webpush_request_invalid"
        payload = receipt["payload"]
        assert payload["privacySafe"], "push_metadata_contains_private_record"
        assert payload["wireBytes"] <= 3072, "push_wire_payload_exceeds_3072_utf8_bytes"
        snapshot = child["input"]["familyRecord"].get("contentSnapshot")
        if snapshot is None:
            assert self.baseline_mode and payload["title"] == "家庭动态" and payload["body"] == "有新的照护记录", "legacy_push_without_snapshot_unexpected"
        else:
            assert payload["title"] == snapshot["title"], "push_title_does_not_match_frozen_snapshot"
            if payload["body"] != snapshot["body"]:
                marker = "…点击查看完整内容"
                assert payload["body"].endswith(marker) and snapshot["body"].startswith(payload["body"][:-len(marker)]), "push_body_is_neither_full_nor_clipped_snapshot"
        assert payload["tag"] == child["input"]["notificationId"], "push_tag_not_stable_notification"
        assert payload["data"]["eventKey"] == event["input"]["familyRecord"]["eventKey"], "push_event_identity_mismatch"
        self.last_delivered_payload = payload
        return payload

    def case(self, name, action):
        self.active_case = name
        entry = {"name": name, "passed": False}
        self.report["cases"].append(entry)
        detail = action()
        entry["passed"] = True
        if detail is not None:
            entry["evidence"] = detail
        self.active_case = None
        print("PASS " + name, flush=True)

    def pref(self, enabled=True, baby=False, quiet=None, zone="UTC", account=None):
        return self.call("PUT", "/api/v1/me/notification-preferences", 200, {
            "babyId": self.baby["id"] if baby else None, "timeZone": zone,
            "kinds": {"family_record": enabled}, "quietHours": quiet}, account or self.recipient)

    def once(self, count=1, notifications_only=False):
        processes = []
        outputs = []
        try:
            for _ in range(count):
                process, output = self.start_worker(notifications_only=notifications_only, once=True)
                processes.append(process)
                outputs.append(output)
            for process in processes:
                code = process.wait(timeout=60)
                assert code == 0, "native_worker_failed"
        finally:
            for process in processes:
                self.stop_worker(process)
            for output in outputs:
                output.close()

    def start_worker(self, notifications_only=False, once=True):
        self.worker_runs += 1
        log = self.runner.logs / ("worker-" + str(self.worker_runs) + ".log")
        output = log.open("wb")
        command = [str(self.worker)]
        if once:
            command.append("--once")
        if notifications_only:
            command.append("--notifications-only")
        try:
            process = subprocess.Popen(command, cwd=self.runtime.SERVER_ROOT,
                                       env=self.environment["env"], stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        except BaseException:
            output.close()
            raise
        self.worker_processes.append(process)
        return process, output

    @staticmethod
    def stop_worker(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)

    def baseline(self):
        self.baseline_mode = True
        self.setup()
        self.case("baseline screenshot-shaped legacy food values are leaked as raw JSON", self.check_readable_food_copy_baseline)

    def readable_food_tenant(self, with_catalogs=False):
        family = self.call("POST", "/api/v1/families", 201, {
            "name": self.prefix + "_readable_family", "timeZone": "Asia/Shanghai"}, self.actor)
        baby = self.call("POST", "/api/v1/families/" + family["id"] + "/babies", 201, {
            "name": self.prefix + "_readable_baby", "birthDate": "2025-03-04", "gender": "girl"}, self.actor)
        reader = self.account("readable_reader")
        invite = self.call("POST", "/api/v1/families/" + family["id"] + "/invites", 201, {}, self.actor)
        self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite["inviteCode"]}, reader)
        self.call("POST", "/api/v1/babies/" + baby["id"] + "/members", 201,
                  {"userId": reader["id"], "role": "member"}, self.actor,
                  "test_readable_grant_" + str(uuid.uuid4()))
        self.device(reader, "readable_reader")
        result = {"family": family, "baby": baby, "reader": reader}
        if with_catalogs:
            catalog_name = "test_食物目录梨"
            catalog = self.call("POST", "/api/v1/food/items", 201, {
                "familyId": family["id"], "name": catalog_name, "category": "fruit",
                "allergenRisk": "low", "recommendedAgeMonths": 6, "tried": True}, self.actor)
            foreign_family = self.call("POST", "/api/v1/families", 201, {
                "name": self.prefix + "_foreign_catalog_family", "timeZone": "Asia/Shanghai"}, self.actor)
            foreign_name = "test_异家庭目录苹果"
            foreign_catalog = self.call("POST", "/api/v1/food/items", 201, {
                "familyId": foreign_family["id"], "name": foreign_name, "category": "fruit",
                "allergenRisk": "low", "recommendedAgeMonths": 6, "tried": True}, self.actor)
            assert catalog["name"] == catalog_name and catalog["id"].startswith("custom_"), "readable_catalog_item_not_created"
            assert foreign_catalog["name"] == foreign_name and foreign_catalog["id"].startswith("custom_"), "foreign_catalog_item_not_created"
            result.update({"catalog": catalog, "catalogName": catalog_name,
                           "foreignCatalog": foreign_catalog, "foreignName": foreign_name})
        return result

    @staticmethod
    def food_metadata_note(note, observations):
        return "[growdesk-web-food:v1]" + json.dumps(
            {"notes": note, "observations": observations}, ensure_ascii=False, separators=(",", ":"))

    def deliver_food_copy_record(self, tenant, label, food_ids, portion, note, occurred_at="2026-10-06T23:15:00Z"):
        family, baby, reader = tenant["family"], tenant["baby"], tenant["reader"]
        record_id = str(uuid.uuid4())
        payload = {"recordDate": "2026-10-07", "mealType": "lunch", "occurredAt": occurred_at,
                   "foodItemIds": food_ids, "portionDescription": portion, "notes": note}
        self.sync_record(record_id, "foodLog", "create", 1, payload, actor=self.actor, family=family, baby=baby)
        persisted = int(self.runner.psql("SELECT count(*) FROM food_records WHERE family_id=" + quote(family["id"]) +
                                         " AND baby_id=" + quote(baby["id"]) + " AND id=" + quote(record_id) + ";"))
        assert persisted == 1, "readable_food_http_write_not_persisted"
        event = self.event(record_id, kind="food")
        assert event["input"]["familyId"] == family["id"] and event["input"]["babyId"] == baby["id"], "readable_food_event_scope_mismatch"
        child = self.delivered(event, recipient=reader, notifications_only=True)
        notification_id = child["input"]["notificationId"]
        db_note = next((item for item in self.notification_rows(event) if item["id"] == notification_id), None)
        assert db_note is not None and db_note["user_id"] == reader["id"], "readable_food_inbox_row_missing"
        inbox = self.call("GET", "/api/v1/notifications?limit=100", 200, account=reader)
        api_note = next((item for item in inbox if item["id"] == notification_id), None)
        assert api_note is not None, "readable_food_http_inbox_missing"
        wire = self.last_delivered_payload
        bodies = {"databaseInbox": db_note["body"], "httpInbox": api_note["body"], "decryptedPush": wire["body"]}
        assert len(set(bodies.values())) == 1, "readable_food_inbox_and_wire_content_diverged"
        return {"event": event, "child": child, "payload": payload, "bodies": bodies,
                "title": wire["title"], "wireBytes": wire["wireBytes"]}

    @staticmethod
    def assert_food_body(bodies, expected=(), forbidden=()):
        for channel, body in bodies.items():
            for fragment in expected:
                assert fragment in body, "readable_food_missing_expected_copy:" + channel
            for fragment in forbidden:
                assert fragment not in body, "readable_food_leaked_internal_value:" + channel

    def check_readable_food_copy_baseline(self):
        tenant = self.readable_food_tenant()
        raw_note = self.food_metadata_note(None, {"acceptance": 5, "babyState": "happy", "hasAbnormal": False})
        actual = self.deliver_food_copy_record(tenant, "screenshot_baseline", ["test_食物南瓜"], "most", raw_note)
        bodies = actual["bodies"]
        missing = [fragment for fragment in ("发生时间：2026-10-07 07:15", "食物：test_食物南瓜", "份量：大部分",
                                               "喜欢程度：5/5", "进食状态：开心", "异常情况：无异常")
                   if fragment not in bodies["decryptedPush"]]
        raw_envelope_visible = all(raw_note in body for body in bodies.values())
        self.report["baselineRed"] = {"actualHttpWriteAndPersistedRow": True, "actualWorkerDelivered": True,
                                      "encryptedWebPushDecrypted": True, "inboxAndWireBodiesEqual": True,
                                      "rawScreenshotEnvelopeVisibleInAllChannels": raw_envelope_visible,
                                      "rawLegacyPortionVisible": "most" in bodies["decryptedPush"],
                                      "redundantSameDayRecordDateVisible": "记录日期：2026-10-07" in bodies["decryptedPush"],
                                      "missingReadableFields": missing,
                                      "decryptedBody": bodies["decryptedPush"],
                                      "expectedReadableFragments": ["发生时间：2026-10-07 07:15", "食物：test_食物南瓜",
                                                                     "份量：大部分", "喜欢程度：5/5", "进食状态：开心", "异常情况：无异常"]}
        assert raw_envelope_visible, "baseline_screenshot_raw_json_not_reproduced"
        assert missing, "baseline_screenshot_fields_unexpectedly_readable"
        assert all(body == bodies["decryptedPush"] for body in bodies.values()), "baseline_inbox_and_wire_diverged"
        assert not missing, "screenshot_readability_expectation_missing"

    def check_readable_food_copy(self):
        tenant = self.readable_food_tenant(with_catalogs=True)
        legacy_name = "test_食物南瓜"
        opaque_id = str(uuid.uuid4())
        primary_note = self.food_metadata_note(None, {"acceptance": 5, "babyState": "happy", "hasAbnormal": False})
        primary = self.deliver_food_copy_record(tenant, "screenshot", [legacy_name], "most", primary_note)
        primary_expected = ("发生时间：2026-10-07 07:15", "食物：" + legacy_name, "份量：大部分",
                            "喜欢程度：5/5", "进食状态：开心", "异常情况：无异常")
        primary_forbidden = ("[growdesk-web-food:v1]", "observations", "acceptance", "babyState", "hasAbnormal",
                             "foodItemIds", "most", "食物项 ID", "Asia/Shanghai", "+08:00", "记录日期：2026-10-07")
        self.assert_food_body(primary["bodies"], primary_expected, primary_forbidden)

        multiline = "test_多行备注第一行\ntest_多行备注第二行"
        abnormal_note = "test_异常说明第一行\ntest_异常说明第二行"
        abnormal_metadata = self.food_metadata_note(multiline, {"acceptance": 4, "babyState": "rejected",
                                                                  "hasAbnormal": True, "abnormalNotes": abnormal_note})
        abnormal = self.deliver_food_copy_record(tenant, "multiline_abnormal", [legacy_name], "little", abnormal_metadata)
        self.assert_food_body(abnormal["bodies"], ("份量：少量", "喜欢程度：4/5", "进食状态：拒绝",
                                "异常情况：有异常", "异常备注：" + abnormal_note, "备注：" + multiline),
                             ("[growdesk-web-food:v1]", "observations", "acceptance", "babyState", "hasAbnormal"))

        mixed_first = self.food_metadata_note("test_目录顺序一", {"acceptance": 3, "babyState": "neutral",
                                                                    "hasAbnormal": False, "abnormalNotes": "test_stale_abnormal_hidden"})
        first = self.deliver_food_copy_record(tenant, "mixed_catalog_first",
                [tenant["catalog"]["id"], legacy_name, opaque_id, tenant["foreignCatalog"]["id"]], "half", mixed_first)
        first_foods = "食物：" + tenant["catalogName"] + "、" + legacy_name
        self.assert_food_body(first["bodies"], (first_foods, "份量：半碗", "喜欢程度：3/5", "进食状态：一般"),
                             (opaque_id, tenant["foreignCatalog"]["id"], tenant["foreignName"],
                              "test_stale_abnormal_hidden", "异常备注：", "食物项 ID"))

        mixed_second = self.food_metadata_note("test_目录顺序二", {"acceptance": 2, "babyState": "happy", "hasAbnormal": False})
        second = self.deliver_food_copy_record(tenant, "mixed_catalog_second",
                [legacy_name, tenant["catalog"]["id"], tenant["foreignCatalog"]["id"], opaque_id], "all", mixed_second)
        second_foods = "食物：" + legacy_name + "、" + tenant["catalogName"]
        self.assert_food_body(second["bodies"], (second_foods, "份量：全部", "喜欢程度：2/5", "进食状态：开心"),
                             (opaque_id, tenant["foreignCatalog"]["id"], tenant["foreignName"], "食物项 ID"))

        malformed = self.deliver_food_copy_record(tenant, "malformed_envelope", [legacy_name], "most",
                                                   "[growdesk-web-food:v1]{malformed")
        wrong_types = self.food_metadata_note(None, {"acceptance": "5", "babyState": [], "hasAbnormal": "false"})
        typed = self.deliver_food_copy_record(tenant, "wrong_metadata_types", [legacy_name], "most", wrong_types)
        safe_fallback_forbidden = ("[growdesk-web-food:v1]", "{malformed", "observations", "acceptance", "babyState",
                                   "hasAbnormal", "hasAbnormal", '"notes"', '"observations"')
        self.assert_food_body(malformed["bodies"], (), safe_fallback_forbidden)
        self.assert_food_body(typed["bodies"], (), safe_fallback_forbidden)

        ai_replay_untouched = None
        if hasattr(self, "last_ai_replay_task"):
            ai = self.task(self.last_ai_replay_task)
            assert ai["status"] == "queued" and ai["attempt"] == 0 and ai["fence_token"] == 0, "notifications_only_food_probe_claimed_ai_task"
            ai_replay_untouched = True

        return {"screenshot": {"readabilityFragments": list(primary_expected), "timezoneAndDuplicateDateSuppressed": True,
                               "inboxAndEncryptedWireEqual": True},
                "multilineAndAbnormal": {"internalLineBreaksPreserved": True, "abnormalNotePreserved": True},
                "catalogResolution": {"mixedInputOrders": ["catalog,legacy", "legacy,catalog"],
                                      "opaqueAndCrossFamilyIDsHidden": True, "staleAbnormalNoteHidden": True},
                "malformedAndWrongTypes": {"twoBoundaryCases": True, "rawEnvelopeSuppressed": True},
                "realHttpWrites": 6, "actualNotificationsOnlyWorkerAndDecryptedPushPerWrite": True,
                "AI202TaskRemainsQueuedUnclaimed": ai_replay_untouched}

    def fixed(self):
        self.setup()
        self.case("preference HTTP defaults, validation and baby authorization", self.check_preferences)
        self.case("REST care create replays once; actor and unassigned member excluded; actual encrypted push accepted", self.check_primary)
        self.case("six record kinds carry complete event-time content through create/update/delete/restore", self.check_six_kind_content)
        self.case("legacy pending family event without content snapshot uses a version-safe fallback", self.check_legacy_pending_snapshot)
        self.case("family and baby content stays isolated across real tenants", self.check_cross_tenant_content)
        self.case("REST care update/delete and sleep/diaper create enqueue distinct events", self.check_care)
        self.case("common REST supplement and sync growth create/update/delete/restore enqueue and replay", self.check_common)
        self.case("changed idempotency body and stale baseVersion roll back without a notification event", self.check_conflict)
        self.case("actual PostgreSQL outbox failure rolls back care and common record transactions, retry persists once", self.check_rollback)
        self.case("concurrent native workers and repeated workers do not duplicate notification or delivery", self.check_concurrent)
        self.case("current global preference disabled before fanout produces no recipient artifacts", self.check_disabled_before)
        self.case("baby preference overrides global and disables delivery after fanout", self.check_disabled_after)
        self.case("baby permission revoked between fanout and delivery rejects recipient", self.check_revoked_after)
        self.case("real loopback provider 503 records retry, same topic survives accepted retry", self.check_retry)
        self.case("real loopback provider 403 is terminal and retains valid subscription", self.check_rejected)
        self.case("real loopback provider 410 removes the confirmed expired subscription", self.check_gone)
        self.case("legacy invalid family timezone falls back to UTC without losing notification", self.check_legacy_zone)
        self.case("oversized recipient retains inbox error while later recipient still receives push", self.check_device_overflow)
        self.case("owned snapshot manifest GET queued then actual worker ready preserves principal isolation", self.check_snapshot_task)
        self.case("cross-midnight quiet hours defer child before fanout claim without a provider request", self.check_quiet_before)
        self.case("new quiet preference after fanout requeues only that delivery without spending retry budget", self.check_quiet_after)
        self.case("one quiet recipient does not delay the other eligible recipient", self.check_quiet_peer)
        self.case("committed family event still fans out after actor leaves family", self.check_actor_left)
        self.case("notifications-only one-shot skips unrelated tasks and handles family push metadata precisely", self.check_notifications_only_once)
        self.case("notifications-only long poll stays idle for unrelated queued work and handles later family event", self.check_notifications_only_long_poll)
        # Keep this last: submit/replay is the tested seam; no AI worker runs.
        ai_replay_case = {
            202: "AI empty-attachment replay returns the identical retained run with 202",
            409: "AI empty-attachment replay retains preexisting 409 without a metadata 500 regression",
        }[self.ai_empty_replay_status]
        self.case(ai_replay_case, self.check_ai_replay)
        self.case("legacy food screenshot values render as readable family-local inbox and push copy", self.check_readable_food_copy)
        assert self.fixture.count(self.actor["pushPath"]) == 0, "actor_received_own_event"
        assert self.fixture.count(self.unassigned["pushPath"]) == self.eligible_peer_requests, "unassigned_received_event"
        self.report["worker"] = {"actualNativeRuns": self.worker_runs, "allOwnedProcessesExited": all(p.poll() is not None for p in self.worker_processes)}
        self.report["finalInventory"] = self.inventory()
        self.report["httpAssertions"] = self.http.assertions

    def check_preferences(self):
        global_pref = self.call("GET", "/api/v1/me/notification-preferences", 200, account=self.recipient)
        baby_pref = self.call("GET", "/api/v1/me/notification-preferences?babyId=" + self.baby["id"], 200, account=self.recipient)
        assert global_pref == {"babyId": None, "timeZone": "UTC", "kinds": {"family_record": True}, "quietHours": None}, "global_default_invalid"
        assert baby_pref == {**global_pref, "babyId": self.baby["id"], "timeZone": "America/Los_Angeles"}, "baby_default_invalid"
        self.call("GET", "/api/v1/me/notification-preferences", 401)
        self.call("GET", "/api/v1/me/notification-preferences?babyId=" + self.baby["id"], 403, account=self.unassigned)
        count_before = int(self.runner.psql("SELECT count(*) FROM notification_preferences;"))
        base = {"timeZone": "UTC", "kinds": {"family_record": True}, "quietHours": None}
        for body in ({**base, "timeZone": "test_Invalid/Zone"}, {**base, "timeZone": "Local"},
                     {**base, "quietHours": {"start": "7:00", "end": "22:00"}},
                     {**base, "quietHours": {"start": "22:00", "end": "22:00"}}):
            self.call("PUT", "/api/v1/me/notification-preferences", 400, body, self.recipient)
        self.call("PUT", "/api/v1/me/notification-preferences", 403, {**base, "babyId": self.baby["id"]}, self.unassigned)
        assert int(self.runner.psql("SELECT count(*) FROM notification_preferences;")) == count_before, "invalid_preference_persisted"
        return {"defaults": baby_pref, "invalidInputsRejected": 4, "unauthorizedBabyRejected": True}

    def check_primary(self):
        before = self.inventory()
        key = "test_replay_" + str(uuid.uuid4())
        self.primary = self.feeding("primary", key)
        first = self.inventory()
        replay = self.feeding("primary", key)
        assert replay == self.primary and self.inventory() == first, "idempotent_create_produced_side_effects"
        assert first["records"] == before["records"] + 1 and first["familyTasks"] == before["familyTasks"] + 1, "record_event_not_atomic"
        self.primary_event = self.event(self.primary["id"])
        child = self.delivered(self.primary_event)
        accepted = self.fixture.count()
        self.once()
        self.once()
        assert self.fixture.count() == accepted, "completed_worker_replayed_delivery"
        inbox = self.call("GET", "/api/v1/notifications?limit=100", 200, account=self.recipient)
        assert any(note["id"] == child["input"]["notificationId"] for note in inbox), "recipient_inbox_missing_notification"
        for account in (self.actor, self.unassigned):
            assert self.call("GET", "/api/v1/notifications?limit=100", 200, account=account) == [], "excluded_recipient_inbox_not_empty"
        return {"record201Committed": True, "oneEventOnReplay": True, "provider201": True,
                "encryptedPayloadDecryptedByOwnedReceiver": True, "metadataContainsNoRecordFieldsOrCredentials": True,
                "recordDetailsMatchFrozenSnapshot": True,
                "notificationId": child["input"]["notificationId"], "repeatWorkerRequests": 0}

    def check_care(self):
        path = self.baby_path("/records/feeding/" + self.primary["id"])
        updated = self.call("PATCH", path, 200, {"baseVersion": self.primary["version"], "notes": "test_private_record_updated"}, self.actor,
                            "test_patch_" + str(uuid.uuid4()))
        self.delivered(self.event(updated["id"], version=2, operation="update"))
        self.call("DELETE", path + "?baseVersion=" + updated["version"], 200, account=self.actor, key="test_delete_" + str(uuid.uuid4()))
        self.delivered(self.event(updated["id"], version=3, operation="delete"))
        for kind, body in (("sleep", {"sleepType": "nap", "startedAt": "2026-10-05T10:00:00Z", "endedAt": "2026-10-05T11:00:00Z"}),
                           ("diaper", {"diaperType": "pee", "occurredAt": "2026-10-05T11:05:00Z"})):
            row = self.call("POST", self.baby_path("/records/" + kind), 201, body, self.actor, "test_care_" + str(uuid.uuid4()))
            self.delivered(self.event(row["id"], kind=kind))
        return {"RESTKinds": ["feeding", "sleep", "diaper"], "operations": ["create", "update", "delete"]}

    def check_common(self):
        self.supplement_body = {"supplementName": "test_vitamin", "occurredAt": "2026-10-05T12:00:00Z", "dose": "1.25", "unitName": "drops"}
        supplement = self.call("POST", self.baby_path("/records/supplement"), 201, self.supplement_body, self.actor,
                               "test_common_" + str(uuid.uuid4()))
        self.delivered(self.event(supplement["id"], kind="supplement"))
        record_id = str(uuid.uuid4())
        command = {"commandId": str(uuid.uuid4()), "familyId": self.family["id"], "babyId": self.baby["id"],
                   "entityType": "growthMeasurement", "entityId": record_id, "operation": "create", "baseVersion": None,
                   "clientCreatedAt": "2026-10-05T12:00:00Z", "payload": {"measurementDate": "2026-10-05", "weightKg": "9.40", "heightCm": "75.5"}}
        first = self.call("POST", "/api/v1/sync/commands", 200, {"commands": [command]}, self.actor)["results"][0]
        assert first["status"] == "applied" and first["version"] == "1", "sync_record_not_applied"
        after = self.inventory()
        replay = self.call("POST", "/api/v1/sync/commands", 200, {"commands": [command]}, self.actor)["results"][0]
        assert replay["status"] == "replayed" and self.inventory() == after, "sync_replay_duplicated_event"
        self.delivered(self.event(record_id, kind="growth"))
        for operation, version, payload in (("update", 2, {"notes": "test_private_record_growth"}), ("delete", 3, {}), ("restore", 4, {})):
            command = {**command, "commandId": str(uuid.uuid4()), "operation": operation, "baseVersion": str(version-1), "payload": payload}
            result = self.call("POST", "/api/v1/sync/commands", 200, {"commands": [command]}, self.actor)["results"][0]
            assert result["status"] == "applied" and result["version"] == str(version), "sync_operation_not_applied"
            self.delivered(self.event(record_id, kind="growth", version=version, operation=operation))
        return {"commonREST": "supplement", "realSync": "growthMeasurement", "syncReplayTaskDelta": 0,
                "syncOperations": ["create", "update", "delete", "restore"]}

    def sync_record(self, record_id, wire_kind, operation, version, payload, actor=None, family=None, baby=None):
        actor, family, baby = actor or self.actor, family or self.family, baby or self.baby
        command = {"commandId": str(uuid.uuid4()), "familyId": family["id"], "babyId": baby["id"],
                   "entityType": wire_kind, "entityId": record_id, "operation": operation,
                   "baseVersion": None if version == 1 else str(version - 1),
                   "clientCreatedAt": "2026-10-06T15:15:00Z", "payload": payload}
        result = self.call("POST", "/api/v1/sync/commands", 200, {"commands": [command]}, actor)["results"][0]
        assert result["status"] == "applied" and result["version"] == str(version), "full_content_sync_command_not_applied"
        return result

    def assert_snapshot(self, event, actor, baby, title_action, record_name, fragments, note):
        native = event["input"]
        family_record = native["familyRecord"]
        snapshot = family_record.get("contentSnapshot")
        assert snapshot is not None and snapshot["version"] == 1, "record_event_snapshot_missing"
        assert native["familyId"] == self.family["id"] and native["babyId"] == self.baby["id"], "snapshot_family_scope_mismatch"
        assert family_record["actorId"] == actor["id"], "snapshot_actor_mismatch"
        actor_name = actor.get("expectedDisplayName") or actor.get("displayName") or actor.get("user", {}).get("displayName") or actor.get("username")
        baby_name = baby.get("expectedDisplayName") or baby.get("name") or baby.get("nickname")
        assert snapshot["title"] == f"{actor_name}为{baby_name}{title_action}{record_name}记录", "snapshot_title_missing_actor_baby_or_operation"
        body = snapshot["body"]
        for fragment in fragments:
            assert fragment in body, "snapshot_body_missing_structured_field"
        assert body.endswith("备注：" + note), "snapshot_note_missing_or_not_last"
        return {"title": snapshot["title"], "snapshotUtf8Bytes": len(body.encode("utf-8")),
                "structuredFieldsChecked": len(fragments) + 1, "noteLast": True}

    def check_six_kind_content(self):
        item = self.call("POST", "/api/v1/food/items", 201, {
            "familyId": self.family["id"], "name": self.prefix + "_sweet_potato", "category": "vegetable",
            "allergenRisk": "low", "recommendedAgeMonths": 6, "tried": True}, self.actor)
        assert item["name"] == self.prefix + "_sweet_potato" and item["id"].startswith("custom_"), "test_food_library_item_not_http_created"
        profiles = [
            {"kind": "feeding", "wire": "feeding", "name": "喂奶", "create": {
                "feedingType": "formula", "occurredAt": "2026-10-06T15:15:00Z", "amountMl": "0", "leftMinutes": 0,
                "rightMinutes": 12, "spitUp": False, "notes": "test_full_create_feeding"}, "update": {
                "feedingType": "formula", "occurredAt": "2026-10-06T16:15:00Z", "amountMl": "135", "leftMinutes": 4,
                "rightMinutes": 14, "spitUp": True, "notes": "test_full_update_feeding"},
             "createFields": ["发生时间：2026-10-06 08:15", "类型：配方奶", "奶量：0 毫升", "左侧时长：0 分钟", "右侧时长：12 分钟", "吐奶：否"],
             "updateFields": ["发生时间：2026-10-06 09:15", "类型：配方奶", "奶量：135 毫升", "左侧时长：4 分钟", "右侧时长：14 分钟", "吐奶：是"]},
            {"kind": "sleep", "wire": "sleep", "name": "睡眠", "create": {
                "sleepType": "nap", "startedAt": "2026-10-06T15:15:00Z", "endedAt": "2026-10-06T16:15:00Z",
                "nightWakingCount": 0, "notes": "test_full_create_sleep"}, "update": {
                "sleepType": "night", "startedAt": "2026-10-06T16:15:00Z", "endedAt": "2026-10-06T17:45:00Z",
                "nightWakingCount": 1, "notes": "test_full_update_sleep"},
             "createFields": ["开始时间：2026-10-06 08:15", "类型：白天小睡", "结束时间：2026-10-06 09:15", "睡眠时长：1 小时 0 分钟", "夜醒次数：0 次"],
             "updateFields": ["开始时间：2026-10-06 09:15", "类型：夜间睡眠", "结束时间：2026-10-06 10:45", "睡眠时长：1 小时 30 分钟", "夜醒次数：1 次"]},
            {"kind": "diaper", "wire": "diaper", "name": "尿布", "create": {
                "diaperType": "both", "occurredAt": "2026-10-06T15:15:00Z", "poopColor": "brown",
                "poopConsistency": "soft", "notes": "test_full_create_diaper"}, "update": {
                "diaperType": "poop", "occurredAt": "2026-10-06T16:20:00Z", "poopColor": "green",
                "poopConsistency": "soft", "notes": "test_full_update_diaper"},
             "createFields": ["发生时间：2026-10-06 08:15", "类型：尿便都有", "便便颜色：棕色", "便便性状：柔软"],
             "updateFields": ["发生时间：2026-10-06 09:20", "类型：便便", "便便颜色：绿色", "便便性状：柔软"]},
            {"kind": "food", "wire": "foodLog", "name": "辅食", "create": {
                "recordDate": "2026-10-06", "occurredAt": "2026-10-06T15:15:00Z", "mealType": "lunch",
                "foodItemIds": [item["id"]], "portionDescription": "test_portion_2tbsp", "reaction": "like",
                "notes": "test_full_create_food"}, "update": {
                "recordDate": "2026-10-06", "occurredAt": "2026-10-06T16:30:00Z", "mealType": "dinner",
                "foodItemIds": [item["id"]], "portionDescription": "test_updated_portion_3tbsp", "reaction": "normal",
                "notes": "test_full_update_food"},
             "createFields": ["发生时间：2026-10-06 08:15", "餐次：午餐", "食物：" + item["name"], "份量：test_portion_2tbsp", "接受度：喜欢"],
             "updateFields": ["发生时间：2026-10-06 09:30", "餐次：晚餐", "食物：" + item["name"], "份量：test_updated_portion_3tbsp", "接受度：一般"]},
            {"kind": "supplement", "wire": "supplementRecord", "name": "补剂", "create": {
                "supplementName": "test_vitamin_d", "occurredAt": "2026-10-06T15:15:00Z", "amount": "1 tablet",
                "dose": "0", "unitName": "ml", "notes": "test_full_create_supplement"}, "update": {
                "supplementName": "test_vitamin_d_updated", "occurredAt": "2026-10-06T16:15:00Z", "amount": "2 tablets",
                "dose": "2.5", "unitName": "ml", "notes": "test_full_update_supplement"},
             "createFields": ["发生时间：2026-10-06 08:15", "补剂：test_vitamin_d", "用量：1 tablet", "剂量：0 ml"],
             "updateFields": ["发生时间：2026-10-06 09:15", "补剂：test_vitamin_d_updated", "用量：2 tablets", "剂量：2.5 ml"]},
            {"kind": "growth", "wire": "growthMeasurement", "name": "生长测量", "create": {
                "measurementDate": "2026-10-06", "weightKg": "9.40", "heightCm": "75.5", "headCircumferenceCm": "45.0",
                "notes": "test_full_create_growth"}, "update": {
                "measurementDate": "2026-10-07", "weightKg": "9.8", "heightCm": "76.1", "headCircumferenceCm": "45.2",
                "notes": "test_full_update_growth"},
             "createFields": ["测量日期：2026-10-06", "体重：9.4", "身长：75.5 厘米", "头围：45"],
             "updateFields": ["测量日期：2026-10-07", "体重：9.8", "身长：76.1 厘米", "头围：45.2"]},
        ]
        operation_names = {"create": "新增", "update": "更新", "delete": "删除", "restore": "恢复"}
        events, case_evidence = [], []
        for profile in profiles:
            record_id = str(uuid.uuid4())
            self.sync_record(record_id, profile["wire"], "create", 1, profile["create"])
            created = self.event(record_id, kind=profile["kind"], version=1, operation="create")
            case_evidence.append(self.assert_snapshot(created, self.actor, self.baby, operation_names["create"], profile["name"], profile["createFields"], profile["create"]["notes"]))
            events.append(created)
            self.sync_record(record_id, profile["wire"], "update", 2, profile["update"])
            updated = self.event(record_id, kind=profile["kind"], version=2, operation="update")
            case_evidence.append(self.assert_snapshot(updated, self.actor, self.baby, operation_names["update"], profile["name"], profile["updateFields"], profile["update"]["notes"]))
            events.append(updated)
            self.sync_record(record_id, profile["wire"], "delete", 3, {})
            deleted = self.event(record_id, kind=profile["kind"], version=3, operation="delete")
            case_evidence.append(self.assert_snapshot(deleted, self.actor, self.baby, operation_names["delete"], profile["name"], profile["updateFields"], profile["update"]["notes"]))
            events.append(deleted)
            self.sync_record(record_id, profile["wire"], "restore", 4, {})
            restored = self.event(record_id, kind=profile["kind"], version=4, operation="restore")
            case_evidence.append(self.assert_snapshot(restored, self.actor, self.baby, operation_names["restore"], profile["name"], profile["updateFields"], profile["update"]["notes"]))
            events.append(restored)

        # Every create snapshot is still the original transaction's content,
        # even though all six underlying records have since been updated,
        # deleted and restored before any notification worker runs.
        for profile, event in zip(profiles, events[::4]):
            snapshot_body = event["input"]["familyRecord"]["contentSnapshot"]["body"]
            assert profile["create"]["notes"] in snapshot_body and profile["update"]["notes"] not in snapshot_body, "later_record_mutation_contaminated_committed_snapshot"
        self.once(count=len(events))
        children_by_key = {}
        for event in events:
            children_by_key[event["input"]["familyRecord"]["eventKey"]] = self.assert_fanout(event)
        self.once(count=len(events))
        for event in events:
            event_key = event["input"]["familyRecord"]["eventKey"]
            child = self.task(children_by_key[event_key][0]["id"])
            self.assert_delivery(event, child)

        long_note = "长备注" * 333
        long_record_id = str(uuid.uuid4())
        self.sync_record(long_record_id, "feeding", "create", 1, {**profiles[0]["create"], "notes": long_note})
        long_event = self.event(long_record_id)
        long_snapshot = long_event["input"]["familyRecord"]["contentSnapshot"]
        assert long_snapshot["body"].endswith("备注：" + long_note), "long_snapshot_note_was_truncated"
        long_child = self.delivered(long_event)
        long_payload = self.last_delivered_payload
        marker = "…点击查看完整内容"
        assert long_payload["wireBytes"] <= 3072 and long_payload["body"].endswith(marker), "long_push_body_missing_explicit_wire_clip"
        assert long_snapshot["body"].startswith(long_payload["body"][:-len(marker)]), "wire_clip_changed_structured_body_prefix"
        for fragment in profiles[0]["createFields"]:
            assert fragment in long_payload["body"], "wire_clip_removed_structured_fact_before_notes"
        inbox = self.call("GET", "/api/v1/notifications?limit=100", 200, account=self.recipient)
        inbox_item = next((note for note in inbox if note["id"] == long_child["input"]["notificationId"]), None)
        assert inbox_item is not None and inbox_item["body"] == long_snapshot["body"] and inbox_item["body"].endswith("备注：" + long_note), "inbox_body_not_full_snapshot"
        return {"recordKinds": [profile["kind"] for profile in profiles], "operationsPerKind": ["create", "update", "delete", "restore"],
                "snapshotAssertions": len(case_evidence), "allSnapshotsCapturedBeforeLaterMutations": True,
                "all24ActualEncryptedPushesMatchedSnapshot": True, "longSnapshotUtf8Bytes": len(long_snapshot["body"].encode("utf-8")),
                "longPushWireBytes": long_payload["wireBytes"], "longPushClippedWithMarker": True,
                "inboxRetainedFullBody": True, "titleBodyChecks": case_evidence}

    def check_legacy_pending_snapshot(self):
        original_note, current_note = "test_legacy_original_snapshot", "test_legacy_current_record"
        record = self.feeding("legacy_pending", key="test_legacy_create_" + str(uuid.uuid4()))
        old = self.event(record["id"])
        self.runner.psql("UPDATE task_outbox SET payload=payload #- '{__native,familyRecord,contentSnapshot}' WHERE aggregate_id=" + quote(old["id"]) + " AND phase_key='native-initial';")
        updated = self.call("PATCH", self.baby_path("/records/feeding/" + record["id"]), 200,
                            {"baseVersion": record["version"], "amountMl": "145", "notes": current_note}, self.actor,
                            "test_legacy_update_" + str(uuid.uuid4()))
        assert updated["version"] == "2", "legacy_current_record_update_failed"
        old = self.event(record["id"], version=1, operation="create", allow_legacy=True)
        old["allowLegacySnapshot"] = True
        current = self.event(record["id"], version=2, operation="update")
        assert old["input"]["familyRecord"].get("contentSnapshot") is None, "legacy_snapshot_fixture_not_removed"
        assert current["input"]["familyRecord"]["contentSnapshot"]["body"].endswith("备注：" + current_note), "current_event_snapshot_missing_after_legacy_pending"
        self.once(count=2)
        old_children = self.assert_fanout(old)
        current_children = self.assert_fanout(current)
        note = next(item for item in self.notification_rows(old) if item["user_id"] == self.recipient["id"])
        assert "旧记录版本 1" in note["body"] and "当前记录版本 2" in note["body"], "legacy_pending_did_not_use_version_safe_fallback"
        assert original_note not in note["body"] and current_note not in note["body"], "legacy_fallback_misattributed_current_record_content"
        child = old_children[0]
        assert child["input"]["familyRecord"]["contentSnapshot"]["body"] == note["body"], "legacy_fallback_push_snapshot_mismatch"
        self.once(count=2)
        self.assert_delivery(old, self.task(child["id"]))
        self.assert_delivery(current, self.task(current_children[0]["id"]))
        return {"legacyPendingWithoutSnapshot": True, "currentRecordVersion": updated["version"],
                "fallbackIdentifiesOldAndCurrentVersions": True, "oldOrNewNotesNotMisattributed": True}

    def check_cross_tenant_content(self):
        other_actor, other_reader = self.account("other_family_actor"), self.account("other_family_reader")
        other_family = self.call("POST", "/api/v1/families", 201, {"name": self.prefix + "_other_family", "timeZone": "America/Los_Angeles"}, other_actor)
        other_baby = self.call("POST", "/api/v1/families/" + other_family["id"] + "/babies", 201, {
            "name": self.prefix + "_other_baby", "birthDate": "2025-02-01", "gender": "boy"}, other_actor)
        invite = self.call("POST", "/api/v1/families/" + other_family["id"] + "/invites", 201, {}, other_actor)
        self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite["inviteCode"]}, other_reader)
        self.call("POST", "/api/v1/babies/" + other_baby["id"] + "/members", 201,
                  {"userId": other_reader["id"], "role": "member"}, other_actor, "test_other_family_grant_" + str(uuid.uuid4()))
        self.device(other_actor, "other_actor")
        self.device(other_reader, "other_reader")
        cross_id = str(uuid.uuid4())
        cross_command = {"commandId": str(uuid.uuid4()), "familyId": other_family["id"], "babyId": other_baby["id"],
                         "entityType": "feeding", "entityId": cross_id, "operation": "create", "baseVersion": None,
                         "clientCreatedAt": "2026-10-06T15:15:00Z", "payload": {"feedingType": "formula",
                         "occurredAt": "2026-10-06T15:15:00Z", "amountMl": "200", "notes": "test_cross_family_attempt"}}
        rejected = self.call("POST", "/api/v1/sync/commands", 200, {"commands": [cross_command]}, self.actor)["results"][0]
        assert rejected["status"] == "error", "client_supplied_foreign_family_scope_authorized_write"
        assert int(self.runner.psql("SELECT count(*) FROM feeding_records WHERE id=" + quote(cross_id) + ";")) == 0, "cross_family_record_write_persisted"
        self.call("GET", self.baby_path("/records/feeding"), 403, account=other_actor)
        self.call("GET", "/api/v1/babies/" + other_baby["id"] + "/records/feeding", 403, account=self.actor)
        other_id = str(uuid.uuid4())
        self.sync_record(other_id, "feeding", "create", 1, {"feedingType": "formula", "occurredAt": "2026-10-06T15:15:00Z",
            "amountMl": "210", "notes": "test_other_tenant_private_marker"}, actor=other_actor, family=other_family, baby=other_baby)
        other_event = self.event(other_id)
        primary_before = self.fixture.count(self.recipient["pushPath"])
        self.delivered(other_event, recipient=other_reader)
        assert self.fixture.count(self.recipient["pushPath"]) == primary_before, "foreign_family_event_reached_primary_push_subscription"
        primary_inbox = self.call("GET", "/api/v1/notifications?limit=100", 200, account=self.recipient)
        assert all("test_other_tenant_private_marker" not in note["body"] for note in primary_inbox), "foreign_family_record_leaked_into_primary_inbox"
        other_inbox = self.call("GET", "/api/v1/notifications?limit=100", 200, account=other_reader)
        assert any("test_other_tenant_private_marker" in note["body"] for note in other_inbox), "authorized_other_family_inbox_missing_own_content"
        return {"clientSuppliedForeignScopeWriteRejected": True, "crossFamilyReadForbidden": True,
                "otherFamilyRecipientReceivedOwnEvent": True, "primaryFamilyReceivedNoForeignPushOrInboxBody": True,
                "extraTestUsers": 2}

    def check_conflict(self):
        key = "test_conflict_" + str(uuid.uuid4())
        row = self.feeding("conflict", key)
        event = self.event(row["id"])
        before = self.inventory()
        self.call("POST", self.baby_path("/records/feeding"), 409, self.feeding_body("changed_body"), self.actor, key)
        assert self.inventory() == before, "conflicting_receipt_changed_persistence"
        self.call("PATCH", self.baby_path("/records/feeding/" + row["id"]), 409,
                  {"baseVersion": "99", "notes": "test_private_record_conflict"}, self.actor, "test_stale_" + str(uuid.uuid4()))
        assert self.inventory() == before, "stale_update_changed_persistence"
        self.call("POST", self.baby_path("/records/feeding"), 400, {}, self.actor, "test_invalid_" + str(uuid.uuid4()))
        assert self.inventory() == before, "invalid_record_changed_persistence"
        self.delivered(event)
        return {"HTTP409": 2, "HTTP400": 1, "recordTimelineCursorReceiptOutboxUnchanged": True}

    def check_rollback(self):
        details = []
        for kind, path, body in (("feeding", self.baby_path("/records/feeding"), self.feeding_body("forced_rollback")),
                                 ("supplement", self.baby_path("/records/supplement"), self.supplement_body)):
            key = "test_database_failure_" + str(uuid.uuid4())
            before = self.inventory()
            self.runner.psql("CREATE FUNCTION test_family_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ "
                             "BEGIN IF NEW.type='family_record_notification' THEN RAISE EXCEPTION 'test_family_outbox_failure'; END IF; RETURN NEW; END $$;"
                             "CREATE TRIGGER test_family_outbox_failure BEFORE INSERT ON task_outbox FOR EACH ROW EXECUTE FUNCTION test_family_outbox_failure();")
            try:
                self.call("POST", path, 500, body, self.actor, key)
                assert self.inventory() == before, "failed_outbox_transaction_partially_committed"
            finally:
                self.runner.psql("DROP TRIGGER test_family_outbox_failure ON task_outbox; DROP FUNCTION test_family_outbox_failure();")
            row = self.call("POST", path, 201, body, self.actor, key)
            self.delivered(self.event(row["id"], kind=kind))
            details.append({"kind": kind, "failureHTTP": 500, "allPersistenceUnchanged": True, "sameKeyRetry": 201})
        return {"actualDatabaseFaultInjection": "owned PostgreSQL trigger raises during outbox insert", "cases": details}

    def check_concurrent(self):
        row = self.feeding("concurrent_worker")
        event = self.event(row["id"])
        before = self.fixture.count()
        self.once(count=2)
        if self.children(event)[0]["status"] == "queued":
            self.once(count=2)
        children = self.children(event)
        assert len(children) == 1 and children[0]["status"] == "succeeded" and children[0]["result_ref"]["delivered"] is True, "concurrent_delivery_not_single"
        assert len(self.notification_rows(event)) == 1 and self.fixture.count() == before + 1, "concurrent_worker_duplicate"
        self.once(count=2)
        assert self.fixture.count() == before + 1, "completed_concurrent_worker_duplicate"
        assert children[0]["fence_token"] == 1 and children[0]["attempt"] == 1, "lease_claim_duplicated"
        return {"actualWorkerProcessesConcurrent": 2, "notifications": 1, "providerRequests": 1, "deliveryFence": 1}

    def check_disabled_before(self):
        self.pref(False)
        row = self.feeding("disabled_before")
        event = self.event(row["id"])
        before = self.fixture.count()
        self.fanout(event, recipients=0)
        self.once()
        assert self.fixture.count() == before, "disabled_preference_still_sent"
        self.pref(True)
        return {"currentPreferenceApplied": True, "notifications": 0, "deliveryTasks": 0, "providerRequests": 0}

    def check_disabled_after(self):
        self.pref(False)
        self.pref(True, baby=True)
        row = self.feeding("baby_override")
        event = self.event(row["id"])
        child = self.fanout(event)[0]
        before = self.fixture.count()
        self.pref(False, baby=True)
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "succeeded" and child["result_ref"]["delivered"] is False and child["result_ref"]["skippedReason"] == "preferences_disabled", "latest_preference_not_checked_before_delivery"
        assert self.fixture.count() == before, "preference_disabled_delivery_reached_provider"
        self.pref(True)
        self.pref(True, baby=True)
        return {"babyOverrideGlobal": True, "skippedReason": "preferences_disabled", "providerRequests": 0}

    def check_revoked_after(self):
        row = self.feeding("revoked_after")
        event = self.event(row["id"])
        child = self.fanout(event)[0]
        before = self.fixture.count()
        self.revoke(self.recipient)
        self.call("GET", self.baby_path("/records/feeding"), 403, account=self.recipient)
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "succeeded" and child["result_ref"]["delivered"] is False and child["result_ref"]["skippedReason"] == "scope_revoked", "revoked_baby_permission_not_checked"
        assert self.fixture.count() == before, "revoked_recipient_reached_provider"
        self.grant(self.recipient)
        return {"actualHTTPBabyRevoke": True, "skippedReason": "scope_revoked", "providerRequests": 0}

    def check_retry(self):
        row = self.feeding("retry_provider")
        event = self.event(row["id"])
        child = self.fanout(event)[0]
        before = self.fixture.count()
        self.fixture.statuses[self.recipient["pushPath"]] = 503
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "queued" and child["attempt"] == 2 and child["error_details"]["retryable"] is True, "retryable_provider_failure_not_retained"
        assert child["error_details"]["code"] == "PUSH_SERVICE_REJECTED" and child["dispatch"] == "active", "provider_failure_state_invalid"
        assert self.fixture.count() == before + 1, "provider_failure_request_missing"
        self.fixture.statuses[self.recipient["pushPath"]] = 201
        due = parse_db_time(child["due"])
        remaining = (due - dt.datetime.now(dt.timezone.utc)).total_seconds()
        assert remaining < 3, "retry_backoff_unbounded"
        if remaining > 0:
            time.sleep(remaining + 0.05)
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "succeeded" and child["result_ref"]["delivered"] is True and child["attempt"] == 2, "provider_retry_not_completed"
        assert self.fixture.count() == before + 2, "retry_request_count_invalid"
        assert self.fixture.requests[-1]["topic"] == self.fixture.requests[-2]["topic"], "retry_topic_identity_changed"
        return {"providerStatuses": [503, 201], "attempts": 2, "stableCollapseTopic": True}

    def check_rejected(self):
        row = self.feeding("rejected_provider")
        event = self.event(row["id"])
        child = self.fanout(event)[0]
        self.fixture.statuses[self.recipient["pushPath"]] = 403
        before = self.fixture.count()
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "failed" and child["error_details"]["retryable"] is False and child["dispatch"] == "closed", "fatal_provider_failure_not_terminal"
        assert self.fixture.count() == before + 1, "fatal_provider_request_missing"
        assert int(self.runner.psql("SELECT count(*) FROM push_devices WHERE user_id=" + quote(self.recipient["id"]) + ";")) == 1, "valid_device_removed_on_rejection"
        self.fixture.statuses[self.recipient["pushPath"]] = 201
        return {"providerStatus": 403, "task": "failed", "deviceRetained": True}

    def check_gone(self):
        row = self.feeding("expired_provider")
        event = self.event(row["id"])
        child = self.fanout(event)[0]
        self.fixture.statuses[self.recipient["pushPath"]] = 410
        before = self.fixture.count()
        self.once()
        child = self.task(child["id"])
        assert child["status"] == "succeeded" and child["result_ref"]["delivered"] is False and child["result_ref"]["subscriptionGone"] is True, "expired_subscription_result_invalid"
        assert self.fixture.count() == before + 1, "expired_provider_request_missing"
        assert int(self.runner.psql("SELECT count(*) FROM push_devices WHERE user_id=" + quote(self.recipient["id"]) + ";")) == 0, "expired_subscription_not_removed"
        self.device(self.recipient, "reader_rebound")
        self.delivered(self.event(self.feeding("after_rebind")["id"]))
        return {"providerStatus": 410, "expiredDeviceRows": 0, "realHTTPRebindDelivered": True}

    def check_legacy_zone(self):
        self.call("PATCH", "/api/v1/families/" + self.family["id"], 200, {"timeZone": "test_Invalid/Zone"}, self.actor)
        new = self.account("legacy_zone_reader")
        self.legacy_reader = new
        invite = self.call("POST", "/api/v1/families/" + self.family["id"] + "/invites", 201, {}, self.actor)
        self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite["inviteCode"]}, new)
        self.grant(new)
        self.device(new, "legacy_reader")
        default = self.call("GET", "/api/v1/me/notification-preferences?babyId=" + self.baby["id"], 200, account=new)
        assert default["timeZone"] == "UTC" and default["quietHours"] is None and default["kinds"]["family_record"] is True, "legacy_timezone_default_not_safe"
        old_recipient = self.recipient
        self.pref(False, baby=True, account=old_recipient)
        self.recipient = new
        try:
            self.delivered(self.event(self.feeding("legacy_zone")["id"]))
            self.pref(False, baby=True)
        finally:
            self.recipient = old_recipient
            self.pref(True, baby=True)
        self.call("PATCH", "/api/v1/families/" + self.family["id"], 200, {"timeZone": "UTC"}, self.actor)
        return {"legacyFamilyTimeZone": "test_Invalid/Zone", "effectiveDefaultTimeZone": "UTC", "actualProviderAccepted": True}

    def quiet_window(self):
        # Pick a real IANA fixed-offset zone where this real clock is just after
        # midnight, so the 22:00 -> 07:00 window is deterministically active.
        now = dt.datetime.now(dt.timezone.utc)
        offset = -now.hour
        if offset < -12:
            offset += 24
        zone = "Etc/GMT" + ("-" if offset > 0 else "+") + str(abs(offset)) if offset else "UTC"
        local = now + dt.timedelta(hours=offset)
        assert local.hour == 0, "quiet_timezone_selection_invalid"
        due = local.replace(hour=7, minute=0, second=0, microsecond=0) - dt.timedelta(hours=offset)
        return zone, {"start": "22:00", "end": "07:00"}, due

    def check_quiet_before(self):
        zone, quiet, expected_due = self.quiet_window()
        self.pref(True, baby=True, quiet=quiet, zone=zone)
        event = self.event(self.feeding("quiet_before")["id"])
        child = self.fanout(event)[0]
        before = self.fixture.count()
        self.once()
        after = self.task(child["id"])
        actual_due = parse_db_time(after["due"])
        assert after["status"] == "queued" and after["attempt"] == 0 and after["fence_token"] == 0, "quiet_child_claimed_before_due"
        assert abs((actual_due - expected_due).total_seconds()) < 2 and self.fixture.count() == before, "quiet_delivery_not_deferred_to_end"
        self.pref(True, baby=True)
        return {"realIanaTimeZone": zone, "quietHours": quiet, "nextDispatchAt": after["due"], "attempt": 0, "providerRequests": 0}

    def check_quiet_after(self):
        event = self.event(self.feeding("quiet_after")["id"])
        child = self.fanout(event)[0]
        zone, quiet, expected_due = self.quiet_window()
        self.pref(True, baby=True, quiet=quiet, zone=zone)
        before = self.fixture.count()
        self.once()
        after = self.task(child["id"])
        actual_due = parse_db_time(after["due"])
        assert after["status"] == "queued" and after["attempt"] == 1 and after["dispatch"] == "active", "late_quiet_consumed_retry_budget"
        assert abs((actual_due - expected_due).total_seconds()) < 2 and self.fixture.count() == before, "late_quiet_sent_or_wrong_due"
        self.once()
        assert self.task(child["id"])["attempt"] == 1 and self.fixture.count() == before, "quiet_delivery_reclaimed_or_sent"
        return {"realIanaTimeZone": zone, "quietHours": quiet, "nextDispatchAt": after["due"], "attemptBefore": 0,
                "attemptAfterFirstClaim": 1, "attemptAfterRepeatWorker": 1, "providerRequests": 0}

    def check_quiet_peer(self):
        assert self.fixture.count(self.unassigned["pushPath"]) == self.eligible_peer_requests, "unassigned_received_event_before_real_grant"
        self.grant(self.unassigned)
        zone, quiet, expected_due = self.quiet_window()
        self.pref(True, baby=True, quiet=quiet, zone=zone)
        event = self.event(self.feeding("quiet_peer")["id"])
        self.once()
        assert self.task(event["id"])["status"] == "succeeded", "multi_recipient_fanout_not_completed"
        notes = self.notification_rows(event)
        assert {n["user_id"] for n in notes} == {self.recipient["id"], self.unassigned["id"]}, "multi_recipient_notification_missing"
        children = self.children(event)
        assert len(children) == 2, "multi_recipient_delivery_missing"
        quiet_child = next(c for c in children if c["input"]["userId"] == self.recipient["id"])
        normal_child = next(c for c in children if c["input"]["userId"] == self.unassigned["id"])
        assert abs((parse_db_time(quiet_child["due"]) - expected_due).total_seconds()) < 2, "quiet_peer_due_invalid"
        before_quiet = self.fixture.count(self.recipient["pushPath"])
        before_normal = self.fixture.count(self.unassigned["pushPath"])
        self.once()
        assert self.task(normal_child["id"])["result_ref"]["delivered"] is True, "normal_peer_blocked_by_quiet_peer"
        assert self.fixture.count(self.unassigned["pushPath"]) == before_normal + 1, "normal_peer_provider_not_called"
        assert self.fixture.count(self.recipient["pushPath"]) == before_quiet, "quiet_peer_received_push"
        quiet_state = self.task(quiet_child["id"])
        assert quiet_state["status"] == "queued" and quiet_state["attempt"] == 0, "quiet_peer_consumed_attempt"
        self.eligible_peer_requests += 1
        self.revoke(self.unassigned)
        self.pref(True, baby=True)
        return {"actualHTTPBabyGrant": True, "notificationRecipients": 2, "quietRecipientRequests": 0,
                "nonquietRecipientAcceptedRequests": 1, "quietRecipientAttempt": 0,
                "unassignedRequestsWhileIneligible": 0}

    def check_actor_left(self):
        family_path = "/api/v1/families/" + self.family["id"]
        self.call("PATCH", family_path + "/members/" + self.recipient["id"], 200, {"role": "admin"}, self.actor)
        self.grant(self.recipient, role="admin")
        event = self.event(self.feeding("actor_left_after_commit")["id"])
        self.call("DELETE", family_path + "/members/" + self.actor["id"], 200, account=self.actor)
        self.call("GET", family_path, 404, account=self.actor)
        self.call("GET", self.baby_path("/records/feeding"), 403, account=self.actor)
        active = int(self.runner.psql("SELECT count(*) FROM family_members WHERE family_id=" + quote(self.family["id"]) +
                                     " AND user_id=" + quote(self.actor["id"]) + " AND status='active' AND deleted_at IS NULL;"))
        assert active == 0, "actor_family_membership_not_revoked"
        child = self.delivered(event)
        assert self.fixture.count(self.actor["pushPath"]) == 0, "actor_left_received_own_event"
        return {"record201BeforeDeparture": True, "actualHTTPAdminTransfer": True, "actualHTTPActorDeparture": True,
                "actorActiveFamilyMemberships": 0, "familyOwnedEventSucceeded": True,
                "recipientProvider201": child["result_ref"]["delivered"]}

    def check_device_overflow(self):
        self.grant(self.unassigned)
        first, later = sorted((self.recipient, self.unassigned), key=lambda account: account["id"])
        installations = []
        path_prefix = "/test_" + self.runner.run_id + "_overflow_"
        before_first = self.fixture.count(first["pushPath"])
        before_later = self.fixture.count(later["pushPath"])
        try:
            for index in range(64):
                installation = str(uuid.uuid4())
                subscription = {"endpoint": self.fixture.origin + path_prefix + str(index), "keys": self.environment["subscriptionKeys"]}
                self.call("PUT", "/api/v1/devices/" + installation + "/push", 200,
                          {"platform": "web", "environment": "production", "token": json.dumps(subscription),
                           "deviceLabel": "test_oversized_family_recipient"}, first)
                installations.append(installation)
            observed = int(self.runner.psql("SELECT count(*) FROM push_devices WHERE user_id=" + quote(first["id"]) + ";"))
            assert observed == 65, "oversized_devices_not_saved_via_http"
            event = self.event(self.feeding("device_overflow")["id"])
            self.once()
            head = self.task(event["id"])
            assert head["status"] == "succeeded" and head["dispatch"] == "closed", "oversized_recipient_blocked_family_fanout"
            result = head["result_ref"]
            assert result["fanoutComplete"] is True and result["recipientErrorCount"] == 1, "oversized_recipient_error_not_reported"
            error = result["recipientErrors"][first["id"]]
            assert error["code"] == "NOTIFICATION_DEVICE_LIMIT" and error["deviceLimit"] == 64 and error["devicesObservedAtLeast"] == 65 and error["delivered"] is False, "oversized_recipient_error_details_invalid"
            notes = self.notification_rows(event)
            assert {n["user_id"] for n in notes} == {first["id"], later["id"]}, "oversized_recipient_inbox_or_later_recipient_missing"
            oversized_note = next(note for note in notes if note["user_id"] == first["id"])
            assert error["notificationId"] == oversized_note["id"], "oversized_error_notification_mismatch"
            for note in notes:
                count = int(self.runner.psql("SELECT count(*) FROM user_changes WHERE user_id=" + quote(note["user_id"]) +
                                             " AND entity_type='notification' AND entity_id=" + quote(note["id"]) + ";"))
                assert count == 1, "oversized_recipient_user_change_missing_or_duplicate"
            children = self.children(event)
            assert len(children) == 1 and children[0]["input"]["userId"] == later["id"], "oversized_devices_silently_truncated_or_later_blocked"
            self.once()
            assert self.task(children[0]["id"])["result_ref"]["delivered"] is True, "later_recipient_delivery_not_completed"
            assert self.fixture.count(later["pushPath"]) == before_later + 1, "later_recipient_provider_not_called"
            assert self.fixture.count(first["pushPath"]) == before_first and not any(r["path"].startswith(path_prefix) for r in self.fixture.requests), "oversized_recipient_received_silent_partial_delivery"
            if later["id"] == self.unassigned["id"]:
                self.eligible_peer_requests += 1
            return {"savedDeviceRows": observed, "oversizedRecipientOrderedBeforeOther": first["id"] < later["id"],
                    "oversizedInboxAndUserChange": True, "oversizedDeliveryTasks": 0, "oversizedProviderRequests": 0,
                    "explicitRecipientError": error, "laterRecipientAcceptedRequests": 1, "fanoutComplete": True}
        finally:
            for installation in installations:
                self.call("DELETE", "/api/v1/devices/" + installation + "/push", 200, account=first)
            self.revoke(self.unassigned)

    def check_snapshot_task(self):
        path = "/api/v1/sync/families/" + self.family["id"] + "/snapshots"
        snapshot = self.call("POST", path, 202, account=self.actor)
        manifest_path = path + "/" + snapshot["snapshotId"]
        queued = self.call("GET", manifest_path, 200, account=self.actor)
        assert queued["status"] == "queued", "owned_snapshot_not_readable"
        self.call("GET", manifest_path, 404, account=self.recipient)
        requests = self.fixture.count()
        self.once()
        ready = self.call("GET", manifest_path, 200, account=self.actor)
        assert ready["status"] == "ready" and ready["pageCount"] > 0, "actual_snapshot_worker_not_ready"
        self.call("GET", manifest_path, 404, account=self.recipient)
        pages = int(self.runner.psql("SELECT jsonb_array_length(manifest->'pages') FROM sync_snapshots WHERE id=" + quote(snapshot["snapshotId"]) + ";"))
        assert pages == ready["pageCount"] and self.task(snapshot["snapshotId"])["status"] == "succeeded", "snapshot_pages_not_persisted_by_worker"
        assert self.fixture.count() == requests, "snapshot_worker_sent_push"
        return {"POST": 202, "ownedManifestGETQueued": 200, "otherPrincipalManifestGET": [404, 404],
                "ownedManifestGETReady": 200, "persistedPageCount": pages, "actualSnapshotWorker": True,
                "dormantTaskAndPageHandlersNotClaimedAsHTTP": True}

    def profile_record(self, label):
        return self.call("POST", self.baby_path("/records/feeding"), 201, self.feeding_body(label),
                         self.profile_actor, "test_profile_record_" + str(uuid.uuid4()))

    def profile_task_candidates(self):
        ai_session = self.call("POST", "/api/v1/ai/sessions", 201,
                               {"babyId": self.baby["id"], "title": "test_notifications_only_worker"}, self.profile_actor)
        ai_path = "/api/v1/ai/sessions/" + ai_session["id"] + "/runs"
        ai_queued = self.call("POST", ai_path, 202, {"clientMessageId": str(uuid.uuid4()),
                                "message": "test_notifications_only_queued_ai", "attachmentIds": []}, self.profile_actor)
        ai_recovery = self.call("POST", ai_path, 202, {"clientMessageId": str(uuid.uuid4()),
                                  "message": "test_notifications_only_expired_ai", "attachmentIds": []}, self.profile_actor)
        self.runner.psql("UPDATE task_executions SET status='running',attempt=1,fence_token=7,lease_owner='test_expired_worker_lease',"
                         "lease_expires_at=clock_timestamp()-INTERVAL '1 second',updated_at=NOW()-INTERVAL '1 hour' WHERE id=" + quote(ai_recovery["id"]) + ";")
        export = self.call("POST", "/api/v1/me/export", 202, account=self.profile_actor)
        snapshot = self.call("POST", "/api/v1/sync/families/" + self.family["id"] + "/snapshots", 202, account=self.profile_actor)
        daily = self.call("POST", self.baby_path("/daily-summaries/runs"), 202,
                          {"targetDate": "2026-10-06"}, self.profile_actor)
        voice = self.queue_unrelated_task("voice_transcription", self.profile_actor,
                    {"familyId": self.family["id"], "babyId": self.baby["id"], "attachmentIds": [str(uuid.uuid4())]})
        ocr = self.queue_unrelated_task("medical_ocr", self.profile_actor,
                  {"familyId": self.family["id"], "babyId": self.baby["id"], "attachmentIds": [str(uuid.uuid4())]})
        notification_id = self.runner.psql("SELECT id FROM notifications WHERE user_id=" + quote(self.profile_recipient["id"]) +
                                           " ORDER BY created_at DESC,id DESC LIMIT 1;")
        device_id = self.runner.psql("SELECT id FROM push_devices WHERE user_id=" + quote(self.profile_recipient["id"]) +
                                     " ORDER BY created_at,id LIMIT 1;")
        assert notification_id and device_id, "profile_push_fixture_missing_notification_or_device"
        plain_push = self.queue_unrelated_task("push_delivery", self.profile_recipient,
                       {"notificationId": notification_id, "pushDeviceId": device_id})
        expired_plain_push = self.queue_unrelated_task("push_delivery", self.profile_recipient,
                               {"notificationId": notification_id, "pushDeviceId": device_id}, expired=True)
        ids = {"aiQueued": ai_queued["id"], "aiExpiredLease": ai_recovery["id"], "userExport": export["taskId"],
               "snapshot": snapshot["snapshotId"], "dailySummary": daily["runId"], "voice": voice,
               "medicalOcr": ocr, "ordinaryPushDelivery": plain_push, "ordinaryPushExpiredLease": expired_plain_push}
        states = {name: self.task_state(task_id) for name, task_id in ids.items()}
        assert states["aiQueued"]["execution"]["status"] == "queued" and states["aiQueued"]["execution"]["attempt"] == 0, "profile_ai_fixture_not_queued"
        assert states["userExport"]["execution"]["status"] == "queued" and states["userExport"]["execution"]["attempt"] == 0, "profile_export_fixture_not_queued"
        assert states["aiExpiredLease"]["execution"]["status"] == "running" and states["aiExpiredLease"]["execution"]["attempt"] == 1, "profile_expired_lease_fixture_invalid"
        self.profile_blocked_ids, self.profile_blocked_states = ids, states
        return ids, states

    def check_notifications_only_once(self):
        invocation_start = self.worker_runs
        self.grant(self.unassigned, grantor=self.recipient)
        self.revoke(self.legacy_reader, grantor=self.recipient)
        self.profile_actor, self.profile_recipient = self.recipient, self.unassigned
        ids, blocked_before = self.profile_task_candidates()

        # Queue and fan out an actual family event, then add an older ordinary
        # outbox row to its push task. The profile must select the tagged row,
        # so current preference checks run against the family metadata.
        guarded_event = self.event(self.profile_record("profile_duplicate_metadata")["id"])
        self.once(notifications_only=True)
        guarded_child = self.children(guarded_event)[0]
        self.pref(False, baby=True, account=self.profile_recipient)
        ordinary_input = dict(guarded_child["input"])
        ordinary_input.pop("familyRecord", None)
        ordinary_payload = json.dumps({"__native": ordinary_input}, separators=(",", ":"))
        duplicate_outbox = str(uuid.uuid4())
        self.runner.psql("INSERT INTO task_outbox(id,type,aggregate_id,payload_version,payload,phase_key,dispatch_state,next_dispatch_at,created_at) VALUES(" +
                         quote(duplicate_outbox) + ",'push_delivery'," + quote(guarded_child["id"]) + ",1," + quote(ordinary_payload) +
                         "::jsonb,'native-initial','active',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour');")
        duplicate_before = self.sql_json("SELECT to_jsonb(o) FROM task_outbox o WHERE id=" + quote(duplicate_outbox) + ";")
        provider_before = self.fixture.count()
        self.once(notifications_only=True)
        guarded_after = self.task(guarded_child["id"])
        duplicate_after = self.sql_json("SELECT to_jsonb(o) FROM task_outbox o WHERE id=" + quote(duplicate_outbox) + ";")
        assert guarded_after["status"] == "succeeded" and guarded_after["result_ref"]["delivered"] is False and guarded_after["result_ref"]["skippedReason"] == "preferences_disabled", "tagged_outbox_metadata_not_used_for_family_delivery"
        assert duplicate_after == duplicate_before and duplicate_after["dispatch_state"] == "active" and duplicate_after["last_dispatched_at"] is None, "notifications_worker_touched_untagged_duplicate_outbox"
        assert self.fixture.count() == provider_before, "untagged_duplicate_outbox_bypassed_family_preference_guard"
        self.pref(True, baby=True, account=self.profile_recipient)
        pending_guarded = [child for child in self.children(guarded_event) if self.task(child["id"])["status"] == "queued"]
        if pending_guarded:
            self.once(count=len(pending_guarded), notifications_only=True)
        assert all(self.task(child["id"])["status"] == "succeeded" for child in self.children(guarded_event)), "guarded_family_event_left_pending_child"

        request_before = self.fixture.count(self.profile_recipient["pushPath"])
        actual_event = self.event(self.profile_record("profile_real_push")["id"])
        self.once(notifications_only=True)
        actual_head = self.task(actual_event["id"])
        actual_children = self.children(actual_event)
        assert actual_head["status"] == "succeeded" and len(actual_children) >= 1, "notifications_worker_did_not_fanout_family_event"
        self.once(count=len(actual_children), notifications_only=True)
        actual_children = [self.task(child["id"]) for child in actual_children]
        assert all(child["status"] == "succeeded" and child["result_ref"]["delivered"] is True for child in actual_children), "notifications_worker_did_not_finish_family_delivery"
        assert self.fixture.count(self.profile_recipient["pushPath"]) == request_before + 1, "notifications_worker_owned_push_request_missing_or_duplicate"
        self.eligible_peer_requests += 1
        receipt = next(r for r in reversed(self.fixture.requests) if r["path"] == self.profile_recipient["pushPath"])
        assert receipt["encrypted"] and receipt["status"] == 201 and receipt["payload"]["decrypted"] and receipt["payload"]["privacySafe"], "notifications_worker_push_not_decrypted_or_private"
        assert receipt["payload"]["data"]["eventKey"] == actual_event["input"]["familyRecord"]["eventKey"], "notifications_worker_push_event_mismatch"
        blocked_after = {name: self.task_state(task_id) for name, task_id in ids.items()}
        assert blocked_after == blocked_before, "notifications_worker_changed_unrelated_task_or_lease_state"
        return {"oneShotProcesses": self.worker_runs - invocation_start, "familyEventAndTaggedDelivery": "succeeded", "familyRecipients": len(actual_children), "ownedLoopbackRequest": "encrypted_and_decrypted",
                "unrelatedKinds": [blocked_after[name]["execution"]["kind"] for name in ids],
                "queuedAIExportSnapshotDailyVoiceOcrAndPlainPushUnchanged": True,
                "expiredAIAndOrdinaryPushLeasesAndAllOutboxMetadataUnchanged": True,
                "untaggedDuplicateOutboxPreserved": True, "providerRequestsDuringPreferenceGuard": 0}

    def check_notifications_only_long_poll(self):
        ids, blocked_before = self.profile_blocked_ids, self.profile_blocked_states
        process, output = self.start_worker(notifications_only=True, once=False)
        idle_requests = self.fixture.count()
        idle_recipient_requests = self.fixture.count(self.profile_recipient["pushPath"])
        try:
            time.sleep(0.75)
            assert process.poll() is None, "notifications_worker_long_poll_exited_early"
            idle_after = {name: self.task_state(task_id) for name, task_id in ids.items()}
            assert idle_after == blocked_before and self.fixture.count() == idle_requests, "notifications_worker_long_poll_touched_unrelated_task"
            event = self.event(self.profile_record("profile_long_poll")["id"])
            deadline = time.monotonic() + 25
            children = []
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError("notifications_worker_long_poll_exited_after_enqueue")
                head = self.task(event["id"])
                children = self.children(event)
                child_states = [self.task(child["id"]) for child in children]
                if head["status"] == "succeeded" and child_states and all(child["status"] == "succeeded" for child in child_states):
                    break
                time.sleep(0.1)
            assert head["status"] == "succeeded" and children and all(child["result_ref"]["delivered"] is True for child in child_states), "notifications_worker_long_poll_missed_family_event"
            assert self.fixture.count(self.profile_recipient["pushPath"]) == idle_recipient_requests + 1, "notifications_worker_long_poll_provider_not_called_or_duplicate"
            assert self.fixture.count() == idle_requests + len(children), "notifications_worker_long_poll_request_count_invalid"
            self.eligible_peer_requests += 1
            after = {name: self.task_state(task_id) for name, task_id in ids.items()}
            assert after == blocked_before, "notifications_worker_long_poll_changed_unrelated_task_or_lease_state"
        finally:
            self.stop_worker(process)
            output.close()
        return {"continuousWorkerStartedBeforeEvent": True, "idleTimeSeconds": 0.75, "familyEventAndDelivery": "succeeded",
                "unrelatedTaskRowsAndOutboxesUnchanged": True, "workerStopped": process.poll() is not None}

    def check_ai_replay(self):
        account = self.recipient
        session = self.call("POST", "/api/v1/ai/sessions", 201, {"babyId": self.baby["id"], "title": "test_owned_ai_replay"}, account)
        path = "/api/v1/ai/sessions/" + session["id"] + "/runs"
        body = {"clientMessageId": str(uuid.uuid4()), "message": "test_only_ai_replay_no_worker", "attachmentIds": []}
        workers = self.worker_runs
        requests = self.fixture.count()
        first = self.call("POST", path, 202, body, account)
        replay = self.call("POST", path, self.ai_empty_replay_status, body, account)
        replay_matches_first = False
        if self.ai_empty_replay_status == 202:
            assert replay.get("id") == first.get("id"), "ai_empty_replay_run_id_changed"
            assert replay == first, "ai_empty_replay_full_response_changed"
            replay_matches_first = True
        else:
            assert replay["error"]["code"] == "CLIENT_MESSAGE_CONFLICT", "ai_replay_regressed_from_baseline_conflict"
        messages = int(self.runner.psql("SELECT count(*) FROM ai_messages WHERE id=" + quote(body["clientMessageId"]) + ";"))
        runs = int(self.runner.psql("SELECT count(*) FROM ai_runs WHERE id=" + quote(first["id"]) + ";"))
        outbox = int(self.runner.psql("SELECT count(*) FROM task_outbox WHERE aggregate_id=" + quote(first["id"]) + ";"))
        assert messages == runs == outbox == 1, "ai_replay_created_duplicate_persistence"
        changed_body = self.call("POST", path, 409, {**body, "message": "test_only_changed_message"}, account)
        assert changed_body["error"]["code"] == "CLIENT_MESSAGE_CONFLICT", "ai_changed_message_replay_not_rejected"
        task = self.call("GET", "/api/v1/ai/runs/" + first["id"], 200, account=account)
        assert task == first, "ai_replay_retained_run_response_changed"
        raw = self.task(first["id"])
        assert task["status"] == "queued" and raw["attempt"] == 0 and raw["fence_token"] == 0, "ai_worker_unexpectedly_started"
        assert self.worker_runs == workers and self.fixture.count() == requests, "ai_replay_invoked_worker_or_push"
        self.last_ai_replay_task = first["id"]
        evidence = {"createHTTP": 202, "replayHTTP": self.ai_empty_replay_status,
                    "firstAndReplaySameRunId": self.ai_empty_replay_status == 202,
                    "fullReplayResponseMatchesCreate": replay_matches_first,
                    "retainedGETMatchesCreateResponse": True,
                    "messageRows": messages, "runRows": runs, "outboxRows": outbox,
                    "changedMessageHTTP": 409, "changedMessageCode": "CLIENT_MESSAGE_CONFLICT",
                    "workerRunDelta": self.worker_runs - workers,
                    "providerRequestDelta": self.fixture.count() - requests,
                    "retainedTaskAttempt": 0, "retainedTaskFenceToken": 0}
        if self.ai_empty_replay_status == 409:
            limitation = {"code": "PREEXISTING_AI_EMPTY_ATTACHMENT_REPLAY_409", "createHTTP": 202, "replayHTTP": 409,
                          "sameClientMessageReplay202Verified": False,
                          "regressionCriterion": "no metadata 500; original HEAD also returned CLIENT_MESSAGE_CONFLICT"}
            self.report.setdefault("knownLimitations", []).append(limitation)
            evidence.update(limitation)
        else:
            evidence["sameClientMessageReplay202Verified"] = True
        return evidence

    def probe_ai_empty_replay(self):
        self.setup()
        name = f"AI empty-attachment replay strict expected status {self.ai_empty_replay_status}"
        self.active_case = name
        try:
            evidence = self.check_ai_replay()
        finally:
            self.active_case = None
        self.report["aiEmptyReplayProbe"] = evidence
        self.report["cases"].append({"name": name, "expected": self.ai_empty_replay_status,
                                     "actual": evidence["replayHTTP"], "passed": True, "evidence": evidence})
        print("PASS " + name, flush=True)


def snapshot_baseline(runtime, runner, server_root, head):
    source = runner.private / "baseline-source"
    source.mkdir()
    archive = subprocess.check_output(["git", "archive", head], cwd=server_root, env=runtime.clean_env())
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                raise RuntimeError("baseline_archive_member_rejected")
        tar.extractall(source)
    runtime.SERVER_ROOT = source
    return hashlib.sha256(archive).hexdigest()


def fixed_source_manifest(runtime, server_root):
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                      cwd=server_root, env=runtime.clean_env()).decode().split("\0")
    inputs = {}
    for name in sorted(set(tracked)):
        path = PurePosixPath(name)
        needed = (name.endswith(".go") or name in ("go.mod", "go.sum", "contracts/openapi.json", "packages/domain/src/who-growth-standards.ts",
                                                  "apps/api/src/knowledge/legacy-reference-data.ts", "apps/api/src/knowledge/books-data.ts")
                  or (name.endswith(".sql") and (name.startswith("prisma/migrations/") or name.startswith("native/migrations/"))))
        if not needed:
            continue
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError("fixed_source_path_rejected")
        original = server_root / name
        if original.is_symlink() or not original.is_file():
            raise RuntimeError("fixed_source_link_or_file_rejected")
        raw = original.read_bytes()
        inputs[name] = hashlib.sha256(raw).hexdigest()
    return inputs


def snapshot_fixed(runtime, runner, server_root):
    source = runner.private / "fixed-source"
    source.mkdir()
    inputs = fixed_source_manifest(runtime, server_root)
    for name in sorted(inputs):
        original = server_root / name
        raw = original.read_bytes()
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    runtime.SERVER_ROOT = source
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"freezeCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=server_root,
                                                      env=runtime.clean_env(), text=True).strip(),
            "immutableInputsSha256": digest, "inputs": inputs}


def start_api(runtime, runner, fixture, head):
    binary = runner.private / "growdesk-api"
    worker = runner.private / "growdesk-worker"
    migrate = runner.private / "growdesk-migrate"
    for target, path in (("api", binary), ("worker", worker), ("migrate", migrate)):
        runtime.command(["go", "build", "-mod=readonly", "-trimpath", "-ldflags=-X main.revision=" + head,
                         "-o", str(path), "./cmd/growdesk-" + target], cwd=runtime.SERVER_ROOT, env=runtime.clean_env(), timeout=300)
    keys = json.loads(runtime.command(["node", "--input-type=module", "-e", """
      import {createECDH, randomBytes} from 'node:crypto';
      const sender=createECDH('prime256v1'); sender.generateKeys();
      const receiver=createECDH('prime256v1'); receiver.generateKeys();
      process.stdout.write(JSON.stringify({public:sender.getPublicKey().toString('base64url'),private:sender.getPrivateKey().toString('base64url'),receiverPrivate:receiver.getPrivateKey().toString('base64url'),
        subscriptionKeys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}}));
    """], cwd=runtime.SERVER_ROOT, env=runtime.clean_env()))
    config = {
        "GROWDESK_GO_EXPERIMENTAL": "1", "GROWDESK_ENV": "test", "HOST": "127.0.0.1", "PORT": str(runner.api_port),
        "DATABASE_URL": f"postgresql://{runner.app_role}:{runner.pg_app_password}@127.0.0.1:{runner.pg_port}/{runner.database}?sslmode=disable",
        "REDIS_URL": f"redis://default:{runner.redis_password}@127.0.0.1:{runner.redis_port}/0", "JWT_SECRET": runner.jwt_secret,
        "SESSION_ENCRYPTION_KEY": runner.session_key, "INVITE_SECRET": runner.invite_secret, "PUBLIC_BASE_URL": runner.api_url,
        "GROWDESK_AI_PROVIDER": "fixture", "GROWDESK_AI_FIXTURE_RESPONSE": '{"text":"test_only_read_only_response","actions":[]}',
        "GROWDESK_PUSH_TEST_ORIGIN": fixture.origin,
        "VAPID_PUBLIC_KEY": keys["public"], "VAPID_PRIVATE_KEY": keys["private"], "VAPID_SUBJECT": "mailto:test_family_push@example.invalid",
    }
    runtime.persist_private_json(runner.private / "api-runtime-secrets.json", config)
    env = runtime.clean_env(config)
    fixture.decrypt_config = (runtime, keys)
    runtime.command([str(migrate)], cwd=runtime.SERVER_ROOT, env=env, timeout=60)
    # Run twice to exercise the actual native migration checksum/replay path.
    runtime.command([str(migrate)], cwd=runtime.SERVER_ROOT, env=env, timeout=60)
    runner.spawn("api", [str(binary)], env=env)
    runner.wait_for(runner.api_ready, "owned API readiness")
    return worker, {"env": env, "subscriptionKeys": keys["subscriptionKeys"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", required=True, type=Path)
    parser.add_argument("--ios-root", type=Path, default=Path("/Users/wangzhuo/Documents/GitHub/growdesk-ios"))
    parser.add_argument("--phase", required=True, choices=("baseline", "fixed"))
    parser.add_argument("--probe", choices=("family-push", "ai-empty-replay", "readable-food"), default="family-push")
    parser.add_argument("--ai-empty-replay-status", type=int, choices=(202, 409), default=409,
                        help="expected replay HTTP status in AI replay acceptance (default: 409)")
    args = parser.parse_args()
    server_root = args.server_root.resolve()
    if not (server_root / ".git").is_file() or server_root != ROOT:
        raise RuntimeError("explicit_isolated_worktree_required")
    helper = args.ios_root.resolve() / "scripts/test-cloud-parity.py"
    spec = importlib.util.spec_from_file_location("owned_family_push_runtime", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError("owned_runner_missing")
    runtime = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = runtime
    sys.dont_write_bytecode = True
    spec.loader.exec_module(runtime)
    original_env = runtime.clean_env
    runtime.clean_env = lambda extra=None: original_env({"GOPROXY": "off", "GOTOOLCHAIN": "go1.27.0", **(extra or {})})
    runtime.SERVER_ROOT = server_root
    runtime.EVIDENCE_ROOT = server_root / "evidence/tasks" / TASK_ID
    run_id = secrets.token_hex(6)
    runner = runtime.OwnedRun(run_id)
    report = {"taskId": TASK_ID, "runId": run_id, "phase": args.phase, "probe": args.probe, "passed": False, "cases": [],
              "aiEmptyReplayExpectedStatus": args.ai_empty_replay_status,
              "status": "IMPLEMENTED_NOT_REVIEWED", "externalPushRequests": 0, "physicalDeviceDeliveryVerified": False,
              "proof": "real HTTP, PostgreSQL, native worker and webpush-go; only owned loopback provider responses are simulated"}
    report["harness"] = {"scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                         "ownedRunSource": str(helper), "ownedRunSourceSha256": hashlib.sha256(helper.read_bytes()).hexdigest()}
    fixture = None
    journey = None
    stage = "source_snapshot"
    code = 1
    try:
        head = runtime.command(["git", "rev-parse", "HEAD"], cwd=server_root, env=runtime.clean_env())
        report["source"] = {"serverRoot": str(server_root), "head": head}
        if args.phase == "baseline":
            report["source"]["baselineArchiveSha256"] = snapshot_baseline(runtime, runner, server_root, head)
        else:
            report["source"].update(snapshot_fixed(runtime, runner, server_root))
        for binary, prefix in (("postgres", "postgres (PostgreSQL) 18."), ("redis-server", "Redis server v=8.")):
            assert runtime.command([runner.executable(binary), "--version"], env=runtime.clean_env()).startswith(prefix), "owned_dependency_version_rejected"
        stage = "owned_postgres"
        runner.init_postgres()
        stage = "owned_redis"
        runner.init_redis()
        fixture = PushFixture()
        stage = "owned_go_build_and_boot"
        worker, environment = start_api(runtime, runner, fixture, head)
        report["nativeMigrations"] = json.loads(runner.psql("SELECT COALESCE(jsonb_agg(name ORDER BY name),'[]'::jsonb) FROM native_go.migrations;"))
        report["isolation"] = {"host": "127.0.0.1", "database": runner.database, "role": runner.app_role, "superuser": False,
                               "postgresPort": runner.pg_port, "redisPort": runner.redis_port, "apiPort": runner.api_port,
                               "pushFixturePort": fixture.port, "virtualVapid": True, "freshCluster": True}
        identity = runner.psql("SELECT current_database() || '|' || current_user || '|' || (SELECT rolsuper::text FROM pg_roles WHERE rolname=current_user);")
        assert identity == runner.database + "|" + runner.app_role + "|false", "owned_database_identity_mismatch"
        journey = Journey(runtime, runner, fixture, worker, environment, report, args.ai_empty_replay_status)
        stage = "real_http_cases"
        if args.probe == "ai-empty-replay":
            journey.probe_ai_empty_replay()
        elif args.probe == "readable-food":
            assert args.phase == "fixed", "readable_food_probe_requires_fixed_phase"
            journey.setup()
            journey.case("legacy food screenshot values render as readable family-local inbox and push copy", journey.check_readable_food_copy)
        elif args.phase == "baseline":
            journey.baseline()
        else:
            journey.fixed()
        report["passed"] = True
        code = 0
    except (Exception, KeyboardInterrupt) as error:
        report["failure"] = {"stage": stage, "class": type(error).__name__}
        message = str(error)
        if re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_:.=]{0,160}", message):
            report["failure"]["code"] = message
        elif re.fullmatch(r"(?:GET|PUT|POST|PATCH|DELETE) /api/v1/[A-Za-z0-9_./-]+: expected \d+, received \d+, code=[A-Za-z0-9_]+", message):
            report["failure"]["httpMismatch"] = message
        if journey and journey.active_case:
            report["failure"]["case"] = journey.active_case
        print("FAIL family push owned acceptance: " + stage + " (" + type(error).__name__ + ")", flush=True)
    finally:
        if args.phase == "fixed" and report.get("source", {}).get("inputs"):
            try:
                expected = report["source"]["inputs"]
                current = fixed_source_manifest(runtime, server_root)
                drift = sorted(name for name in set(expected) | set(current) if expected.get(name) != current.get(name))
                head_after = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=server_root,
                                                     env=runtime.clean_env(), text=True).strip()
                if head_after != report["source"]["freezeCommit"]:
                    drift.append("HEAD")
                report["source"]["drift"] = drift
                report["source"]["headAfter"] = head_after
                report["source"]["immutableInputsSha256After"] = hashlib.sha256(
                    json.dumps(current, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                if drift:
                    code = 1
            except Exception as error:
                report["source"]["drift"] = ["verification_failed:" + type(error).__name__]
                code = 1
        if journey:
            stop_errors = []
            for process in journey.worker_processes:
                try:
                    journey.stop_worker(process)
                except Exception as error:
                    stop_errors.append(type(error).__name__)
                    code = 1
            report["worker"] = {"actualNativeRuns": journey.worker_runs,
                                "allOwnedProcessesExited": all(p.poll() is not None for p in journey.worker_processes),
                                "stopErrors": stop_errors}
            report["testUsers"] = journey.test_users
            report["httpAssertions"] = journey.http.assertions
        if fixture:
            report["fixture"] = {"requests": fixture.requests, "count": fixture.count()}
            try:
                fixture.close()
                report["fixture"]["stopped"] = True
            except Exception as error:
                report["fixture"]["stopError"] = type(error).__name__
                code = 1
        try:
            report["cleanup"] = runner.cleanup()
            report["cleanup"]["taskId"] = TASK_ID
            report["cleanup"]["resources"] = ["owned PostgreSQL cluster", "test database and non-superuser role", "owned Redis process",
                                                "owned Go API process", "explicitly joined native workers", "owned loopback HTTP push fixture"]
            (runner.evidence / "backend-cleanup.json").write_text(json.dumps(report["cleanup"], indent=2) + "\n")
        except Exception as error:
            report["cleanup"] = {"status": "cleanup_failed", "class": type(error).__name__}
            code = 1
        if runner.logs.exists():
            shutil.rmtree(runner.logs)
        report["passed"] = code == 0
        target = runner.evidence / "persistence-report.json"
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print("PERSISTENCE_REPORT=" + str(target), flush=True)
    return code


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_args: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt) as error:
        print("Owned family push setup rejected (" + type(error).__name__ + ").", flush=True)
        raise SystemExit(1)
