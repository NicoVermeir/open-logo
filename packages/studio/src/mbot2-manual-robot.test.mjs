import assert from "node:assert/strict";
import test from "node:test";
import { createMBot2ManualRobot } from "@openlogo/studio";
import { robotPenAngle } from "../dist/mbot2-manual-robot.js";

test("pen calibration uses absolute targets in either servo direction without extrapolation", () => {
  const settings = {
    downAngle: 60,
    raisedAngle: 120,
    measuredLiftMillimeters: 10,
    liftMillimeters: 5,
    settleMilliseconds: 500,
  };
  assert.equal(robotPenAngle(true, settings), 60);
  assert.equal(robotPenAngle(false, settings), 90);
  assert.equal(robotPenAngle(false, settings), 90);
  assert.equal(robotPenAngle(false, { ...settings, liftMillimeters: 10 }), 120);
  assert.equal(
    robotPenAngle(false, { ...settings, downAngle: 120, raisedAngle: 60 }),
    90,
  );
  for (const invalid of [
    { downAngle: NaN },
    { raisedAngle: Infinity },
    { downAngle: -1 },
    { downAngle: 181 },
    { raisedAngle: -1 },
    { raisedAngle: 181 },
    { raisedAngle: 60 },
    { measuredLiftMillimeters: NaN },
    { liftMillimeters: NaN },
    { measuredLiftMillimeters: 0 },
    { liftMillimeters: 0 },
    { liftMillimeters: 11 },
    { settleMilliseconds: 99 },
    { settleMilliseconds: 2001 },
  ]) {
    assert.throws(
      () => robotPenAngle(false, { ...settings, ...invalid }),
      /Calibrate/,
    );
  }
});

function createTransport() {
  const expressions = [];
  let connected = true;
  return {
    expressions,
    transport: {
      deviceName: "mBot2 classroom",
      get connected() {
        return connected;
      },
      run: assert.fail,
      async evaluate(expression) {
        expressions.push(expression);
        return expression.startsWith("(mbot2.")
          ? 1
          : expression.includes("battery")
            ? 87
            : 24.5;
      },
      disconnect() {
        connected = false;
      },
    },
  };
}

test("pen commands acknowledge then settle, use absolute socket-3 angles, and reject invalid settings", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = createTransport();
  let acknowledge;
  fake.transport.evaluate = (expression) => {
    fake.expressions.push(expression);
    return new Promise((resolve) => {
      acknowledge = resolve;
    });
  };
  const robot = createMBot2ManualRobot(fake.transport);
  const settings = {
    downAngle: 90,
    raisedAngle: 115,
    measuredLiftMillimeters: NaN,
    liftMillimeters: NaN,
    settleMilliseconds: 200,
  };
  assert.equal(robotPenAngle(true, settings), 90);
  assert.equal(robotPenAngle(false, settings), 115);
  let finished = false;
  const action = robot.setPenDown(false, settings).then(() => {
    finished = true;
  });
  context.mock.timers.tick(200);
  assert.equal(finished, false);
  acknowledge(1);
  await Promise.resolve();
  context.mock.timers.tick(199);
  assert.equal(finished, false);
  context.mock.timers.tick(1);
  await action;
  assert.equal(finished, true);
  assert.deepEqual(fake.expressions, ["(mbot2.servo_set(115,3),1)[1]"]);
  const lowered = robot.setPenDown(true, settings);
  acknowledge(1);
  await Promise.resolve();
  context.mock.timers.tick(200);
  await lowered;
  assert.equal(fake.expressions[1], "(mbot2.servo_set(90,3),1)[1]");
  await assert.rejects(
    robot.setPenDown(false, { ...settings, liftMillimeters: 11 }),
    /Calibrate/,
  );
  for (const [angle, settle] of [
    [NaN, 500],
    [-1, 500],
    [181, 500],
    [60.5, 500],
    [60, NaN],
    [60, 99],
    [60, 2001],
  ]) {
    await assert.rejects(robot.setPenAngle(angle, settle), /safe integer/);
  }
  assert.equal(fake.expressions.length, 2);
  const failed = robot.setPenDown(true, settings);
  acknowledge(undefined);
  await assert.rejects(failed, /not acknowledged/);
  const disconnected = robot.setPenAngle(120, 500);
  acknowledge(1);
  await Promise.resolve();
  fake.transport.disconnect();
  context.mock.timers.tick(500);
  await assert.rejects(disconnected, /disconnected/);
  await assert.rejects(robot.setPenAngle(120, 500), /disconnected/);
});

test("maps every direction to an acknowledged finite robot-side pulse", async () => {
  const fake = createTransport();
  const robot = createMBot2ManualRobot(fake.transport);

  await robot.forward(50, 0.5);
  await robot.backward(70, 1.2);
  await robot.turnLeft(40, 0.3);
  await robot.turnRight(60, 2);

  assert.deepEqual(fake.expressions, [
    "(mbot2.forward(50,0.5),1)[1]",
    "(mbot2.backward(70,1.2),1)[1]",
    "(mbot2.turn_left(40,0.3),1)[1]",
    "(mbot2.turn_right(60,2),1)[1]",
  ]);
});

test("clamps unsafe movement inputs and maps emergency stop", async () => {
  const fake = createTransport();
  const robot = createMBot2ManualRobot(fake.transport);

  await robot.forward(-20, 0);
  await robot.backward(500, 12);
  await robot.turnLeft(Number.NaN, Number.NaN);
  await robot.stop();

  assert.deepEqual(fake.expressions, [
    "(mbot2.forward(10,0.1),1)[1]",
    "(mbot2.backward(100,2),1)[1]",
    "(mbot2.turn_left(10,0.1),1)[1]",
    "(mbot2.EM_stop(),1)[1]",
  ]);
});

