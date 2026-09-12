#!/usr/bin/env bash
set -euo pipefail
# No persistent fixed-port instances are accepted or stopped by this runner.
if [[ "${1:-run}" != run || $# -gt 1 ]]; then
  echo 'Usage: infra-test-env.sh run (creates, tests and cleans its own isolated instances)' >&2
  exit 2
fi
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-isolated.py"
