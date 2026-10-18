"""Candidate protocol and resampler checks; no models, network or playback."""
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from protocol import MAX_FRAME_BYTES, read_frame, write_frame
from tts_candidate import pcm24k, serve

try:
    import numpy as np
except ImportError:
    np = None


def request(text="你好。", **fields):
    source = BytesIO()
    write_frame(source, {"type": "tts.synthesize", "requestId": "test", "text": text, "speed": 1, **fields})
    source.seek(0)
    return source


class TtsProtocolTests(unittest.TestCase):
    def test_binary_output_round_trip_and_size_limit(self):
        stream = BytesIO()
        write_frame(stream, {"type": "tts.pcm"}, b"\x00\x7f\xff\x80")
        stream.seek(0)
        self.assertEqual(read_frame(stream), ({"type": "tts.pcm"}, b"\x00\x7f\xff\x80"))
        with self.assertRaises(ValueError):
            write_frame(BytesIO(), {}, b"x" * MAX_FRAME_BYTES)

    def test_sentence_callback_continues_and_only_complete_audio_becomes_pcm(self):
        events = []

        def generate(text, sid, speed, callback):
            self.assertEqual(callback([0.2, 0.3], 0.5), 1)
            self.assertFalse(any(header["type"] == "tts.pcm" for header, _ in events))
            self.assertEqual(callback([0.1], 1), 1)
            return SimpleNamespace(samples=[0.2, 0.3, 0.1], sample_rate=44100)

        tts = SimpleNamespace(sample_rate=44100, generate=generate)
        with patch("tts_candidate.pcm24k", return_value=b"\x00\x01" * 40000):
            self.assertEqual(serve(tts, request(), lambda header, body=b"": events.append((header, body))), 0)
        self.assertEqual([header["type"] for header, _ in events], ["tts.started", "tts.callback", "tts.callback", "tts.pcm", "tts.pcm", "tts.completed"])
        self.assertEqual(sum(len(body) for _, body in events), 80000)
        self.assertEqual(events[-1][0]["frames"], 40000)
        self.assertTrue(all(len(body) <= 65536 for _, body in events))

    def test_invalid_text_speed_and_type_never_call_model(self):
        for fields in ({"text": ""}, {"text": "x" * 601}, {"text": "\0"}, {"speed": True}, {"speed": 3}, {"type": "unknown"}):
            events = []
            tts = SimpleNamespace(generate=lambda *_args: self.fail("model called on invalid input"))
            self.assertEqual(serve(tts, request(**fields), lambda header: events.append(header)), 2)
            self.assertEqual(events, [{"type": "tts.error", "code": "protocol_error"}])

    def test_native_failure_returns_controlled_error_and_keeps_protocol_usable(self):
        events = []

        def fail(*_args, **_kwargs):
            raise RuntimeError("private model path or text")

        self.assertEqual(serve(SimpleNamespace(generate=fail), request(), lambda header: events.append(header)), 0)
        self.assertEqual(events[-1], {"type": "tts.error", "requestId": "test", "code": "local_unavailable"})


@unittest.skipIf(np is None, "NumPy is available in the explicitly installed speech venv")
class ResamplerTests(unittest.TestCase):
    def samples(self, frequency, seconds=0.1):
        return 0.5 * np.sin(2 * np.pi * frequency * np.arange(round(44100 * seconds)) / 44100)

    def test_duration_and_dc_gain(self):
        pcm = np.frombuffer(pcm24k(np.full(44100, 0.25), 44100), dtype="<i2")
        self.assertEqual(len(pcm), 24000)
        self.assertLess(np.max(np.abs(pcm.astype(float) / 32767 - 0.25)), 0.00004)

    def test_speech_band_preserved_and_above_nyquist_attenuated(self):
        low = np.frombuffer(pcm24k(self.samples(1000), 44100), dtype="<i2").astype(float)[100:-100] / 32767
        high = np.frombuffer(pcm24k(self.samples(18000), 44100), dtype="<i2").astype(float)[100:-100] / 32767
        self.assertAlmostEqual(float(np.sqrt(np.mean(low ** 2))), 0.5 / 2 ** 0.5, delta=0.005)
        self.assertLess(float(np.sqrt(np.mean(high ** 2))), 0.003)

    def test_direct_rate_clipping_and_invalid_samples(self):
        self.assertEqual(list(np.frombuffer(pcm24k([-2, 0, 2], 24000), dtype="<i2")), [-32767, 0, 32767])
        for samples, rate in (([], 44100), ([float("nan")], 44100), ([[0]], 44100), ([0], 0)):
            with self.assertRaises(ValueError):
                pcm24k(samples, rate)


if __name__ == "__main__":
    unittest.main()
