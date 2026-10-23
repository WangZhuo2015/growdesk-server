from pathlib import Path
import hashlib, json, os, shutil, subprocess, tarfile

ROOT = Path('/private/tmp/growdesk-push-copy-20261007')
OUT = Path('/private/tmp/growdesk-push-copy-candidate-20261007')
GO = '/Users/wangzhuo/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.0.darwin-arm64/bin/go'
REPORTS = ROOT / 'evidence/tasks/PUSH_COPY_READABLE_20261007'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def command(args, **kw):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, **kw)

revision = command(['git', 'rev-parse', 'HEAD']).stdout.decode().strip()
report_path = REPORTS / 'runtime-final-report-path.txt'
report = json.loads(Path(report_path.read_text().strip()).read_text())
assert report['passed'] is True and len(report['cases']) == 27
assert report['cleanup']['errors'] == [] and report['source']['drift'] == []
assert not OUT.exists()
OUT.mkdir()
archive = OUT / 'source.tar'
archive.write_bytes(command(['git', 'archive', '--format=tar', revision]).stdout)
source = OUT / 'source'
source.mkdir()
with tarfile.open(archive) as stream:
    stream.extractall(source)
archive.unlink()
inputs = report['source']['inputs']
checked = {}
for relative, expected in inputs.items():
    # Harness-only input may have remained uncommitted during the runtime run.
    if relative.startswith('scripts/'):
        continue
    candidate = source / relative
    assert candidate.is_file() and sha(candidate) == expected, relative + ' differed from green runtime source'
    checked[relative] = expected
server = OUT / 'server'
(server / 'bin').mkdir(parents=True)
env = dict(os.environ, GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off',
           GOFLAGS='-mod=readonly', CGO_ENABLED='0', GOOS='linux', GOARCH='arm64',
           GOCACHE='/private/tmp/gocache-growdesk-push-copy')
for target in ('growdesk-api', 'growdesk-worker'):
    subprocess.run([GO, 'build', '-trimpath', '-ldflags=-X main.revision=' + revision,
                    '-o', str(server / 'bin' / target), './cmd/' + target],
                   cwd=source, env=env, check=True)
shutil.copy2(REPORTS / 'operations/environment-launch.py', server / 'environment-launch.py')
shutil.copy2(REPORTS / 'operations/activate.py', OUT / 'activate.py')
manifest = {'revision': revision, 'baselineRevision': '8b9edd3be223c2e784bf3ba617d7f11eac27323a',
            'runtimeReportSha256': sha(Path(report_path.read_text().strip())),
            'sourceInputsCompared': checked, 'files': {relative: sha(server / relative)
             for relative in ('bin/growdesk-api', 'bin/growdesk-worker', 'environment-launch.py')}}
(server / 'bundle-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
bundle = OUT.with_suffix('.tar.gz')
with tarfile.open(bundle, 'w:gz') as stream:
    stream.add(server, arcname='server')
    stream.add(OUT / 'activate.py', arcname='activate.py')
proof = {'revision': revision, 'cleanArchiveComparedToGreenInputs': len(checked),
         'manifestSha256': sha(server / 'bundle-manifest.json'),
         'activationSha256': sha(OUT / 'activate.py'), 'archiveSha256': sha(bundle),
         'archiveBytes': bundle.stat().st_size, 'files': manifest['files']}
(REPORTS / 'operations/candidate-build.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
