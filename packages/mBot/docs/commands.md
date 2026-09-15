# mBot2 Command Reference

Two parts:

1. [**The friendly wrappers**](#part-1--the-friendly-wrappers) — the simple `MBot2` methods we built.
2. [**The full robot API**](#part-2--the-full-robot-api) — *everything* the robot can do, callable via
   `bot.run(...)` / `bot.eval(...)`.

> Captured from a real robot, **firmware 44.01.013**. Run `py tools/introspect.py` to regenerate
> this list for your own robot/firmware.

---

## Part 1 — the friendly wrappers

These are the methods on the `MBot2` class (`mbot2/robot.py`). Each one just sends a small piece of
Python to the robot. Import and connect once:

```python
from mbot2 import MBot2

with MBot2() as bot:        # auto-connects; auto-disconnects at the end
    bot.led(0, 255, 0)
    bot.forward(50, 1)
```

### Movement
| Method | What it does | Runs on robot |
| --- | --- | --- |
| `forward(speed=50, secs=None)` | Drive forward. With `secs`, moves that long then **auto-stops**. | `mbot2.forward(speed[,secs])` |
| `backward(speed=50, secs=None)` | Drive backward. | `mbot2.backward(...)` |
| `turn_left(speed=50, secs=None)` | Spin left. | `mbot2.turn_left(...)` |
| `turn_right(speed=50, secs=None)` | Spin right. | `mbot2.turn_right(...)` |
| `turn(degrees)` | Turn a precise angle using the gyro. `+`=right, `-`=left. | `mbot2.turn(deg)` |
| `drive(left, right)` | Set each wheel speed (-100..100). Runs until `stop()`. | `mbot2.drive_speed(l,r)` |
| `stop()` | Stop the motors. | `mbot2.EM_stop()` |

> Tip: pass `secs` for safety — the robot stops itself even if a Bluetooth packet is lost.

### Lights (the 5 RGB LEDs)
| Method | What it does | Runs on robot |
| --- | --- | --- |
| `led(r, g, b)` | Set all LEDs to a color (0-255 each). | `cyberpi.led.on(r,g,b)` |
| `led(r, g, b, which=N)` | Set one LED (`N` = 1..5). | `cyberpi.led.on(r,g,b,id=N)` |
| `led_off()` | Turn the lights off. | `cyberpi.led.on(0,0,0)` |
| `led_effect(name="rainbow")` | Built-in light show. Names: `rainbow`, `spoondrift`, `meteor_blue`, `meteor_green`, `flash_red`, `flash_orange`, `firefly`. | `cyberpi.led.play(name=...)` |

### Sound
| Method | What it does | Runs on robot |
| --- | --- | --- |
| `beep(freq=523, secs=0.3)` | Play a tone. Bigger `freq` = higher. | `cyberpi.audio.play_tone(freq,secs)` |
| `play_note(note=60, beat=0.5)` | Play a musical note (0-132). | `cyberpi.audio.play_music(note=,beat=)` |
| `volume(level)` | Set volume 0-100. | `cyberpi.audio.set_vol(level)` |

### Screen
| Method | What it does | Runs on robot |
| --- | --- | --- |
| `show(text)` | Show text centered on the screen. | `cyberpi.display.show_label(text,24,'center')` |

### Sensors (return a value)
| Method | Returns | Runs on robot |
| --- | --- | --- |
| `battery()` | Battery % (0-100) | `cyberpi.get_battery()` |
| `brightness()` | Ambient light (0-100) | `cyberpi.get_bri()` |
| `loudness()` | Mic loudness (0-100) | `cyberpi.get_loudness('maximum')` |
| `roll()` / `pitch()` / `yaw()` | Tilt angles (degrees) | `cyberpi.get_roll()` … |
| `button(name="a")` | `True` while pressed (`"a"`/`"b"`) | `cyberpi.controller.is_press(name)` |
| `distance()` | Ultrasonic cm (reads ~300 when clear) | `cyberpi.ultrasonic2.get(1)` |

> ✅ All the wrapper methods above are **verified working on a real mBot2** (firmware
> 44.01.013). Earlier drafts flagged `distance()` and `loudness()` as unverified — the
> ultrasonic namespace turned out to be `cyberpi.ultrasonic2` (not `mbot2.ultrasonic2`),
> and both are now confirmed.

> 📖 **Want the deep dive?** [**docs/sensors.md**](sensors.md) explains the **ultrasonic**
> and **line-follower** sensors in detail — how they work, their range/limits, ready-to-run
> obstacle-avoid and line-follow examples, and troubleshooting tips.

### Escape hatches — run ANY robot command
| Method | What it does |
| --- | --- |
| `run("code")` | Send any Python to run on the robot (no return). |
| `eval("expr")` | Run an expression and get its value back. |
| `sleep(secs)` | Pause your script. |

```python
bot.run("mbot2.straight(30)")          # drive exactly 30 cm
print(bot.eval("cyberpi.get_acc('z')"))  # read the accelerometer
```

Everything in Part 2 is reachable this way.

---

## Part 2 — the full robot API

The robot runs MicroPython with two main modules: **`cyberpi`** (the brain board — lights, sound,
screen, sensors) and **`mbot2`** (the body — motors, wheels, servos). Anything below can be called
with `bot.run("...")` or `bot.eval("...")`.

Signatures shown with `()` are known/common; others are present in the firmware but you may need to
check their arguments (call `bot.eval("dir(...)")`, or peek in the
[Makeblock examples](https://github.com/PerfecXX/mBot2)).

### Driving & motors (`mbot2.*`)
| Command | Notes |
| --- | --- |
| `mbot2.forward(speed[, secs])` / `backward(...)` | speed in RPM; optional time then auto-stop |
| `mbot2.turn_left(speed[, secs])` / `turn_right(...)` | spin in place |
| `mbot2.straight(cm)` | drive a **precise distance** (negative = backward) |
| `mbot2.turn(degrees)` / `turn_degrees(...)` | precise gyro turn |
| `mbot2.forward_with_gyro(...)` | straight-line drive corrected by the gyro |
| `mbot2.drive_speed(l, r)` | set each wheel speed (RPM) |
| `mbot2.drive_power(l, r)` | set each wheel raw power |
| `mbot2.EM_stop()` | stop |
| `mbot2.EM_get_speed(...)`, `EM_get_angle(...)`, `EM_reset_angle(...)`, `EM_lock(...)` | encoder motor read/control |
| `mbot2.set_pwm(...)`, `read_analog(...)`, `read_digital(...)`, `write_digital(...)` | low-level ports |

### Servos & add-on modules (`mbot2.*`)
| Command | Notes |
| --- | --- |
| `mbot2.servo_set(...)`, `servo_get(...)`, `servo_drive(...)`, `servo_release(...)` | servo control (confirm arg order) |
| `mbot2.motor_set/get/drive/stop(...)` | generic motor driver |

### Lights (`cyberpi.led.*`)
| Command | Notes |
| --- | --- |
| `cyberpi.led.on(r, g, b[, id=1..5])` | set all, or one LED |
| `cyberpi.led.off([id])` | turn off |
| `cyberpi.led.move(n)` | shift colors around the ring |
| `cyberpi.led.play(name='rainbow')` | effects: rainbow, spoondrift, meteor_blue, meteor_green, flash_red, flash_orange, firefly |
| `cyberpi.led.breathe(...)`, `rainbow_effect(...)`, `meteor_effect(...)`, `firefly_effect(...)` | individual effects |
| `cyberpi.led.set_bri(0-100)` / `get_bri()` / `add_bri(n)` | LED brightness |
| `cyberpi.led.show(...)`, `show_single(...)`, `ring_graph(...)` | advanced patterns |

### Sound (`cyberpi.audio.*`)
| Command | Notes |
| --- | --- |
| `cyberpi.audio.play_tone(freq, secs)` | a tone |
| `cyberpi.audio.play_music(note=, beat=)` / `play_note(...)` | musical notes (0-132) |
| `cyberpi.audio.play("name")` / `play_until("name")` | **built-in sound clips** (play_until waits till done) |
| `cyberpi.audio.play_drum(...)` | drum sounds |
| `cyberpi.audio.play_melody(...)` / `play_melody_until_done(...)` | melodies |
| `cyberpi.audio.record()` / `stop_record()` / `play_record()` | record & replay the mic |
| `cyberpi.audio.set_vol(0-100)` / `get_vol()` / `add_vol(n)` | volume |
| `cyberpi.audio.set_tempo(...)` / `get_tempo()` | playback tempo |
| `cyberpi.audio.stop()` / `stop_sounds()` | stop audio |

### Screen (`cyberpi.display.*`, `cyberpi.console.*`)
| Command | Notes |
| --- | --- |
| `cyberpi.display.show_label(text, size, x, y, index)` | show text (x/y or `'center'`) |
| `cyberpi.display.set_brush(r, g, b)` | text/drawing color |
| `cyberpi.display.clear()` / `rotate_to(...)` | clear / rotate screen |
| `cyberpi.console.println(text)` / `print(text)` | scrolling text console |
| `cyberpi.display.linechart` / `barchart` / `table` | live charts & tables |

### Sensors & motion (`cyberpi.*`)
| Command | Returns |
| --- | --- |
| `cyberpi.get_bri()` | ambient light (0-100) |
| `cyberpi.get_loudness('maximum')` | mic loudness |
| `cyberpi.get_battery()` / `get_extra_battery()` | battery % |
| `cyberpi.get_acc('x'/'y'/'z')` | accelerometer (m/s²) |
| `cyberpi.get_gyro('x'/'y'/'z')` | gyroscope (deg/s) |
| `cyberpi.get_rotation('x'/'y'/'z')` | accumulated rotation |
| `cyberpi.get_roll()` / `get_pitch()` / `get_yaw()` | orientation (deg); `reset_yaw()` to zero |
| `cyberpi.is_shake()` / `get_shakeval()` | shaking? / how hard |
| `cyberpi.is_freefall()` | dropped? |
| `cyberpi.is_tiltleft()` / `is_tiltright()` / `is_tiltforward()` / `is_tiltback()` | tilt direction |
| `cyberpi.is_faceup()` / `is_facedown()` / `is_stand()` / `is_handstand()` | posture |
| `cyberpi.is_waveup()` / `is_wavedown()` / `is_waveleft()` / `is_waveright()` | wave gesture |
| `cyberpi.get_wave_speed()` / `get_wave_angle()` | gesture details |

### Buttons & joystick
| Command | Notes |
| --- | --- |
| `cyberpi.controller.is_press('a'/'b'/'up'/'down'/'left'/'right'/'middle')` | button/joystick pressed? |
| `cyberpi.controller.get_count('a')` / `reset_count('a')` | press counter |
| `cyberpi.joystick...` | joystick object (separate from `controller`) |

### Plug-in (mBuild) sensors — `cyberpi.<sensor>`
Available drivers seen on this firmware (call `dir()` on one to see its methods):
`quad_rgb_sensor` (**line following**), `dual_rgb_sensor`, `ultrasonic2`, `led_ultrasonic_sensor`,
`ranging_sensor`, `angle_sensor`, `multi_touch`, `sound_sensor`, `pir`, `soil_sensor`,
`temp_sensor`, `humiture`, `mq2`, `flame_sensor`, `magnetic_sensor`, `smart_servo`,
`smart_camera`, `ir`, `science`.

### Network, cloud & AI (`cyberpi.*`)
| Command | Notes |
| --- | --- |
| `cyberpi.wifi...` | connect to Wi-Fi |
| `cyberpi.cloud...` | weather, time, etc. |
| `cyberpi.mqtt...` | MQTT messaging |
| `cyberpi.mesh` / `broadcast` / `message` | robot-to-robot messaging |
| `cyberpi.speech...` | text-to-speech **and** speech recognition |
| `cyberpi.iot...` / `espnow...` | IoT / ESP-NOW |

### Housekeeping (`cyberpi.*`)
| Command | Notes |
| --- | --- |
| `cyberpi.get_firmware_version()` | firmware string |
| `cyberpi.get_name()` / `set_name(...)` | Bluetooth name |
| `cyberpi.get_mac_address()` | MAC address |
| `cyberpi.get_language()` / `set_language(...)` | UI language |
| `cyberpi.timer...` | stopwatch |
| `cyberpi.restart()` | reboot the robot |
| `cyberpi.stop_script()` / `stop_all()` | stop running code |

---

## Discover more

The robot is the source of truth. To explore any object:

```python
from mbot2 import MBot2
with MBot2() as bot:
    print(bot.eval("dir(cyberpi.audio)"))        # list an object's methods
    print(bot.eval("cyberpi.quad_rgb_sensor"))   # poke at a sensor
```

Or just run `py tools/introspect.py` for the full dump.
