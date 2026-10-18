#!/usr/bin/env python3
"""Explicit offline CPU CosyVoice3 candidate. No recording or playback.

Native generated batches are sent immediately as 24k PCM. The existing Node WAV
adapter still buffers them; benchmark observations expose both timing bounds.
Cancel kills this isolated process, including the upstream LLM inference thread.
"""
import argparse
import math
import os
from pathlib import Path
import sys
import time

from protocol import read_frame, write_frame
from tts_candidate import pcm24k

REFERENCE_TEXT = "这是用于本地语音评测的合成参考声音，请用自然清晰的普通话朗读。"


def load_model(directory, source, reference, threads):
    os.environ.setdefault("MPLBACKEND", "Agg")
    os.environ.setdefault("MPLCONFIGDIR", str(Path(reference).parent / "matplotlib-cache"))
    root, code, wav = Path(directory), Path(source), Path(reference)
    if not all(path.is_absolute() for path in (root, code, wav)) or not root.is_dir() or not wav.is_file():
        raise ValueError("local_unavailable")
    for name in ("cosyvoice3.yaml", "llm.pt", "flow.pt", "hift.pt", "campplus.onnx", "speech_tokenizer_v3.onnx", "CosyVoice-BlankEN/model.safetensors"):
        if not (root / name).is_file():
            raise ValueError("local_unavailable")
    sys.path.insert(0, str(code))
    sys.path.insert(0, str(code / "third_party" / "Matcha-TTS"))
    import torch
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    from cosyvoice.cli.cosyvoice import CosyVoice3
    model = CosyVoice3(str(root), load_trt=False, load_vllm=False, fp16=False)
    if model.sample_rate != 24000 or model.model.device.type != "cpu":
        raise ValueError("unexpected_runtime")
    # Cache the synthetic reference in RAM; never save spk2info or user speech.
    if not model.add_zero_shot_spk("You are a helpful assistant.<|endofprompt|>" + REFERENCE_TEXT, str(wav), "jojo-benchmark"):
        raise ValueError("invalid_reference")
    return model, str(torch.__version__)


def serve(model, source, emit):
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
                raise ValueError("protocol_error")
            if not isinstance(text, str) or not text.strip() or len(text) > 600 or "\0" in text or isinstance(speed, bool) or not isinstance(speed, (float, int)) or not math.isfinite(speed) or speed != 1:
                raise ValueError("protocol_error")
        except Exception:
            emit({"type": "tts.error", "code": "protocol_error"})
            return 2
        try:
            started = time.monotonic()
            emit({"type": "tts.started", "requestId": request_id})
            total, sequence, batch = 0, 0, 0
            for result in model.inference_zero_shot(text, "", "", zero_shot_spk_id="jojo-benchmark", stream=True, speed=1.0, text_frontend=False):
                samples = result["tts_speech"].detach().cpu().numpy().reshape(-1)
                if not len(samples):
                    continue
                batch += 1
                if batch > 1000 or total + len(samples) > 24000 * 120:
                    raise ValueError("audio_limit")
                emit({"type": "tts.callback", "requestId": request_id, "callback": batch, "samples": len(samples), "atMs": (time.monotonic() - started) * 1000})
                pcm = pcm24k(samples, 24000)
                for offset in range(0, len(pcm), 65536):
                    sequence += 1
                    emit({"type": "tts.pcm", "requestId": request_id, "sequence": sequence, "sampleRate": 24000}, pcm[offset:offset + 65536])
                total += len(pcm) // 2
            if not total:
                raise ValueError("empty_audio")
            emit({"type": "tts.completed", "requestId": request_id, "frames": total})
        except Exception:
            emit({"type": "tts.error", "requestId": request_id, "code": "local_unavailable"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--reference-wav", required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.threads <= 8:
        parser.error("invalid threads")
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    emit = lambda header, body=b"": write_frame(protocol, header, body)
    started = time.monotonic()
    try:
        model, version = load_model(args.model_dir, args.source_dir, args.reference_wav, args.threads)
        emit({"type": "tts.ready", "protocolVersion": 1, "sampleRate": 24000, "runtimeVersion": version, "loadMs": (time.monotonic() - started) * 1000})
    except Exception:
        emit({"type": "tts.error", "code": "local_unavailable"})
        return 1
    return serve(model, sys.stdin.buffer, emit)


if __name__ == "__main__":
    raise SystemExit(main())
