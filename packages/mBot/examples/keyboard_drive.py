"""
keyboard_drive.py - drive the robot like a remote control.
Keys:  W = forward   S = back   A = left   D = right   space = stop   Q = quit

In Thonny: press the green Run button -- a little remote-control window
           pops up.  Click it once, then use the keys above.
In a terminal: python examples/keyboard_drive.py

Each key nudges the robot briefly, so it can't run away if you let go.
"""

import sys

from mbot2 import MBot2

# Reading one key at a time works differently on Windows vs Mac/Linux,
# so we set up a read_key() that does the right thing on each.
try:
    import msvcrt  # Windows

    def read_key():
        return msvcrt.getch().decode("utf-8", "ignore").lower()

    def keyboard_works():
        return True

except ImportError:
    import termios, tty  # Mac / Linux

    def read_key():
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        return ch.lower()

    def keyboard_works():
        # Thonny's Shell looks like a terminal but can't do raw key reads,
        # so actually try the terminal control and see if it works.
        try:
            termios.tcgetattr(sys.stdin.fileno())
            return True
        except (termios.error, ValueError, OSError):
            return False

SPEED = 50
BURST = 0.25   # seconds per key press


def drive_with_keys(bot):
    """Terminal mode: read one key at a time, no Enter needed."""
    while True:
        key = read_key()
        if key == "q":
            break
        elif key == "w":
            bot.forward(SPEED, BURST)
        elif key == "s":
            bot.backward(SPEED, BURST)
        elif key == "a":
            bot.turn_left(SPEED, BURST)
        elif key == "d":
            bot.turn_right(SPEED, BURST)
        elif key == " ":
            bot.stop()


def drive_with_window(bot):
    """Thonny / IDE mode: a little pop-up window captures the key presses."""
    import tkinter as tk

    root = tk.Tk()
    root.title("mBot2 Remote")
    tk.Label(
        root,
        text="Click this window, then drive:\n\n"
             "W A S D = move     space = stop     Q = quit",
        font=("Helvetica", 14), justify="center", padx=24, pady=24,
    ).pack(expand=True, fill="both")

    def on_key(event):
        k = event.keysym.lower()
        if k == "q":
            root.destroy()
        elif k == "w":
            bot.forward(SPEED, BURST)
        elif k == "s":
            bot.backward(SPEED, BURST)
        elif k == "a":
            bot.turn_left(SPEED, BURST)
        elif k == "d":
            bot.turn_right(SPEED, BURST)
        elif k == "space":
            bot.stop()

    root.bind("<KeyPress>", on_key)
    root.focus_force()
    root.mainloop()


print(__doc__)

with MBot2() as bot:
    bot.led(0, 0, 255)
    if keyboard_works():
        drive_with_keys(bot)        # real terminal: single key presses
    else:
        try:
            drive_with_window(bot)  # Thonny / IDE: pop-up remote window
        except Exception as e:
            print("Couldn't open the remote-control window:", e)
            print("Run from a terminal instead: python examples/keyboard_drive.py")

print("Bye!")
