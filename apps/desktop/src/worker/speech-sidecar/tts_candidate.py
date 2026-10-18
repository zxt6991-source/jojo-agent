#!/usr/bin/env python3
"""Explicit CPU-only TTS candidate, no microphone/playback/network/files.

The model stays warm across requests. VITS callbacks are sentence batches, not
incremental phoneme synthesis. Numeric callback observations are diagnostic;
only a complete resampled utterance is delivered to the existing WAV adapter.
The host terminates this process on cancellation and recreates it on next use.
"""
import argparse
import math
import os
import sys
import time
from pathlib import Path

from protocol import read_frame, write_frame

MAX_SECONDS = 120


def pcm24k(samples, sample_rate):
    """Bounded windowed-sinc downsampling; never relabel native 44.1 kHz as 24k.

    A 48-tap Lanczos window and 6% transition band avoid linear-interpolation
    aliasing. Work is batched so long utterances do not allocate a full tap grid.
    """
    import numpy as np
    source = np.asarray(samples, dtype=np.float32)
    if source.ndim != 1 or not source.size or not np.isfinite(source).all() or not 8000 <= sample_rate <= 96000 or source.size > sample_rate * MAX_SECONDS:
        raise ValueError("invalid_audio")
    count = max(1, round(source.size * 24000 / sample_rate))
    if sample_rate == 24000:
        output = source
    else:
        output = np.empty(count, dtype=np.float32)
        taps = np.arange(-23, 25)
        cutoff = min(1.0, 24000 / sample_rate) * 0.94
        for start in range(0, count, 4096):
            stop = min(count, start + 4096)
            positions = np.arange(start, stop) * sample_rate / 24000
            indices = np.floor(positions).astype(np.int64)[:, None] + taps
            distances = positions[:, None] - indices
            weights = cutoff * np.sinc(cutoff * distances) * np.sinc(distances / 24)
            weights[np.abs(distances) >= 24] = 0
            weights /= weights.sum(axis=1, keepdims=True)
            output[start:stop] = (source[np.clip(indices, 0, source.size - 1)] * weights).sum(axis=1)
    return np.rint(np.clip(output, -1, 1) * 32767).astype("<i2").tobytes()


def load_model(directory, threads):
    import sherpa_onnx
    root = Path(directory)
    required = ["model.int8.onnx", "lexicon.txt", "tokens.txt", "dict/jieba.dict.utf8", "date.fst", "number.fst", "phone.fst"]
    if any(not (root / name).is_file() for name in required):
        raise ValueError("local_unavailable")
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=str(root / "model.int8.onnx"), lexicon=str(root / "lexicon.txt"),
                tokens=str(root / "tokens.txt"), dict_dir=str(root / "dict")),
            num_threads=threads, debug=False, provider="cpu"),
        rule_fsts=",".join(str(root / name) for name in ("phone.fst", "date.fst", "number.fst")), max_num_sentences=1)
    if not config.validate():
        raise ValueError("local_unavailable")
    return sherpa_onnx.OfflineTts(config), sherpa_onnx.__version__


def serve(tts, source, emit):
    while True:
        try:
            frame = read_frame(source)
            if frame is None:
                return 0
            header, body = frame
            if header.get("type") == "shutdown" and not body:
                return 0
            request_id, text, speed = header.get("requestId"), header.get("text"), header.get("speed")
            if body or header.get("type") != "tts.synthesize" or not isinstance(request_id, str) or not 1 <= len(request_id) <= 256:
                raise ValueError("invalid_protocol")
            if not isinstance(text, str) or not text.strip() or len(text) > 600 or "\0" in text or isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not 0.5 <= speed <= 2:
                raise ValueError("invalid_protocol")
        except Exception:
            emit({"type": "tts.error", "code": "protocol_error"})
            return 2
        try:
            started = time.monotonic()
            emit({"type": "tts.started", "requestId": request_id})
            callback_count, callback_samples, exceeded = 0, 0, False

            def callback(samples, progress):
                nonlocal callback_count, callback_samples, exceeded
                callback_count += 1
                callback_samples += len(samples)
                if callback_samples > tts.sample_rate * MAX_SECONDS or callback_count > 1000:
                    exceeded = True
                    return 0
                emit({"type": "tts.callback", "requestId": request_id, "callback": callback_count,
                      "samples": len(samples), "atMs": (time.monotonic() - started) * 1000})
                # sherpa 1.13.8 C++ contract: 1 continues; 0 stops. Its Python
                # generate docstring says the opposite; verified against source.
                return 1

            audio = tts.generate(text, sid=0, speed=float(speed), callback=callback)
            if exceeded:
                raise ValueError("audio_limit")
            pcm = pcm24k(audio.samples, audio.sample_rate)
            sequence = 0
            for offset in range(0, len(pcm), 65536):
                sequence += 1
                emit({"type": "tts.pcm", "requestId": request_id, "sequence": sequence, "sampleRate": 24000}, pcm[offset:offset + 65536])
            emit({"type": "tts.completed", "requestId": request_id, "frames": len(pcm) // 2})
        except Exception:
            emit({"type": "tts.error", "requestId": request_id, "code": "local_unavailable"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.threads <= 8:
        parser.error("invalid threads")
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    emit = lambda header, body=b"": write_frame(protocol, header, body)
    started = time.monotonic()
    try:
        tts, version = load_model(args.model_dir, args.threads)
        emit({"type": "tts.ready", "protocolVersion": 1, "sampleRate": tts.sample_rate,
              "runtimeVersion": version, "loadMs": (time.monotonic() - started) * 1000})
    except Exception:
        emit({"type": "tts.error", "code": "local_unavailable"})
        return 1
    return serve(tts, sys.stdin.buffer, emit)


if __name__ == "__main__":
    raise SystemExit(main())
