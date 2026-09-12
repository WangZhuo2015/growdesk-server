import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourcePaths = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.backend.json', 'apps', 'packages', 'deploy'];

try {
  if (git('status', '--porcelain')) throw new Error('Commit the verified source before packaging; working tree is not clean.');
  const revision = git('rev-parse', 'HEAD');
  const tracked = git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...sourcePaths).split('\n');
  // Inspect names only; never open credentials. Runtime environment files are
  // generated on the target machine and must never enter a source release.
  if (tracked.some((name) => /(^|\/)\.env($|\.(?!example$))|\.(pem|key)$|(^|\/)node_modules\//.test(name))) {
    throw new Error('Release paths contain a credential or installed dependency file.');
  }
  const destination = path.join(root, 'build', 'releases');
  mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, `growdesk-${revision}.tar.gz`);
  execFileSync('git', ['archive', '--format=tar.gz', `--output=${archive}`, 'HEAD', '--', ...sourcePaths], { cwd: root });
  const manifest = {
    revision,
    archive: path.basename(archive),
    archiveSHA256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    lockfileSHA256: createHash('sha256').update(readFileSync(path.join(root, 'package-lock.json'))).digest('hex'),
    stage: 'foundation',
    businessAPIAvailable: false,
  };
  writeFileSync(`${archive}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(archive);
  console.log(`SHA256 ${manifest.archiveSHA256}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release packaging failed');
  process.exitCode = 1;
}
