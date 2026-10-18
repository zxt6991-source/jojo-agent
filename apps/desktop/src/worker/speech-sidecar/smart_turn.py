"""Smart Turn v3.1 ONNX, using the official Whisper feature preprocessing.

Sources: pipecat-ai/smart-turn inference.py and audio_utils.py.
No from_pretrained call, cache lookup or automatic model download is performed.
A model being available does not certify Chinese replay accuracy.
"""
from pathlib import Path
import time


class SmartTurn:
    def __init__(self, model):
        if not model or not Path(model).is_file():
            raise RuntimeError("smart_turn_model_missing")
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(Path(model).resolve()), sess_options=options,
                                            providers=["CPUExecutionProvider"])
        if [item.name for item in self.session.get_inputs()] != ["input_features"]:
            raise RuntimeError("smart_turn_incompatible_model")
        self.extractor = WhisperFeatureExtractor(chunk_length=8)

    def predict(self, samples):
        import numpy as np
        started = time.perf_counter()
        audio = np.asarray(samples[-8 * 16000:], dtype=np.float32)
        # Official audio_utils pads the beginning so the utterance ends at 8 s.
        if len(audio) < 8 * 16000:
            audio = np.pad(audio, (8 * 16000 - len(audio), 0), mode="constant")
        features = self.extractor(audio, sampling_rate=16000, return_tensors="np",
                                  padding="max_length", max_length=8 * 16000,
                                  truncation=True, do_normalize=True)
        inputs = np.expand_dims(features.input_features.squeeze(0).astype(np.float32), axis=0)
        probability = float(self.session.run(None, {"input_features": inputs})[0][0].item())
        if not np.isfinite(probability) or not 0 <= probability <= 1:
            raise RuntimeError("smart_turn_invalid_score")
        return probability, (time.perf_counter() - started) * 1000
