import importlib.util,sys,pathlib,re
root=pathlib.Path('/private/tmp/growdesk-server-vaccine-edit-20261002')
p=root/'scripts/go-medical-growth-ocr-typed-integration.py'
spec=importlib.util.spec_from_file_location('clinical_startup_diagnostic',p)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
original=m.OwnedStack._start_postgres
def traced_start(self):
    try: return original(self)
    except Exception:
        path=self.root/'postgres.log'
        raw=path.read_text(errors='replace')[-12000:] if path.is_file() else 'No postgres.log was written'
        for secret in (self.db_password,self.admin_password,self.jwt,self.redis_password,self.minio_password):
            raw=raw.replace(secret,'[redacted]')
        raw=re.sub(r'postgres(?:ql)?://[^\s]+','[redacted-connection-url]',raw)
        print('Owned PostgreSQL startup log (bounded):\n'+raw,flush=True)
        raise
m.OwnedStack._start_postgres=traced_start
sys.exit(m.main())
