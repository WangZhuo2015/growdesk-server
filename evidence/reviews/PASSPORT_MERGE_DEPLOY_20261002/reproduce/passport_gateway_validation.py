import base64, hashlib, hmac, json, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import websocket
from native_validation import NativeOwned, base, BIN, OUT, PG

class Provider(BaseHTTPRequestHandler):
    calls = 0
    entered = threading.Event()
    release = threading.Event()
    def log_message(self, *args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length','0')))
        if self.path.endswith('/audio/transcriptions'):
            body = {'text':'test diaper proposal'}
        elif self.path.endswith('/chat/completions'):
            Provider.calls += 1
            number = Provider.calls
            if number == 2:
                Provider.entered.set()
                if not Provider.release.wait(10): raise RuntimeError('test provider barrier timed out')
            proposal = {'text':'','actions':[{'actionId':str(uuid.uuid4()),'entityType':'diaper','operation':'create','summary':'test diaper proposal','payload':{'diaperType':'pee','occurredAt':'2026-10-02T00:00:00Z'}}]}
            body = {'choices':[{'message':{'content':json.dumps(proposal)}}]}
        else: raise AssertionError('unexpected local provider request')
        raw = json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)

def wait_frame(ws, kind):
    for _ in range(30):
        raw = ws.recv()
        if isinstance(raw, str):
            msg = json.loads(raw)
            if msg.get('type') == kind: return msg
            if msg.get('type') == 'error': raise AssertionError(msg)
    raise AssertionError('expected frame '+kind)

def send(ws, body): ws.send(json.dumps({'v':1, **body}))
def voice(ws, turn):
    send(ws, {'type':'audio.start','turnId':turn})
    ws.send_binary(bytes(3200))
    send(ws, {'type':'audio.end','turnId':turn})
def confirmation(card):
    return {'type':'card.confirm','runId':card['runId'],**card['confirmation']}

