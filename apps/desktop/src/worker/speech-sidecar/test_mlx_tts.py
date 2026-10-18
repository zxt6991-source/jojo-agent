from io import BytesIO
from types import SimpleNamespace
import unittest
import numpy as np
from mlx_tts import MAX_TOKENS, serve
from protocol import write_frame


def request(**fields):
    stream = BytesIO()
    write_frame(stream, {"type": "tts.synthesize", "requestId": "test", "text": "你好。", "speed": 1, **fields})
    stream.seek(0)
    return stream


class NeuralVoiceProtocolTests(unittest.TestCase):
    def test_coherent_text_and_selected_voice_reach_model_with_bounded_native_pcm(self):
        calls, events = [], []

        def generate(text, **kwargs):
            calls.append((text, kwargs))
            yield SimpleNamespace(audio=np.zeros(40000, dtype=np.float32), sample_rate=24000, token_count=20)

        self.assertEqual(serve(SimpleNamespace(generate=generate), request(speakerId="Vivian"), lambda header, body=b"": events.append((header, body))), 0)
        self.assertEqual(calls[0][0], "你好。")
        self.assertEqual(calls[0][1]["voice"], "Vivian")
        self.assertEqual(calls[0][1]["lang_code"], "auto")
        self.assertTrue(calls[0][1]["stream"])
        self.assertEqual([header["type"] for header, _ in events], ["tts.started", "tts.callback", "tts.pcm", "tts.pcm", "tts.completed"])
        self.assertEqual(events[-1][0]["frames"], 40000)
        self.assertTrue(all(len(body) <= 65536 for _, body in events))

    def test_english_and_bilingual_text_do_not_force_chinese_pronunciation(self):
        for text in ("The morning light is soft and clear.", "Morning light. 晨光照在窗前。"):
            calls, events = [], []

            def generate(value, **kwargs):
                calls.append((value, kwargs["lang_code"]))
                yield SimpleNamespace(audio=np.zeros(2400, dtype=np.float32), sample_rate=24000, token_count=10)

            self.assertEqual(serve(SimpleNamespace(generate=generate), request(text=text), lambda header, body=b"": events.append(header)), 0)
            self.assertEqual(calls, [(text, "auto")])
            self.assertEqual(events[-1]["type"], "tts.completed")

    def test_invalid_input_never_calls_generation(self):
        def unexpected(*_args, **_kwargs):
            self.fail("model called on invalid input")
        for fields in ({"speakerId": "Tingting"}, {"speed": 1.2}, {"speed": True}, {"text": "x" * 601}, {"text": "\0"}, {"text": ""}):
            events = []
            self.assertEqual(serve(SimpleNamespace(generate=unexpected), request(**fields), lambda header: events.append(header)), 2)
            self.assertEqual(events, [{"type": "tts.error", "code": "protocol_error"}])

    def test_invalid_audio_and_token_limit_never_publish_success(self):
        for audio, sample_rate, tokens, code in ((np.array([np.nan]), 24000, 1, "invalid_audio"), (np.zeros(1), 44100, 1, "invalid_audio"), (np.zeros(1), 24000, MAX_TOKENS, "synthesis_limit")):
            events = []
            model = SimpleNamespace(generate=lambda *_args, **_kwargs: iter([SimpleNamespace(audio=audio, sample_rate=sample_rate, token_count=tokens)]))
            self.assertEqual(serve(model, request(), lambda header, body=b"": events.append(header)), 1)
            self.assertEqual([event["type"] for event in events], ["tts.started", "tts.error"])
            self.assertEqual(events[-1]["code"], code)

    def test_inference_exception_is_not_reported_as_missing_local_installation(self):
        def generate(*_args, **_kwargs):
            raise RuntimeError("private library diagnostic")
        events = []
        self.assertEqual(serve(SimpleNamespace(generate=generate), request(), lambda header, body=b"": events.append(header)), 1)
        self.assertEqual(events[-1]["code"], "synthesis_failed")
        self.assertNotIn("private", str(events))


if __name__ == "__main__":
    unittest.main()
