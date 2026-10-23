#!/usr/bin/env bash
set -euo pipefail
umask 077
stage=/home/ubuntu/growdesk/releases/passport-short-turn-20261003.HpwUp7VM
binary=/home/ubuntu/growdesk/bin/growdesk-api
expected_old=c98deb95c8060f871256b1520be3a95e8b318b8645740df81e52eba955f6f921
expected_new=9ae41d1fdddf3a605a95bed61d4a7249eb3e2c47bed388d96ba9d95a4065f7d9
phase=preflight
replaced=0
rollback() {
  status=$?
  printf 'Deployment failed at phase=%s\n' "$phase" >&2
  if [ "$replaced" -eq 1 ]; then
    sudo cp -p -- "$stage/growdesk-api.rollback" "$binary.rollback-short-turn"
    sudo mv -f -- "$binary.rollback-short-turn" "$binary"
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
sudo cp -p -- /home/ubuntu/growdesk/api.env "$stage/api.env.rollback"
sudo chmod 600 "$stage/api.env.rollback"
env_hash=$(sudo sha256sum /home/ubuntu/growdesk/api.env | cut -d' ' -f1)
printf 'phase=%s PASS\n' "$phase"
phase=replace
sudo cp -p -- "$stage/growdesk-api-linux-arm64" "$binary.next-short-turn"
sudo chown --reference="$binary" "$binary.next-short-turn"
sudo chmod --reference="$binary" "$binary.next-short-turn"
sudo mv -f -- "$binary.next-short-turn" "$binary"
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
[ "$(sudo sha256sum /home/ubuntu/growdesk/api.env | cut -d' ' -f1)" = "$env_hash" ]
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
