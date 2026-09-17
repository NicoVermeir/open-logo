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

test("play button requires calibration and a release, ignores holds, and rearms after idle", async () => {
  const fake = createRobot();
  let pressed = true;
  let reads = 0;
  let runs = 0;
  let enabled = true;
  let locked = false;
  fake.robot.isPlayButtonPressed = async () => {
    reads++;
    return pressed;
  };
  const controller = createRobotControlPanelController(
    async () => fake.robot,
    () => locked,
  );
  const poll = () =>
    controller.pollPlayButton(
      () => {
        runs++;
      },
      () => enabled,
    );
  await poll();
  await controller.connect();
  await poll();
  assert.equal(reads, 0);
  controller.confirmPenSettings();
  await poll();
  assert.equal(runs, 0);
  pressed = false;
  await poll();
  pressed = true;
  await poll();
  await poll();
  assert.equal(runs, 1);
  for (const block of ["disabled", "locked", "disconnected"]) {
    pressed = false;
    await poll();
    const before = reads;
    enabled = block !== "disabled";
    locked = block === "locked";
    fake.robot.connected = block !== "disconnected";
    pressed = true;
    await poll();
    assert.equal(reads, before);
    enabled = true;
    locked = false;
    fake.robot.connected = true;
    await poll();
    assert.equal(runs, 1);
  }
  pressed = false;
  await poll();
  pressed = true;
  await poll();
  assert.equal(runs, 2);
  await controller.dispose();
  const before = reads;
  await poll();
  assert.equal(reads, before);
});

test("play button skips overlapping polls and discards stale reads and errors", async () => {
  const fake = createRobot();
  let pressed = false;
  let runs = 0;
  let enabled = true;
  fake.robot.isPlayButtonPressed = async () => pressed;
  const controller = createRobotControlPanelController(async () => fake.robot);
  const poll = () =>
    controller.pollPlayButton(
      () => {
        runs++;
      },
      () => enabled,
    );
  await controller.connect();
  controller.confirmPenSettings();
  for (const interruption of [
    "stop",
    "disconnect",
    "connection-loss",
    "disabled",
    "reset",
    "error",
  ]) {
    await poll();
    let resolveRead;
    let rejectRead;
    let reads = 0;
    fake.robot.isPlayButtonPressed = () => {
      reads++;
      return new Promise((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
    };
    const pending = poll();
    await poll();
    assert.equal(reads, 1);
    if (interruption === "stop") await controller.stop();
    if (interruption === "disconnect") {
      await controller.disconnect();
      await controller.connect();
      controller.confirmPenSettings();
    }
    if (interruption === "disabled") enabled = false;
    if (interruption === "reset") controller.resetPlayButton();
    if (interruption === "connection-loss") {
      fake.robot.connected = false;
    }
    if (interruption === "error") rejectRead(new Error("button unavailable"));
    else resolveRead(true);
    await pending;
    assert.equal(runs, 0);
    assert.equal(controller.getView().status, "connected");
    assert.equal(controller.getView().busy, false);
    enabled = true;
    fake.robot.connected = true;
    pressed = true;
    fake.robot.isPlayButtonPressed = async () => pressed;
    await poll();
    assert.equal(runs, 0);
    pressed = false;
  }
  await poll();
  pressed = true;
  await poll();
  assert.equal(runs, 1);
  pressed = false;
  await poll();
  let resolveRead;
  fake.robot.isPlayButtonPressed = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const pending = poll();
  await controller.dispose();
  resolveRead(true);
  await pending;
  assert.equal(runs, 1);
});

test("play button does not read during robot actions or on unsupported adapters", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  const enabled = () => true;
  await controller.connect();
  controller.confirmPenSettings();
  await controller.pollPlayButton(assert.fail, enabled);
  await controller.showStatus("Ready");
  fake.robot.showStatus = async (text) => fake.calls.push(["screen", text]);
  await controller.showStatus("Ready");
  assert.deepEqual(fake.calls, [["screen", "Ready"]]);
  fake.robot.isPlayButtonPressed = assert.fail;
  let finishAction;
  const action = controller.runProgram(
    () =>
      new Promise((resolve) => {
        finishAction = resolve;
      }),
  );
  await controller.pollPlayButton(assert.fail, enabled);
  finishAction();
  await action;
});

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
  await controller.disconnect();
  await controller.connect();
  assert.equal(controller.getView().penConfirmed, false);
  assert.equal(controller.getView().penState, "unknown");
});

