"""Silero via the existing sherpa-onnx runtime; no energy-detector substitute."""
from pathlib import Path


class SileroVad:
    def __init__(self, model, stop_secs=0.2):
        if not model or not Path(model).is_file():
            raise RuntimeError("vad_model_missing")
        import sherpa_onnx
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(Path(model).resolve())
        config.silero_vad.min_silence_duration = stop_secs
        config.silero_vad.min_speech_duration = 0.1
        config.silero_vad.max_speech_duration = 60.0
        config.sample_rate = 16000
        config.num_threads = 1
        self.detector = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=2)

    def accept(self, samples):
        self.detector.accept_waveform(samples)
        speaking = self.detector.is_speech_detected()
        # We own pre-roll and turn memory. Do not retain completed VAD segments.
        while not self.detector.empty():
            self.detector.pop()
        return speaking

    def reset(self):
        self.detector.reset()
