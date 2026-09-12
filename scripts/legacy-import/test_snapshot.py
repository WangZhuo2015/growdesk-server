import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('snapshot',Path(__file__).with_name('snapshot.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SnapshotTests(unittest.TestCase):
    def test_wal_readonly_excludes_live_credentials_and_private_files(self):
        with tempfile.TemporaryDirectory(prefix='test_legacy_') as root:
            root=Path(root);source=root/'old';source.mkdir();database=source/'prod.db'
            db=sqlite3.connect(database);db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE User(id TEXT PRIMARY KEY,username TEXT)')
            db.execute("INSERT INTO User VALUES('test_user','test_user')")
            db.execute('CREATE TABLE OAuthRefreshToken(id TEXT PRIMARY KEY,token TEXT)')
            db.execute("INSERT INTO OAuthRefreshToken VALUES('test_token','test_sensitive')");db.commit()
            folder=source/'public/uploads';folder.mkdir(parents=True);(folder/'test_image.txt').write_text('test_file')
            before=db.execute('PRAGMA data_version').fetchone()
            target=root/'new/snapshot';result=module.capture(database,target,'test_source')
            self.assertEqual(result['counts'],{'User':1});self.assertEqual(result['excluded'],{'OAuthRefreshToken':1})
            self.assertEqual(result['attachmentFiles'],1)
            content=(target/'legacy.json').read_text();self.assertNotIn('test_sensitive',content)
            self.assertEqual(json.loads(content)['tables']['User'][0]['username'],'test_user')
            self.assertEqual(db.execute('PRAGMA data_version').fetchone(),before)
            for file in target.rglob('*'):
                self.assertEqual(file.stat().st_mode & 0o077,0)
            with self.assertRaises(ValueError):module.capture(database,target,'test_source')
            with self.assertRaises(ValueError):module.capture(database,source/'inside','test_source')
            db.close()

if __name__=='__main__':unittest.main()
