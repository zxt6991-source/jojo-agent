"""Offline protocol/lifecycle tests. Model doubles never represent acoustic accuracy."""
from array import array
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
import json
import struct
import subprocess
import sys
import unittest

from protocol import MAX_FRAME_BYTES, context_from, read_frame, write_frame
from main import Session, serve


CONTEXT = {"voiceSessionId": "voice", "captureId": "capture", "turnId": "turn", "generation": 0}


def encoded(header, pcm=b""):
    payload = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode()
    return struct.pack(">II", len(payload) + 4 + len(pcm), len(payload)) + payload + pcm


class Samples(list):
    def copy(self):
        return Samples(self)

    def astype(self, _dtype):
        return self

    def __truediv__(self, divisor):
        return Samples(value / divisor for value in self)

    def __getitem__(self, item):
        value = super().__getitem__(item)
        return Samples(value) if isinstance(item, slice) else value


def fake_numpy():
    return SimpleNamespace(float32="float32", frombuffer=lambda data, dtype: Samples(array("h", data)),
                           concatenate=lambda frames: Samples(value for frame in frames for value in frame),
                           empty=lambda size, dtype: Samples())


class Vad:
    calls = 0

    def accept(self, samples):
        self.calls += 1
        return samples[0] > 0

    def reset(self):
        pass


class Asr:
    calls = 0

    def create_stream(self):
        return []

    def accept(self, stream, samples):
        self.calls += 1
        stream.extend(samples)
        return "你好" if any(value > 0 for value in stream) else ""

    def finish(self, stream):
        return "你好" if any(value > 0 for value in stream) else ""


def fixture_runtime():
    return SimpleNamespace(args=SimpleNamespace(pre_roll_ms=400, reset_gap_frames=5, max_turn_secs=60),
                           vad=Vad(), asr=Asr(), smart=SimpleNamespace(predict=lambda audio: (0.9, 1.0)))


class PartialReader(BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 3))


class PartialWriter(BytesIO):
    def write(self, data):
        return super().write(data[:3])


class ProtocolTests(unittest.TestCase):
    def test_partial_and_coalesced_pipe_reads_keep_binary_audio(self):
        audio = struct.pack("<4h", 1, -2, 0, 32767)
        source = PartialReader(encoded({"type": "audio.frame", **CONTEXT}, audio) + encoded({"type": "shutdown"}))
        self.assertEqual(read_frame(source), ({"type": "audio.frame", **CONTEXT}, audio))
        self.assertEqual(read_frame(source), ({"type": "shutdown"}, b""))
        self.assertIsNone(read_frame(source))

    def test_partial_writes_do_not_truncate_events(self):
        target = PartialWriter()
        write_frame(target, {"type": "asr.final", "text": "春花秋月何时了"})
        self.assertEqual(read_frame(BytesIO(target.getvalue()))[0]["text"], "春花秋月何时了")

    def test_invalid_lengths_json_types_utf8_and_nonfinite_numbers_fail(self):
        for frame in [b"\x00", struct.pack(">I", MAX_FRAME_BYTES + 1),
                      struct.pack(">II", 6, 20) + b"{}", encoded([]),
                      struct.pack(">II", 6, 2) + b"\xff\xff", encoded({"value": float("nan")})]:
            with self.subTest(frame=frame[:10]), self.assertRaises((ValueError, UnicodeError)):
                read_frame(BytesIO(frame))

    def test_generation_is_safe_integer_and_never_bool(self):
        for generation in [True, -1, 2**53, 1.5, "0"]:
            with self.assertRaises(ValueError):
                context_from({**CONTEXT, "generation": generation})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.previous_numpy = sys.modules.get("numpy")
        sys.modules["numpy"] = fake_numpy()

    def tearDown(self):
        if self.previous_numpy is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self.previous_numpy

    def session(self):
        events = []
        runtime = fixture_runtime()
        return Session(CONTEXT.copy(), runtime, events.append), runtime, events

    def frame(self, sequence, value=1000):
        return ({"type": "audio.frame", **CONTEXT, "sequence": sequence, "sampleRate": 16000, "channels": 1},
                struct.pack("<320h", *([value] * 320)))

    def test_endpoint_decision_does_not_commit_until_host_finish(self):
        session, _runtime, events = self.session()
        session.frame(*self.frame(0))
        session.frame(*self.frame(1, 0))
        self.assertIn("turn.complete", [item["type"] for item in events])
        self.assertNotIn("asr.final", [item["type"] for item in events])
        session.finish()
        session.finish()
        self.assertEqual([item["text"] for item in events if item["type"] == "asr.final"], ["你好"])

    def test_optional_turn_model_failure_preserves_asr_and_audio_ack(self):
        session, runtime, events = self.session()
        def fail(_audio):
            raise RuntimeError("private-path-or-audio-details")
        runtime.smart.predict = fail
        session.frame(*self.frame(0))
        session.frame(*self.frame(1, 0))
        self.assertIn({"type": "turn.unavailable", "code": "inference_failed", **CONTEXT}, events)
        self.assertEqual(events[-1], {"type": "audio.ack", "sequence": 1, **CONTEXT})
        self.assertNotIn("private-path", json.dumps(events))
        session.finish()
        self.assertEqual(events[-1]["text"], "你好")

    def test_cancel_acknowledges_queued_audio_without_restarting_inference(self):
        session, runtime, events = self.session()
        session.frame(*self.frame(0))
        session.cancel()
        asr_calls = runtime.asr.calls
        vad_calls = runtime.vad.calls
        session.frame(*self.frame(1))
        session.frame(*self.frame(10))
        session.finish()
        self.assertEqual(runtime.asr.calls, asr_calls)
        self.assertEqual(runtime.vad.calls, vad_calls)
        self.assertEqual(events[-1], {"type": "audio.ack", **CONTEXT, "sequence": 10})
        self.assertNotIn("asr.final", [item["type"] for item in events])

    def test_severe_gap_reports_reset_and_starts_fresh_turn(self):
        session, _runtime, events = self.session()
        session.frame(*self.frame(0))
        session.frame(*self.frame(7, 0))
        self.assertIn({"type": "audio.gap", **CONTEXT, "missingFrames": 6, "turnReset": True}, events)
        session.finish()
        self.assertEqual(events[-1]["text"], "")

    def test_invalid_control_does_not_reuse_prior_capture_context(self):
        commands = encoded({"type": "session.open", **CONTEXT}) + encoded({"type": "turn.finish", "generation": -1})
        events = []
        self.assertEqual(serve(fixture_runtime(), BytesIO(commands), events.append), 0)
        self.assertEqual(events[-1], {"type": "error", "code": "invalid_context"})

    def test_old_generation_audio_never_reaches_new_turn(self):
        new = {**CONTEXT, "turnId": "next", "generation": 1}
        commands = b"".join([encoded({"type": "session.open", **CONTEXT}),
                             encoded({"type": "turn.reset", **new}), encoded(*self.frame(0)),
                             encoded({"type": "turn.finish", **new})])
        runtime = fixture_runtime()
        events = []
        serve(runtime, BytesIO(commands), events.append)
        self.assertEqual(runtime.asr.calls, 0)
        self.assertEqual(events[-1], {"type": "asr.final", "text": "", **new})

    def test_excessive_transcript_is_rejected_and_turn_stays_cancelled(self):
        session, runtime, _events = self.session()
        runtime.asr.accept = lambda stream, samples: "中" * 5000
        with self.assertRaisesRegex(ValueError, "transcript_limit"):
            session.frame(*self.frame(0))