test("manual movement and Emergency Stop wait for robot acknowledgement", async () => {
  const fake = createTransport();
  let acknowledge;
  fake.transport.evaluate = (expression) => {
    fake.expressions.push(expression);
    return new Promise((resolve) => {
      acknowledge = resolve;
    });
  };
  const robot = createMBot2ManualRobot(fake.transport);
  let finished = false;
  const movement = robot.forward(50, 0.5).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  acknowledge(1);
  await movement;
  assert.equal(finished, true);

  const rejectedMovement = robot.forward(50, 0.5);
  acknowledge(undefined);
  await assert.rejects(rejectedMovement, /Robot movement was not acknowledged/);

  const stop = robot.stop();
  acknowledge(undefined);
  await assert.rejects(stop, /Emergency Stop was not acknowledged/);
});

test("reads basic status and delegates connection state", async () => {
  const fake = createTransport();
  const robot = createMBot2ManualRobot(fake.transport);

  assert.equal(robot.deviceName, "mBot2 classroom");
  assert.equal(robot.connected, true);
  assert.equal(await robot.battery(), 87);
  assert.equal(await robot.distance(), 24.5);
  assert.deepEqual(fake.expressions, [
    "cyberpi.get_battery()",
    "cyberpi.ultrasonic2.get(1)",
  ]);
  robot.disconnect();
  assert.equal(robot.connected, false);
});

test("returns no reading for non-numeric sensor responses", async () => {
  const fake = createTransport();
  fake.transport.evaluate = async () => "unknown";
  const robot = createMBot2ManualRobot(fake.transport);

  assert.equal(await robot.battery(), undefined);
});

test("precise movement waits for a robot response and rejects missing acknowledgements", async () => {
  const fake = createTransport();
  const timeouts = [];
  let acknowledge;
  fake.transport.evaluate = (expression, timeoutMilliseconds) => {
    fake.expressions.push(expression);
    timeouts.push(timeoutMilliseconds);
    return new Promise((resolve) => {
      acknowledge = resolve;
    });
  };
  const robot = createMBot2ManualRobot(fake.transport);
  let finished = false;
  const movement = robot.moveCentimeters(-4).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  acknowledge(1);
  await movement;
  assert.equal(finished, true);
  const turn = robot.turnDegrees(-20);
  acknowledge(undefined);
  await assert.rejects(turn, /not acknowledged/);
  assert.deepEqual(fake.expressions, [
    "(mbot2.straight(-4,speed=30),1)[1]",
    "(mbot2.turn(-20,speed=30),1)[1]",
  ]);
  assert.deepEqual(timeouts, [5_000, 5_000]);
});

test("precise movement sends one full request per phase with scaled timeouts and bounded inputs", async () => {
  const fake = createTransport();
  const timeouts = [];
  fake.transport.evaluate = async (expression, timeoutMilliseconds) => {
    fake.expressions.push(expression);
    timeouts.push(timeoutMilliseconds);
    return 1;
  };
  const robot = createMBot2ManualRobot(fake.transport);

  await robot.moveCentimeters(10);
  await robot.moveCentimeters(-15.2);
  await robot.turnDegrees(91);
  await robot.turnDegrees(-367);
  for (const direction of [1, -1]) {
    await robot.moveCentimeters(direction * 1_000);
    await robot.turnDegrees(direction * 5_000);
  }
  for (const amount of [0, -0]) {
    await robot.moveCentimeters(amount);
    await robot.turnDegrees(amount);
  }
  for (const amount of [Number.NaN, Infinity, -Infinity]) {
    await assert.rejects(robot.moveCentimeters(amount), /bounded/);
    await assert.rejects(robot.turnDegrees(amount), /bounded/);
  }
  for (const direction of [1, -1]) {
    await assert.rejects(robot.moveCentimeters(direction * 1_000.1), /bounded/);
    await assert.rejects(robot.turnDegrees(direction * 5_000.1), /bounded/);
  }

  assert.deepEqual(fake.expressions, [
    "(mbot2.straight(10,speed=30),1)[1]",
    "(mbot2.straight(-15.2,speed=30),1)[1]",
    "(mbot2.turn(91,speed=30),1)[1]",
    "(mbot2.turn(-367,speed=30),1)[1]",
    "(mbot2.straight(1000,speed=30),1)[1]",
    "(mbot2.turn(5000,speed=30),1)[1]",
    "(mbot2.straight(-1000,speed=30),1)[1]",
    "(mbot2.turn(-5000,speed=30),1)[1]",
  ]);
  assert.deepEqual(
    timeouts,
    [8_000, 11_000, 13_000, 40_000, 503_000, 503_000, 503_000, 503_000],
  );
});

test("precise movement checks cancellation before dispatch and after the full motion acknowledgement", async () => {
  const fake = createTransport();
  let cancelled = false;
  fake.transport.evaluate = async (expression) => {
    fake.expressions.push(expression);
    cancelled = true;
    return 1;
  };
  const robot = createMBot2ManualRobot(fake.transport);

  await assert.rejects(
    robot.moveCentimeters(6, () => true),
    /stopped/,
  );
  await assert.rejects(
    robot.turnDegrees(90, () => true),
    /stopped/,
  );
  assert.deepEqual(fake.expressions, []);
  await assert.rejects(
    robot.moveCentimeters(6, () => cancelled),
    /stopped/,
  );
  cancelled = false;
  await assert.rejects(
    robot.turnDegrees(90, () => cancelled),
    /stopped/,
  );
  assert.deepEqual(fake.expressions, [
    "(mbot2.straight(6,speed=30),1)[1]",
    "(mbot2.turn(90,speed=30),1)[1]",
  ]);
});
