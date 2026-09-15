"""
hello.py - the simplest possible mBot2 script: lights and sound, no movement.
Run it:  py examples/hello.py
"""

from mbot2 import MBot2

with MBot2() as bot:
    bot.led(0, 255, 0)      # green   (Red, Green, Blue -- each 0 to 255)
    bot.beep(784)           # a note  (bigger number = higher pitch)
    bot.led(255, 0, 0)      # red
    bot.beep(1047)          # higher note
    bot.led_off()

print("Done! Try changing the colors and notes above.")
