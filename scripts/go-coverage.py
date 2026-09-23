#!/usr/bin/env python3
"""Check native registration coverage, never confuse it with behavior acceptance."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'}
REFERENCE = 'f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('inventory', type=Path)
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    contract = json.loads((ROOT / 'contracts/openapi.json').read_text())
    inventory = json.loads(args.inventory.read_text())
    if inventory.get('reference') != REFERENCE:
        raise SystemExit('Reference changed without a parity rebaseline')
    expected = {(method.upper(), path): operation['operationId']
                for path, item in contract['paths'].items()
                for method, operation in item.items() if method in METHODS}
    actual = {}
    missing = []
    for operation in inventory['operations']:
        key = (operation['method'], operation['path'])
        if key in actual or expected.get(key) != operation['operationId']:
            raise SystemExit('Duplicate or mismatched native route inventory: ' + str(key))
        if not isinstance(operation.get('implemented'), bool):
            raise SystemExit('Coverage must be a real boolean')
        actual[key] = operation
        if not operation['implemented']:
            missing.append(operation)
    if len(expected) != 151 or set(actual) != set(expected):
        raise SystemExit('Frozen contract and native route inventory differ')
    print(f'Native registrations: {len(actual) - len(missing)}/{len(actual)}; missing: {len(missing)}', flush=True)
    print('Registration is not proof of permission, transaction, worker or browser correctness.', flush=True)
    for operation in sorted(missing, key=lambda value: value['operationId']):
        print(f"MISSING {operation['operationId']} {operation['method']} {operation['path']}", flush=True)
    if args.require_complete and missing:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
