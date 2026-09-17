import assert from "node:assert/strict";
import test from "node:test";
import { createCameraRobotDemoController } from "../dist/index.js";

const image = { width: 1, height: 1, rgba: new Uint8Array(4) };
const result = { source: "forward 10", blocks: [], issues: [] };
const noOp = () => {};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const frameSource = (captureFrame) => ({ captureFrame, cancelCapture: noOp });
const robotRunner = (runOnRobot) => ({ runOnRobot, reset: async () => {} });

test("captures, recognizes, and runs without overwriting the completed program display", async () => {
  const calls = [];
  const states = [];
  const controller = createCameraRobotDemoController(
    frameSource(async () => {
      calls.push("capture");
      return image;
    }),
    {
      getState: () => ({ error: null }),
      async importImage(capturedImage) {
        assert.equal(capturedImage, image);
        calls.push("recognize");
        return result;
      },
    },
    robotRunner(async () => {
      calls.push("run");
      return true;
    }),
    {
      onStateChange: (state) => states.push(state.status),
      reportStatus: async (text) => calls.push(`screen:${text}`),
    },
  );

  await controller.run();

  assert.deepEqual(calls, [
    "screen:Taking photo",
    "capture",
    "screen:Reading board",
    "recognize",
    "screen:Running",
    "run",
  ]);
  assert.deepEqual(states, [
    "capturing",
    "recognizing",
    "running",
    "succeeded",
  ]);
  assert.deepEqual(controller.getState(), {
    status: "succeeded",
    error: null,
  });
});

test("does not run the robot when recognition fails", async () => {
  let robotRuns = 0;
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: "No board found." }),
      importImage: async () => null,
    },
    robotRunner(async () => {
      robotRuns++;
      return true;
    }),
  );

  await controller.run();

  assert.equal(robotRuns, 0);
  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "No board found.",
  });
});

test("uses the recognition fallback when the importer has no error", async () => {
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: null }),
      importImage: async () => null,
    },
    robotRunner(async () => assert.fail("robot should not run")),
  );

  await controller.run();

  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Board recognition failed.",
  });
});

test("reports camera failures and ignores a concurrent click", async () => {
  let releaseCapture;
  let captures = 0;
  const controller = createCameraRobotDemoController(
    frameSource(() => {
      captures++;
      return new Promise((resolve, reject) => {
        releaseCapture = () => reject(new Error("Camera permission denied."));
      });
    }),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
    },
    robotRunner(async () => true),
  );

  const firstRun = controller.run();
  await controller.run();
  releaseCapture();
  await firstRun;

  assert.equal(captures, 1);
  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Camera permission denied.",
  });
});

test("reports a fallback error for non-Error failures and permits a retry", async () => {
  let attempts = 0;
  const controller = createCameraRobotDemoController(
    frameSource(async () => {
      attempts++;
      if (attempts === 1) throw "camera unavailable";
      return image;
    }),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
    },
    robotRunner(async () => true),
  );

  await controller.run();
  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Camera-to-robot demo failed.",
  });

  await controller.run();
  assert.equal(attempts, 2);
  assert.equal(controller.getState().status, "succeeded");
});

test("does not report success when robot execution is declined", async () => {
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
    },
    robotRunner(async () => false),
  );

  await controller.run();

  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Robot run did not complete.",
  });
});

test("cancel clears terminal success and failure state", async () => {
  let succeeds = true;
  const controller = createCameraRobotDemoController(
    frameSource(async () => {
      if (!succeeds) throw new Error("camera failed");
      return image;
    }),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
    },
    robotRunner(async () => true),
  );

  await controller.run();
  controller.cancel();
  assert.deepEqual(controller.getState(), { status: "idle", error: null });

  succeeds = false;
  await controller.run();
  controller.cancel();
  assert.deepEqual(controller.getState(), { status: "idle", error: null });
});

test("cancelling capture prevents recognition and robot execution", async () => {
  let releaseCapture;
  let captureCancellations = 0;
  let imports = 0;
  let robotRuns = 0;
  let robotCancellations = 0;
  const controller = createCameraRobotDemoController(
    {
      captureFrame: () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve(image);
        }),
      cancelCapture() {
        captureCancellations++;
      },
    },
    {
      getState: () => ({ error: null }),
      importImage: async () => {
        imports++;
        return result;
      },
      cancel() {},
    },
    {
      async runOnRobot() {
        robotRuns++;
        return true;
      },
      reset() {
        robotCancellations++;
      },
    },
  );

  const run = controller.run();
  controller.cancel();
  releaseCapture();
  await run;

  assert.equal(captureCancellations, 1);
  assert.equal(imports, 0);
  assert.equal(robotRuns, 0);
  assert.equal(robotCancellations, 1);
  assert.deepEqual(controller.getState(), { status: "idle", error: null });
});

