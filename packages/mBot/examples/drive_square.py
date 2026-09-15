"""
drive_square.py - make the robot drive in a square.
Give it floor space!   Run it:  py examples/drive_square.py
"""

from mbot2 import MBot2

with MBot2() as bot:
    bot.led(0, 0, 255)                 # blue while driving
    for side in range(4):              # 4 sides of a square
        bot.forward(40, 1)             # drive forward 1 second
        bot.turn(90)                   # turn the corner
    bot.led_off()

print("Square complete! Change the 4 to 3 for a triangle.")
