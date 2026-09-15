import assert from "node:assert/strict";
import test from "node:test";
import { createRobotControlPanelController } from "@openlogo/studio";

function createRobot() {
  const calls = [];
  return {
    calls,
    robot: {
      deviceName: "mBot2",
      connected: true,
      setPenDown: async (...values) => calls.push(["pen", ...values]),
      setPenAngle: async (...values) => calls.push(["angle", ...values]),
      forward: async (...values) => calls.push(["forward", ...values]),
      backward: async (...values) => calls.push(["backward", ...values]),
      turnLeft: async (...values) => calls.push(["left", ...values]),
      turnRight: async (...values) => calls.push(["right", ...values]),
      stop: async () => calls.push(["stop"]),
      battery: async () => 90,
      distance: async () => 12,
      disconnect: () => calls.push(["disconnect"]),
    },
  };
}

test("manual pen and program share frozen calibration and reconnect requires confirmation", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  const settings = {
    downAngle: 60,
    raisedAngle: 120,
    measuredLiftMillimeters: 10,
    liftMillimeters: 5,
    settleMilliseconds: 500,
  };
  await controller.connect();
  assert.deepEqual(controller.getView().penSettings, {
    downAngle: 90,
    raisedAngle: 115,
    measuredLiftMillimeters: NaN,
    liftMillimeters: NaN,
    settleMilliseconds: 200,
  });
  controller.confirmPenSettings();
  assert.equal(controller.getView().penConfirmed, true);
  assert.deepEqual(fake.calls, []);
  controller.setPenSettings({ liftMillimeters: 5 });
  controller.confirmPenSettings();
  assert.equal(controller.getView().penConfirmed, false);
  await controller.setPenDown(false);
  assert.deepEqual(fake.calls, []);
  controller.setPenSettings(settings);
  await controller.testPenAngle("downAngle");
  controller.confirmPenSettings();
  await controller.setPenDown(false);
  assert.equal(controller.getView().penState, "up");
  await controller.setPenDown(true);
  assert.equal(controller.getView().penState, "down");
  await controller.runProgram(async (_robot, _cancelled, snapshot) => {
    assert.deepEqual(snapshot, settings);
    assert.equal(Object.isFrozen(snapshot), true);
    controller.setPenSettings({ liftMillimeters: 9 });
    await controller.setPenDown(false);
    assert.equal(controller.getView().penSettings.liftMillimeters, 5);
  });
  assert.deepEqual(fake.calls, [
    ["angle", 60, 500],
    ["pen", false, settings],
    ["pen", true, settings],
    ["stop"],
    ["pen", false, settings],
  ]);
  controller.disconnect();
  await controller.connect();
  assert.equal(controller.getView().penConfirmed, false);
  assert.equal(controller.getView().penState, "unknown");
});

test("reports unsupported browsers", () => {
  const controller = createRobotControlPanelController(undefined);
  assert.equal(controller.getView().status, "unsupported");
});

test("program owns the connection until acknowledgement settles, with emergency cancellation", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  let finish;
  let isCancelled;
  const running = controller.runProgram(async (robot, cancelled) => {
    assert.equal(robot, fake.robot);
    isCancelled = cancelled;
    await new Promise((resolve) => {
      finish = resolve;
    });
  });
  await controller.move("forward");
  await controller.runProgram(async () => assert.fail("overlapping program"));
  assert.equal(controller.getView().busy, true);
  assert.equal(isCancelled(), false);
  await controller.stop();
  assert.equal(isCancelled(), true);
  assert.deepEqual(fake.calls, [["stop"]]);
  finish();
  await running;
  assert.equal(controller.getView().busy, false);
  assert.deepEqual(fake.calls, [["stop"], ["stop"]]);
});

test("virtual execution locks manual and program actions", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(
    async () => fake.robot,
    () => true,
  );
  await controller.connect();
  await controller.move("forward");
  await controller.refreshStatus();
  await controller.runProgram(async () =>
    assert.fail("virtual execution active"),
  );
  assert.deepEqual(fake.calls, []);
});

test("connects, drives with current settings, and refreshes status", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  const views = [];
  const unsubscribe = controller.subscribe((view) => views.push(view));
  controller.setSpeed(75);
  controller.setDuration(1.5);

  await controller.connect();
  await controller.move("forward");
  await controller.move("backward");
  await controller.move("left");
  await controller.move("right");
  await controller.stop();
  await controller.refreshStatus();

  assert.equal(controller.getView().status, "connected");
  assert.equal(controller.getView().battery, 90);
  assert.equal(controller.getView().distance, 12);
  assert.deepEqual(fake.calls, [
    ["forward", 75, 1.5],
    ["backward", 75, 1.5],
    ["left", 75, 1.5],
    ["right", 75, 1.5],
    ["stop"],
  ]);
  assert.ok(views.length > 5);
  controller.disconnect();
  assert.equal(controller.getView().status, "disconnected");
  unsubscribe();
  controller.dispose();
});

test("surfaces connection errors", async () => {
  const controller = createRobotControlPanelController(async () => {
    throw new Error("Chooser cancelled.");
  });
  await controller.connect();
  assert.equal(controller.getView().status, "error");
  assert.equal(controller.getView().statusMessage, "Chooser cancelled.");
});

test("surfaces non-Error connection and command failures", async () => {
  const connectionController = createRobotControlPanelController(async () => {
    throw "cancelled";
  });
  await connectionController.connect();
  assert.equal(
    connectionController.getView().statusMessage,
    "Could not connect.",
  );

  const fake = createRobot();
  fake.robot.forward = async () => {
    throw "failed";
  };
  const commandController = createRobotControlPanelController(
    async () => fake.robot,
  );
  await commandController.connect();
  await commandController.move("forward");
  assert.equal(commandController.getView().status, "error");
  assert.equal(
    commandController.getView().statusMessage,
    "Robot command failed.",
  );

  fake.robot.backward = async () => {
    throw new Error("Motor unavailable.");
  };
  await commandController.move("backward");
  assert.equal(commandController.getView().statusMessage, "Motor unavailable.");
});

test("emergency stop runs during a busy status refresh", async () => {
  let resolveBattery;
  const fake = createRobot();
  fake.robot.battery = () =>
    new Promise((resolve) => {
      resolveBattery = resolve;
    });
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  const refresh = controller.refreshStatus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getView().busy, true);

  await controller.stop();
  assert.deepEqual(fake.calls, [["stop"]]);
  assert.equal(controller.getView().busy, true);

  resolveBattery(90);
  await refresh;
  assert.equal(controller.getView().busy, false);
});

test("ignores unavailable, concurrent, and disposed actions", async () => {
  const unsupported = createRobotControlPanelController(undefined);
  await unsupported.connect();
  await unsupported.move("forward");
  await unsupported.stop();
  unsupported.disconnect();
  unsupported.dispose();

  let resolveConnection;
  const fake = createRobot();
  const controller = createRobotControlPanelController(
    () =>
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
  );
  const connection = controller.connect();
  await controller.connect();
  resolveConnection(fake.robot);
  await connection;

  let resolveForward;
  fake.robot.forward = () =>
    new Promise((resolve) => {
      resolveForward = resolve;
    });
  const movement = controller.move("forward");
  await controller.move("backward");
  resolveForward();
  await movement;

  controller.dispose();
  await controller.connect();
  assert.deepEqual(fake.calls, [["disconnect"]]);
});
