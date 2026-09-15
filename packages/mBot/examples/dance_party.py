"""
dance_party.py - the robot dance party!  Run it:  py examples/dance_party.py

    1 = Wiggle Boogie
    2 = Spin & Sparkle
    q = Quit

KIDS: change the colors (led numbers), speeds, and beeps -- or copy a dance
and invent your own!  Give the robot floor space.
"""

from mbot2 import MBot2


def wiggle_boogie(bot):
    print("  Wiggle Boogie!")
    bot.led_effect("rainbow")
    for _ in range(4):                      # wiggle side to side
        bot.led(255, 0, 0); bot.turn_left(70, 0.25)
        bot.led(0, 0, 255); bot.turn_right(70, 0.25)
    bot.led(0, 255, 0)
    bot.forward(50, 0.5)                     # scoot forward
    bot.backward(50, 0.5)                    # scoot back
    bot.beep(880, 0.25)
    bot.led(255, 255, 0)
    bot.turn(360)                            # one big spin!
    bot.led_off()


def spin_and_sparkle(bot):
    print("  Spin & Sparkle!")
    for _ in range(3):
        bot.led(255, 0, 255); bot.turn(180);  bot.beep(1047, 0.15)
        bot.led(0, 255, 255); bot.turn(-180); bot.beep(784, 0.15)
    bot.led_effect("firefly")               # sparkly finish
    bot.sleep(1.0)
    bot.led_off()


with MBot2() as bot:
    while True:
        print("\n=== DANCE PARTY ===  1=Wiggle  2=Sparkle  q=Quit")
        choice = input("Your pick: ").strip().lower()
        if choice == "1":
            wiggle_boogie(bot)
        elif choice == "2":
            spin_and_sparkle(bot)
        elif choice == "q":
            print("Bye! 👋")
            break
        else:
            print("  Type 1, 2, or q")
