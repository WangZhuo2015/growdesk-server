set -euo pipefail
umask 077
[ "$(sha256sum /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/voice-gate.tar.gz | cut -d' ' -f1)" = b2cc4da8527acfa05ddeef2ad63ba770dd12ca96a882bea2ffb7a5d0a74d0d8b ]
tar --no-same-owner -xzf /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/voice-gate.tar.gz -C /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7
[ "$(sha256sum /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/growdesk-api-linux-arm64 | cut -d' ' -f1)" = fb9bcc8511fdfe3427631374d4abfe8a11d0cd202fd1e879e4ac807279434841 ]
[ "$(sha256sum /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/local-voice-linux-arm64.test | cut -d' ' -f1)" = 4b252721a0b0ecf16d42484bec994b05d08e93f3a063d9bd721b26f6b2cc0455 ]
[ "$(sha256sum /srv/growdesk-tts/synthesize.py | cut -d' ' -f1)" = 2d9431ff06a61ebf85eb4d85ab9cf3a44b656341895a22fe6cf307e6c7fa62a5 ]
[ "$(sha256sum /srv/growdesk-tts/model/model.onnx | cut -d' ' -f1)" = bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d ]
chmod 700 /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/local-voice-linux-arm64.test
env -i PATH=/usr/bin:/bin TMPDIR=/tmp GROWDESK_LOCAL_VOICE_ACCEPTANCE=1 'ASR_COMMAND=/srv/asr/run.sh {input}' GROWDESK_TTS_PROVIDER=local-sherpa GROWDESK_TTS_VOICE=zh GROWDESK_TTS_TIMEOUT_MS=110000 /home/ubuntu/growdesk/releases/passport-audio-query-20261003.7Rfz1DF7/local-voice-linux-arm64.test -test.v -test.timeout=180s '-test.run=^(TestLocalASR|TestTranscribeLocalASR|TestLocalPassportTTS|TestSynthesizeLocalPassportTTS|TestPassportExistingLocalVoiceAcceptance|TestPassportTTS|TestPassportSpeech|TestPassportVoiceDiagnostic)'