def main():
    owned = NativeOwned()
    provider = ThreadingHTTPServer(('127.0.0.1',0),Provider)
    thread = threading.Thread(target=provider.serve_forever,daemon=True); thread.start()
    ws = lock = None
    evidence = []
    try:
        owned.start()
        owned.env.update(GROWDESK_AI_PROVIDER='openai-compatible',GROWDESK_AI_BASE_URL=f'http://127.0.0.1:{provider.server_port}/v1',GROWDESK_AI_API_KEY='test_unused',GROWDESK_AI_MODEL='test_local',GROWDESK_AI_TIMEOUT_MS='15000')
        host = owned.serve(BIN)
        def expect(method,path,status,body=None,token=None): return base.expect(host,method,path,status,body,token)
        user = expect('POST','/api/v1/auth/register',201,{'username':'test_passport_gateway','password':'test_passport_password_8675309','displayName':'test passport','deviceLabel':'test browser'})['data']
        token = user['accessToken']
        family = expect('POST','/api/v1/families',201,{'name':'test Passport Family','timeZone':'UTC'},token)['data']['id']
        baby = expect('POST',f'/api/v1/families/{family}/babies',201,{'name':'test Passport Baby','birthDate':'2026-01-02','gender':'girl'},token)['data']['id']
        pairing = expect('POST','/api/v1/passport/pairings',201,{'hardware':'test Passport','firmwareVersion':'test review'})['data']
        pollpath = f"/api/v1/passport/pairings/{pairing['pairingId']}/poll"
        assert expect('POST',pollpath,200,{'pollToken':pairing['pollToken']})['data']['status'] == 'pending'
        expect('POST','/api/v1/passport/pairings/claim',200,{'pairCode':pairing['pairCode'],'familyId':family,'babyId':baby,'deviceLabel':'test Passport'},token)
        device = expect('POST',pollpath,200,{'pollToken':pairing['pollToken']})['data']
        assert 'deviceCredential' not in expect('POST',pollpath,200,{'pollToken':pairing['pollToken']})['data']
        access = expect('POST','/api/v1/passport/auth/token',200,{'deviceId':device['deviceId'],'deviceCredential':device['deviceCredential']})['data']['accessToken']
        evidence.append('real DB pairing/claim/one-time credential/auth PASS')
        enc = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
        jwt_header, jwt_payload, _ = access.split('.')
        claims = json.loads(base64.urlsafe_b64decode(jwt_payload+'='*((-len(jwt_payload))%4)))
        claims['exp'] = int(time.time()) + 2
        unsigned = jwt_header+'.'+enc(json.dumps(claims).encode())
        short_token = unsigned+'.'+enc(hmac.new(owned.jwt.encode(),unsigned.encode(),hashlib.sha256).digest())
        expiring = websocket.create_connection(host.replace('http://','ws://')+'/api/v1/passport/ws',header=['Authorization: Bearer '+short_token],timeout=5)
        send(expiring,{'type':'hello'}); wait_frame(expiring,'ready')
        started = time.monotonic()
        try:
            assert expiring.recv() == '', 'idle token-expired connection remained open'
        except websocket.WebSocketConnectionClosedException: pass
        finally: expiring.close()
        assert time.monotonic()-started < 4
        evidence.append('idle WebSocket closes at JWT expiry PASS')
        ws = websocket.create_connection(host.replace('http://','ws://')+'/api/v1/passport/ws',header=['Authorization: Bearer '+access],timeout=12)
        send(ws,{'type':'hello'}); assert wait_frame(ws,'ready')['baby']['id'] == baby
        voice(ws,'test_turn_1'); first = wait_frame(ws,'card.present')
        count = lambda: int(owned.sql(f"SELECT count(*) FROM diaper_records WHERE baby_id='{baby}'"))
        for value in (None,[],['test_wrong'],[1],[first['confirmation']['actionIds'][0]]*2):
            req = confirmation(first)
            if value is None: req.pop('actionIds')
            else: req['actionIds'] = value
            send(ws,req); error = wait_frame(ws,'error')
            assert error['code'] == 'INVALID_CONFIRMATION',error
            assert count() == 0
        evidence.append('invalid/missing/empty/duplicate/nonstring action selections reject without DB writes PASS')
        lock = subprocess.Popen([str(PG/'psql'),'-X','-h','127.0.0.1','-p',str(owned.pgport),'-U',owned.role,'-d',owned.database,'-qAt','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        lock.stdin.write(f"BEGIN; SELECT cursor FROM family_sync_states WHERE family_id='{family}' FOR UPDATE;\n\\echo TEST_FAMILY_LOCKED\n"); lock.stdin.flush()
        while lock.stdout.readline().strip() != 'TEST_FAMILY_LOCKED':
            if lock.poll() is not None: raise AssertionError('family lock holder failed')
        voice(ws,'test_turn_2'); assert Provider.entered.wait(5)
        send(ws,confirmation(first))
        for _ in range(100):
            if int(owned.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%family_sync_states%'")) > 0: break
            time.sleep(.03)
        else: raise AssertionError('confirmation did not wait on actual DB transaction lock')
        Provider.release.set(); second = wait_frame(ws,'card.present')
        assert second['runId'] != first['runId']
        lock.stdin.write('COMMIT;\n\\q\n'); lock.stdin.flush(); lock.wait(timeout=5); lock = None
        saved = wait_frame(ws,'card.saved'); assert saved['runId'] == first['runId'] and saved['entityType'] == 'diaper' and count() == 1,saved
        send(ws,confirmation(second)); saved2 = wait_frame(ws,'card.saved')
        assert saved2['runId'] == second['runId'] and saved2['entityType'] == 'diaper' and count() == 2,saved2
        evidence.append('real WS receipt entityType and newer proposal surviving older blocked confirmation PASS')
        send(ws,confirmation(second)); assert wait_frame(ws,'error')['code'] == 'NO_PENDING_PROPOSAL' and count() == 2
        evidence.append('replayed confirmation cannot duplicate records PASS')
        voice(ws,'test_turn_3'); third = wait_frame(ws,'card.present')
        expect('DELETE','/api/v1/passport/devices/'+device['deviceId'],200,token=token)
        send(ws,confirmation(third)); denied = wait_frame(ws,'error')
        assert denied['code'] == 'CONFIRM_FAILED' and 'DEVICE_ACCESS_REVOKED' in denied['message'] and count() == 2,denied
        evidence.append('revoked device cannot mutate through an already-open WebSocket PASS')
        calls_before = Provider.calls
        send(ws,{'type':'audio.start','turnId':'test_revoked_voice'})
        assert wait_frame(ws,'error')['code'] == 'DEVICE_ACCESS_REVOKED'
        assert Provider.calls == calls_before
        evidence.append('revoked device cannot start a new voice turn on an existing connection PASS')
        print('\n'.join(evidence),flush=True)
        (OUT/'passport-gateway.json').write_text(json.dumps({'status':'PASS','checks':evidence,'database':'fresh owned PostgreSQL18; no production data','provider':'loopback-only ASR/LLM fixture; no billable external call'},indent=2)+'\n')
    finally:
        Provider.release.set()
        if lock:
            lock.stdin.write('ROLLBACK;\n\\q\n'); lock.stdin.flush(); lock.wait(timeout=5)
        if ws: ws.close()
        owned.close(); provider.shutdown(); provider.server_close()

if __name__ == '__main__': main()
