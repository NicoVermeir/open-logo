"""
read_sensors.py - ask the robot about the world around it.
The robot reacts: it lights up red when something gets close.
Run it:  py examples/read_sensors.py   (press Ctrl-C to stop)
"""

import time
from mbot2 import MBot2

with MBot2() as bot:
    print(f"Battery:    {bot.battery()}%")
    print(f"Brightness: {bot.brightness()}")
    print("\nWave your hand near the front sensor... (Ctrl-C to stop)\n")
    try:
        while True:
            d = bot.distance()                       # cm (None if no sensor)
            print(f"distance = {d} cm   loudness = {bot.loudness()}")
            if d is not None and d < 15:
                bot.led(255, 0, 0)                   # red = something close!
            else:
                bot.led(0, 80, 0)                    # green = all clear
            time.sleep(0.3)
    except KeyboardInterrupt:
        pass
