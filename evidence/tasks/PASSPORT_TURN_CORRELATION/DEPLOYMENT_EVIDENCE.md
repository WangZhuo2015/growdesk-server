# Passport turn-correlation deployment evidence

Date: 2026-10-03 UTC. Overall task status remains **IMPLEMENTED_NOT_REVIEWED**. This records the authorized Go binary rollout and bounded runtime checks; it does not mark the feature accepted or establish device, provider, or database-transaction acceptance.

## Target and rollout

- SSH target: `ubuntu@ampere.zwang.fun`, using `ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun` (port 22; no credentials or secrets are included here).
- Host architecture: Linux `aarch64`.
- Active Nginx include: `/etc/sing-box/nginx.d/growdesk.conf`. Its `/api/v1/passport/ws` and `/api/v1/passport/` locations proxy to `127.0.0.1:3081`.
- Active process: `growdesk-api.service`, direct host binary `/home/ubuntu/growdesk/bin/growdesk-api`, owner `ubuntu:ubuntu`, mode `755`. Compose API port `3180` and preview port `3181` are not the Passport upstream.
- Local artifact: `/tmp/growdesk-api-passport-turn-correlation-20261002-arm64`, statically linked ELF Linux ARM64, built with Go 1.27.0. SHA-256: `b98fe98f297db78c8dfbb8f24474b729e4323a45601289bbb30ae9f8760a551e`.
- Previous live binary SHA-256: `e2ed09212813dfdcb261555be045581f6fbb730f117e5c6cd66020ca0fe9faa6`.
- Preserved rollback copy: `/home/ubuntu/growdesk/releases/passport-turn-correlation-20261002-b98fe98/growdesk-api.rollback`, verified against the previous live hash. The uploaded new artifact remains at `/home/ubuntu/growdesk/releases/passport-turn-correlation-20261002-b98fe98/growdesk-api.new`.
- The binary was atomically replaced at the existing `ExecStart` path and only `growdesk-api.service` was restarted. No Nginx reload or Compose change was made.

The first immediate listener check raced the service startup and triggered the planned automatic rollback. The old binary was restored and its listener recovered; `NRestarts=0` was observed. A second attempt used a 30-second bound and required two consecutive one-second checks of stable PID, new process hash, active unit, and listening port.

Final read-only snapshot at `2026-10-03T04:26:38Z`: unit `active/running`; `MainPID=1966743`; `NRestarts=0`; `ExecMainStartTimestamp=2026-10-03 04:24:30 UTC`; running-process and on-disk SHA-256 both equal the new artifact hash; `127.0.0.1:3081` is listening. The second rollout reached readiness in about 2 seconds. An unauthenticated GET to `https://ampere.zwang.fun:8443/api/v1/passport/ws` returned HTTP `401`, as expected at the auth boundary. No token was sent.

## Public TLS comparison

Using local LibreSSL `s_client` with SNI `ampere.zwang.fun`, verification enabled, and `-showcerts`, ports 443 and 8443 served the same four-certificate chain before and after the binary replacement. The SAN is `DNS:ampere.zwang.fun`; local verification returned `0 (ok)`.

| Served certificate | SHA-256 of DER | Public key and certificate signature |
| --- | --- | --- |
| `ampere.zwang.fun`, issued by Let's Encrypt YE2 | `324ee95821bfa37b29bfd471ec0a136b3c4388a73e2642c2b98fcfad763c49d0` | ECDSA P-256; `ecdsa-with-SHA384` |
| Let's Encrypt YE2, issued by ISRG Root YE | `97658de8c68dfa98ace1e5028a63d54a1aae911b3e21471076c6850cd08cbab4` | ECDSA P-384; `ecdsa-with-SHA384` |
| ISRG Root YE, issued by ISRG Root X2 | `0fc0901cca2bae9e9fdbb02d50d02f1094f7b36672086991b9e897626dc485f0` | ECDSA P-384; `ecdsa-with-SHA384` |
| Cross-signed ISRG Root X2, issued by ISRG Root X1 | `ee5f7abd6981bb0255632cd8f49283451b4b18844d12040b44ee00f07b8fe2c6` | ECDSA P-384; `sha256WithRSAEncryption` |

Both ports negotiated TLS 1.3 with `AEAD-CHACHA20-POLY1305-SHA256`; forced TLS 1.2 also succeeded on both with `ECDHE-ECDSA-CHACHA20-POLY1305`, serving the identical chain. The active 443 Nginx server has no Passport route; the Passport locations are on 8443. Therefore, HTTPS success on port 443 alone does not prove the Passport endpoint was reached. The certificate is unchanged by the gateway rollout, and the local OpenSSL result does not establish that the ESP-IDF certificate bundle trusts this chain; the device's reported `esp-x509-crt-bundle` error remains unresolved by this server-side evidence.

## Independent verification commands

The following read-only commands can be repeated without reading runtime configuration, secrets, or database contents:

```sh
ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun \
  'systemctl show growdesk-api.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp --no-pager'
ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun bash -s <<'SH'
set -e
passport_pid=$(systemctl show growdesk-api.service -p MainPID --value)
sudo sha256sum "/proc/$passport_pid/exe"
sudo ss -ltnp 'sport = :3081'
SH
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --max-time 10 --noproxy '*' https://ampere.zwang.fun:8443/api/v1/passport/ws
openssl s_client -connect ampere.zwang.fun:8443 -servername ampere.zwang.fun \
  -verify 8 -showcerts
openssl s_client -connect ampere.zwang.fun:443 -servername ampere.zwang.fun \
  -verify 8 -showcerts
```

## Rollback

If the service hash, stable listener, or anonymous `401` check fails, restore the saved old binary and restart only this unit:

```sh
release=/home/ubuntu/growdesk/releases/passport-turn-correlation-20261002-b98fe98
live=/home/ubuntu/growdesk/bin/growdesk-api
sudo install -o ubuntu -g ubuntu -m 0755 "$release/growdesk-api.rollback" "$live.rollback.next"
sudo mv -f "$live.rollback.next" "$live"
sudo systemctl restart growdesk-api.service
```

Then verify `/proc/<MainPID>/exe` hashes to `e2ed09212813dfdcb261555be045581f6fbb730f117e5c6cd66020ca0fe9faa6`, the unit is active, and `127.0.0.1:3081` is listening. The rollback copy and new artifact are retained in the release directory.

No credential-bearing request, database query or transaction test, voice-provider call, push, or device WebSocket/card/confirmation test was performed as part of this deployment evidence.

Root independently verified the active PID, `NRestarts=0`, new running-process
SHA-256, the `127.0.0.1:3081` listener, and the anonymous public `401` response.
The SSH account uses fish, so commands requiring POSIX assignments explicitly
invoke `bash -s` as above.
