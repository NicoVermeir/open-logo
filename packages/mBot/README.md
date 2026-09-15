# mbot2 🤖

Control a **Makeblock mBot2 (CyberPi)** from your computer in **plain Python over Bluetooth** —
no mBlock, no uploading, no dongle. Write a few lines of Python and the robot moves, lights up,
and beeps in real time.

```python
from mbot2 import MBot2

with MBot2() as bot:        # finds & connects over Bluetooth automatically
    bot.led(0, 255, 0)      # green
    bot.forward(50, 1)      # drive at speed 50 for 1 second
    bot.turn(90)            # turn 90 degrees
    bot.beep(880)           # play a note
```

A learn-to-code project, built with my 8-year-old daughter.

## Install

```bash
pip install -e .
```

That installs the `mbot2` package (and `bleak`) so `import mbot2` works in any script.
Then turn the robot **on** and make sure it isn't connected to a phone or mBlock.

> Just want to run the examples without installing? They work too — each one adds the
> project folder to the path automatically. `pip install -e .` is only needed for scripts
> you write elsewhere.

## Your first script

Create `myrobot.py` anywhere:

```python
from mbot2 import MBot2

bot = MBot2()               # connect
bot.led(255, 0, 255)        # purple
bot.forward(40, 1)          # forward 1 second (it auto-stops)
bot.turn(180)               # spin around
bot.beep(660)
bot.disconnect()
```

Run it: `py myrobot.py`. That's the whole idea — simple, top-to-bottom Python.

## What the robot can do

| Category | Commands |
| --- | --- |
| **Move** | `forward(speed, secs)`, `backward(...)`, `turn_left(...)`, `turn_right(...)`, `turn(degrees)`, `drive(left, right)`, `stop()` |
| **Lights** | `led(r, g, b)`, `led(r, g, b, which=1..5)`, `led_off()`, `led_effect("rainbow")` |
| **Sound** | `beep(freq, secs)`, `play_note(note, beat)`, `volume(0-100)` |
| **Screen** | `show("hi!")` |
| **Sensors** | `distance()`, `battery()`, `brightness()`, `loudness()`, `roll()`, `pitch()`, `yaw()`, `button("a")` |
| **Anything** | `run("...")` runs any Python on the robot; `eval("...")` runs it and returns the result |

Movement tip: pass `secs` (like `forward(50, 1)`) and the robot stops **itself** after that
time — safe even if a Bluetooth packet drops. Leave `secs` off and it keeps going until `stop()`.

**Kid-friendly cheat sheet:** open **[docs/cheatsheet.html](docs/cheatsheet.html)** in a browser,
or print the ready-made **[docs/cheatsheet.pdf](docs/cheatsheet.pdf)** — a colorful one-page (A4)
reference of the most fun commands. Great taped up next to the computer.

**Full command reference:** see **[docs/commands.md](docs/commands.md)** — every wrapper method
plus the complete robot API. Or **ask the robot directly:** `py tools/introspect.py` prints the
full list its firmware supports.

**Sensors in depth:** **[docs/sensors.md](docs/sensors.md)** goes deep on the **ultrasonic**
(distance) and **line-follower** sensors — how they work, their range and limits, worked
obstacle-avoid and line-follow examples, and troubleshooting.

## Examples

Run any of these (`py examples/<name>.py`):

| File | What it does |
| --- | --- |
| `examples/hello.py` | Lights + sound only (no movement) — start here |
| `examples/drive_square.py` | Drives in a square |
| `examples/dance_party.py` | Interactive dance menu (the fun one!) |
| `examples/keyboard_drive.py` | Drive it like a remote control (W/A/S/D) |
| `examples/read_sensors.py` | Robot reacts to distance/light/sound |

## Project layout

```
mbot2/         the library  (protocol.py, connection.py, robot.py)
examples/      ready-to-run scripts (great for tinkering)
tools/         diagnostics: scan.ps1, explore_ble.py, probe_ble.py, introspect.py
onboard/       dance_party.py — the MicroPython version to run ON the robot via mBlock
docs/          commands.md — full command reference; sensors.md — ultrasonic & line-follower
               deep dive; cheatsheet.html/.pdf — one-page kid cheat sheet
```

## How it works

The CyberPi's Bluetooth pipe speaks Makeblock's private **"f3/f4" framing** — the same
"Live Mode" mBlock uses. Each frame wraps a snippet of Python that the robot evaluates
instantly (and can answer with JSON). This project implements that protocol on top of
[`bleak`](https://github.com/hbldh/bleak):

1. Connect over BLE, subscribe to notify characteristic `ffe2`, write to `ffe3`
2. Send the "enter Live Mode" frame
3. Send a sensor read until the robot replies (handshake)
4. Stream Python commands → the robot runs them live

See `mbot2/protocol.py` for the exact frame format.

## Credits

The f3/f4 protocol was figured out with help from
[Hulupeep/mbot_ruvector](https://github.com/Hulupeep/mbot_ruvector) (which traces back to
Makeblock's own `makeblock` pip package). The Python/`bleak` implementation here is original.

## License

MIT
