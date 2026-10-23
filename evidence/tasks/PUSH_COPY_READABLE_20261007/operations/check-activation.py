"""Local control-flow tests; these do not establish production deployment."""
from pathlib import Path
import hashlib, json, tempfile, types, shutil

SOURCE = Path(__file__).with_name('activate.py')
SCRIPT = SOURCE.read_text()
PREFIX, MAIN = SCRIPT.split('\ntry:\n', 1)
RESULTS = []

for fault in (None, 'after-copy', 'worker-start', 'backup', 'preexisting-backup'):
    with tempfile.TemporaryDirectory(prefix='push-copy-activation-') as directory:
        base = Path(directory)
        fake_proc = base / 'proc'
        ns = {'__name__': 'local_activation_test'}
        exec(compile(PREFIX.replace("Path('/proc')", f'Path({str(fake_proc)!r})'), str(SOURCE), 'exec'), ns)
        ns['ROOT'] = base / 'release'
        ns['SERVER'] = ns['ROOT'] / 'server'
        ns['ROLLBACK'] = ns['ROOT'] / 'rollback'
        ns['API'] = base / 'live/growdesk-api'
        ns['OLD_WORKER'] = base / 'old/growdesk-worker'
        ns['LIVE'] = base / 'web'
        ns['DROPIN'] = base / 'units/60-readable-copy.conf'
        for p in (ns['API'], ns['OLD_WORKER'], ns['SERVER'] / 'bin/growdesk-api',
                  ns['SERVER'] / 'bin/growdesk-worker', ns['SERVER'] / 'environment-launch.py',
                  ns['LIVE'] / '.env', base / 'api.env'):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(('local fixture ' + str(p)).encode())
        ns['API_HASH'] = ns['sha'](ns['API'])
        ns['WORKER_HASH'] = ns['sha'](ns['OLD_WORKER'])
        provenance = ns['LIVE'] / '.next/standalone/build-provenance.json'
        provenance.parent.mkdir(parents=True)
        provenance.write_text(json.dumps({'sourceGitSha': ns['WEB_REVISION'], 'sourceDirty': False}))
        config = base / 'units/existing.conf'
        config.parent.mkdir(parents=True)
        config.write_text('fixture existing configuration')
        ns['CONFIG_HASHES'] = {str(config): ns['sha'](config)}
        baseline = ns['BASE_REVISION']
        revision = 'fixture_candidate_revision'
        bundle = {'baselineRevision': baseline, 'revision': revision, 'files': {
            relative: ns['sha'](ns['SERVER'] / relative)
            for relative in ('bin/growdesk-api', 'bin/growdesk-worker', 'environment-launch.py')}}
        (ns['SERVER'] / 'bundle-manifest.json').write_text(json.dumps(bundle))
        if fault == 'preexisting-backup':
            ns['ROLLBACK'].mkdir()
            (ns['ROLLBACK'] / 'preserved.txt').write_text('existing rollback must survive')
        state = {unit: {'ActiveState': 'active', 'SubState': 'running', 'MainPID': str(110 + index), 'NRestarts': '0'}
                 for index, unit in enumerate(ns['UNITS'])}
        calls = []
        fail_used = False

        def populate(unit):
            pid = state[unit]['MainPID']
            folder = fake_proc / pid
            folder.mkdir(parents=True, exist_ok=True)
            if unit == 'growdesk-api':
                binary = ns['API']
            elif unit == 'growdesk-notifications-worker':
                binary = ns['SERVER'] / 'bin/growdesk-worker' if ns['DROPIN'].exists() else ns['OLD_WORKER']
            else:
                return
            (folder / 'exe').write_bytes(binary.read_bytes())
            (folder / 'cmdline').write_bytes(b'worker\0--notifications-only\0')

        for unit in state:
            populate(unit)

        def fake_ctl(*args):
            global fail_used
            calls.append(list(args))
            if args[0] in ('stop', 'start'):
                for unit in args[1:]:
                    assert unit != 'baby-panel', 'Web must not be restarted'
                    if args[0] == 'stop':
                        state[unit].update(ActiveState='inactive', SubState='dead', MainPID='0')
                    else:
                        if fault == 'worker-start' and unit == 'growdesk-notifications-worker' and not fail_used:
                            fail_used = True
                            raise RuntimeError('fixture worker-start failure')
                        state[unit].update(ActiveState='active', SubState='running', MainPID=str(200 + len(calls)))
                        populate(unit)
            return types.SimpleNamespace(stdout=b'')

        def fake_health():
            global fail_used
            if fault == 'after-copy' and ns['DROPIN'].exists() and not fail_used:
                fail_used = True
                raise RuntimeError('fixture readiness failure')
            assert state['growdesk-api']['ActiveState'] == 'active'
            return {'status': 'ok', 'dependencies': {'postgres': 'ok', 'redis': 'ok'}}

        def fake_install(path, content):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

        def fake_run(args, **kwargs):
            if args[:4] == ['sudo', '-n', 'rm', '-f']:
                Path(args[4]).unlink(missing_ok=True)
                return types.SimpleNamespace(stdout=b'')
            raise AssertionError('unexpected simulated command')

        def fake_version(path):
            return {'revision': revision if ns['sha'](path) in (bundle['files']['bin/growdesk-api'], bundle['files']['bin/growdesk-worker']) else baseline}

        def fake_copy(source, destination):
            if fault == 'backup' and destination == ns['ROLLBACK'] / 'growdesk-api':
                raise RuntimeError('fixture backup-copy failure')
            return shutil.copy2(source, destination)

        ns.update(ctl=fake_ctl, props=lambda unit: dict(state[unit]), health=fake_health,
                  wait_api=fake_health, install=fake_install, run=fake_run, version=fake_version,
                  shutil=types.SimpleNamespace(copy2=fake_copy, rmtree=shutil.rmtree),
                  time=types.SimpleNamespace(sleep=lambda seconds: None), print=lambda *args: None)
        # Substitute only the fixture api.env path; no production environment is read.
        fixture_main = MAIN.replace("Path('/home/ubuntu/growdesk/api.env')", f'Path({str(base / "api.env")!r})')
        try:
            exec(compile('try:\n' + fixture_main, str(SOURCE), 'exec'), ns)
        except (RuntimeError, AssertionError):
            assert fault is not None
        receipt = ns['receipt']
        if fault is None:
            assert receipt['deployed'] and receipt['webProcessUnchanged'] and receipt['environmentFilesUnchanged']
        elif fault in ('after-copy', 'worker-start'):
            assert not receipt['deployed'] and receipt['rolledBack'] and receipt['rollbackBinaryHashesVerified']
            assert ns['sha'](ns['API']) == ns['API_HASH'] and not ns['DROPIN'].exists()
        elif fault == 'backup':
            assert receipt['preflightBackupCleaned'] and not ns['ROLLBACK'].exists()
            assert ns['sha'](ns['API']) == ns['API_HASH'] and calls == []
        else:
            assert (ns['ROLLBACK'] / 'preserved.txt').read_text() == 'existing rollback must survive'
            assert ns['sha'](ns['API']) == ns['API_HASH'] and calls == []
        assert all('baby-panel' not in c[1:] for c in calls if c[0] in ('start', 'stop'))
        RESULTS.append({'fault': fault, 'passed': True, 'serviceCommands': calls,
                        'deployed': receipt['deployed'], 'rolledBack': receipt.get('rolledBack', False)})

output = SOURCE.with_name('activation-control-flow-tests.json')
output.write_text(json.dumps({'scriptSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                             'localSimulationOnly': True, 'tests': RESULTS}, indent=2) + '\n')
print(json.dumps({'passed': len(RESULTS), 'evidence': str(output)}))