class SubprocessTests(unittest.TestCase):
    def test_real_probe_has_only_framed_capabilities_without_models(self):
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("main.py")), "--probe"],
                                capture_output=True, timeout=10, check=True)
        source = BytesIO(result.stdout)
        header, body = read_frame(source)
        self.assertEqual(header["type"], "ready")
        self.assertFalse(body)
        self.assertTrue(all(not item["available"] for item in header["capabilities"].values()))
        self.assertIsNone(read_frame(source))

    def test_real_pipe_round_trip_partial_final_reset_and_shutdown(self):
        audio = struct.pack("<320h", *([1000] * 320))
        new = {**CONTEXT, "turnId": "next", "generation": 1}
        commands = b"".join([encoded({"type": "session.open", **CONTEXT}),
                             encoded({"type": "audio.frame", **CONTEXT, "sequence": 0,
                                      "sampleRate": 16000, "channels": 1}, audio),
                             encoded({"type": "turn.finish", **CONTEXT}),
                             encoded({"type": "turn.reset", **new}),
                             encoded({"type": "session.close", **new}), encoded({"type": "shutdown"})])
        result = subprocess.run([sys.executable, "-B", __file__, "--serve-fixture"], input=commands,
                                capture_output=True, timeout=10, check=True)
        source = PartialReader(result.stdout)
        events = []
        while True:
            frame = read_frame(source)
            if frame is None:
                break
            header, body = frame
            self.assertFalse(body)
            events.append(header)
        self.assertEqual([event["text"] for event in events if event["type"] == "asr.final"], ["你好"])
        self.assertEqual(events[-1], {"type": "session.closed", **new})

    def test_truncated_protocol_fails_closed_in_real_process(self):
        result = subprocess.run([sys.executable, "-B", __file__, "--serve-fixture"], input=b"\x00\x01",
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(read_frame(BytesIO(result.stdout))[0], {"type": "error", "code": "invalid_protocol", "fatal": True})


if __name__ == "__main__":
    if "--serve-fixture" in sys.argv:
        sys.modules["numpy"] = fake_numpy()
        raise SystemExit(serve(fixture_runtime(), sys.stdin.buffer, lambda event: write_frame(sys.stdout.buffer, event)))
    unittest.main()
