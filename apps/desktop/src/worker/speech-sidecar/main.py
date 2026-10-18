#!/usr/bin/env python3
"""Persistent speech sidecar. No microphone, network port, or raw-audio files.

Run --probe to inspect local availability without opening a capture session.
Normal operation uses binary frames on stdin/stdout; all library logs go stderr.
Auto endpoint is host controlled: turn.complete never commits/finalizes itself.
"""
import argparse
from collections import deque
import os
import sys

from protocol import context_from, read_frame, write_frame
from streaming_asr import StreamingAsr
from vad import SileroVad
from smart_turn import SmartTurn


class SampleRing:
    def __init__(self, capacity):
        self.capacity = capacity
        self.frames = deque()
        self.size = 0

    def append(self, samples):
        self.frames.append(samples.copy())
        self.size += len(samples)
        while self.size > self.capacity:
            first = self.frames.popleft()
            extra = self.size - self.capacity
            if len(first) > extra:
                self.frames.appendleft(first[extra:])
                self.size -= extra
            else:
                self.size -= len(first)

    def array(self):
        import numpy as np
        return np.concatenate(list(self.frames)) if self.frames else np.empty(0, dtype=np.float32)

    def clear(self):
        self.frames.clear()
        self.size = 0


class Session:
    def __init__(self, context, runtime, emit):
        self.context = context
        self.runtime = runtime
        self.emit = lambda event: emit({**event, **self.context})
        self.preroll = SampleRing(int(runtime.args.pre_roll_ms * 16))
        self.smart_audio = SampleRing(8 * 16000)
        self.sequence = -1
        self.samples_seen = 0
        self.reset_turn()

    def reset_turn(self):
        self.runtime.vad.reset()
        self.stream = None
        self.speaking = False
        self.last_text = ""
        self.turn_samples = 0
        self.finalized = False
        self.preroll.clear()
        self.smart_audio.clear()

    def cancel(self):
        self.reset_turn()
        # Frames already in the pipe may follow cancellation. Only a host reset
        # advancing generation may make this turn accept inference again.
        self.finalized = True

    def transcript(self, kind, text):
        # JSON framing is bounded by bytes, not Python/JS character count.
        # Reject excessive model output rather than silently committing a prefix.
        if not isinstance(text, str) or len(text.encode("utf-8")) > 12_000:
            raise ValueError("transcript_limit")
        self.emit({"type": kind, "text": text})

    def frame(self, header, body):
        import numpy as np
        sequence = header.get("sequence")
        if type(sequence) is not int or not 0 <= sequence <= 2**53 - 1 or sequence <= self.sequence:
            raise ValueError("invalid_sequence")
        if header.get("sampleRate") != 16000 or header.get("channels") != 1 or not body or len(body) % 2 or len(body) > 32_000:
            raise ValueError("invalid_audio")
        gap = sequence - self.sequence - 1
        if gap:
            severe = not self.finalized and gap >= self.runtime.args.reset_gap_frames
            if severe:
                self.reset_turn()
            self.emit({"type": "audio.gap", "missingFrames": gap, "turnReset": severe})
        self.sequence = sequence
        samples = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
        self.samples_seen += len(samples)
        if self.finalized:
            self.emit({"type": "audio.ack", "sequence": sequence})
            return
        speaking = self.runtime.vad.accept(samples)
        started = speaking and not self.speaking
        if started:
            if self.stream is None:
                self.stream = self.runtime.asr.create_stream()
                previous = self.preroll.array()
                if len(previous):
                    self.runtime.asr.accept(self.stream, previous)
                    self.smart_audio.append(previous)
            self.emit({"type": "vad.started", "atMs": self.samples_seen / 16})
        if self.stream is not None:
            self.turn_samples += len(samples)
            if self.turn_samples > self.runtime.args.max_turn_secs * 16000:
                self.cancel()
                self.emit({"type": "error", "code": "turn_audio_limit"})
                self.emit({"type": "audio.ack", "sequence": sequence})
                return
            text = self.runtime.asr.accept(self.stream, samples)
            self.smart_audio.append(samples)
            if text != self.last_text:
                self.last_text = text
                self.transcript("asr.partial", text)
        if self.speaking and not speaking:
            self.emit({"type": "vad.stopped", "atMs": self.samples_seen / 16})
            if self.runtime.smart is not None:
                try:
                    score, elapsed = self.runtime.smart.predict(self.smart_audio.array())
                    self.emit({"type": "turn.complete" if score > 0.5 else "turn.incomplete",
                               "score": score, "inferenceMs": elapsed})
                except Exception:
                    # An optional endpoint model must not destroy the ASR draft.
                    # The host may wait for its VAD-silence fallback or manual stop.
                    self.emit({"type": "turn.unavailable", "code": "inference_failed"})
        self.speaking = speaking
        self.preroll.append(samples)
        self.emit({"type": "audio.ack", "sequence": sequence})

    def finish(self):
        if self.finalized:
            return
        # Explicit manual finish can finalize even when VAD did not start.
        if self.stream is None:
            self.stream = self.runtime.asr.create_stream()
            samples = self.preroll.array()
            if len(samples):
                self.runtime.asr.accept(self.stream, samples)
        text = self.runtime.asr.finish(self.stream)
        self.finalized = True
        self.stream = None
        self.preroll.clear()
        self.smart_audio.clear()
        self.transcript("asr.final", text)