test("reports unsupported browsers", () => {
  const controller = createRobotControlPanelController(undefined);
  assert.equal(controller.getView().status, "unsupported");
});

test("disconnect invalidates a pending connection", async () => {
  const fake = createRobot();
  const replacement = createRobot();
  let connectorCalls = 0;
  let resolveConnection;
  const controller = createRobotControlPanelController(() => {
    connectorCalls++;
    if (connectorCalls === 1)
      return new Promise((resolve) => {
        resolveConnection = resolve;
      });
    return Promise.resolve(replacement.robot);
  });

  const connection = controller.connect();
  await controller.disconnect();
  await controller.connect();
  assert.equal(connectorCalls, 1);
  resolveConnection(fake.robot);
  await connection;
  await controller.connect();

  assert.equal(connectorCalls, 2);
  assert.equal(controller.getView().status, "connected");
  assert.equal(controller.getView().busy, false);
  assert.deepEqual(fake.calls, [["disconnect"]]);
});

test("disconnect invalidates pending status readings", async () => {
  const fake = createRobot();
  let resolveBattery;
  let resolveDistance;
  fake.robot.battery = () =>
    new Promise((resolve) => {
      resolveBattery = resolve;
    });
  fake.robot.distance = () =>
    new Promise((resolve) => {
      resolveDistance = resolve;
    });
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  const refresh = controller.refreshStatus();
  controller.disconnect();
  resolveBattery(42);
  resolveDistance(7);
  await refresh;

  assert.equal(controller.getView().status, "disconnected");
  assert.equal(controller.getView().battery, undefined);
  assert.equal(controller.getView().distance, undefined);
});

test("a rejected connection cannot overwrite a later disconnect", async () => {
  let rejectConnection;
  const controller = createRobotControlPanelController(
    () =>
      new Promise((_resolve, reject) => {
        rejectConnection = reject;
      }),
  );
  const connecting = controller.connect();
  await controller.disconnect();
  rejectConnection(new Error("stale connection failure"));
  await connecting;
  assert.equal(controller.getView().status, "disconnected");
  assert.equal(controller.getView().statusMessage, "Robot disconnected.");
  assert.equal(controller.getView().busy, false);
});

test("a rejected stale status reading cannot overwrite disconnect", async () => {
  const fake = createRobot();
  let rejectBattery;
  fake.robot.battery = () =>
    new Promise((_resolve, reject) => {
      rejectBattery = reject;
    });
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  const refresh = controller.refreshStatus();
  controller.disconnect();
  rejectBattery(new Error("stale telemetry failure"));
  await assert.rejects(refresh, /stale telemetry failure/);

  assert.equal(controller.getView().status, "disconnected");
  assert.equal(controller.getView().statusMessage, "Robot disconnected.");
  assert.equal(controller.getView().busy, false);
});

test("disconnect stops, raises a confirmed pen, then disconnects", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  controller.confirmPenSettings();

  await controller.disconnect();

  assert.deepEqual(fake.calls, [
    ["stop"],
    [
      "pen",
      false,
      {
        downAngle: 90,
        raisedAngle: 115,
        measuredLiftMillimeters: NaN,
        liftMillimeters: NaN,
        settleMilliseconds: 200,
      },
    ],
    ["disconnect"],
  ]);
});

