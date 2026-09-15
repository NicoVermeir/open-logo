"""
mbot2 - control a Makeblock mBot2 / CyberPi from Python over Bluetooth.

Quick start:

    from mbot2 import MBot2

    with MBot2() as bot:
        bot.led(0, 255, 0)
        bot.forward(50, 1)
        bot.beep(880)
"""

from .robot import MBot2
from .connection import AsyncMBot2

__all__ = ["MBot2", "AsyncMBot2"]
__version__ = "0.1.0"