class Runtime:
    def __init__(self, args):
        self.args = args
        self.capabilities = {}
        self.vad = self.load("vad", lambda: SileroVad(args.vad_model, args.vad_stop_secs))
        self.asr = self.load("streamingAsr", lambda: StreamingAsr(args.paraformer_dir, args.threads))
        self.smart = self.load("smartTurn", lambda: SmartTurn(args.smart_turn_model))

    def load(self, name, factory):
        try:
            value = factory()
            self.capabilities[name] = {"available": True}
            return value
        except Exception as error:
            # Never emit exception strings: native libraries may include paths/audio.
            reason = str(error) if isinstance(error, RuntimeError) and str(error).replace("_", "").isalnum() else "local_dependency_or_model_unavailable"
            self.capabilities[name] = {"available": False, "reason": reason}
            print(f"speech-sidecar {name}: unavailable", file=sys.stderr, flush=True)
            return None


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vad-model", default="")
    parser.add_argument("--paraformer-dir", default="")
    parser.add_argument("--smart-turn-model", default="")
    parser.add_argument("--vad-stop-secs", type=float, default=0.2)
    parser.add_argument("--pre-roll-ms", type=int, default=400)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--reset-gap-frames", type=int, default=5)
    parser.add_argument("--max-turn-secs", type=int, default=60)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if not 0.05 <= args.vad_stop_secs <= 5 or not 100 <= args.pre_roll_ms <= 1000 or not 1 <= args.threads <= 8 or not 1 <= args.reset_gap_frames <= 100 or not 1 <= args.max_turn_secs <= 120:
        parser.error("invalid speech limits")
    return args


def main():
    args = parse_args()
    # Keep a private protocol FD. Redirect Python and native-library stdout to stderr.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    emit = lambda event: write_frame(protocol, event)
    runtime = Runtime(args)
    emit({"type": "ready", "protocolVersion": 1, "capabilities": runtime.capabilities})
    if args.probe:
        return 0
    return serve(runtime, sys.stdin.buffer, emit)


def serve(runtime, source, emit):
    """Host-controlled protocol loop, also exercised with offline model doubles."""
    session = None
    while True:
        try:
            frame = read_frame(source)
        except Exception:
            emit({"type": "error", "code": "invalid_protocol", "fatal": True})
            return 2
        if frame is None:
            return 0
        header, body = frame
        kind = header.get("type")
        context = {}
        try:
            if kind == "shutdown":
                if body:
                    raise ValueError("unexpected_audio")
                return 0
            context = context_from(header)
            if kind != "audio.frame" and body:
                raise ValueError("unexpected_audio")
            if kind == "session.open":
                if session is not None:
                    raise ValueError("session_already_open")
                if runtime.asr is None or runtime.vad is None:
                    raise ValueError("local_unavailable")
                session = Session(context, runtime, emit)
                emit({"type": "session.opened", **context})
            elif session is None:
                raise ValueError("session_not_open")
            elif kind == "turn.reset":
                if context["voiceSessionId"] != session.context["voiceSessionId"] or context["generation"] <= session.context["generation"]:
                    raise ValueError("stale_generation")
                session.context = context
                session.sequence = -1
                session.reset_turn()
                emit({"type": "turn.reset", **context})
            elif session.context != context:
                # Old capture events never reach a new generation or turn.
                continue
            elif kind == "session.close":
                session.reset_turn()
                session = None
                emit({"type": "session.closed", **context})
            elif kind == "cancel":
                session.cancel()
            elif kind == "turn.finish":
                session.finish()
            elif kind == "audio.frame":
                session.frame(header, body)
            else:
                raise ValueError("unknown_control")
        except ValueError as error:
            code = str(error) if str(error).replace("_", "").isalnum() else "invalid_control"
            if code == "transcript_limit" and session is not None:
                session.cancel()
            emit({"type": "error", "code": code, **context})
        except Exception:
            # A model failure invalidates this turn, never another capture generation.
            if session is not None:
                session.cancel()
            emit({"type": "error", "code": "inference_failed", **context})


if __name__ == "__main__":
    raise SystemExit(main())
