#!/usr/bin/env bash
set -euo pipefail
umask 077
stage=/home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7
binary=/home/ubuntu/growdesk/bin/growdesk-api
expected_old=9ae41d1fdddf3a605a95bed61d4a7249eb3e2c47bed388d96ba9d95a4065f7d9
expected_new=80cc6c2f14932d13116b4d67fdf720365b71635031277083614c43cb58458562
phase=preflight
replaced=0
rollback() {
  status=$?
  printf 'Deployment failed at phase=%s\n' "$phase" >&2
  if [ "$replaced" -eq 1 ]; then
    sudo cp -p -- "$stage/growdesk-api.rollback" "$binary.rollback-audio-query"
    sudo mv -f -- "$binary.rollback-audio-query" "$binary"
    sudo systemctl restart growdesk-api.service
    printf '%s\n' 'Original binary restored; configuration was not changed.' >&2
  fi
  exit "$status"
}
trap rollback ERR
pid=$(sudo systemctl show growdesk-api.service -p MainPID --value)
[ "$(sudo sha256sum "$binary" | cut -d' ' -f1)" = "$expected_old" ]
[ "$(sudo sha256sum "/proc/$pid/exe" | cut -d' ' -f1)" = "$expected_old" ]
[ "$(sha256sum "$stage/growdesk-api-linux-arm64" | cut -d' ' -f1)" = "$expected_new" ]
sudo cp -p -- "$binary" "$stage/growdesk-api.rollback"
env_metadata=$(sudo stat -c '%d:%i:%s:%Y:%Z' /home/ubuntu/growdesk/api.env)
printf 'phase=%s PASS\n' "$phase"
phase=replace
sudo cp -p -- "$stage/growdesk-api-linux-arm64" "$binary.next-audio-query"
sudo chown --reference="$binary" "$binary.next-audio-query"
sudo chmod --reference="$binary" "$binary.next-audio-query"
sudo mv -f -- "$binary.next-audio-query" "$binary"
replaced=1
printf 'phase=%s PASS\n' "$phase"
phase=restart
sudo systemctl restart growdesk-api.service
printf 'phase=%s PASS\n' "$phase"
phase=running-executable
matched=0
for attempt in $(seq 1 25); do
  pid=$(sudo systemctl show growdesk-api.service -p MainPID --value)
  if observed_hash=$(sudo sha256sum "/proc/$pid/exe" 2>/dev/null); then
    observed_hash=${observed_hash%% *}
    if [ "$observed_hash" = "$expected_new" ]; then matched=1; break; fi
  fi
  sleep 0.2
done
[ "$matched" -eq 1 ]
printf 'phase=%s PASS attempts=%s\n' "$phase" "$attempt"
phase=configuration
[ "$(sudo stat -c '%d:%i:%s:%Y:%Z' /home/ubuntu/growdesk/api.env)" = "$env_metadata" ]
printf 'phase=%s PASS unchanged\n' "$phase"
phase=public-listener
matched=0
for attempt in $(seq 1 8); do
  if http_code=$(curl --connect-timeout 3 --max-time 5 -sS -o /dev/null -w '%{http_code}' https://ampere.zwang.fun:8443/api/v1/passport/ws); then
    if [ "$http_code" = 401 ]; then matched=1; break; fi
  fi
  sleep 0.5
done
[ "$matched" -eq 1 ]
printf 'phase=%s PASS anonymous-WS=401 attempts=%s\n' "$phase" "$attempt"
phase=final-runtime
sudo systemctl is-active --quiet growdesk-api.service
pid=$(sudo systemctl show growdesk-api.service -p MainPID --value)
[ "$(sudo sha256sum "/proc/$pid/exe" | cut -d' ' -f1)" = "$expected_new" ]
trap - ERR
printf '%s\n' 'Deployment PASS; API configuration unchanged.'
date -u '+%Y-%m-%d %H:%M:%S UTC'
sudo sha256sum "$binary" "/proc/$pid/exe" "$stage/growdesk-api.rollback"
sudo systemctl show growdesk-api.service -p MainPID -p NRestarts -p ActiveState -p SubState -p ExecMainStartTimestamp