test("disconnect remains pending through cleanup and reports cleanup failure", async () => {
  const fake = createRobot();
  let rejectStop;
  fake.robot.stop = () =>
    new Promise((_resolve, reject) => {
      rejectStop = reject;
    });
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  controller.confirmPenSettings();

  const disconnect = controller.disconnect();
  assert.equal(controller.getView().busy, true);
  assert.notEqual(controller.getView().status, "disconnected");
  rejectStop(new Error("Stop acknowledgement failed"));

  await assert.rejects(disconnect, /Stop acknowledgement failed/);
  assert.deepEqual(fake.calls, [
    [
      "pen",
      false,
      {
        downAngle: 90,
        raisedAngle: 115,
        measuredLiftMillimeters: NaN,
        liftMillimeters: NaN,
        settleMilliseconds: 200,
      },
    ],
    ["disconnect"],
  ]);
  assert.equal(controller.getView().status, "error");
  assert.equal(controller.getView().busy, false);
});

test("disconnect retains ownership, permits emergency Stop, and blocks reconnect until cleanup settles", async () => {
  const fake = createRobot();
  const originalStop = fake.robot.stop;
  let resolveCleanupStop;
  let stopCount = 0;
  fake.robot.stop = () => {
    stopCount += 1;
    if (stopCount > 1) return originalStop();
    return new Promise((resolve) => {
      resolveCleanupStop = resolve;
    });
  };
  let connectionCount = 0;
  const controller = createRobotControlPanelController(async () => {
    connectionCount += 1;
    return fake.robot;
  });
  await controller.connect();

  const disconnect = controller.disconnect();
  assert.equal(controller.getView().robotOwned, true);
  await controller.connect();
  assert.equal(connectionCount, 1);
  await controller.stop();
  assert.deepEqual(fake.calls, [["stop"]]);

  resolveCleanupStop();
  await disconnect;
  assert.equal(controller.getView().robotOwned, false);
  assert.equal(controller.getView().status, "disconnected");
  assert.deepEqual(fake.calls, [["stop"], ["disconnect"]]);
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
  await controller.runProgram(assert.fail);
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

test("a stale program cannot publish or clear a newer program's cancellation", async () => {
  const first = createRobot();
  const second = createRobot();
  const robots = [first.robot, second.robot];
  first.robot.disconnect = () => {
    first.robot.connected = false;
    first.calls.push(["disconnect"]);
  };
  const controller = createRobotControlPanelController(async () =>
    robots.shift(),
  );
  await controller.connect();

  let rejectFirstProgram;
  const firstRun = controller.runProgram(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirstProgram = reject;
      }),
  );
  await controller.disconnect();
  await controller.connect();

  let secondCancelled;
  let finishSecondProgram;
  const secondRun = controller.runProgram(async (_robot, cancelled) => {
    secondCancelled = cancelled;
    await new Promise((resolve) => {
      finishSecondProgram = resolve;
    });
  });
  rejectFirstProgram(new Error("stale program failure"));
  await assert.rejects(firstRun, /stale program failure/);

  assert.equal(controller.getView().status, "connected");
  assert.equal(secondCancelled(), false);
  await controller.stop();
  assert.equal(secondCancelled(), true);
  finishSecondProgram();
  await secondRun;
});

test("program rejects when mandatory safety cleanup fails", async () => {
  const fake = createRobot();
  fake.robot.stop = async () => {
    throw new Error("Stop acknowledgement failed");
  };
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  await assert.rejects(
    controller.runProgram(async () => {}),
    /Stop acknowledgement failed/,
  );
  assert.equal(controller.getView().busy, false);
});

test("a rejected program preserves an owned robot connection", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  await assert.rejects(
    controller.runProgram(async () => {
      throw new Error("Robot runs do not support clear_screen.");
    }),
    /Robot runs do not support clear_screen/,
  );

  assert.equal(controller.getView().status, "connected");
  assert.equal(controller.getView().robotOwned, true);
  assert.equal(controller.getView().busy, false);
  assert.equal(
    controller.getView().statusMessage,
    "Robot runs do not support clear_screen.",
  );
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
  controller.confirmPenSettings();
  await controller.testPenAngle("downAngle");
  assert.equal(controller.getView().penConfirmed, false);
  await controller.runProgram(assert.fail);
  assert.deepEqual(fake.calls, []);
});

