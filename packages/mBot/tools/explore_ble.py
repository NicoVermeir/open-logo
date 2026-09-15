#!/usr/bin/env python3
"""
BLE explorer for the mBot2 / CyberPi.
Scans for the robot, connects, and prints every Bluetooth service and
characteristic it exposes -- so we can see what we're allowed to write to.

Run:  py ble_explore.py
(Make sure the robot is ON and not connected to anything else.)
"""

import asyncio
from bleak import BleakScanner, BleakClient

NAME_HINTS = ("makeblock", "cyberpi", "mbot", "bluefi")

# Human-readable names for the common properties
PROP_ORDER = ["read", "write-without-response", "write", "notify", "indicate"]


def looks_like_robot(device, adv):
    name = (adv.local_name or device.name or "").lower()
    return any(h in name for h in NAME_HINTS)


async def main():
    print("Scanning for the robot (up to 15s)...")
    found = await BleakScanner.discover(timeout=15.0, return_adv=True)

    # Show everything we saw, robot first
    robots = []
    print("\nDevices seen:")
    for address, (device, adv) in found.items():
        name = adv.local_name or device.name or "(no name)"
        is_robot = looks_like_robot(device, adv)
        tag = "  <-- ROBOT" if is_robot else ""
        print(f"  {name:32} {address}  {adv.rssi} dBm{tag}")
        if is_robot:
            robots.append(device)

    if not robots:
        print("\nNo robot found. Is it ON and not connected to your phone/another PC?")
        return

    target = robots[0]
    print(f"\nConnecting to {target.name or target.address} ...")

    try:
        async with BleakClient(target) as client:
            print("CONNECTED!\n")
            print("Services & characteristics:")
            print("=" * 64)
            for service in client.services:
                print(f"\n[Service] {service.uuid}")
                print(f"          {service.description}")
                for char in service.characteristics:
                    props = ", ".join(p for p in PROP_ORDER if p in char.properties)
                    extra = [p for p in char.properties if p not in PROP_ORDER]
                    if extra:
                        props = (props + ", " + ", ".join(extra)).strip(", ")
                    star = " *WRITABLE*" if ("write" in char.properties or
                                             "write-without-response" in char.properties) else ""
                    print(f"   - Char {char.uuid}  [{props}]{star}")
                    print(f"            {char.description}")
            print("\n" + "=" * 64)
            print("Look for a characteristic marked *WRITABLE* (often with notify too).")
            print("That's our candidate for sending drive commands.")
    except Exception as e:
        print(f"\nConnection failed: {e}")
        print("If it mentions pairing/bonding, the robot may require pairing first.")


if __name__ == "__main__":
    asyncio.run(main())
