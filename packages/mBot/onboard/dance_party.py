#  ============================================================
#   ROBOT DANCE PARTY!  🤖💃
#  ============================================================
#  This program runs ON the mBot2 robot itself.
#
#  HOW TO USE IT:
#    1. Open mBlock 5 on the computer.
#    2. Connect the mBot2 (USB cable or Bluetooth).
#    3. Switch to "Upload mode" and the Python editor.
#    4. Paste this whole file in, and click "Upload".
#    5. On the robot, press button A or button B to dance!
#
#  TRY CHANGING THINGS:
#    - The numbers after led.on() are colors:  (Red, Green, Blue)
#      Each goes from 0 to 255. Mix them to make any color!
#    - The first number in forward()/turn() is the SPEED.
#    - The note numbers make different musical sounds.
#  ============================================================

import cyberpi
import mbot2
from time import sleep

cyberpi.audio.set_vol(80)   # how loud the music is (0 to 100)


# ---- Little helper "dance moves" we can reuse ----------------

def rainbow_lights():
    """Light up all 5 lights in rainbow colors."""
    cyberpi.led.on(255, 0,   0,   id=1)   # red
    cyberpi.led.on(255, 150, 0,   id=2)   # orange
    cyberpi.led.on(255, 255, 0,   id=3)   # yellow
    cyberpi.led.on(0,   255, 0,   id=4)   # green
    cyberpi.led.on(0,   100, 255, id=5)   # blue


def lights_off():
    cyberpi.led.off(id='all')


def beep(note):
    """Play one musical note. Bigger number = higher sound."""
    cyberpi.audio.play_music(note=note, beat=0.25)


# ---- Dance #1: The Wiggle Boogie  (press button A) ----------

def wiggle_boogie():
    cyberpi.display.show_label("Wiggle Boogie!", 16, 0, 30, 1)
    cyberpi.led.play(name="rainbow")     # built-in rainbow light show

    for step in range(4):                # do the wiggle 4 times
        mbot2.turn_left(70, 0.25)        # quick wiggle left
        beep(60)
        mbot2.turn_right(70, 0.25)       # quick wiggle right
        beep(64)

    mbot2.forward(60, 0.6)               # scoot forward
    beep(67)
    mbot2.backward(60, 0.6)              # scoot back
    beep(69)

    mbot2.turn(360)                      # one big spin all the way around!
    cyberpi.audio.play_until("yeah")     # say "yeah!"
    lights_off()


# ---- Dance #2: Spin & Sparkle  (press button B) -------------

def spin_and_sparkle():
    cyberpi.display.show_label("Spin & Sparkle!", 16, 0, 30, 1)

    for step in range(3):
        rainbow_lights()
        mbot2.turn(180)                  # half spin
        beep(72)
        lights_off()
        mbot2.turn(-180)                 # spin back the other way
        beep(65)

    cyberpi.led.play(name="firefly")     # sparkly finish
    cyberpi.audio.play_until("wow")
    lights_off()


# ---- The main loop: wait for a button, then dance -----------

cyberpi.display.show_label("DANCE PARTY!",   16, 0, 0,  0)
cyberpi.display.show_label("A = Wiggle",     12, 0, 50, 2)
cyberpi.display.show_label("B = Sparkle",    12, 0, 70, 3)

while True:
    if cyberpi.controller.is_press('a'):
        wiggle_boogie()
    elif cyberpi.controller.is_press('b'):
        spin_and_sparkle()
    sleep(0.05)
