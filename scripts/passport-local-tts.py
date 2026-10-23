#!/usr/bin/env python3
"""Fixed offline MeloTTS renderer, launched by the guarded Passport runner.

Install this file as /srv/growdesk-tts/synthesize.py with the official
vits-melo-tts-zh_en release extracted to /srv/growdesk-tts/model. No runtime
downloads, configurable paths, shell invocation, or network provider exist.
"""

import io
import stat
import sys
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


MAX_TEXT_BYTES = 8 * 1024
MAX_WAVE_BYTES = 12 * 1024 * 1024
MODEL_ROOT = Path("/srv/growdesk-tts/model")


def render(text):
    for directory in (MODEL_ROOT, *MODEL_ROOT.parents):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("fixed local TTS model directory is unprotected")
    for name in ("model.onnx", "tokens.txt", "lexicon.txt", "phone.fst", "date.fst", "number.fst"):
        info = (MODEL_ROOT / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("fixed local TTS model asset is unprotected")
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(MODEL_ROOT / "model.onnx"),
                tokens=str(MODEL_ROOT / "tokens.txt"),
                lexicon=str(MODEL_ROOT / "lexicon.txt"),
            ),
            num_threads=1,
            provider="cpu",
            debug=False,
        ),
        rule_fsts=",".join(
            str(MODEL_ROOT / name)
            for name in ("phone.fst", "date.fst", "number.fst")
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError("fixed local TTS model configuration is invalid")
    engine = sherpa_onnx.OfflineTts(config)
    generated_samples = 0
    exceeded = False

    def bounded_batch(samples, progress):
        nonlocal generated_samples, exceeded
        generated_samples += len(samples)
        if generated_samples * 2 + 44 > MAX_WAVE_BYTES:
            exceeded = True
            return 0
        return 1

    # In the installed VITS implementation, 1 continues and 0 stops later
    # batches. Reject an interrupted result rather than emitting partial audio.
    # Go also enforces process time/CPU/address-space limits during each batch.
    audio = engine.generate(text, sid=0, speed=1.0, callback=bounded_batch)
    if exceeded:
        raise ValueError("local TTS generation exceeded its audio byte budget")
    samples = np.asarray(audio.samples)
    if (
        audio.sample_rate != 44100
        or samples.ndim != 1
        or len(samples) == 0
        or len(samples) * 2 + 44 > MAX_WAVE_BYTES
        or not np.isfinite(samples).all()
    ):
        raise ValueError("local TTS audio exceeds the fixed format or byte budget")
    pcm = np.clip(samples * 32767, -32768, 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(audio.sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def main():
    if len(sys.argv) != 1:
        raise ValueError("local TTS accepts text only on stdin")
    raw = sys.stdin.buffer.read(MAX_TEXT_BYTES + 1)
    if not raw or len(raw) > MAX_TEXT_BYTES:
        raise ValueError("local TTS input exceeds its byte budget")
    text = raw.decode("utf-8", errors="strict")
    if not text.strip() or "\x00" in text:
        raise ValueError("local TTS input is invalid")
    sys.stdout.buffer.write(render(text))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never log input text, arbitrary paths, or package exception details.
        print("Local speech synthesis failed", file=sys.stderr)
        raise SystemExit(1)
