"""
MBot2 - the friendly, synchronous way to control the robot.

Write plain Python, no async needed:

    from mbot2 import MBot2

    with MBot2() as bot:        # connects automatically
        bot.led(0, 255, 0)      # green
        bot.forward(50, 1)      # drive at speed 50 for 1 second
        bot.turn(90)            # turn 90 degrees
        bot.beep(880)           # play a note

Under the hood this runs an asyncio + bleak event loop on a background thread,
so your script reads top-to-bottom like normal.
"""

import asyncio
import threading
import time

from .connection import AsyncMBot2


class MBot2:
    def __init__(self, address=None, name=None, connect=True, verbose=True):
        self._verbose = verbose
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self._bot = AsyncMBot2(address=address, name=name)
        if connect:
            self.connect()

    # -- event loop plumbing ------------------------------------------------
    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _call(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def _say(self, msg):
        if self._verbose:
            print(msg)

    # -- connection ---------------------------------------------------------
    def connect(self):
        self._say("Connecting to mBot2 over Bluetooth...")
        self._call(self._bot.connect())
        self._say(f"Connected to {self._bot.name}! Ready for commands.")
        return self

    def disconnect(self):
        try:
            self.stop()
        except Exception:
            pass
        try:
            self._call(self._bot.disconnect())
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._say("Disconnected.")

    @property
    def connected(self):
        return self._bot.is_connected

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.disconnect()

    # -- escape hatches -----------------------------------------------------
    def run(self, code: str):
        """Run any Python snippet on the robot, e.g. bot.run("cyberpi.led.on(255,0,0)")."""
        self._call(self._bot.run(code))

    def eval(self, expr: str, timeout=3.0):
        """Evaluate a Python expression on the robot and return the result."""
        return self._call(self._bot.eval(expr, timeout))

    @staticmethod
    def sleep(secs):
        """Pause your script (same as time.sleep)."""
        time.sleep(secs)

    # -- movement -----------------------------------------------------------
    # If you pass `secs`, the robot moves for that long then stops ITSELF
    # (safe even if a Bluetooth packet drops), and the call waits that long.
    def _move(self, fn, speed, secs):
        self.run(f"mbot2.{fn}({speed})" if secs is None else f"mbot2.{fn}({speed},{secs})")
        if secs:
            time.sleep(secs + 0.1)

    def forward(self, speed=50, secs=None):    self._move("forward", speed, secs)
    def backward(self, speed=50, secs=None):   self._move("backward", speed, secs)
    def turn_left(self, speed=50, secs=None):  self._move("turn_left", speed, secs)
    def turn_right(self, speed=50, secs=None): self._move("turn_right", speed, secs)

    def turn(self, degrees):
        """Turn in place by a precise angle (uses the gyro). + = right, - = left."""
        self.run(f"mbot2.turn({degrees})")
        time.sleep(max(0.5, abs(degrees) / 120.0))

    def drive(self, left_speed, right_speed):
        """Set each wheel independently (-100..100). Runs until you stop()."""
        self.run(f"mbot2.drive_speed({left_speed},{right_speed})")

    def stop(self):
        self.run("mbot2.EM_stop()")

    # -- lights -------------------------------------------------------------
    def led(self, r, g, b, which=None):
        """Set LED color (0-255 each). `which` 1-5 picks one light; default = all."""
        if which is None:
            self.run(f"cyberpi.led.on({r},{g},{b})")
        else:
            self.run(f"cyberpi.led.on({r},{g},{b},id={which})")

    def led_off(self):
        self.run("cyberpi.led.on(0,0,0)")

    def led_effect(self, name="rainbow"):
        """Built-in light shows: rainbow, spoondrift, meteor_blue, meteor_green,
        flash_red, flash_orange, firefly."""
        self.run(f"cyberpi.led.play(name='{name}')")

    # -- sound --------------------------------------------------------------
    def beep(self, freq=523, secs=0.3):
        """Play a tone. Bigger freq = higher pitch."""
        self.run(f"cyberpi.audio.play_tone({freq},{secs})")
        time.sleep(secs + 0.05)

    def play_note(self, note=60, beat=0.5):
        """Play a musical note (0-132)."""
        self.run(f"cyberpi.audio.play_music(note={note},beat={beat})")
        time.sleep(beat + 0.05)

    def volume(self, level):
        """Set speaker volume 0-100."""
        self.run(f"cyberpi.audio.set_vol({level})")

    # -- screen -------------------------------------------------------------
    def show(self, text):
        """Show text on the robot's screen."""
        self.run(f"cyberpi.display.show_label('{text}',24,'center')")

    # -- sensors (return a value from the robot) ----------------------------
    def distance(self):
        """Ultrasonic distance in cm (reads ~300 max when nothing is in range)."""
        return self.eval("cyberpi.ultrasonic2.get(1)")

    def battery(self):
        """Battery level (0-100)."""
        return self.eval("cyberpi.get_battery()")

    def brightness(self):
        """Ambient light level (0-100)."""
        return self.eval("cyberpi.get_bri()")

    def loudness(self):
        """Microphone loudness (0-100)."""
        return self.eval("cyberpi.get_loudness('maximum')")

    def roll(self):   return self.eval("cyberpi.get_roll()")
    def pitch(self):  return self.eval("cyberpi.get_pitch()")
    def yaw(self):    return self.eval("cyberpi.get_yaw()")

    def button(self, name="a"):
        """True if button 'a' or 'b' is being pressed."""
        return self.eval(f"cyberpi.controller.is_press('{name}')")
