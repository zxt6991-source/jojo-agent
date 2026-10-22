#!/usr/bin/env python3
"""Compare two sampling profiles on fixed synthetic text; no playback or downloads.

Run with .local-speech/venv-mlx-tts/bin/python3. This is a seeded diagnostic,
not a production latency benchmark or a listening-quality assessment.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
TEXT = "已经找到播放延迟的主要原因，我会先验证流式播放，再检查回声消除，具体结果放在屏幕上。"


def bounded(lower, upper):
    def parse(value):
        number = int(value)
        if not lower <= number <= upper:
            raise argparse.ArgumentTypeError(f"must be between {lower} and {upper}")
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--seed-start", type=bounded(0, 1000000), default=0)
    parser.add_argument("--seeds", type=bounded(1, 32), default=24)
    parser.add_argument("--max-tokens", type=bounded(50, 1500), default=400)
    args = parser.parse_args()
    # Reserve the new report before importing MLX or loading any model.
    with args.report.open("x", encoding="utf-8") as output:
        report = {"scope": "fixed_sentence_parameter_diagnosis_not_production_benchmark",
                  "measuredAt": datetime.now(timezone.utc).isoformat(), "status": "running",
                  "syntheticTextChars": len(TEXT), "seedStart": args.seed_start,
                  "seeds": args.seeds, "maxTokens": args.max_tokens,
                  "modelRevision": "08c72cad5e2fd0f41730c8bd1f28149585e46361",
                  "modelHashesVerified": False, "loadTimeIncluded": False,
                  "physicalOutputPlayed": False, "listeningQualityAssessed": False, "rows": []}

        def save():
            output.seek(0)
            output.write(json.dumps(report, indent=2, allow_nan=False) + "\n")
            output.truncate()
            output.flush()

        save()
        try:
            os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", USE_TORCH="0", USE_TF="0")
            sys.path.insert(0, str(ROOT / "apps/desktop/src/worker/speech-sidecar"))
            from mlx_tts import GENERATION_PARAMETERS, load_model
            import mlx.core as mx
            import numpy as np

            model, runtime = load_model(str(ROOT / ".local-speech/models/Qwen3-TTS-0.6B-4bit"))
            report["runtime"] = runtime
            profiles = [("previous", {"temperature": .7, "top_p": .9, "top_k": 50, "repetition_penalty": 1.05}),
                        ("checkpoint", dict(GENERATION_PARAMETERS))]
            report["profiles"] = dict(profiles)
            save()
            for seed in range(args.seed_start, args.seed_start + args.seeds):
                for name, parameters in profiles:
                    mx.random.seed(seed)
                    started = time.monotonic()
                    first = None
                    tokens = frames = callbacks = 0
                    error = None
                    generated = model.generate(TEXT, voice="Serena", lang_code="auto", **parameters,
                                               max_tokens=args.max_tokens, verbose=False, stream=True, streaming_interval=.8)
                    try:
                        for chunk in generated:
                            first = first if first is not None else (time.monotonic() - started) * 1000
                            samples = np.asarray(chunk.audio)
                            if samples.ndim != 1 or not samples.size or not np.isfinite(samples).all() or chunk.sample_rate != 24000:
                                raise ValueError("invalid_audio")
                            tokens += chunk.token_count
                            frames += samples.size
                            callbacks += 1
                        if not frames:
                            raise ValueError("empty_audio")
                    except Exception:
                        error = "generation_failed"
                    finally:
                        generated.close()
                        mx.synchronize()
                        model.speech_tokenizer.decoder.reset_streaming_state()
                        mx.clear_cache()
                    row = {"profile": name, "seed": seed, "tokens": tokens, "audioMs": frames / 24,
                           "callbacks": callbacks, "firstPcmMs": first, "totalMs": (time.monotonic() - started) * 1000,
                           "hitLimit": tokens >= args.max_tokens, "error": error}
                    report["rows"].append(row)
                    save()
                    print(json.dumps(row, allow_nan=False), flush=True)
            report["status"] = "completed"
            save()
            return 0
        except BaseException:
            report["status"] = "failed"
            save()
            raise


if __name__ == "__main__":
    raise SystemExit(main())
