from mbot2 import MBot2

with MBot2() as bot:
    bot.led(0, 255, 0)
    bot.forward(50, 1)
    bot.turn(90)
    bot.beep(880)