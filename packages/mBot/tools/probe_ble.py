#!/usr/bin/env python3
"""
Probe the mBot2 / CyberPi BLE serial pipe to see if it speaks a
MicroPython REPL. We listen on the notify characteristic (ffe2) and
send a few HARMLESS pokes to the write characteristic (ffe3):
  - Ctrl-C  (interrupt; harmless)
  - newline
  - print("hello")   (would echo / print in a REPL)
  - Ctrl-B  (ensure we're in the friendly REPL)
Everything the robot sends back is printed as hex + readable text.

Run:  py ble_probe.py
"""

import asyncio
from bleak import BleakScanner, BleakClient

NAME_HINTS = ("makeblock", "cyberpi", "mbot", "bluefi")
WRITE_UUID  = "0000ffe3-0000-1000-8000-00805f9b34fb"   # we send here
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"   # robot replies here

inbox = bytearray()


def on_notify(_handle, data: bytearray):
    inbox.extend(data)
    text = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
    print(f"  <- {data.hex(' ')}   |{text}|")


async def main():
    print("Scanning for the robot...")
    device = await BleakScanner.find_device_by_filter(
        lambda d, adv: any(h in ((adv.local_name or d.name or "").lower())
                           for h in NAME_HINTS),
        timeout=15.0,
    )
    if not device:
        print("Robot not found. Is it ON?")
        return

    print(f"Connecting to {device.name or device.address} ...")
    async with BleakClient(device) as client:
        print("CONNECTED. Listening on ffe2...\n")
        await client.start_notify(NOTIFY_UUID, on_notify)
        await asyncio.sleep(1.0)

        async def send(label, payload):
            print(f"-> {label}: {payload!r}")
            await client.write_gatt_char(WRITE_UUID, payload, response=True)
            await asyncio.sleep(1.5)

        await send("Ctrl-C (interrupt)",   b"\x03")
        await send("newline",              b"\r\n")
        await send('print("hello")',       b'print("hello")\r\n')
        await send("Ctrl-B (friendly REPL)", b"\x02")
        await asyncio.sleep(1.5)

        await client.stop_notify(NOTIFY_UUID)
        print("\n================ SUMMARY ================")
        if inbox:
            text = "".join(chr(b) if 32 <= b < 127 else "." for b in inbox)
            print(f"Total bytes received: {len(inbox)}")
            print(f"As text: {text}")
            if b">>>" in inbox or b"hello" in inbox or b"Traceback" in inbox:
                print("\n*** Looks like a MicroPython REPL! We can drive it with text. ***")
            else:
                print("\nGot data, but not an obvious REPL. Likely a binary protocol.")
        else:
            print("No reply. The pipe is probably a one-way binary command channel.")


if __name__ == "__main__":
    asyncio.run(main())
