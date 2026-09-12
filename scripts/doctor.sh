#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo " GrowDesk Backend Environment Doctor"
echo "========================================="

FAIL=0

# 1. Node.js check (locked major 24)
echo -n "Checking Node.js (24.x)... "
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  NODE_MAJOR=$(echo "$NODE_VER" | sed -E 's/v([0-9]+).*/\1/')
  if [ "$NODE_MAJOR" -eq 24 ]; then
    echo "OK ($NODE_VER)"
  else
    echo "FAIL ($NODE_VER; Node 24.x required)"
    FAIL=1
  fi
else
  echo "FAIL (node not found)"
  FAIL=1
fi

# 2. npm check (>= 10)
echo -n "Checking npm (>= 10.0.0)... "
if command -v npm >/dev/null 2>&1; then
  NPM_VER=$(npm -v)
  NPM_MAJOR=$(echo "$NPM_VER" | cut -d. -f1)
  if [ "$NPM_MAJOR" -ge 10 ]; then
    echo "OK ($NPM_VER)"
  else
    echo "FAIL ($NPM_VER < 10)"
    FAIL=1
  fi
else
  echo "FAIL (npm not found)"
  FAIL=1
fi

# 3. Docker CLI check (optional for the Homebrew-only local profile)
echo -n "Checking Docker CLI... "
if command -v docker >/dev/null 2>&1; then
  DOCKER_VER=$(docker --version)
  echo "OK ($DOCKER_VER)"
else
  echo "WARN (docker not installed; OCI checks are CI-only)"
  if [ "${REQUIRE_DOCKER:-0}" = "1" ]; then
    FAIL=1
  fi
fi

# 4. Swift check (>= 6)
echo -n "Checking Swift (>= 6.0)... "
if command -v swift >/dev/null 2>&1; then
  SWIFT_VER=$(swift --version 2>/dev/null | head -n 1)
  SWIFT_MAJOR=$(echo "$SWIFT_VER" | sed -nE 's/.*version ([0-9]+).*/\1/p')
  if [ -n "$SWIFT_MAJOR" ] && [ "$SWIFT_MAJOR" -ge 6 ]; then
    echo "OK ($SWIFT_VER)"
  else
    echo "FAIL ($SWIFT_VER; Swift 6+ required)"
    FAIL=1
  fi
else
  echo "FAIL (swift not found)"
  FAIL=1
fi

# 5. Xcode check (>= 16)
echo -n "Checking Xcode / xcodebuild... "
if command -v xcodebuild >/dev/null 2>&1; then
  XCODE_VER=$(xcodebuild -version | tr '\n' ' ' | sed 's/  */ /g')
  XCODE_MAJOR=$(echo "$XCODE_VER" | sed -nE 's/.*Xcode ([0-9]+).*/\1/p')
  if [ -n "$XCODE_MAJOR" ] && [ "$XCODE_MAJOR" -ge 16 ]; then
    echo "OK ($XCODE_VER)"
  else
    echo "FAIL ($XCODE_VER; Xcode 16+ required)"
    FAIL=1
  fi
else
  echo "FAIL (xcodebuild not found)"
  FAIL=1
fi

# 6. PostgreSQL 18 check
echo -n "Checking PostgreSQL 18 binaries... "
PG_BIN="${PG_BIN:-$(dirname "$(which initdb 2>/dev/null || echo "/opt/homebrew/opt/postgresql@18/bin/initdb")")}"
if [ -x "$PG_BIN/initdb" ] && [ -x "$PG_BIN/pg_ctl" ] && [ -x "$PG_BIN/pg_isready" ]; then
  PG_VER=$("$PG_BIN/pg_ctl" --version || true)
  PG_MAJOR=$(echo "$PG_VER" | sed -nE 's/.*PostgreSQL\) ([0-9]+).*/\1/p')
  if [ "$PG_MAJOR" = "18" ]; then
    echo "OK ($PG_VER at $PG_BIN)"
  else
    echo "FAIL ($PG_VER; PostgreSQL 18 required)"
    FAIL=1
  fi
else
  echo "FAIL (PostgreSQL 18 binaries not found at $PG_BIN)"
  FAIL=1
fi

# 7. Redis 8 check
echo -n "Checking Redis 8 binaries... "
REDIS_BIN="${REDIS_BIN:-$(dirname "$(which redis-server 2>/dev/null || echo "/opt/homebrew/opt/redis/bin/redis-server")")}"
if [ -x "$REDIS_BIN/redis-server" ] && [ -x "$REDIS_BIN/redis-cli" ]; then
  REDIS_VER=$("$REDIS_BIN/redis-server" --version || true)
  REDIS_MAJOR=$(echo "$REDIS_VER" | sed -nE 's/.*v=([0-9]+).*/\1/p')
  if [ "$REDIS_MAJOR" = "8" ]; then
    echo "OK ($REDIS_VER at $REDIS_BIN)"
  else
    echo "FAIL ($REDIS_VER; Redis 8 required)"
    FAIL=1
  fi
else
  echo "FAIL (Redis 8 binaries not found at $REDIS_BIN)"
  FAIL=1
fi

echo "========================================="
if [ "$FAIL" -eq 0 ]; then
  echo " All environment prerequisites verified successfully!"
  exit 0
else
  echo " Doctor found missing or incompatible prerequisites!"
  exit 1
fi
