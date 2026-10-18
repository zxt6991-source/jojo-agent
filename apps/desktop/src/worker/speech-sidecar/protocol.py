"""Bounded local binary framing: u32be length, u32be JSON length, JSON, PCM."""
import json
import struct

MAX_FRAME_BYTES = 1_048_576
MAX_HEADER_BYTES = 16_384


def reject_json_constant(_constant):
    raise ValueError("invalid_json_number")


def read_exact(stream, size, allow_eof=False):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            if allow_eof and not chunks:
                return None
            raise ValueError("truncated_frame")
        chunks.extend(part)
    return bytes(chunks)


def read_frame(stream):
    prefix = read_exact(stream, 4, allow_eof=True)
    if prefix is None:
        return None
    size = struct.unpack(">I", prefix)[0]
    if not 6 <= size <= MAX_FRAME_BYTES:
        raise ValueError("invalid_frame_length")
    payload = read_exact(stream, size)
    header_size = struct.unpack(">I", payload[:4])[0]
    if not 0 < header_size <= min(MAX_HEADER_BYTES, size - 4):
        raise ValueError("invalid_header_length")
    header = json.loads(payload[4:4 + header_size].decode("utf-8"), parse_constant=reject_json_constant)
    if not isinstance(header, dict):
        raise ValueError("invalid_header")
    return header, payload[4 + header_size:]


def write_frame(stream, header, body=b""):
    payload = json.dumps(header, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(payload) > MAX_HEADER_BYTES:
        raise ValueError("event_too_large")
    if not isinstance(body, bytes) or len(payload) + 4 + len(body) > MAX_FRAME_BYTES:
        raise ValueError("event_too_large")
    frame = struct.pack(">II", len(payload) + 4 + len(body), len(payload)) + payload + body
    offset = 0
    while offset < len(frame):
        written = stream.write(frame[offset:])
        if not isinstance(written, int) or written <= 0:
            raise ValueError("protocol_write_failed")
        offset += written
    stream.flush()


def context_from(header):
    context = {key: header.get(key) for key in ("voiceSessionId", "captureId", "turnId", "generation")}
    if not all(isinstance(context[key], str) and 0 < len(context[key]) <= 256
               for key in ("voiceSessionId", "captureId", "turnId")):
        raise ValueError("invalid_context")
    if type(context["generation"]) is not int or not 0 <= context["generation"] <= 2**53 - 1:
        raise ValueError("invalid_generation")
    return context
