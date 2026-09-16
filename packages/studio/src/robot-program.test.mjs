import assert from "node:assert/strict";
import test from "node:test";
import {
  createStudioState,
  runRobotProgram as executeRobotProgram,
  createRobotRunController,
  createRobotControlPanelController,
  createRunController,
} from "@openlogo/studio";

const penSettings = {
  downAngle: 60,
  raisedAngle: 120,
  measuredLiftMillimeters: 10,
  liftMillimeters: 5,
  settleMilliseconds: 500,
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function runRobotProgram(robot, options) {
  robot.setPenDown ??= async () => {};
  return executeRobotProgram(robot, { penSettings, ...options });
}
function confirmPen(controls) {
  controls.setPenSettings(penSettings);
  controls.confirmPenSettings();
}

function simulateQuarterTurnUndertravel(commandedDegrees) {
  if ([90, 91].includes(Math.abs(commandedDegrees))) {
    return commandedDegrees - Math.sign(commandedDegrees);
  }
  return commandedDegrees;
}

test("polygon corners keep the offset pen on every virtual vertex", async () => {
  for (const sideCount of [3, 4]) {
    for (const command of ["right", "left"]) {
      for (const sign of [1, -1]) {
        for (const initialHeading of [0, 37, 211]) {
          const angle = (sign * 360) / sideCount;
          const state = createStudioState();
          state.setSource(
            `pen_down\nrepeat ${sideCount} [ forward 60 ${command} ${angle} ]`,
          );
          const initialRadians = (initialHeading * Math.PI) / 180;
          let centerX =
            26 * Math.cos(initialRadians) - 126 * Math.sin(initialRadians);
          let centerY =
            -126 * Math.cos(initialRadians) - 26 * Math.sin(initialRadians);
          let heading = initialHeading;
          let penDown = false;
          const drawn = [];
          const penTip = () => {
            const radians = (heading * Math.PI) / 180;
            return [
              centerX + 126 * Math.sin(radians) - 26 * Math.cos(radians),
              centerY + 126 * Math.cos(radians) + 26 * Math.sin(radians),
            ];
          };
          await runRobotProgram(
            {
              connected: true,
              setPenDown: async (down) => {
                penDown = down;
              },
              moveCentimeters: async (amount) => {
                const from = penTip();
                const radians = (heading * Math.PI) / 180;
                centerX += amount * 10 * Math.sin(radians);
                centerY += amount * 10 * Math.cos(radians);
                if (penDown) drawn.push({ from, to: penTip() });
              },
              turnDegrees: async (amount) => {
                assert.equal(penDown, false);
                heading += simulateQuarterTurnUndertravel(amount);
              },
            },
            { state, repaint() {}, cancelled: () => false },
          );
          const virtualLines = state.getState().turtleScene.items;
          assert.equal(drawn.length, sideCount);
          assert.equal(virtualLines.length, sideCount);
          for (const [index, line] of drawn.entries()) {
            for (const endpoint of ["from", "to"]) {
              const [virtualX, virtualY] =
                virtualLines[index].segment[endpoint];
              const expectedX =
                virtualX * Math.cos(initialRadians) +
                virtualY * Math.sin(initialRadians);
              const expectedY =
                virtualY * Math.cos(initialRadians) -
                virtualX * Math.sin(initialRadians);
              const error = Math.hypot(
                line[endpoint][0] - expectedX,
                line[endpoint][1] - expectedY,
              );
              assert.ok(
                error < 1e-8,
                `${command} ${angle}, side ${index + 1} ${endpoint}: ${error} mm error`,
              );
            }
          }
          assert.ok(Math.hypot(...penTip()) < 1e-8);
          assert.equal(
            heading,
            initialHeading + sign * 360 * (command === "left" ? -1 : 1),
          );
        }
      }
    }
  }
});

test("90-degree turns compensate one degree of hardware underturn without changing geometry", async () => {
  for (const [source, direction] of [
    ["right 90", 1],
    ["left 90", -1],
    ["right -90", -1],
    ["left -90", 1],
    ["right 360 / 4", 1],
    ["left 360 / 4", -1],
  ]) {
    for (const penCommand of ["pen_down", "pen_up"]) {
      const expectedPenDown = penCommand === "pen_down";
      const state = createStudioState({
        source: `${penCommand}\nforward 40\n${source}\nforward 40`,
      });
      const calls = [];
      let penDown = false;
      await executeRobotProgram(
        {
          connected: true,
          async setPenDown(down) {
            penDown = down;
            calls.push(["pen", down]);
          },
          async moveCentimeters(distance) {
            calls.push(["move", distance, penDown]);
          },
          async turnDegrees(angle) {
            assert.equal(penDown, false);
            calls.push(["turn", angle]);
          },
        },
        { state, penSettings, repaint() {}, cancelled: () => false },
      );
      assert.deepEqual(
        calls,
        [
          ["pen", expectedPenDown],
          ["move", 4, expectedPenDown],
          ["pen", false],
          ["move", direction > 0 ? 10 : 15.2, false],
          ["turn", direction * 91],
          ["move", direction > 0 ? -15.2 : -10, false],
          ...(expectedPenDown ? [["pen", true]] : []),
          ["move", 4, expectedPenDown],
        ],
        source,
      );
      const snapshot = state.getState();
      assert.ok(
        Math.abs(snapshot.turtleState.position[0] - direction * 40) < 1e-8,
      );
      assert.ok(Math.abs(snapshot.turtleState.position[1] - 40) < 1e-8);
      assert.equal(snapshot.turtleState.heading, direction > 0 ? 90 : 270);
      assert.equal(snapshot.turtleState.penDown, expectedPenDown);
      assert.equal(snapshot.turtleScene.items.length, expectedPenDown ? 2 : 0);
      assert.equal(penDown, expectedPenDown);
    }
  }
});

test("180-degree turns apply clockwise lateral calibration without changing signed heading", async () => {
  for (const [source, signedAngle, leftCorrectionMillimeters] of [
    ["right 180", 180, 13.3],
    ["left 180", -180, 0],
    ["right -180", -180, 0],
    ["left -180", 180, 13.3],
    ["right 360 / 2", 180, 13.3],
    ["left 360 / 2", -180, 0],
  ]) {
    for (const initialHeading of [0, 37, 211]) {
      const state = createStudioState({
        source: `pen_down\nforward 40\n${source}\nforward 40`,
      });
      const initialRadians = (initialHeading * Math.PI) / 180;
      let horizontal =
        26 * Math.cos(initialRadians) - 126 * Math.sin(initialRadians);
      let vertical =
        -126 * Math.cos(initialRadians) - 26 * Math.sin(initialRadians);
      let heading = initialHeading;
      let down = false;
      const drawn = [];
      const pens = [];
      const tip = () => {
        const radians = (heading * Math.PI) / 180;
        return [
          horizontal + 126 * Math.sin(radians) - 26 * Math.cos(radians),
          vertical + 126 * Math.cos(radians) + 26 * Math.sin(radians),
        ];
      };
      await executeRobotProgram(
        {
          connected: true,
          async setPenDown(value) {
            down = value;
            pens.push(value);
          },
          async moveCentimeters(distance) {
            const from = tip();
            horizontal += distance * 10 * Math.sin((heading * Math.PI) / 180);
            vertical += distance * 10 * Math.cos((heading * Math.PI) / 180);
            if (down) drawn.push([from, tip()]);
          },
          async turnDegrees(amount) {
            assert.equal(down, false);
            heading += amount;
          },
        },
        { state, penSettings, repaint() {}, cancelled: () => false },
      );
      const vertex = [
        40 * Math.sin(initialRadians),
        40 * Math.cos(initialRadians),
      ];
      const expectedCalibrationDisplacement = [
        -leftCorrectionMillimeters * Math.cos(initialRadians),
        leftCorrectionMillimeters * Math.sin(initialRadians),
      ];
      assert.ok(
        Math.abs(heading - initialHeading - signedAngle) < 1e-8,
        source,
      );
      assert.deepEqual(pens, [true, false, true]);
      assert.equal(drawn.length, 2);
      for (const coordinate of [0, 1]) {
        assert.ok(Math.abs(drawn[0][0][coordinate]) < 1e-8, source);
        assert.ok(
          Math.abs(drawn[0][1][coordinate] - vertex[coordinate]) < 1e-8,
          source,
        );
        assert.ok(
          Math.abs(
            drawn[1][0][coordinate] -
              vertex[coordinate] -
              expectedCalibrationDisplacement[coordinate],
          ) < 1e-8,
          source,
        );
        assert.ok(
          Math.abs(
            tip()[coordinate] - expectedCalibrationDisplacement[coordinate],
          ) < 1e-8,
          source,
        );
        assert.ok(
          Math.abs(state.getState().turtleState.position[coordinate]) < 1e-8,
          source,
        );
      }
      assert.equal(state.getState().turtleState.heading, 180);
      assert.equal(state.getState().turtleScene.items.length, 2);
    }
  }
});

test("360-degree turns apply signed calibration without repositioning and preserve pen intent", async () => {
  for (const [source, physicalAngle] of [
    ["right 360", 367],
    ["left 360", -367],
    ["right -360", -367],
    ["left -360", 367],
    ["right 180 * 2", 367],
    ["left 720 / 2", -367],
  ]) {
    for (const penCommand of ["pen_down", "pen_up"]) {
      const state = createStudioState({
        source: `${penCommand}\nforward 40\n${source}\nforward 40`,
      });
      const commands = [];
      let penDown = false;
      await executeRobotProgram(
        {
          connected: true,
          async setPenDown(value) {
            penDown = value;
            commands.push(["pen", value]);
          },
          async moveCentimeters(distance) {
            commands.push(["move", distance]);
          },
          async turnDegrees(amount) {
            assert.equal(penDown, false, source);
            commands.push(["turn", amount]);
          },
        },
        { state, penSettings, repaint() {}, cancelled: () => false },
      );
      const expectedPenDown = penCommand === "pen_down";
      assert.deepEqual(
        commands,
        [
          ["pen", expectedPenDown],
          ["move", 4],
          ["pen", false],
          ["turn", physicalAngle],
          ...(expectedPenDown ? [["pen", true]] : []),
          ["move", 4],
        ],
        source,
      );
      assert.equal(penDown, expectedPenDown, source);
      assert.deepEqual(state.getState().turtleState.position, [0, 80]);
      assert.equal(state.getState().turtleState.heading, 0);
      assert.equal(
        state.getState().turtleScene.items.length,
        expectedPenDown ? 2 : 0,
      );
    }
  }
});

test("450-degree turns combine calibrated full and quarter turns while preserving pen intent", async () => {
  for (const [source, direction] of [
    ["right 450", 1],
    ["left 450", -1],
    ["right -450", -1],
    ["left -450", 1],
    ["right 900 / 2", 1],
    ["left 360 + 90", -1],
  ]) {
    for (const penCommand of ["pen_down", "pen_up"]) {
      const expectedPenDown = penCommand === "pen_down";
      const calls = [];
      let penDown = false;
      const state = createStudioState({
        source: `${penCommand}\nforward 40\n${source}\nforward 40`,
      });
      await executeRobotProgram(
        {
          connected: true,
          async setPenDown(down) {
            penDown = down;
            calls.push(["pen", down]);
          },
          async moveCentimeters(distance) {
            calls.push(["move", distance, penDown]);
          },
          async turnDegrees(angle) {
            assert.equal(penDown, false);
            calls.push(["turn", angle]);
          },
        },
        { state, penSettings, repaint() {}, cancelled: () => false },
      );
      assert.deepEqual(calls, [
        ["pen", expectedPenDown],
        ["move", 4, expectedPenDown],
        ["pen", false],
        ["turn", direction * 367],
        ["move", direction > 0 ? 10 : 15.2, false],
        ["turn", direction * 91],
        ["move", direction > 0 ? -15.2 : -10, false],
        ...(expectedPenDown ? [["pen", true]] : []),
        ["move", 4, expectedPenDown],
      ]);
      assert.equal(penDown, expectedPenDown);
      const snapshot = state.getState();
      assert.ok(
        Math.abs(snapshot.turtleState.position[0] - direction * 40) < 1e-8,
      );
      assert.ok(Math.abs(snapshot.turtleState.position[1] - 40) < 1e-8);
      assert.equal(snapshot.turtleState.heading, direction > 0 ? 90 : 270);
      assert.equal(snapshot.turtleState.penDown, expectedPenDown);
      assert.equal(snapshot.turtleScene.items.length, expectedPenDown ? 2 : 0);
    }
  }
});

test("left offset compensation returns the pen tip to the Logo vertex without drawing repositioning", async () => {
  for (const initialHeading of [0, 37, 211]) {
    for (const angle of [
      90, -90, 120, -120, -180, 179.999, -179.999, 181, -181, -270, 540, -540,
      720, -720, 0, 20,
    ]) {
      const state = createStudioState({
        source: `left ${-initialHeading}\npen_down\nforward 19\nleft ${-angle}\nforward 19`,
      });
      let horizontal = 26;
      let vertical = -126;
      let heading = 0;
      let down = false;
      const drawn = [];
      const tip = () => {
        const radians = (heading * Math.PI) / 180;
        return [
          horizontal + 126 * Math.sin(radians) - 26 * Math.cos(radians),
          vertical + 126 * Math.cos(radians) + 26 * Math.sin(radians),
        ];
      };
      await executeRobotProgram(
        {
          connected: true,
          async setPenDown(value) {
            down = value;
          },
          async moveCentimeters(distance) {
            assert.ok(Math.abs(distance) <= 1_000);
            const from = tip();
            horizontal += distance * 10 * Math.sin((heading * Math.PI) / 180);
            vertical += distance * 10 * Math.cos((heading * Math.PI) / 180);
            if (down) drawn.push([from, tip()]);
          },
          async turnDegrees(amount) {
            assert.ok(Math.abs(amount) <= 5_000);
            assert.equal(down, false);
            heading += simulateQuarterTurnUndertravel(amount);
          },
        },
        { state, penSettings, repaint() {}, cancelled: () => false },
      );
      const vertex = [
        19 * Math.sin((initialHeading * Math.PI) / 180),
        19 * Math.cos((initialHeading * Math.PI) / 180),
      ];
      const expected = [
        vertex[0] + 19 * Math.sin(((initialHeading + angle) * Math.PI) / 180),
        vertex[1] + 19 * Math.cos(((initialHeading + angle) * Math.PI) / 180),
      ];
      assert.ok(Math.abs(heading - initialHeading - angle) < 1e-8);
      for (const coordinate of [0, 1]) {
        assert.ok(Math.abs(tip()[coordinate] - expected[coordinate]) < 1e-8);
        assert.ok(
          Math.abs(drawn[1][0][coordinate] - vertex[coordinate]) < 1e-8,
        );
        assert.ok(
          Math.abs(
            state.getState().turtleState.position[coordinate] -
              expected[coordinate],
          ) < 1e-8,
        );
      }
      const drawnDistance = drawn.reduce(
        (total, [from, to]) =>
          total + Math.hypot(to[0] - from[0], to[1] - from[1]),
        0,
      );
      assert.ok(Math.abs(drawnDistance - 38) < 1e-8);
      assert.equal(state.getState().turtleScene.items.length, drawn.length);
    }
  }
});

test("turn restoration follows the latest explicit pen command, never the virtual default", async () => {
  for (const [prefix, expected] of [
    ["", [false, false]],
    ["if false [ pen_down ]\n", [false, false]],
    ["pen_down\n", [true, false, true, false, true]],
    ["pen_down\npen_up\n", [true, false, false, false]],
    ["pen_up\n", [false, false, false]],
  ]) {
    const pens = [];
    await executeRobotProgram(
      {
        connected: true,
        async setPenDown(down) {
          pens.push(down);
        },
        async moveCentimeters() {},
        async turnDegrees() {},
      },
      {
        state: createStudioState({ source: `${prefix}right 90\nleft 90` }),
        penSettings,
        repaint() {},
        cancelled: () => false,
      },
    );
    assert.deepEqual(pens, expected);
  }
});

test("every compensation acknowledgement gates the canvas and cancellation prevents subsequent commands", async () => {
  for (const source of [
    "right 90",
    "right 360",
    "left 360",
    "right 450",
    "left 450",
    "right -450",
    "left -450",
  ]) {
    const baseline = [];
    await executeRobotProgram(
      {
        connected: true,
        async setPenDown() {
          baseline.push("pen");
        },
        async turnDegrees() {
          baseline.push("turn");
        },
        async moveCentimeters() {
          baseline.push("move");
        },
      },
      {
        state: createStudioState({ source: `pen_down\n${source}` }),
        penSettings,
        repaint() {},
        cancelled: () => false,
      },
    );
    for (const disconnect of [false, true]) {
      for (let stopAt = 1; stopAt <= baseline.length; stopAt++) {
        const state = createStudioState({ source: `pen_down\n${source}` });
        let calls = 0;
        let cancelled = false;
        let release;
        const command = async () => {
          calls++;
          if (calls === stopAt)
            await new Promise((resolve) => {
              release = resolve;
            });
        };
        const robot = {
          connected: true,
          setPenDown: command,
          turnDegrees: command,
          moveCentimeters: command,
        };
        const run = executeRobotProgram(robot, {
          state,
          penSettings,
          repaint() {},
          cancelled: () => cancelled,
        });
        await nextTurn();
        assert.equal(calls, stopAt);
        assert.equal(state.getState().turtleState.heading, 0);
        assert.deepEqual(state.getState().turtleState.position, [0, 0]);
        assert.equal(state.getState().turtleScene.items.length, 0);
        if (disconnect) robot.connected = false;
        else cancelled = true;
        release();
        await assert.rejects(run, disconnect ? /disconnected/ : /stopped/);
        assert.equal(calls, stopAt);
        assert.equal(state.getState().turtleState.heading, 0);
      }
    }
  }
});

test("compensation and zero-distance commands count toward preflight before any hardware command", async () => {
  for (const source of ["repeat 23 [ right 90 ]", "repeat 501 [ forward 0 ]"]) {
    let commands = 0;
    const command = async () => {
      commands++;
    };
    await assert.rejects(
      executeRobotProgram(
        {
          connected: true,
          setPenDown: command,
          moveCentimeters: command,
          turnDegrees: command,
        },
        {
          state: createStudioState({ source }),
          penSettings,
          repaint() {},
          cancelled: () => false,
        },
      ),
      /500 motion segments/,
    );
    assert.equal(commands, 0);
  }
});

test("450-degree plans include calibration and translations in the 500-segment budget", async () => {
  for (const turnCommand of ["right", "left"]) {
    for (const [distance, exceedsBudget] of [
      [400, false],
      [420, true],
    ]) {
      let commands = 0;
      const command = async () => {
        commands++;
      };
      const run = executeRobotProgram(
        {
          connected: true,
          setPenDown: command,
          moveCentimeters: command,
          turnDegrees: command,
        },
        {
          state: createStudioState({
            source: `repeat 8 [ ${turnCommand} 450 ]\nforward ${distance}`,
          }),
          penSettings,
          repaint() {},
          cancelled: () => false,
        },
      );
      if (exceedsBudget) {
        await assert.rejects(run, /500 motion segments/);
        assert.equal(commands, 0);
      } else {
        await run;
        assert.equal(commands, 41);
      }
    }
  }
});

test("explicit pen commands gate motion and virtual pen changes; cancellation prevents lowering", async () => {
  const state = createStudioState({
    source: "pen_up\nforward 10\npen_down\nforward 10",
  });
  const calls = [];
  const pending = [];
  let cancelled = false;
  const robot = {
    connected: true,
    setPenDown(down, settings) {
      calls.push(["pen", down, settings]);
      return new Promise((resolve) => pending.push(resolve));
    },
    async moveCentimeters(distance) {
      calls.push(["move", distance]);
    },
  };
  const run = executeRobotProgram(robot, {
    state,
    penSettings,
    repaint() {},
    cancelled: () => cancelled,
  });
  assert.deepEqual(calls, [["pen", false, penSettings]]);
  assert.equal(state.getState().turtleState.penDown, true);
  assert.deepEqual(state.getState().turtleState.position, [0, 0]);
  cancelled = true;
  pending.shift()();
  await assert.rejects(run, /stopped/);
  assert.equal(calls.length, 1);
  assert.equal(state.getState().turtleState.penDown, true);
});

test("robot runs only lower the pen for an executed pen_down command", async () => {
  for (const source of [
    "forward 20",
    "if false [ pen_down ]\nforward 20",
    "pen_down\nforward 20\npen_up",
  ]) {
    const calls = [];
    const state = createStudioState();
    state.setSource(source);
    await executeRobotProgram(
      {
        connected: true,
        async setPenDown(down, settings) {
          calls.push(["pen", down, settings]);
        },
        async moveCentimeters(distance) {
          calls.push(["move", distance]);
        },
      },
      {
        state,
        penSettings,
        repaint() {},
        cancelled: () => false,
      },
    );
    assert.deepEqual(
      calls,
      source.startsWith("pen_down")
        ? [
            ["pen", true, penSettings],
            ["move", 2],
            ["pen", false, penSettings],
          ]
        : [["move", 2]],
    );
  }
});

test("uncalibrated physical runs never send a command", async () => {
  const state = createStudioState({ source: "forward 10" });
  await assert.rejects(
    executeRobotProgram({}, { state, repaint() {}, cancelled: () => false }),
    /calibration/,
  );
});

test("ordinary right commands reposition around the evaluated angle without chunking", async () => {
  for (const [angle, advance, retreat, hardwareTurnDegrees] of [
    [20, 12.14154985, -13.05845015, 20],
    [90, 10, -15.2, 91],
    [-90, 15.2, -10, -91],
    [120, 8.0966679, -17.1033321, 120],
    [-120, 17.1033321, -8.0966679, -120],
    [-270, 10, -15.2, -270],
    [0, 0, 0, 0],
  ]) {
    const state = createStudioState({ source: `right ${angle}` });
    const calls = [];
    await runRobotProgram(
      {
        connected: true,
        async setPenDown(down) {
          calls.push(["pen", down]);
        },
        async moveCentimeters(amount) {
          calls.push(["move", amount]);
        },
        async turnDegrees(amount) {
          calls.push(["turn", amount]);
        },
      },
      { state, repaint() {}, cancelled: () => false },
    );
    if (angle === 0) {
      assert.deepEqual(calls, []);
    } else {
      assert.deepEqual(
        calls.map(([kind]) => kind),
        ["pen", "move", "turn", "move"],
      );
      assert.deepEqual(calls[0], ["pen", false]);
      assert.ok(Math.abs(calls[1][1] - advance) < 1e-8);
      assert.deepEqual(calls[2], ["turn", hardwareTurnDegrees]);
      assert.ok(Math.abs(calls[3][1] - retreat) < 1e-8);
    }
    assert.deepEqual(state.getState().turtleState.position, [0, 0]);
    assert.equal(
      state.getState().turtleState.heading,
      ((angle % 360) + 360) % 360,
    );
    assert.equal(state.getState().turtleScene.items.length, 0);
  }
});

test("near-half turns use bounded direct translation and finish at the requested heading", async () => {
  for (const angle of [170, -170, 179.999, -179.999]) {
    const state = createStudioState({ source: `left ${-angle}` });
    const radians = (angle * Math.PI) / 180;
    const displacement = [
      -26 - (126 * Math.sin(radians) - 26 * Math.cos(radians)),
      126 - (126 * Math.cos(radians) + 26 * Math.sin(radians)),
    ];
    const calls = [];
    await runRobotProgram(
      {
        connected: true,
        async moveCentimeters(amount) {
          calls.push(["move", amount]);
        },
        async turnDegrees(amount) {
          calls.push(["turn", amount]);
        },
      },
      { state, repaint() {}, cancelled: () => false },
    );
    const firstMove = calls.findIndex(([kind]) => kind === "move");
    const lastMove = calls.findLastIndex(([kind]) => kind === "move");
    const steeringAngle =
      (Math.atan2(displacement[0], displacement[1]) * 180) / Math.PI;
    assert.equal(firstMove, 1);
    for (const [kind, amount] of calls.slice(0, firstMove)) {
      assert.equal(kind, "turn");
      assert.ok(Math.abs(amount - steeringAngle) < 1e-8);
    }
    const translation = calls.slice(firstMove, lastMove + 1);
    assert.equal(translation.length, 1);
    assert.ok(Math.abs(translation[0][1]) < 26);
    assert.ok(translation.every(([kind]) => kind === "move"));
    assert.ok(
      Math.abs(
        translation.reduce((total, [, amount]) => total + amount * 10, 0) -
          Math.hypot(...displacement),
      ) < 1e-8,
    );
    const finish = calls.slice(lastMove + 1);
    assert.ok(finish.length > 0);
    assert.ok(finish.every(([kind]) => kind === "turn"));
    assert.ok(
      Math.abs(
        finish.reduce((total, [, amount]) => total + amount, 0) -
          (angle - steeringAngle),
      ) < 1e-8,
    );
  }
});

test("robot acknowledgements gate whole virtual movements and subsequent commands", async () => {
  const state = createStudioState();
  state.setSource("forward 40\nright 20\nback 10");
  const pending = [];
  const calls = [];
  const robot = {
    connected: true,
    moveCentimeters: (amount) => {
      calls.push(["move", amount]);
      return new Promise((resolve) => pending.push(resolve));
    },
    turnDegrees: (amount) => {
      calls.push(["turn", amount]);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const run = runRobotProgram(robot, {
    state,
    repaint() {},
    cancelled: () => false,
  });
  await nextTurn();
  assert.deepEqual(calls, [["move", 4]]);
  assert.deepEqual(state.getState().turtleState.position, [0, 0]);
  pending.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.getState().turtleState.position, [0, 40]);
  assert.equal(state.getState().turtleScene.items.length, 1);
  for (let count = 0; pending.length > 0 && count < 500; count++) {
    pending.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await run;
  assert.deepEqual(
    calls.slice(0, 4).map(([kind]) => kind),
    ["move", "move", "turn", "move"],
  );
  assert.deepEqual(calls[0], ["move", 4]);
  assert.ok(Math.abs(calls[1][1] - 12.14154985) < 1e-8);
  assert.deepEqual(calls[2], ["turn", 20]);
  assert.ok(Math.abs(calls[3][1] + 13.05845015) < 1e-8);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1)[0], "move");
  assert.ok(Math.abs(calls.at(-1)[1] + 1) < 1e-10);
  assert.equal(state.getState().turtleState.heading, 20);
});

test("cancellation after acknowledgement prevents stale canvas updates", async () => {
  const state = createStudioState();
  state.setSource("forward 40");
  let resolveMovement;
  let cancelled = false;
  const robot = {
    connected: true,
    moveCentimeters: () =>
      new Promise((resolve) => {
        resolveMovement = resolve;
      }),
  };
  const run = runRobotProgram(robot, {
    state,
    repaint() {},
    cancelled: () => cancelled,
  });
  await nextTurn();
  cancelled = true;
  resolveMovement();
  await assert.rejects(run, /stopped/);
  assert.deepEqual(state.getState().turtleState.position, [0, 0]);
});

test("preflight rejects diagnostics, unsupported effects, and excessive travel before movement", async () => {
  for (const source of [
    "unknown_command",
    "forward 10\nclear_screen",
    "forward 20000",
    "set_position [10 0]",
    ":sides = 1\nright 5010 / :sides",
  ]) {
    const state = createStudioState();
    state.setSource(source);
    let movements = 0;
    await assert.rejects(
      runRobotProgram(
        {
          connected: true,
          async moveCentimeters() {
            movements++;
          },
          async turnDegrees() {
            movements++;
          },
        },
        { state, repaint() {}, cancelled: () => false },
      ),
    );
    assert.equal(movements, 0);
  }
});

test("calculated turns retain direction and complete rotations inside loops", async () => {
  const state = createStudioState();
  state.setSource(
    ":sides = 4\nrepeat 2 [ right 360 / :sides + 360\nleft 270 ]",
  );
  const angles = [];
  await runRobotProgram(
    {
      connected: true,
      async moveCentimeters() {},
      async turnDegrees(angle) {
        angles.push(angle);
      },
    },
    { state, repaint() {}, cancelled: () => false },
  );
  assert.deepEqual(angles, [367, 91, -270, 367, 91, -270]);
  assert.equal(state.getState().turtleState.heading, 0);
});

test("turn expressions execute once and observe changing procedure state", async () => {
  const state = createStudioState();
  state.setSource(`:turn_count = 0
define next_turn
  :turn_count = :turn_count + 1
  return :turn_count * 10
end
repeat 3 [ right next_turn ]
print :turn_count`);
  const angles = [];
  await runRobotProgram(
    {
      connected: true,
      async moveCentimeters() {},
      async turnDegrees(amount) {
        angles.push(amount);
      },
    },
    { state, repaint() {}, cancelled: () => false },
  );
  assert.ok(
    Math.abs(angles.reduce((total, angle) => total + angle, 0) - 60) < 1e-8,
  );
  assert.equal(state.getState().turtleState.heading, 60);
  assert.deepEqual(state.getState().output, ["3"]);
});

test("parenthesized signed turns preserve spans and avoid generated-name collisions", async () => {
  const state = createStudioState();
  state.setSource(`:r000 = 1
:r0000 = 2
:turn_amount = -450
repeat 2 [ (right :turn_amount) :turn_amount = :turn_amount + 540 ]
left -20`);
  const angles = [];
  const spans = [];
  await runRobotProgram(
    {
      connected: true,
      async moveCentimeters() {},
      async turnDegrees(amount) {
        angles.push(amount);
        spans.push(state.getState().currentInstructionSourceSpan);
      },
    },
    { state, repaint() {}, cancelled: () => false },
  );
  assert.deepEqual(angles, [-367, -91, 91, 20]);
  assert.equal(state.getState().turtleState.heading, 20);
  const lastInstruction = spans.findIndex((span) => span.start[0] === 5);
  assert.equal(lastInstruction, 3);
  assert.ok(
    spans.slice(0, lastInstruction).every((span) => span.start[0] === 4),
  );
  assert.ok(spans.slice(lastInstruction).every((span) => span.start[0] === 5));
});

test("invalid calculated turns retain learner diagnostics and never move", async () => {
  for (const source of ['right "hello"', "right 360 / 0"]) {
    const state = createStudioState({ source });
    let movements = 0;
    await assert.rejects(
      runRobotProgram(
        {
          connected: true,
          async turnDegrees() {
            movements++;
          },
        },
        { state, repaint() {}, cancelled: () => false },
      ),
    );
    assert.equal(movements, 0);
    assert.ok(state.getState().diagnostics.length > 0);
    assert.ok(
      state
        .getState()
        .diagnostics.every(
          (diagnostic) =>
            diagnostic.source_span.start[0] === 1 &&
            diagnostic.source_span.end[0] === 1,
        ),
    );
  }
});

test("shared run controls cancel hardware and keep reset immune to late acknowledgements", async () => {
  const state = createStudioState();
  state.setSource("forward 40");
  let acknowledge;
  let stops = 0;
  const robot = {
    connected: true,
    deviceName: "test",
    async setPenDown() {},
    async stop() {
      stops++;
    },
    moveCentimeters: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  };
  const controls = createRobotControlPanelController(async () => robot);
  await controls.connect();
  confirmPen(controls);
  const controller = createRobotRunController(
    createRunController(state),
    controls,
    () => {},
  );
  const run = controller.runOnRobot();
  await nextTurn();
  assert.equal(state.getState().runStatus, "running");
  controller.run();
  controller.step();
  await controller.runOnRobot();
  assert.equal(controller.deliverKey("space"), false);
  assert.equal(controller.deliverClick(), false);
  controller.stop();
  assert.equal(state.getState().runStatus, "stopped");
  controller.reset();
  acknowledge();
  await run;
  assert.equal(state.getState().runStatus, "idle");
  assert.deepEqual(state.getState().turtleState.position, [0, 0]);
  assert.ok(stops >= 1);
});

test("robot completion and failures settle shared run state and always stop motors", async () => {
  for (const fail of [false, true]) {
    const state = createStudioState();
    state.setSource("forward 10\nprint 42");
    let stops = 0;
    const controls = createRobotControlPanelController(async () => ({
      connected: true,
      deviceName: "test",
      async setPenDown() {},
      async stop() {
        stops++;
      },
      async moveCentimeters() {
        if (fail) throw new Error("No acknowledgement");
      },
    }));
    await controls.connect();
    confirmPen(controls);
    const controller = createRobotRunController(
      createRunController(state),
      controls,
      () => {},
    );
    await controller.runOnRobot();
    assert.equal(state.getState().runStatus, fail ? "stopped" : "done");
    assert.deepEqual(state.getState().output, fail ? [] : ["42"]);
    assert.equal(stops, 1);
    assert.equal(state.getState().currentInstructionSourceSpan, null);
    if (fail)
      assert.match(state.getState().notice.message, /No acknowledgement/);
  }
});

test("procedures, distance expressions, and virtual pen settings use the same trace", async () => {
  const state = createStudioState();
  state.setSource(
    'define travel :distance\npen_up\nforward :distance * 2\nleft 20\npen_down\nback 10\nend\nset_color "red"\nset_width 2\nset_background "white"\nhide_turtle\ntravel 10\nshow_turtle',
  );
  const calls = [];
  await runRobotProgram(
    {
      connected: true,
      async setPenDown(down, settings) {
        calls.push(["pen", down, settings]);
      },
      async moveCentimeters(amount) {
        calls.push(["move", amount]);
      },
      async turnDegrees(amount) {
        calls.push(["turn", amount]);
      },
    },
    { state, repaint() {}, cancelled: () => false },
  );
  assert.deepEqual(calls.slice(0, 3), [
    ["pen", false, penSettings],
    ["move", 2],
    ["pen", false, penSettings],
  ]);
  assert.equal(calls[3][0], "move");
  assert.ok(Math.abs(calls[3][1] - 13.05845015) < 1e-8);
  assert.deepEqual(calls[4], ["turn", -20]);
  assert.equal(calls[5][0], "move");
  assert.ok(Math.abs(calls[5][1] + 12.14154985) < 1e-8);
  assert.deepEqual(calls.at(-2), ["pen", true, penSettings]);
  assert.equal(calls.at(-1)[0], "move");
  assert.ok(Math.abs(calls.at(-1)[1] + 1) < 1e-10);
  assert.equal(state.getState().turtleScene.items.length, 1);
  assert.equal(state.getState().turtleState.heading, 340);
});

test("disconnect prevents pending motion from updating the canvas", async () => {
  const state = createStudioState();
  state.setSource("forward 40");
  let acknowledge;
  const robot = {
    connected: true,
    moveCentimeters: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  };
  const run = runRobotProgram(robot, {
    state,
    repaint() {},
    cancelled: () => false,
  });
  await nextTurn();
  robot.connected = false;
  acknowledge();
  await assert.rejects(run, /disconnected/);
  assert.deepEqual(state.getState().turtleState.position, [0, 0]);
});

test("runtime errors and unsupported trace effects are preflighted before movement", async () => {
  for (const source of ["forward 10\nprint 1 / 0", "forward 10\nwait 1"]) {
    const state = createStudioState();
    state.setSource(source);
    let movements = 0;
    await assert.rejects(
      runRobotProgram(
        {
          connected: true,
          async moveCentimeters() {
            movements++;
          },
        },
        { state, repaint() {}, cancelled: () => false },
      ),
    );
    assert.equal(movements, 0);
  }
});
