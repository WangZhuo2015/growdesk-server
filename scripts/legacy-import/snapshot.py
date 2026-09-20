"""Create an immutable, private legacy snapshot; never modify the live source.

Run on the source host. Only aggregate counts/hashes are written to stdout.
The archive contains sensitive personal data and must never be committed/served.
"""
from contextlib import closing
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat

EXCLUDED = {'OAuthClient', 'OAuthAuthorizationCode', 'OAuthRefreshToken', 'OAuthConsent',
            'OAuthAuditLog', 'PersonalAccessToken', 'PushSubscription'}

def capture(source, destination, source_id):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('Destination must be new; snapshots are immutable')
    if not source.is_file() or destination.is_relative_to(source.parent):
        raise ValueError('Destination must be outside the legacy application')
    os.umask(0o077)
    destination.mkdir(parents=True, mode=0o700)
    try:
        snapshot = destination / 'source.sqlite'
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src:
            src.execute('PRAGMA query_only=ON')
            with closing(sqlite3.connect(snapshot)) as target:
                src.backup(target, pages=256, sleep=0.02)
                target.execute('PRAGMA journal_mode=DELETE')
        snapshot.chmod(0o600)
        with closing(sqlite3.connect(snapshot.as_uri() + '?mode=ro', uri=True)) as db:
            db.row_factory = sqlite3.Row
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            if db.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('Source has foreign key violations')
            tables = sorted(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'") )
            rows = {}
            excluded = {}
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                if table in EXCLUDED:
                    excluded[table] = db.execute('SELECT count(*) FROM ' + quoted).fetchone()[0]
                else:
                    rows[table] = sorted([dict(row) for row in db.execute('SELECT * FROM '+quoted)], key=lambda row: str(row['id']))
        envelope = dict(formatVersion=1, sourceId=source_id, timeZone='Asia/Shanghai',
                        capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        sourceSha256=hashlib.sha256(snapshot.read_bytes()).hexdigest(),
                        tables=rows, excluded=excluded)
        payload = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        archive = destination / 'legacy.json'
        archive.write_bytes(payload)
        archive.chmod(0o600)
        files=[]
        captured_paths = {}
        for relative in ['public/uploads', 'data/archive']:
            # Standalone Next deployments can retain runtime-created files
            # below `.next/standalone` even when the source-tree copy was
            # pruned by a later build. Capture both approved roots by their
            # canonical application-relative path and fail on disagreement.
            for base in (source.parent, source.parent/'.next/standalone'):
                folder=base/relative
                if not folder.exists(): continue
                if folder.is_symlink(): raise ValueError('Attachment root is a symlink')
                for file in sorted(folder.rglob('*')):
                    if file.is_symlink(): raise ValueError('Attachment symlink rejected')
                    if not file.is_file(): continue
                    if not stat.S_ISREG(file.stat().st_mode) or file.stat().st_size > 256*1024*1024:
                        raise ValueError('Unsupported attachment file')
                    rel=file.relative_to(base)
                    size=file.stat().st_size
                    digest=hashlib.sha256(file.read_bytes()).hexdigest()
                    prior=captured_paths.get(str(rel))
                    if prior is not None:
                        if prior != (size,digest): raise ValueError('Conflicting attachment copies')
                        continue
                    captured_paths[str(rel)]=(size,digest)
                    target=destination/'files'/rel
                    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                    shutil.copyfile(file,target)
                    target.chmod(0o600)
                    files.append(dict(path=str(rel),size=size,sha256=digest))
        (destination/'files.json').write_text(json.dumps(files,ensure_ascii=False))
        manifest=dict(sourceId=source_id, sourceSha256=envelope['sourceSha256'],
                      archiveSha256=hashlib.sha256(payload).hexdigest(), capturedAt=envelope['capturedAt'],
                      counts={table:len(value) for table,value in rows.items()}, excluded=excluded,
                      attachmentFiles=len(files), attachmentBytes=sum(f['size'] for f in files),
                      attachmentConsistency='Files copied after consistent database snapshot; immutable archive originals, mutable uploads require later per-reference verification.')
        (destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        return manifest
    except BaseException:
        # Leave no partial artifact advertised as importable.
        shutil.rmtree(destination)
        raise

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--source-id',required=True)
    args=parser.parse_args()
    try: print(json.dumps(capture(args.source,args.destination,args.source_id),indent=2))
    except Exception as error:
        print(json.dumps({'error':type(error).__name__}))
        raise SystemExit(1)
