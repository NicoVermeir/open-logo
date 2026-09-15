"""
Async Bluetooth transport for the mBot2 / CyberPi using bleak.

Most users want the simple, blocking `MBot2` class in `robot.py`. Use
`AsyncMBot2` directly only if you're writing asyncio code yourself.
"""

import asyncio

from bleak import BleakScanner, BleakClient

from . import protocol as p

WRITE_UUID = "0000ffe3-0000-1000-8000-00805f9b34fb"    # we write commands here
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"   # robot replies here
NAME_HINTS = ("makeblock", "cyberpi", "mbot", "bluefi")

BLE_CHUNK = 20            # write frames in 20-byte BLE packets (ffe-module size)
CHUNK_DELAY = 0.008       # small gap between packets


class AsyncMBot2:
    """Asyncio driver. See `MBot2` for the friendly synchronous version."""

    def __init__(self, address=None, name=None):
        self.address = address          # connect to a specific BLE address, or
        self.name_filter = name         # match a name substring, else auto-detect
        self.client = None
        self._idx = 1
        self._parser = p.F3Parser()
        self._pending = {}              # idx -> Future awaiting a reply
        self._reply_seen = asyncio.Event()

    # -- connection ---------------------------------------------------------
    def _match(self, d, adv):
        name = (adv.local_name or d.name or "")
        if self.name_filter:
            return self.name_filter.lower() in name.lower()
        return any(h in name.lower() for h in NAME_HINTS)

    async def connect(self, timeout=15.0):
        if self.address:
            device = await BleakScanner.find_device_by_address(self.address, timeout=timeout)
        else:
            device = await BleakScanner.find_device_by_filter(self._match, timeout=timeout)
        if not device:
            raise RuntimeError(
                "mBot2 not found over Bluetooth. Is it ON and not connected to "
                "a phone or mBlock?")
        self.name = device.name or device.address
        self.client = BleakClient(device)
        await self.client.connect()
        await self.client.start_notify(NOTIFY_UUID, self._on_notify)
        await self._handshake()

    async def disconnect(self):
        if self.client and self.client.is_connected:
            await self.client.disconnect()

    @property
    def is_connected(self):
        return bool(self.client and self.client.is_connected)

    # -- internals ----------------------------------------------------------
    def _next_idx(self):
        i = self._idx
        self._idx = (self._idx % 0xFFFE) + 1
        return i

    def _on_notify(self, _char, data):
        for resp in self._parser.feed(bytes(data)):
            self._reply_seen.set()
            fut = self._pending.pop(resp.idx, None)
            if fut is not None and not fut.done():
                fut.set_result(resp.value)

    async def _write(self, frame: bytes):
        for i in range(0, len(frame), BLE_CHUNK):
            await self.client.write_gatt_char(WRITE_UUID, frame[i:i + BLE_CHUNK], response=False)
            await asyncio.sleep(CHUNK_DELAY)

    async def _handshake(self):
        await self._write(p.ONLINE_MODE_FRAME)
        await asyncio.sleep(0.5)
        for _ in range(12):
            self._reply_seen.clear()
            frame = p.build_script_frame("cyberpi.get_bri()", self._next_idx(),
                                         p.MODE_WITH_RESPONSE)
            await self._write(frame)
            try:
                await asyncio.wait_for(self._reply_seen.wait(), timeout=0.5)
                self._idx = 1
                return
            except asyncio.TimeoutError:
                continue
        # No ack, but the robot often still accepts commands; carry on.
        self._idx = 1

    # -- sending ------------------------------------------------------------
    async def run(self, code: str):
        """Send a Python snippet for the robot to run (fire-and-forget)."""
        await self._write(p.build_script_frame(code, self._next_idx(), p.MODE_NO_RESPONSE))

    async def eval(self, expr: str, timeout=3.0):
        """Evaluate a Python expression on the robot and return its value."""
        idx = self._next_idx()
        fut = asyncio.get_event_loop().create_future()
        self._pending[idx] = fut
        await self._write(p.build_script_frame(expr, idx, p.MODE_WITH_RESPONSE))
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(idx, None)
            return None