test("a disconnected program reports non-Error failure without further hardware commands", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  const failure = { reason: "lost connection" };
  await assert.rejects(
    controller.runProgram(async () => {
      fake.robot.connected = false;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(controller.getView().status, "error");
  assert.equal(controller.getView().statusMessage, "Robot run failed.");
  assert.equal(controller.getView().busy, false);
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
  await controller.disconnect();
  assert.equal(controller.getView().status, "disconnected");
  unsubscribe();
  await controller.dispose();
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
  assert.equal(commandController.getView().robotOwned, true);
  assert.equal(
    commandController.getView().statusMessage,
    "Robot command failed.",
  );

  fake.robot.backward = async () => {
    throw new Error("Motor unavailable.");
  };
  await commandController.move("backward");
  assert.equal(commandController.getView().statusMessage, "Motor unavailable.");
  assert.equal(commandController.getView().robotOwned, true);
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
  await unsupported.disconnect();
  await unsupported.dispose();

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

  await controller.dispose();
  await controller.connect();
  assert.deepEqual(fake.calls, [["stop"], ["disconnect"]]);
});

test("dispose disconnects and reports safety cleanup rejection", async () => {
  const fake = createRobot();
  fake.robot.stop = async () => {
    throw new Error("cleanup failed");
  };
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();

  await assert.rejects(controller.dispose(), /cleanup failed/);

  assert.deepEqual(fake.calls, [["disconnect"]]);
});

test("disconnect handles an already disconnected robot", async () => {
  const fake = createRobot();
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  fake.robot.connected = false;

  await controller.disconnect();

  assert.deepEqual(fake.calls, [["disconnect"]]);
  assert.equal(controller.getView().status, "disconnected");
});

test("cleanup failure releases ownership when disconnect succeeds", async () => {
  const fake = createRobot();
  fake.robot.stop = async () => {
    throw "stop failed";
  };
  fake.robot.disconnect = () => {
    fake.robot.connected = false;
  };
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  await assert.rejects(
    controller.disconnect(),
    (error) => error === "stop failed",
  );
  assert.equal(controller.getView().status, "error");
  assert.equal(
    controller.getView().statusMessage,
    "Robot safety cleanup failed.",
  );
  assert.equal(controller.getView().deviceName, "");
  assert.equal(controller.getView().robotOwned, false);
  await controller.move("forward");
  assert.deepEqual(fake.calls, []);
});

test("dispose cancels the program and raises its calibrated pen before disconnect", async () => {
  const fake = createRobot();
  fake.robot.disconnect = () => {
    fake.robot.connected = false;
    fake.calls.push(["disconnect"]);
  };
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  controller.confirmPenSettings();
  const settings = controller.getView().penSettings;
  let finish;
  let isCancelled;
  const running = controller.runProgram((_robot, cancelled) => {
    isCancelled = cancelled;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await controller.dispose();
  assert.equal(isCancelled(), true);
  assert.deepEqual(fake.calls, [
    ["stop"],
    ["pen", false, settings],
    ["disconnect"],
  ]);
  finish();
  await running;
  assert.equal(fake.calls.length, 3);
});

test("disconnect attempts every safety action and aggregates cleanup failures", async () => {
  const fake = createRobot();
  fake.robot.stop = async () => {
    throw new Error("stop failed");
  };
  fake.robot.setPenDown = async () => {
    throw new Error("pen failed");
  };
  fake.robot.disconnect = () => {
    throw new Error("disconnect failed");
  };
  const controller = createRobotControlPanelController(async () => fake.robot);
  await controller.connect();
  controller.confirmPenSettings();

  await assert.rejects(controller.disconnect(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((failure) => failure.message),
      ["stop failed", "pen failed", "disconnect failed"],
    );
    return true;
  });
  assert.equal(controller.getView().status, "error");
});
