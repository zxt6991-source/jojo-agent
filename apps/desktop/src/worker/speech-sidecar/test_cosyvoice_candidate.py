"""Offline generated-batch checks. No weights, dependency imports or playback."""
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from protocol import write_frame
from cosyvoice_candidate import serve


class Tensor:
    def __init__(self, samples):
        self.samples = samples

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return SimpleNamespace(reshape=lambda _shape: self.samples)


def request(**fields):
    stream = BytesIO()
    write_frame(stream, {"type": "tts.synthesize", "requestId": "test", "text": "你好。", "speed": 1, **fields})
    stream.seek(0)
    return stream


class CosyVoiceCandidateTests(unittest.TestCase):
    def test_delivers_each_generated_pcm_batch_before_asking_for_the_next(self):
        events = []

        def generate(*args, **kwargs):
            self.assertTrue(kwargs["stream"])
            self.assertFalse(kwargs["text_frontend"])
            self.assertEqual(kwargs["zero_shot_spk_id"], "jojo-benchmark")
            yield {"tts_speech": Tensor([0.1, 0.2])}
            self.assertTrue(any(header["type"] == "tts.pcm" for header, _body in events))
            self.assertFalse(any(header["type"] == "tts.completed" for header, _body in events))
            yield {"tts_speech": Tensor([0.3, 0.4])}

        with patch("cosyvoice_candidate.pcm24k", return_value=b"\x01\x00\x02\x00"):
            self.assertEqual(serve(SimpleNamespace(inference_zero_shot=generate), request(), lambda header, body=b"": events.append((header, body))), 0)
        self.assertEqual([header["type"] for header, _body in events], ["tts.started", "tts.callback", "tts.pcm", "tts.callback", "tts.pcm", "tts.completed"])
        self.assertEqual(events[-1][0]["frames"], 4)
        self.assertEqual([header["sequence"] for header, _body in events if header["type"] == "tts.pcm"], [1, 2])

    def test_invalid_requests_never_start_the_model_or_silently_ignore_speed(self):
        for fields in ({"text": ""}, {"text": "x" * 601}, {"text": "\0"}, {"speed": True}, {"speed": 1.1}, {"requestId": ""}, {"type": "unknown"}):
            events = []
            self.assertEqual(serve(SimpleNamespace(), request(**fields), lambda header: events.append(header)), 2)
            self.assertEqual(events, [{"type": "tts.error", "code": "protocol_error"}])

    def test_empty_or_crashed_generation_is_a_failure_without_false_completion(self):
        for mode in ("empty", "crash"):
            events = []

            def generate(*args, **kwargs):
                if mode == "crash":
                    raise RuntimeError("untrusted private details")
                return iter(())

            self.assertEqual(serve(SimpleNamespace(inference_zero_shot=generate), request(), lambda header: events.append(header)), 0)
            self.assertEqual(events[-1], {"type": "tts.error", "requestId": "test", "code": "local_unavailable"})
            self.assertFalse(any(event["type"] == "tts.completed" for event in events))


if __name__ == "__main__":
    unittest.main()
