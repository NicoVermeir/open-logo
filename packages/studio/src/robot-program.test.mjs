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

test("left offset compensation returns the pen tip to the Logo vertex without drawing repositioning", async () => {
  for (const initialHeading of [0, 37, 211]) {
    for (const angle of [90, -90, 180, -270, 450, -450, 360, -360, 0, 20]) {
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
            heading += amount;
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
      state: createStudioState({ source: "pen_down\nright 90" }),
      penSettings,
      repaint() {},
      cancelled: () => false,
    },
  );
  for (const disconnect of [false, true]) {
    for (let stopAt = 1; stopAt <= baseline.length; stopAt++) {
      const state = createStudioState({ source: "pen_down\nright 90" });
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

test("right commands advance 105 mm, turn the evaluated angle, then reverse 138 mm without chunking", async () => {
  for (const angle of [20, 90, -90, 180, -270, 450, -450, 360, -360, 0]) {
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
    assert.deepEqual(
      calls,
      angle === 0
        ? []
        : [
            ["pen", false],
            ["move", 10.5],
            ["turn", angle],
            ["move", -13.8],
          ],
    );
    assert.deepEqual(state.getState().turtleState.position, [0, 0]);
    assert.equal(state.getState().turtleState.heading, ((angle % 360) + 360) % 360);
    assert.equal(state.getState().turtleScene.items.length, 0);
  }
});

test("left turns steer directly into offset translation and finish at the requested heading", async () => {
  for (const [source, angle, displacement] of [
    ["left -90", 90, [-152, 100]],
    ["left 90", -90, [100, 152]],
  ]) {
    const state = createStudioState({ source });
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
  assert.deepEqual(calls.slice(0, 4), [
    ["move", 4],
    ["move", 10.5],
    ["turn", 20],
    ["move", -13.8],
  ]);
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
  assert.equal(angles[0], 450);
  assert.equal(angles.length, 6);
  assert.ok(
    Math.abs(angles.reduce((total, angle) => total + angle, 0) - 360) < 1e-8,
  );
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
  assert.equal(angles[0], -450);
  assert.ok(
    Math.abs(angles.reduce((total, angle) => total + angle, 0) + 340) < 1e-8,
  );
  assert.equal(state.getState().turtleState.heading, 20);
  const lastInstruction = spans.findIndex((span) => span.start[0] === 5);
  assert.equal(lastInstruction, 2);
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
  assert.equal(calls[3][0], "turn");
  assert.ok(calls[3][1] > 0);
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
