#!/usr/bin/env python3
"""Stage current deployed public Web source, excluding runtime data and secrets."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
LIVE = Path('/home/ubuntu/growdesk/voice-e2e-releases/20261024-web-shortcut-07cb8f2243fa/web')
CHECKOUT = Path('/home/ubuntu/Github/baby_panel_for_cecilia')
OUT = Path('/tmp/growdesk-openai-defaults-web-20261030')
EVIDENCE = ROOT / 'evidence/tasks/OPENAI_OFFICIAL_API_20261030'
SOURCE_ROOTS = {'app', 'components', 'lib', 'types', 'stores', 'hooks', 'styles', 'prisma', 'public', 'tests', 'scripts'}
ROOT_FILES = {'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'next-env.d.ts', 'postcss.config.mjs', 'eslint.config.mjs', 'components.json', 'middleware.ts', 'proxy.ts', 'AGENTS.md'}
SOURCE_SUFFIXES = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cts', '.cjs', '.css', '.scss', '.json', '.prisma', '.md', '.sql', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest', '.sh', '.py'}
PUBLIC_CATALOGS = ('01_sources.json', '02_vaccines.json', '03_milestones.json', '04_foods.json', '05_books.json', '06_activities.json')


def allowed(relative: Path) -> bool:
    if relative.is_absolute() or '..' in relative.parts:
        return False
    if any(part.startswith('.env') or part in {'.gpt', '.git', '.next', '.data', 'data', 'backups', 'uploads', 'archive', 'node_modules', 'evidence'} for part in relative.parts):
        return False
    if relative.name.startswith('llm-profiles') or relative.suffix not in SOURCE_SUFFIXES:
        return False
    return relative.parts[0] in SOURCE_ROOTS or relative.as_posix() in ROOT_FILES


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if OUT.exists():
        raise RuntimeError('refusing to overwrite an existing candidate')
    OUT.mkdir()
    baseline: dict[str, str] = {}
    pending = [LIVE]
    while pending:
        directory = pending.pop()
        for source in directory.iterdir():
            relative = source.relative_to(LIVE)
            if source.is_symlink():
                continue
            if source.is_dir():
                if relative.parts[0] in SOURCE_ROOTS and not any(part.startswith('.env') or part in {'.gpt', '.git', '.next', '.data', 'data', 'backups', 'uploads', 'archive', 'node_modules', 'evidence'} for part in relative.parts):
                    pending.append(source)
                continue
            if source.is_file() and allowed(relative):
                target = OUT / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                baseline[relative.as_posix()] = sha(target)
    # These six public reference catalogs are required by postbuild. No other
    # entry in the runtime data directory is enumerated or copied.
    for name in PUBLIC_CATALOGS:
        source = LIVE / 'data' / name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('public reference catalog is missing or linked')
        target = OUT / 'data' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        baseline['data/' + name] = sha(target)
    # The live standalone tree omitted source for three still-compiled public
    # discovery routes. Restore only those registered routes from their pinned
    # source archive; do not resurrect other removed application endpoints.
    archived = json.loads((LIVE.parent / 'web-source-manifest.json').read_text())
    expected = {entry['path']: entry['sha256'] for entry in archived['files']}
    compiled = json.loads((LIVE / '.next/server/app-paths-manifest.json').read_text())
    with tarfile.open(LIVE.parent / 'web-source.tar.gz') as archive:
        for name in ('app/.well-known/oauth-authorization-server/route.ts', 'app/.well-known/oauth-protected-resource/mcp/route.ts', 'app/.well-known/oauth-protected-resource/route.ts'):
            if (OUT / name).exists():
                continue
            if '/' + name[4:-3] not in compiled:
                raise RuntimeError('discovery route is no longer registered')
            member = archive.getmember(name)
            if not member.isfile():
                raise RuntimeError('archived discovery source is not regular')
            raw = archive.extractfile(member).read()
            if hashlib.sha256(raw).hexdigest() != expected[name]:
                raise RuntimeError('archived discovery source hash changed')
            target = OUT / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            baseline[name] = expected[name]
    spec = importlib.util.spec_from_file_location('public_stager', ROOT / 'scripts/stage-llm-settings-web.py')
    assert spec and spec.loader
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.copy_installed_tree(CHECKOUT / 'generated', OUT / 'generated', generated=True)
    helper.copy_installed_tree(CHECKOUT / 'node_modules', OUT / 'node_modules')
    helper.audit_candidate_tree(OUT)
    result = {'task': 'OPENAI_OFFICIAL_API_20261030', 'baseline': str(LIVE), 'candidate': str(OUT),
              'sourceFiles': baseline, 'runtimePrivateFilesCopied': False, 'donorsApplied': False}
    (EVIDENCE / 'web-source-baseline.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'candidate': str(OUT), 'livePublicSourceFiles': len(baseline)}))


if __name__ == '__main__':
    main()
