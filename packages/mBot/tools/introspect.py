"""
introspect.py - ask the robot to list its own API.

Because we run code live on the robot, we can ask it `dir(...)` and it tells us
exactly which commands its firmware supports -- more accurate than any webpage.

Run it:  py tools/introspect.py
"""

from mbot2 import MBot2

# (object name, what it does)
TARGETS = [
    ("cyberpi",          "the brain board: lights, sound, screen, sensors"),
    ("cyberpi.led",      "the 5 RGB lights"),
    ("cyberpi.audio",    "speaker / sounds"),
    ("cyberpi.display",  "the screen"),
    ("cyberpi.console",  "text console on screen"),
    ("cyberpi.controller", "buttons and joystick"),
    ("mbot2",            "the robot body: motors, wheels, servos"),
]


def show(bot, name):
    members = bot.eval(f"dir({name})")
    print(f"\n## {name}")
    if not members:
        print("   (no response -- this object may not exist on this firmware)")
        return
    public = [m for m in members if not m.startswith("_")]
    # print in tidy columns
    for i in range(0, len(public), 4):
        print("   " + "  ".join(f"{m:<18}" for m in public[i:i + 4]))


with MBot2() as bot:
    print("Asking the robot to describe itself...")
    fw = bot.eval("cyberpi.get_firmware_version()") or bot.eval("cyberpi.version")
    if fw:
        print(f"Firmware: {fw}")
    for name, desc in TARGETS:
        print(f"\n{'='*60}\n{desc}")
        show(bot, name)

print("\nThese are the building blocks. Use them with bot.run('...') or bot.eval('...').")
