#!/usr/bin/env python3
"""Freeze tested standalone Web and daily binary; no runtime credentials included."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/tmp/growdesk-openai-defaults-web-20261030')
PAYLOAD = Path('/tmp/growdesk-openai-defaults-release-20261030')
EVIDENCE = ROOT / 'evidence/tasks/OPENAI_OFFICIAL_API_20261030'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if PAYLOAD.exists():
        raise RuntimeError('refusing to overwrite a frozen release')
    for name in ('web-final-build', 'web-final-unit', 'daily-owned-final', 'go-focused-final', 'launcher-tests-final'):
        if json.loads((EVIDENCE / (name + '.json')).read_text())['exit_code'] != 0:
            raise RuntimeError('required final validation did not pass: ' + name)
    donors = json.loads((EVIDENCE / 'web-official-donors.json').read_text())
    for name, expected in donors.items():
        if sha(SOURCE / name) != expected:
            raise RuntimeError('tested source changed: ' + name)
    spec = importlib.util.spec_from_file_location('source_auditor', ROOT / 'scripts/stage-llm-settings-web.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.audit_candidate_tree(SOURCE / '.next/standalone')
    PAYLOAD.mkdir()
    shutil.copytree(SOURCE / '.next/standalone', PAYLOAD / 'web', symlinks=True)
    native = Path('node_modules/@libsql/linux-arm64-gnu')
    if not (PAYLOAD / 'web' / native).exists():
        helper.copy_installed_tree(SOURCE / native, PAYLOAD / 'web' / native)
    for name in ('launch-web.py', 'launch-api.py', 'launch-daily.py'):
        shutil.copy2(ROOT / 'deploy/openai-defaults-20261030' / name, PAYLOAD / name)
    shutil.copy2('/tmp/growdesk-openai-daily-release-20261030', PAYLOAD / 'growdesk-daily-summary')
    helper.audit_candidate_tree(PAYLOAD)
    files, links = {}, {}
    for path in sorted(PAYLOAD.rglob('*')):
        relative = path.relative_to(PAYLOAD).as_posix()
        if path.is_symlink():
            links[relative] = path.readlink().as_posix()
        elif path.is_file():
            files[relative] = sha(path)
    manifest = {'task': 'OPENAI_OFFICIAL_API_20261030', 'payload': str(PAYLOAD), 'files': files, 'links': links,
                'webBuildId': (SOURCE / '.next/BUILD_ID').read_text().strip(), 'privateRuntimeFilesCopied': False,
                'mainApiBinaryReplaced': False, 'databaseMigrations': False, 'sourceDonors': donors}
    path = EVIDENCE / 'release-manifest.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'payload': str(PAYLOAD), 'files': len(files), 'links': len(links), 'manifestSha256': sha(path)}))


if __name__ == '__main__':
    main()
