/** Bundled as source so a packaged Electron worker needs no repository-relative files. */
export const SENSEVOICE_PYTHON_HELPER = String.raw`
import json
import os
import sys

# Keep native-library diagnostics off the structured protocol and out of application logs.
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
null_fd = os.open(os.devnull, os.O_WRONLY)
os.dup2(null_fd, 1)
os.dup2(null_fd, 2)
os.close(null_fd)

def emit(message):
    protocol.write(json.dumps(message, ensure_ascii=False) + "\n")
    protocol.flush()

def fail(code):
    emit({"type": "error", "code": code})
    raise SystemExit(1)

try:
    import numpy as np
    import sherpa_onnx
except Exception:
    fail("local_unavailable")

try:
    directory, language = sys.argv[1:3]
    if not os.path.isabs(directory) or language not in ("auto", "zh", "en", "ja", "ko", "yue"):
        fail("local_unavailable")
    model = os.path.join(directory, "model.int8.onnx")
    if not os.path.isfile(model):
        model = os.path.join(directory, "model.onnx")
    tokens = os.path.join(directory, "tokens.txt")
    if not os.path.isfile(model) or not os.path.isfile(tokens):
        fail("local_unavailable")
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model, tokens=tokens, language=language, use_itn=True,
        num_threads=2, debug=False, provider="cpu",
    )
except Exception:
    fail("local_unavailable")

emit({"type": "ready"})
try:
    # 60 seconds, 16 kHz, mono, signed 16-bit little endian. No files or network.
    maximum_bytes = 60 * 16000 * 2
    pcm = sys.stdin.buffer.read(maximum_bytes + 1)
    if not pcm or len(pcm) % 2 or len(pcm) > maximum_bytes:
        fail("invalid_audio")
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    text = stream.result.text
    if not isinstance(text, str):
        fail("protocol_error")
    emit({"type": "final", "text": text})
except Exception:
    fail("local_unavailable")
`;
