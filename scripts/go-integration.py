#!/usr/bin/env python3
"""Native Go HTTP regressions on exclusively owned PostgreSQL/Redis containers."""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

class OwnedEnvironment:
    def __init__(self):
        self.owner = secrets.token_hex(8)
        self.containers, self.processes, self.files = [], [], []
        self.password, self.admin_password, self.jwt = secrets.token_hex(24), secrets.token_hex(24), secrets.token_hex(32)
        self.role = self.database = 'test_go_' + self.owner
        self.pg = ''
        self.env = {k:v for k,v in os.environ.items() if not (k.startswith(('PG','AWS','S3','GROWDESK','REDIS','DATABASE','JWT','OPENAI','ANTHROPIC','SESSION_ENCRYPTION','INVITE')) or k in ('NODE_ENV','PORT','HOST'))}
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            for value in (self.password,self.admin_password,self.jwt): print('::add-mask::' + value, flush=True)
    def run(self, args, data=None):
        return subprocess.run(args, input=data, text=True, check=True, capture_output=True, env=self.env).stdout.strip()
    def container(self, image, args, command=None):
        name = 'test_growdesk_go_' + self.owner + '_' + str(len(self.containers))
        cid = self.run(['docker','run','--rm','-d','--name',name,'--label','growdesk.test.owner='+self.owner,*args,image,*(command or [])])
        self.containers.append(cid)
        return cid
    def port(self, cid, internal):
        bindings = json.loads(self.run(['docker','inspect',cid]))[0]['NetworkSettings']['Ports'][str(internal)+'/tcp']
        assert len(bindings)==1 and bindings[0]['HostIp']=='127.0.0.1'
        port = int(bindings[0]['HostPort'])
        assert port not in (5432,6379,3088,3089)
        return port
    def sql(self, statement):
        return self.run(['docker','exec','-i','-e','PGPASSWORD='+self.password,self.pg,'psql','-X','-v','ON_ERROR_STOP=1','-At','-U',self.role,'-d',self.database], statement)
    def start(self):
        self.pg = self.container('postgres:18',['-e','POSTGRES_PASSWORD='+self.admin_password,'-e','POSTGRES_DB=test_bootstrap','-p','127.0.0.1::5432'])
        redis = self.container('redis:8',['-p','127.0.0.1::6379'],['redis-server','--requirepass',self.password])
        # The image's temporary initialization server accepts Unix sockets only.
        # Probe TCP so a transient bootstrap server cannot pass readiness.
        for _ in range(100):
            probe = subprocess.run(['docker','exec',self.pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d','test_bootstrap'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if probe.returncode == 0: break
            time.sleep(.2)
        else: raise RuntimeError('owned PostgreSQL did not become ready')
        create = f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\nCREATE DATABASE {self.database} OWNER {self.role};\n"
        self.run(['docker','exec','-i','-e','PGPASSWORD='+self.admin_password,self.pg,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','test_bootstrap'], create)
        assert self.sql('SELECT current_database(),current_user,rolsuper FROM pg_roles WHERE rolname=current_user;') == self.database+'|'+self.role+'|f'
        for directory in sorted((ROOT/'prisma/migrations').iterdir()):
            sql = directory/'migration.sql'
            if sql.is_file(): self.sql(sql.read_text())
        pg_port, redis_port = self.port(self.pg,5432), self.port(redis,6379)
        self.env.update(DATABASE_URL=f'postgresql://{self.role}:{self.password}@127.0.0.1:{pg_port}/{self.database}?sslmode=disable', REDIS_URL=f'redis://default:{self.password}@127.0.0.1:{redis_port}/0', JWT_SECRET=self.jwt, SESSION_ENCRYPTION_KEY=self.jwt, GROWDESK_ENV='test', DB_POOL_MAX='10', HOST='127.0.0.1')
        return self
    def serve(self, binary):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0))
            port = sock.getsockname()[1]
        assert port not in (3088,3089)
        log = tempfile.TemporaryFile(mode='w+t')
        self.files.append(log)
        proc = subprocess.Popen([str(binary.resolve())], cwd=ROOT, env={**self.env,'PORT':str(port)}, stdout=log, stderr=log)
        self.processes.append(proc)
        base = f'http://127.0.0.1:{port}'
        for _ in range(100):
            if proc.poll() is not None:
                log.seek(0)
                raise RuntimeError('native API exited: '+log.read()[-4000:])
            try:
                status,_ = http(base,'GET','/health/ready')
                if status == 200: return base
            except OSError: pass
            time.sleep(.1)
        raise RuntimeError('native API readiness timed out')
    def close(self):
        for proc in reversed(self.processes):
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        for cid in reversed(self.containers):
            with contextlib.suppress(Exception):
                info = json.loads(self.run(['docker','inspect',cid]))[0]
                if info['Config']['Labels'].get('growdesk.test.owner') == self.owner: self.run(['docker','rm','-f',cid])
        for f in self.files: f.close()

def http(base, method, path, body=None, token=None, headers=None):
    hdr = {'Accept':'application/json',**(headers or {})}
    if token: hdr['Authorization'] = 'Bearer '+token
    data = None
    if body is not None:
        data = json.dumps(body,ensure_ascii=False,separators=(',',':')).encode()
        hdr['Content-Type'] = 'application/json'
    req = urllib.request.Request(base+path,data=data,headers=hdr,method=method)
    try:
        with urllib.request.urlopen(req,timeout=20) as response: return response.status,json.load(response)
    except urllib.error.HTTPError as err:
        return err.code,json.load(err)

def expect(base, method, path, status, body=None, token=None, headers=None):
    code,data = http(base,method,path,body,token,headers)
    if code != status:
        safe = data.get('error',{}).get('code','unexpected_success') if isinstance(data,dict) else type(data).__name__
        raise AssertionError(f'{method} {path}: expected {status}, got {code}; {safe}')
    return data

def run_tests(owned,base):
    username = 'test_native_'+owned.owner
    password = 'test_password_'+secrets.token_hex(12)
    payload = {'username':username,'password':password,'displayName':'Test Go User','deviceLabel':'test_web'}
    registered = expect(base,'POST','/api/v1/auth/register',201,payload)['data']
    token,uid = registered['accessToken'],registered['user']['id']
    expect(base,'POST','/api/v1/auth/register',409,payload)
    assert expect(base,'GET','/api/v1/me',200,token=token)['data'] == registered['user']
    expect(base,'GET','/api/v1/me',401)
    expect(base,'POST','/api/v1/auth/login',401,{'username':username,'password':'wrong_password'})
    second = expect(base,'POST','/api/v1/auth/login',200,{'username':username,'password':password})['data']
    assert len(expect(base,'GET','/api/v1/auth/sessions',200,token=token)['data']) == 2
    expect(base,'DELETE','/api/v1/auth/sessions/'+second['sessionId'],200,token=token)
    expect(base,'GET','/api/v1/me',401,token=second['accessToken'])
    print('PASS native register/login/current-user/session isolation',flush=True)
    refresh_body = {'refreshToken':registered['refreshToken'],'rotationId':'00000000-0000-4000-8000-000000000001'}
    rotated = expect(base,'POST','/api/v1/auth/refresh',200,refresh_body)['data']
    assert expect(base,'POST','/api/v1/auth/refresh',200,refresh_body)['data'] == rotated
    expect(base,'POST','/api/v1/auth/refresh',409,{**refresh_body,'rotationId':'00000000-0000-4000-8000-000000000002'})
    expect(base,'GET','/api/v1/me',401,token=rotated['accessToken'])
    print('PASS atomic refresh replay and session-family revocation',flush=True)
    secret_hash = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
    bound = expect(base,'POST','/api/v1/auth/bff/session',200,{'sessionSecretHash':secret_hash,'username':username,'password':password})['data']
    exchanged = expect(base,'POST','/api/v1/auth/bff/session',200,{'sessionSecretHash':secret_hash,'userId':uid})['data']
    assert exchanged['accessToken'] == bound['accessToken']
    assert owned.sql(f"SELECT encrypted_refresh_token FROM bff_sessions WHERE session_secret_hash='{secret_hash}';").startswith('go:v1:')
    owned.sql(f"UPDATE bff_sessions SET access_token_expires_at=NOW()-INTERVAL '1 minute' WHERE session_secret_hash='{secret_hash}';")
    exchanged = expect(base,'POST','/api/v1/auth/bff/session',200,{'sessionSecretHash':secret_hash})['data']
    expect(base,'GET','/api/v1/me',200,token=exchanged['accessToken'])
    expect(base,'DELETE','/api/v1/auth/bff/session',200,{'sessionSecretHash':secret_hash})
    expect(base,'GET','/api/v1/me',401,token=exchanged['accessToken'])
    print('PASS encrypted BFF exchange/refresh/revocation',flush=True)
    login = expect(base,'POST','/api/v1/auth/login',200,{'username':username,'password':password})['data']
    token = login['accessToken']
    recovery = expect(base,'POST','/api/v1/auth/recovery-codes/regenerate',200,{'password':password},token)['data']
    assert len(recovery['codes']) == 10
    new_password = 'test_new_password_'+secrets.token_hex(8)
    request = {'username':username,'recoveryCode':recovery['codes'][0],'newPassword':new_password}
    expect(base,'POST','/api/v1/auth/password/recover',200,request)
    expect(base,'POST','/api/v1/auth/password/recover',401,request)
    expect(base,'GET','/api/v1/me',401,token=token)
    expect(base,'POST','/api/v1/auth/login',200,{'username':username,'password':new_password})
    print('PASS single-use recovery and revocation',flush=True)
    # These scenarios do not certify unimplemented operations.

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary',type=Path,required=True)
    args = parser.parse_args()
    owned = OwnedEnvironment()
    def interrupted(signum,frame): raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM,interrupted)
    try:
        owned.start()
        run_tests(owned,owned.serve(args.binary))
    finally: owned.close()

if __name__ == '__main__': main()
