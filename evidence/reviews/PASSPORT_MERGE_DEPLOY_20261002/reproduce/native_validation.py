import importlib.util, json, os, secrets, socket, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(os.environ.get('PASSPORT_REVIEW_ROOT', str(Path(__file__).resolve().parents[4])))
PG = Path(os.environ.get('PASSPORT_REVIEW_PG_BIN', '/opt/homebrew/opt/postgresql@18/bin'))
OUT = Path(os.environ.get('PASSPORT_REVIEW_OUTPUT', '/tmp/growdesk-passport-review-output'))
OUT.mkdir(parents=True, exist_ok=True)
BIN = OUT/'bin/growdesk-api'

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT/'scripts'/f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

base = load('go-integration')
def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

class NativeOwned(base.OwnedEnvironment):
    def start(self):
        self.temp = tempfile.TemporaryDirectory(prefix='test_passport_pg_')
        self.data = Path(self.temp.name)/'pg'
        self.pgport, self.redisport = free_port(), free_port()
        self.run([str(PG/'initdb'), '-D', str(self.data), '-U', 'test_admin', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8'])
        self.run([str(PG/'pg_ctl'), '-D', str(self.data), '-l', str(Path(self.temp.name)/'pg.log'), '-o', f'-h 127.0.0.1 -p {self.pgport} -k {self.temp.name}', '-w', 'start'])
        redislog = tempfile.TemporaryFile(mode='w+t'); self.files.append(redislog)
        proc = subprocess.Popen(['/opt/homebrew/bin/redis-server', '--bind','127.0.0.1','--port',str(self.redisport),'--requirepass',self.password,'--save','','--appendonly','no'], cwd=self.temp.name, env=self.env, stdout=redislog, stderr=redislog)
        self.processes.append(proc)
        self.run([str(PG/'psql'),'-X','-h','127.0.0.1','-p',str(self.pgport),'-U','test_admin','-d','postgres','-v','ON_ERROR_STOP=1'], f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE DATABASE {self.database} OWNER {self.role};")
        assert self.sql('SELECT current_database(),current_user,rolsuper FROM pg_roles WHERE rolname=current_user;') == self.database+'|'+self.role+'|f'
        for file in sorted((ROOT/'prisma/migrations').glob('*/migration.sql')):
            self.sql(file.read_text())
        self.sql((ROOT/'native/migrations/0003_passport.sql').read_text())
        self.env.update(DATABASE_URL=f'postgresql://{self.role}:{self.password}@127.0.0.1:{self.pgport}/{self.database}?sslmode=disable', REDIS_URL=f'redis://default:{self.password}@127.0.0.1:{self.redisport}/0', JWT_SECRET=self.jwt, SESSION_ENCRYPTION_KEY=self.jwt, GROWDESK_ENV='test', GROWDESK_GO_EXPERIMENTAL='1', DB_POOL_MAX='10', HOST='127.0.0.1')
        return self
    def sql(self, statement):
        return self.run([str(PG/'psql'),'-X','-h','127.0.0.1','-p',str(self.pgport),'-U',self.role,'-d',self.database,'-v','ON_ERROR_STOP=1','-At'], statement)
    def close(self):
        super().close()
        if hasattr(self, 'data'):
            self.run([str(PG/'pg_ctl'),'-D',str(self.data),'-m','fast','-w','stop'])
            self.temp.cleanup()

def main():
    reports = {}
    for name in ('go-integration', 'go-domain-integration', 'go-companion-integration', 'go-session-review-integration'):
        module = load(name)
        module.OwnedEnvironment = NativeOwned
        if hasattr(module, 'TOOLS'): module.TOOLS.OwnedEnvironment = NativeOwned
        sys.argv = [name, '--binary', str(BIN)]
        if name != 'go-integration': sys.argv += ['--report', str(OUT/f'{name}-native.json')]
        print('RUN',name, 'fresh owned PostgreSQL18/Redis', flush=True)
        module.main()
        reports[name] = 'PASS'
    (OUT/'native-validation-summary.json').write_text(json.dumps(reports,indent=2))

if __name__ == '__main__': main()
