#!/usr/bin/env python3
"""Common lifecycle for native/domain HTTP regressions, never a production runner.

Each run owns disposable PostgreSQL/Redis containers through the existing
harness. Caller-provided database URLs, live accounts and paid providers are
not accepted. Real TypeScript HTTP comparison is opt-in, never a mock server.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('remaining_domain', ROOT / 'scripts/go-domain-integration.py')
assert SPEC and SPEC.loader
DOMAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DOMAIN)
TOOLS = DOMAIN.TOOLS


def run_module(scenario, scope: str) -> None:
    if not __debug__:
        raise RuntimeError('Assertions are required; do not run with python -O')
    parser = argparse.ArgumentParser(description=scope)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise RuntimeError('Build the native executable first')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    identity = json.loads(subprocess.check_output([str(binary), '--version'], cwd=ROOT, text=True))
    if identity.get('revision') != commit:
        raise RuntimeError('Binary revision does not match the tested checkout')
    report = {'scope': scope, 'status': 'RUNNING', 'commit': commit, 'binary': identity, 'runtimes': {}}

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')

    signal.signal(signal.SIGTERM, interrupted)

    def save():
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    save()
    try:
        for runtime in (('go', 'typescript') if args.reference else ('go',)):
            owned = TOOLS.OwnedEnvironment()
            try:
                owned.start()
                native = owned.serve(binary)
                base = native if runtime == 'go' else DOMAIN.serve_reference(owned)
                process = owned.processes[-1]

                def restart():
                    nonlocal process
                    process.terminate()
                    process.wait(timeout=10)
                    endpoint = owned.serve(binary) if runtime == 'go' else DOMAIN.serve_reference(owned)
                    process = owned.processes[-1]
                    return endpoint

                report['runtimes'][runtime] = scenario(owned, base).run(restart, runtime, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][name]['observations'] for name in ('go', 'typescript'))
            if left != right:
                differences = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    differences.append({'lengths': [len(left), len(right)]})
                raise AssertionError('HTTP/state parity differs: ' + json.dumps(differences, ensure_ascii=False))
            report['differentialObservations'] = len(left)
        report['status'] = 'PASS'
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failureType'] = type(error).__name__
        raise
    finally:
        save()
