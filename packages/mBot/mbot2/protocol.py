"""
Low-level CyberPi "Live Mode" protocol (f3/f4 framing).

The CyberPi's Bluetooth/serial pipe accepts binary frames; each frame carries a
snippet of Python that the robot evaluates and (optionally) answers with JSON.
This module just builds frames and parses replies -- no I/O.

Frame format:
  f3 [hdr_check] [datalen_lo] [datalen_hi] [type] [mode] [idx_lo] [idx_hi] [data...] [checksum] f4
    hdr_check = (datalen_hi + datalen_lo + 0xf3) & 0xff
    datalen   = len(data) + 4          # type + mode + idx_lo + idx_hi
    checksum  = (type + mode + idx_lo + idx_hi + sum(data)) & 0xff
  For TYPE_SCRIPT, data = [script_len_lo, script_len_hi, <script bytes>]
  A reply's data (after the 2-byte length prefix) is JSON like {"ret": 42}.

Protocol reference: github.com/Hulupeep/mbot_ruvector, derived from the
'makeblock' pip package v0.1.8.
"""

import ast
import json

HEADER = 0xF3
FOOTER = 0xF4
TYPE_SCRIPT = 0x28

MODE_NO_RESPONSE = 0x00
MODE_WITH_RESPONSE = 0x01

# Sent once to put the CyberPi into Live Mode before streaming commands.
ONLINE_MODE_FRAME = bytes([0xF3, 0xF6, 0x03, 0x00, 0x0D, 0x00, 0x01, 0x0E, 0xF4])


def build_script_frame(script: str, idx: int, mode: int) -> bytes:
    """Wrap a Python snippet in an f3/f4 frame."""
    sb = script.encode("utf-8")
    data = bytes([len(sb) & 0xFF, (len(sb) >> 8) & 0xFF]) + sb
    idx_lo, idx_hi = idx & 0xFF, (idx >> 8) & 0xFF
    datalen = len(data) + 4
    hdr_check = (((datalen >> 8) & 0xFF) + (datalen & 0xFF) + 0xF3) & 0xFF
    head = bytes([HEADER, hdr_check, datalen & 0xFF, (datalen >> 8) & 0xFF,
                  TYPE_SCRIPT, mode, idx_lo, idx_hi])
    cksum = (TYPE_SCRIPT + mode + idx_lo + idx_hi + sum(data)) & 0xFF
    return head + data + bytes([cksum, FOOTER])


class Response:
    """A parsed reply frame: `idx` it answers, the decoded `value`, and `raw` JSON."""
    __slots__ = ("idx", "value", "raw")

    def __init__(self, idx, value, raw):
        self.idx = idx
        self.value = value
        self.raw = raw

    def __repr__(self):
        return f"Response(idx={self.idx}, value={self.value!r})"


def _parse_ret(raw: str):
    """Extract the value of the "ret" field from a reply payload."""
    try:
        return json.loads(raw).get("ret")
    except Exception:
        pass
    for pat in ('"ret":', "'ret':"):
        i = raw.find(pat)
        if i >= 0:
            s = raw[i + len(pat):].strip()
            if s.endswith("}"):
                s = s[:-1].strip()
            try:
                return ast.literal_eval(s)
            except Exception:
                return s
    return None


class F3Parser:
    """Streaming parser. Feed bytes as they arrive; get back complete Responses."""

    def __init__(self):
        self._buf = bytearray()
        self._receiving = False
        self._datalen = 0

    def feed(self, data) -> list:
        out = []
        for b in data:
            r = self._feed_byte(b)
            if r is not None:
                out.append(r)
        return out

    def _feed_byte(self, b):
        self._buf.append(b)

        # Look for a valid 4-byte header anywhere in the recent stream.
        if len(self._buf) > 3:
            n = len(self._buf)
            b3, b2, b1, b0 = self._buf[n - 4], self._buf[n - 3], self._buf[n - 2], self._buf[n - 1]
            if b3 == HEADER and ((b0 + b1 + b3) & 0xFF) == b2:
                self._buf = bytearray([HEADER, b2, b1, b0])
                self._datalen = b1 + (b0 << 8)
                self._receiving = True

        if self._receiving:
            if len(self._buf) == self._datalen + 6 and self._buf[0] == HEADER:
                frame = bytes(self._buf)
                self._buf = bytearray()
                self._receiving = False
                self._datalen = 0
                return self._parse_frame(frame)
            if len(self._buf) > 4096:          # safety valve
                self._buf = bytearray()
                self._receiving = False
                self._datalen = 0
        elif len(self._buf) > 64:
            self._buf = self._buf[-4:]          # keep buffer small while hunting

        return None

    @staticmethod
    def _parse_frame(frame):
        if len(frame) < 10 or frame[4] != TYPE_SCRIPT:
            return None
        idx = frame[6] + (frame[7] << 8)
        data = frame[8:len(frame) - 2]
        if len(data) < 3:
            return None
        raw = bytes(data[2:]).decode("utf-8", "replace")
        return Response(idx, _parse_ret(raw), raw)
