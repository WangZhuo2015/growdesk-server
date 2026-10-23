#!/usr/bin/env bash
set -euo pipefail

# Run on the existing host after the frozen artifact and offline checks pass.
# No secrets are embedded or printed; api.env.new was prepared on the host.
task_release=/home/ubuntu/growdesk/releases/passport-voice-20261003.53x7uqn0
task_live=/home/ubuntu/growdesk/bin/growdesk-api
task_config=/home/ubuntu/growdesk/api.env
task_previous=b98fe98f297db78c8dfbb8f24474b729e4323a45601289bbb30ae9f8760a551e
task_expected=${1:?Pass the exact verified new binary SHA-256}
[[ "$task_expected" =~ ^[a-f0-9]{64}$ ]]

task_wait_stable() {
  local expected=$1 previous_pid=0 stable=0 pid actual
  for _ in {1..30}; do
    pid=$(systemctl show growdesk-api.service -p MainPID --value)
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && systemctl is-active --quiet growdesk-api.service; then
      if ! actual=$(sudo -n sha256sum "/proc/$pid/exe" 2>/dev/null | awk '{print $1}'); then actual=missing; fi
      if [[ "$actual" == "$expected" ]] && ss -ltn 'sport = :3081' | awk '$4 == "127.0.0.1:3081" {found=1} END {exit !found}'; then
        if [[ "$pid" == "$previous_pid" ]]; then stable=$((stable+1)); else stable=1; fi
        previous_pid=$pid
        if ((stable >= 2)); then return 0; fi
      else stable=0; fi
    else stable=0; fi
    sleep 1
  done
  return 1
}

task_rollback() {
  trap - ERR INT TERM
  set +e
  sudo -n install -o ubuntu -g ubuntu -m 0755 "$task_release/growdesk-api.rollback" "$task_live.rollback.next"
  sudo -n mv -f "$task_live.rollback.next" "$task_live"
  sudo -n install -o ubuntu -g ubuntu -m 0600 "$task_release/api.env.rollback" "$task_config.rollback.next"
  sudo -n mv -f "$task_config.rollback.next" "$task_config"
  sudo -n systemctl restart growdesk-api.service
  if task_wait_stable "$task_previous"; then printf 'ROLLBACK_RESTORED %s\n' "$task_previous"; else printf 'ROLLBACK_FAILED\n'; fi
  exit 1
}

test "$(sha256sum "$task_release/growdesk-api.new" | awk '{print $1}')" = "$task_expected"
test "$(sha256sum "$task_release/growdesk-api.rollback" | awk '{print $1}')" = "$task_previous"
test "$(sha256sum "$task_live" | awk '{print $1}')" = "$task_previous"
test "$(sha256sum /srv/growdesk-tts/synthesize.py | awk '{print $1}')" = 2d9431ff06a61ebf85eb4d85ab9cf3a44b656341895a22fe6cf307e6c7fa62a5
test "$(sha256sum /srv/growdesk-tts/model/model.onnx | awk '{print $1}')" = bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d
cmp --silent "$task_config" "$task_release/api.env.rollback"
test "$(stat -c '%a' "$task_release/api.env.new")" = 600
test "$(stat -c '%a' "$task_release/api.env.rollback")" = 600
test "$(stat -c '%a' "$task_release")" = 700
trap task_rollback ERR INT TERM

sudo -n install -o ubuntu -g ubuntu -m 0600 "$task_release/api.env.new" "$task_config.voice.next"
sudo -n install -o ubuntu -g ubuntu -m 0755 "$task_release/growdesk-api.new" "$task_live.voice.next"
sudo -n mv -f "$task_config.voice.next" "$task_config"
sudo -n mv -f "$task_live.voice.next" "$task_live"
sudo -n systemctl restart growdesk-api.service
task_wait_stable "$task_expected"
task_public_status=$(curl --silent --show-error --noproxy '*' --max-time 10 --output /dev/null --write-out '%{http_code}' https://ampere.zwang.fun:8443/api/v1/passport/ws)
test "$task_public_status" = 401
trap - ERR INT TERM
printf 'DEPLOYED %s\n' "$task_expected"
systemctl show growdesk-api.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp --no-pager
printf 'ANONYMOUS_PASSPORT_STATUS %s\n' "$task_public_status"
