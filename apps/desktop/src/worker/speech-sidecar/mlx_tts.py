#!/usr/bin/env python3
"""Offline Apple Silicon neural voice. No microphone, playback or remote code.

The model stays warm. Cooperative cancellation stops at a generated batch
boundary and confirms cleanup before another request. Only bounded PCM crosses stdout.
"""
import argparse
from importlib.metadata import version
import math
import os
from pathlib import Path
import sys
import select
import time

from protocol import read_frame, write_frame

VOICES = ("Serena", "Vivian", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee")
MAX_FRAMES = 24000 * 120
MAX_TOKENS = 1500
# Sampling defaults from the pinned CustomVoice checkpoint's generation_config.
# Keep them explicit; runtime model files must not change the generation policy.
GENERATION_PARAMETERS = {"temperature": 0.9, "top_p": 1.0, "top_k": 50, "repetition_penalty": 1.05}
# Each segment starts from the same sampling state. Warmup, other requests and
# cancellation must not randomly change the selected preset's next rendering.
# This removes request-order drift, not the model's text-dependent prosody.
GENERATION_SEED = 0


def load_model(directory):
    root = Path(directory)
    required = ("config.json", "model.safetensors", "tokenizer_config.json", "vocab.json", "merges.txt",
                "speech_tokenizer/config.json", "speech_tokenizer/model.safetensors")
    if not root.is_absolute() or any(not (root / name).is_file() for name in required):
        raise ValueError("local_unavailable")
    import mlx.core as mx
    if not mx.metal.is_available():
        raise ValueError("local_unavailable")
    mx.set_default_device(mx.gpu)
    mx.set_memory_limit(6 * 1024 ** 3)
    mx.set_cache_limit(512 * 1024 ** 2)
    from mlx_audio.tts.utils import load_model as load
    model = load(str(root), trust_remote_code=False)
    if model.sample_rate != 24000 or model.config.tts_model_type != "custom_voice":
        raise ValueError("invalid_model")
    return model, version("mlx-audio")


class Cancelled(Exception):
    pass


def serve(model, source, emit, has_control=lambda: False, cleanup_cancel=lambda: None,
          seed_generation=lambda _seed: None):
    import numpy as np
    last_completed = None

    def check_cancel(request_id):
        # The production source is unbuffered: select cannot miss a cancel frame
        # that a buffered read has already prefetched from the OS pipe.
        if not has_control():
            return
        frame = read_frame(source)
        if frame is None:
            raise BrokenPipeError("input_closed")
        header, body = frame
        if body or header != {"type": "tts.cancel", "requestId": request_id}:
            raise ValueError("protocol_error")
        raise Cancelled()

    while True:
        try:
            frame = read_frame(source)
            if frame is None:
                return 0
            header, body = frame
            if header.get("type") == "shutdown" and not body:
                return 0
            if header.get("type") == "tts.cancel":
                # Completion can cross an in-flight cancel. Acknowledge the
                # barrier even when all audio was sent before cancellation.
                if body or last_completed is None or header != {"type": "tts.cancel", "requestId": last_completed}:
                    raise ValueError("protocol_error")
                emit({"type": "tts.cancelled", "requestId": last_completed})
                last_completed = None
                continue
            request_id, text, speed = header.get("requestId"), header.get("text"), header.get("speed")
            voice = header.get("speakerId", "default")
            if body or header.get("type") != "tts.synthesize" or not isinstance(request_id, str) or not 1 <= len(request_id) <= 256:
                raise ValueError("protocol_error")
            if not isinstance(text, str) or not text.strip() or len(text) > 600 or "\0" in text or voice not in ("default", *VOICES):
                raise ValueError("protocol_error")
            # This model does not implement tempo control. Never silently ignore it.
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed != 1:
                raise ValueError("protocol_error")
        except Exception:
            emit({"type": "tts.error", "code": "protocol_error"})
            return 2
        try:
            last_completed = None
            started = time.monotonic()
            emit({"type": "tts.started", "requestId": request_id})
            total, sequence, batch, tokens = 0, 0, 0, 0
            # A full coherent segment shares prosody; stream only the generated
            # audio, without slicing text into independently restarted clauses.
            check_cancel(request_id)
            seed_generation(GENERATION_SEED)
            generation = model.generate(text, voice="Serena" if voice == "default" else voice,
                                        lang_code="auto", **GENERATION_PARAMETERS,
                                        max_tokens=MAX_TOKENS, verbose=False, stream=True,
                                        streaming_interval=0.8)
            try:
                while True:
                    check_cancel(request_id)
                    try:
                        result = next(generation)
                    except StopIteration:
                        break
                    check_cancel(request_id)
                    samples = np.asarray(result.audio, dtype=np.float32)
                    if samples.ndim != 1 or not samples.size or result.sample_rate != 24000 or not np.isfinite(samples).all():
                        raise ValueError("invalid_audio")
                    tokens += result.token_count
                    if tokens >= MAX_TOKENS or total + samples.size > MAX_FRAMES:
                        raise ValueError("audio_limit")
                    batch += 1
                    if batch > 1000:
                        raise ValueError("audio_limit")
                    emit({"type": "tts.callback", "requestId": request_id, "callback": batch,
                          "samples": samples.size, "atMs": (time.monotonic() - started) * 1000})
                    pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
                    for offset in range(0, len(pcm), 65536):
                        sequence += 1
                        emit({"type": "tts.pcm", "requestId": request_id, "sequence": sequence, "sampleRate": 24000}, pcm[offset:offset + 65536])
                    total += samples.size
            finally:
                close = getattr(generation, "close", None)
                if close:
                    close()
            check_cancel(request_id)
            if not total:
                raise ValueError("empty_audio")
            last_completed = request_id
            emit({"type": "tts.completed", "requestId": request_id, "frames": total})
        except Cancelled:
            try:
                # Closing the generator alone skips the library's normal tail
                # cleanup. Reset decoder state and synchronize GPU work first.
                cleanup_cancel()
                emit({"type": "tts.cancelled", "requestId": request_id})
            except Exception:
                emit({"type": "tts.error", "requestId": request_id, "code": "synthesis_failed"})
                return 1
        except Exception as error:
            # Controlled categories only; library traces never enter the UI.
            code = {"protocol_error": "protocol_error", "audio_limit": "synthesis_limit", "invalid_audio": "invalid_audio", "empty_audio": "empty_result"}.get(str(error), "synthesis_failed")
            emit({"type": "tts.error", "requestId": request_id, "code": code})
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    emit = lambda header, body=b"": write_frame(protocol, header, body)
    started = time.monotonic()
    try:
        model, runtime_version = load_model(args.model_dir)
        emit({"type": "tts.ready", "protocolVersion": 1, "sampleRate": 24000,
              "cooperativeCancel": True, "runtimeVersion": runtime_version, "loadMs": (time.monotonic() - started) * 1000})
    except Exception:
        emit({"type": "tts.error", "code": "local_unavailable"})
        return 1
    import mlx.core as mx

    def cleanup_cancel():
        mx.synchronize()
        model.speech_tokenizer.decoder.reset_streaming_state()
        mx.clear_cache()

    source = os.fdopen(os.dup(sys.stdin.fileno()), "rb", buffering=0)
    return serve(model, source, emit, lambda: bool(select.select([source], [], [], 0)[0]),
                 cleanup_cancel, mx.random.seed)


if __name__ == "__main__":
    raise SystemExit(main())
