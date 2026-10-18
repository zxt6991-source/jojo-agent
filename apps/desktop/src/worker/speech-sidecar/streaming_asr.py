"""One warm Paraformer recognizer, fresh streams per user turn."""
from pathlib import Path


class StreamingAsr:
    def __init__(self, directory, threads=2):
        root = Path(directory) if directory else None
        if root is None or not root.is_dir():
            raise RuntimeError("asr_model_missing")
        def model(name):
            for suffix in (".int8.onnx", ".onnx"):
                candidate = root / (name + suffix)
                if candidate.is_file():
                    return str(candidate.resolve())
            raise RuntimeError("asr_model_missing")
        tokens = root / "tokens.txt"
        if not tokens.is_file():
            raise RuntimeError("asr_tokens_missing")
        import sherpa_onnx
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(tokens.resolve()), encoder=model("encoder"), decoder=model("decoder"),
            sample_rate=16000, feature_dim=80, num_threads=threads, provider="cpu",
            decoding_method="greedy_search", enable_endpoint_detection=False,
        )

    def create_stream(self):
        return self.recognizer.create_stream()

    def accept(self, stream, samples):
        stream.accept_waveform(16000, samples)
        self.decode(stream)
        return self.recognizer.get_result(stream)

    def decode(self, stream):
        while self.recognizer.is_ready(stream):
            self.recognizer.decode_stream(stream)

    def finish(self, stream):
        import numpy as np
        # Official sherpa file-decoding example pads 0.66 s before input_finished.
        stream.accept_waveform(16000, np.zeros(int(0.66 * 16000), dtype=np.float32))
        stream.input_finished()
        self.decode(stream)
        return self.recognizer.get_result(stream)
