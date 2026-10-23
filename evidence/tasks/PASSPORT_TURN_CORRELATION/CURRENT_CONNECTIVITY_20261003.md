# Current Passport gateway connectivity

Capture window: 2026-10-03 08:04:31–08:06:31 UTC. Read-only checks only. The task status remains **IMPLEMENTED_NOT_REVIEWED**.

## Upstream process

At 08:04:31 UTC, SSH to `ubuntu@ampere.zwang.fun` (using `-o BatchMode=yes -o HostKeyAlias=161.33.201.230`) reported `growdesk-api.service` as `active/running`, `MainPID=1966743`, `NRestarts=0`, and `ExecMainStartTimestamp=2026-10-03 04:24:30 UTC`.

At 08:04:33 UTC, `/proc/1966743/exe` had SHA-256 `b98fe98f297db78c8dfbb8f24474b729e4323a45601289bbb30ae9f8760a551e`, matching the retained rollout artifact in [DEPLOYMENT_EVIDENCE.md](DEPLOYMENT_EVIDENCE.md). `ss` showed `growdesk-api` listening on `127.0.0.1:3081`.

Commands used:

```sh
ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun \
  'systemctl show growdesk-api.service -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp --no-pager'
ssh -o BatchMode=yes -o HostKeyAlias=161.33.201.230 ubuntu@ampere.zwang.fun bash -s
# bash -s body: read MainPID; sudo -n sha256sum /proc/$MainPID/exe;
# sudo -n ss -ltnp 'sport = :3081'
```

## Public endpoint and TLS

The local resolver returned `198.18.0.97` for `ampere.zwang.fun`. To test the known gateway address directly while preserving TLS SNI and hostname validation, the route was pinned to `161.33.201.230` with curl `--resolve`.

At 08:06:08 UTC, an unauthenticated GET to `https://ampere.zwang.fun:8443/api/v1/passport/ws` returned HTTP `401`, `remote_ip=161.33.201.230`, and `tls_verify=0` (successful certificate verification). This is the expected anonymous auth boundary; no token was sent and no WebSocket upgrade or authenticated handshake was attempted.

At 08:06:30–08:06:31 UTC, LibreSSL `s_client` connected directly to `161.33.201.230` on ports 443 and 8443 with SNI `ampere.zwang.fun`, `-verify 8 -verify_return_error -showcerts`. Both ports served four certificates and returned `verify return:1` at every depth from the leaf through the root. The served chains matched, including these SHA-256 fingerprints:

| Certificate | SHA-256 |
| --- | --- |
| `ampere.zwang.fun`, issued by Let's Encrypt YE2 | `324ee95821bfa37b29bfd471ec0a136b3c4388a73e2642c2b98fcfad763c49d0` |
| Let's Encrypt YE2, issued by ISRG Root YE | `97658de8c68dfa98ace1e5028a63d54a1aae911b3e21471076c6850cd08cbab4` |
| ISRG Root YE, issued by ISRG Root X2 | `0fc0901cca2bae9e9fdbb02d50d02f1094f7b36672086991b9e897626dc485f0` |
| Cross-signed ISRG Root X2, issued by ISRG Root X1 | `ee5f7abd6981bb0255632cd8f49283451b4b18844d12040b44ee00f07b8fe2c6` |

The endpoint check and TLS validation show that the gateway address is reachable from this workstation and presents a locally trusted chain. They do not establish that the Passport firmware's embedded trust bundle accepts the chain.

## Device boundary

Device state from the task handoff, not re-measured in this capture: the device remains on the first repair image `447031ELF` and reports WSS TLS MPI allocation failure `0x4290`; the newer TLS fix has not been flashed. No physical device or serial session was accessed. This capture therefore does not establish device TLS success, WebSocket hello/ready, card display, or confirmation behavior.

No server configuration, secrets, database, provider, authenticated route, or service state was changed or read. No deployment or restart was performed.
