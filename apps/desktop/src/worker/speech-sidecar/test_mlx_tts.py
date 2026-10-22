from io import BytesIO
from types import SimpleNamespace
import unittest
import os
import random
import select
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
        self.assertEqual(calls[0][1], {
            "voice": "Vivian", "lang_code": "auto", "temperature": 0.9,
            "top_p": 1.0, "top_k": 50, "repetition_penalty": 1.05,
            "max_tokens": 1500, "verbose": False, "stream": True, "streaming_interval": 0.8,
        })
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
            events, seeds = [], []
            self.assertEqual(serve(SimpleNamespace(generate=unexpected), request(**fields), lambda header: events.append(header), seed_generation=seeds.append), 2)
            self.assertEqual(events, [{"type": "tts.error", "code": "protocol_error"}])
            self.assertEqual(seeds, [])

    def test_each_request_is_independent_of_warmup_order_and_other_speakers(self):
        stream, events, seeds, calls = BytesIO(), [], [], []
        rng = random.Random(99)
        inputs = [("first", "同一段正文。", "default"), ("warmup", "你好。", "default"),
                  ("other", "不同的内容消耗不同数量的采样。", "Vivian"),
                  ("second", "同一段正文。", "default"), ("explicit", "同一段正文。", "Serena"),
                  ("different-voice", "同一段正文。", "Vivian")]
        for request_id, text, speaker in inputs:
            write_frame(stream, {"type": "tts.synthesize", "requestId": request_id,
                                 "text": text, "speakerId": speaker, "speed": 1})
        stream.seek(0)

        def seed(value):
            seeds.append(value)
            rng.seed(value)

        def generate(text, **kwargs):
            calls.append((text, kwargs["voice"]))
            # Different inputs consume different amounts of random state. The
            # next request must still render identically to its earlier copy.
            for _ in text:
                rng.random()
            voice_offset = 0.1 if kwargs["voice"] == "Serena" else 0.3
            yield SimpleNamespace(audio=np.array([voice_offset + rng.random() * 0.1 for _ in range(4)]),
                                  sample_rate=24000, token_count=1)

        self.assertEqual(serve(SimpleNamespace(generate=generate), stream,
                               lambda header, body=b"": events.append((header, body)), seed_generation=seed), 0)
        pcm = {header["requestId"]: body for header, body in events if header["type"] == "tts.pcm"}
        self.assertEqual(seeds, [0] * len(inputs))
        self.assertEqual(calls, [(text, "Serena" if speaker == "default" else speaker) for _, text, speaker in inputs])
        self.assertEqual(pcm["first"], pcm["second"])
        self.assertEqual(pcm["first"], pcm["explicit"])
        self.assertNotEqual(pcm["first"], pcm["different-voice"])

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

    def test_incremental_token_limit_stops_before_publishing_a_truncated_success(self):
        for batches in (149, 150):
            with self.subTest(batches=batches):
                events, closed = [], []

                def generate(*_args, **_kwargs):
                    try:
                        for _ in range(batches):
                            yield SimpleNamespace(audio=np.zeros(2), sample_rate=24000, token_count=10)
                    finally:
                        closed.append(True)

                result = serve(SimpleNamespace(generate=generate), request(), lambda header, body=b"": events.append(header))
                self.assertEqual(closed, [True])
                self.assertEqual(sum(event["type"] == "tts.callback" for event in events), 149)
                self.assertEqual(result, 0 if batches == 149 else 1)
                if batches == 149:
                    self.assertEqual(events[-1]["type"], "tts.completed")
                else:
                    self.assertEqual(events[-1]["code"], "synthesis_limit")
                    self.assertNotIn("tts.completed", [event["type"] for event in events])

    def test_cancel_discards_future_batches_closes_generator_and_reuses_model(self):
        reader, writer = os.pipe()
        events, lifecycle, generated, pcm, seeds = [], [], [], [], []
        rng = random.Random(99)

        def seed(value):
            seeds.append(value)
            rng.seed(value)

        with os.fdopen(reader, "rb", buffering=0) as source, os.fdopen(writer, "wb", buffering=0) as control:
            write_frame(control, {"type": "tts.synthesize", "requestId": "first", "text": "你好。", "speed": 1})

            def generate(text, **_kwargs):
                try:
                    for index in range(3):
                        generated.append((text, index))
                        yield SimpleNamespace(audio=np.full(2400, rng.random(), dtype=np.float32), sample_rate=24000, token_count=10)
                finally:
                    lifecycle.append("closed")

            def emit(header, body=b""):
                events.append(header)
                if header["type"] == "tts.pcm":
                    pcm.append((header["requestId"], body))
                if header["type"] == "tts.pcm" and header["requestId"] == "first":
                    write_frame(control, {"type": "tts.cancel", "requestId": "first"})
                if header["type"] == "tts.cancelled":
                    self.assertEqual(lifecycle, ["closed", "cleaned"])
                    write_frame(control, {"type": "tts.synthesize", "requestId": "second", "text": "恢复。", "speed": 1})
                if header["type"] == "tts.completed":
                    self.assertEqual(header["requestId"], "second")
                    write_frame(control, {"type": "shutdown"})

            result = serve(SimpleNamespace(generate=generate), source, emit,
                           lambda: bool(select.select([source], [], [], 0)[0]), lambda: lifecycle.append("cleaned"), seed)
            self.assertEqual(result, 0)
        self.assertEqual(generated, [("你好。", 0), ("恢复。", 0), ("恢复。", 1), ("恢复。", 2)])
        self.assertEqual([event["requestId"] for event in events if event["type"] == "tts.completed"], ["second"])
        self.assertEqual(sum(event["type"] == "tts.cancelled" for event in events), 1)
        self.assertEqual(seeds, [0, 0])
        self.assertEqual(pcm[0][1], pcm[1][1])

    def test_completion_race_acknowledges_cancel_before_accepting_another_request(self):
        stream = request()
        stream.seek(0, 2)
        write_frame(stream, {"type": "tts.cancel", "requestId": "test"})
        write_frame(stream, {"type": "tts.synthesize", "requestId": "next", "text": "继续。", "speed": 1})
        stream.seek(0)
        events = []
        model = SimpleNamespace(generate=lambda *_args, **_kwargs: iter([SimpleNamespace(audio=np.zeros(2), sample_rate=24000, token_count=1)]))
        self.assertEqual(serve(model, stream, lambda header, body=b"": events.append(header)), 0)
        self.assertEqual([(event["type"], event["requestId"]) for event in events if event["type"] in ("tts.completed", "tts.cancelled")],
                         [("tts.completed", "test"), ("tts.cancelled", "test"), ("tts.completed", "next")])

    def test_cancel_before_first_batch_does_not_start_generation(self):
        stream = request()
        stream.seek(0, 2)
        write_frame(stream, {"type": "tts.cancel", "requestId": "test"})
        stream.seek(0)
        events, cleaned, seeds = [], [], []
        def unexpected(*_args, **_kwargs):
            self.fail("cancelled request started generation")
        self.assertEqual(serve(SimpleNamespace(generate=unexpected), stream,
                               lambda header, body=b"": events.append(header), lambda: True, lambda: cleaned.append(True), seeds.append), 0)
        self.assertEqual([event["type"] for event in events], ["tts.started", "tts.cancelled"])
        self.assertEqual(cleaned, [True])
        self.assertEqual(seeds, [])

    def test_stale_cancel_and_failed_cleanup_never_acknowledge_reuse(self):
        for stale in (True, False):
            stream = request()
            stream.seek(0, 2)
            write_frame(stream, {"type": "tts.cancel", "requestId": "old" if stale else "test"})
            stream.seek(0)
            events = []
            def cleanup():
                raise RuntimeError("private cleanup error")
            self.assertEqual(serve(SimpleNamespace(), stream, lambda header, body=b"": events.append(header), lambda: True, cleanup), 1)
            self.assertEqual([event["type"] for event in events], ["tts.started", "tts.error"])
            self.assertEqual(events[-1]["code"], "protocol_error" if stale else "synthesis_failed")


if __name__ == "__main__":
    unittest.main()