test("cancelling recognition cancels the import and prevents robot execution", async () => {
  let releaseImport;
  let importCancellations = 0;
  let robotRuns = 0;
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: null }),
      importImage: () =>
        new Promise((resolve) => {
          releaseImport = () => resolve(result);
        }),
      cancel() {
        importCancellations++;
      },
    },
    {
      async runOnRobot() {
        robotRuns++;
        return true;
      },
      reset() {},
    },
  );

  const run = controller.run();
  await Promise.resolve();
  controller.cancel();
  releaseImport();
  await run;

  assert.equal(importCancellations, 1);
  assert.equal(robotRuns, 0);
  assert.deepEqual(controller.getState(), { status: "idle", error: null });
});

test("cancelling physical execution resets the robot and ignores its completion", async () => {
  let releaseRobot;
  let acknowledgeReset;
  let robotResets = 0;
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
      cancel() {},
    },
    {
      runOnRobot: () =>
        new Promise((resolve) => {
          releaseRobot = () => resolve(true);
        }),
      reset: () =>
        new Promise((resolve) => {
          robotResets++;
          acknowledgeReset = resolve;
        }),
    },
  );

  const run = controller.run();
  await nextTurn();
  assert.equal(controller.getState().status, "running");
  const cancellation = controller.cancel();
  assert.equal(controller.cancel(), cancellation);
  assert.equal(controller.getState().status, "running");
  await controller.run();
  assert.equal(robotResets, 1);
  assert.equal(controller.getState().status, "running");
  acknowledgeReset();
  await cancellation;
  releaseRobot();
  await run;

  assert.equal(robotResets, 1);
  assert.deepEqual(controller.getState(), { status: "idle", error: null });
});

test("a stale robot acknowledgement cannot overwrite an immediate retry", async () => {
  let releaseFirstRobot;
  let robotRuns = 0;
  const states = [];
  const controller = createCameraRobotDemoController(
    frameSource(async () => image),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
      cancel() {},
    },
    {
      runOnRobot() {
        robotRuns++;
        if (robotRuns === 1)
          return new Promise((resolve) => {
            releaseFirstRobot = () => resolve(true);
          });
        return Promise.resolve(true);
      },
      async reset() {},
    },
    { onStateChange: (state) => states.push(state.status) },
  );

  const firstRun = controller.run();
  await nextTurn();
  await controller.cancel();
  const retry = controller.run();
  await retry;
  releaseFirstRobot();
  await firstRun;

  assert.equal(robotRuns, 2);
  assert.equal(controller.getState().status, "succeeded");
  assert.deepEqual(states.slice(-4), [
    "capturing",
    "recognizing",
    "running",
    "succeeded",
  ]);
});

test("cancellation reports robot reset failures and permits a retry", async () => {
  let releaseCapture;
  let resetFailure = new Error("Emergency stop was not acknowledged.");
  const controller = createCameraRobotDemoController(
    frameSource(
      () =>
        new Promise((resolve) => {
          releaseCapture = () => resolve(image);
        }),
    ),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
      cancel() {},
    },
    {
      async runOnRobot() {
        return true;
      },
      async reset() {
        if (resetFailure !== undefined) throw resetFailure;
      },
    },
  );

  const firstRun = controller.run();
  await assert.rejects(controller.cancel(), /Emergency stop/);
  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Emergency stop was not acknowledged.",
  });
  releaseCapture();
  await firstRun;

  resetFailure = undefined;
  const retry = controller.run();
  releaseCapture();
  await retry;
  assert.equal(controller.getState().status, "succeeded");
});

test("cancellation reports a fallback for non-Error reset failures", async () => {
  let rejectCapture;
  const controller = createCameraRobotDemoController(
    frameSource(
      () =>
        new Promise((_resolve, reject) => {
          rejectCapture = reject;
        }),
    ),
    {
      getState: () => ({ error: null }),
      importImage: async () => result,
      cancel() {},
    },
    {
      async runOnRobot() {
        return true;
      },
      async reset() {
        throw "reset failed";
      },
    },
  );

  const run = controller.run();
  await assert.rejects(
    controller.cancel(),
    (error) => error === "reset failed",
  );
  rejectCapture(new Error("Capture cancelled."));
  await run;
  assert.deepEqual(controller.getState(), {
    status: "failed",
    error: "Robot reset failed.",
  });
});
