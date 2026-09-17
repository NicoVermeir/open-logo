import { expect, test, type Page } from "@playwright/test";

async function installMBot2BluetoothMock(
  page: Page,
  options: {
    readonly disconnectAfterFirstConnect?: boolean;
    readonly holdProgramAcknowledgement?: boolean;
  } = {},
): Promise<void> {
  await page.addInitScript((mockOptions) => {
    const host = globalThis as typeof globalThis & {
      robotBluetoothMock?: {
        readonly scripts: string[];
        readonly connectCount: number;
        readonly disconnectCount: number;
        releaseMovement(): void;
      };
    };
    const scripts: string[] = [];
    let connected = false;
    let connectCount = 0;
    let disconnectCount = 0;
    let bufferedBytes: number[] = [];
    let releaseMovement!: () => void;
    const movementBlocked = new Promise<void>((resolve) => {
      releaseMovement = resolve;
    });
    const notifyCharacteristic = Object.assign(new EventTarget(), {
      value: undefined as DataView | undefined,
      async startNotifications() {
        return this;
      },
      async writeValueWithoutResponse() {},
    });
    const writeCharacteristic = Object.assign(new EventTarget(), {
      async startNotifications() {
        return this;
      },
      async writeValueWithoutResponse(value: BufferSource) {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        bufferedBytes.push(...bytes);
        if (bufferedBytes.length < 4) return;
        const frameLength = bufferedBytes[2]! + (bufferedBytes[3]! << 8) + 6;
        if (bufferedBytes.length < frameLength) return;
        const frame = Uint8Array.from(bufferedBytes.splice(0, frameLength));
        if (frame[4] !== 0x28) return;
        const script = new TextDecoder().decode(frame.subarray(10, -2));
        scripts.push(script);
        if (script.startsWith("(mbot2.forward(")) await movementBlocked;
        const sensorValue = script.includes("get_battery")
          ? 87
          : script.includes("ultrasonic2.get")
            ? 31
            : script.startsWith("(mbot2.")
              ? 1
              : undefined;
        if (sensorValue !== undefined) {
          const payload = new TextEncoder().encode(
            JSON.stringify({ ret: sensorValue }),
          );
          const dataLength = payload.length + 6;
          const response = new Uint8Array(dataLength + 6);
          response.set([
            0xf3,
            (dataLength + 0xf3) & 0xff,
            dataLength,
            0,
            0x28,
            1,
            frame[6]!,
            frame[7]!,
            payload.length,
            0,
          ]);
          response.set(payload, 10);
          response[response.length - 1] = 0xf4;
          const acknowledge = () => {
            notifyCharacteristic.value = new DataView(response.buffer);
            notifyCharacteristic.dispatchEvent(
              new Event("characteristicvaluechanged"),
            );
          };
          if (
            mockOptions.holdProgramAcknowledgement &&
            script.startsWith("(mbot2.")
          ) {
            void movementBlocked.then(acknowledge);
          } else acknowledge();
        }
      },
    });
    const device = Object.assign(new EventTarget(), {
      name: "CyberPi browser test",
      gatt: {
        get connected() {
          return connected;
        },
        async connect() {
          connectCount += 1;
          connected = true;
          if (mockOptions.disconnectAfterFirstConnect && connectCount === 1) {
            queueMicrotask(() => {
              connected = false;
            });
          }
          return this;
        },
        disconnect() {
          disconnectCount += 1;
          connected = false;
        },
        async getPrimaryService() {
          return {
            async getCharacteristic(uuid: string) {
              return uuid.includes("ffe2")
                ? notifyCharacteristic
                : writeCharacteristic;
            },
          };
        },
      },
    });
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: { requestDevice: async () => device },
    });
    host.robotBluetoothMock = {
      scripts,
      get connectCount() {
        return connectCount;
      },
      get disconnectCount() {
        return disconnectCount;
      },
      releaseMovement,
    };
  }, options);
}

async function confirmPenCalibration(page: Page): Promise<void> {
  await page.locator("#robot-pen-down-angle").fill("60");
  await page.locator("#robot-pen-raised-angle").fill("120");
  await page.locator("#robot-pen-measured-lift").fill("10");
  await page.locator("#robot-pen-lift").fill("5");
  await page.locator("#robot-pen-settle").fill("100");
  await page.locator("#robot-pen-confirm").click();
  await expect(page.locator("#robot-pen-calibration-status")).toHaveText(
    "Confirmed",
  );
}

async function installCameraMock(
  page: Page,
  options: {
    readonly holdCapture?: boolean;
    readonly failureMessage?: string;
    readonly hideDevicesUntilPermission?: boolean;
    readonly liveFrames?: boolean;
    readonly holdPlayback?: boolean;
    readonly playFailureMessage?: string;
  } = {},
): Promise<void> {
  await page.addInitScript((mockOptions) => {
    let releaseCapture!: () => void;
    const captureBlocked = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let releasePlayback!: () => void;
    const playbackBlocked = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const captureRequests: MediaStreamConstraints[] = [];
    let permissionGranted = false;
    let stoppedTracks = 0;
    const tracks: EventTarget[] = [];
    const frameContexts: CanvasRenderingContext2D[] = [];
    function paintFrames(color = "blue") {
      for (const context of frameContexts) {
        context.fillStyle = "white";
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = "black";
        context.font = "36px monospace";
        context.fillText("forward 20", 40, 100);
        context.fillStyle = "red";
        context.fillRect(0, 180, 320, 180);
        context.fillStyle = color;
        context.fillRect(320, 180, 320, 180);
      }
    }
    let devices: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[] = [
      { kind: "videoinput", deviceId: "built-in", label: "Built-in webcam" },
      { kind: "audioinput", deviceId: "microphone", label: "Microphone" },
      { kind: "videoinput", deviceId: "usb", label: "USB board webcam" },
    ];
    const mediaDevices = new EventTarget();
    Reflect.set(globalThis, "cameraMock", {
      releaseCapture,
      releasePlayback,
      captureRequests,
      paintFrames,
      endTracks() {
        for (const track of tracks) track.dispatchEvent(new Event("ended"));
      },
      get stoppedTracks() {
        return stoppedTracks;
      },
      setDevices(nextDevices: typeof devices) {
        devices = nextDevices;
        mediaDevices.dispatchEvent(new Event("devicechange"));
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: Object.assign(mediaDevices, {
        enumerateDevices: async () =>
          mockOptions.hideDevicesUntilPermission && !permissionGranted
            ? [{ kind: "videoinput", deviceId: "", label: "" }]
            : devices,
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          captureRequests.push(constraints);
          if (mockOptions.holdCapture) await captureBlocked;
          if (mockOptions.failureMessage)
            throw new Error(mockOptions.failureMessage);
          permissionGranted = true;
          if (mockOptions.liveFrames) {
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 360;
            frameContexts.push(canvas.getContext("2d")!);
            paintFrames();
            const stream = canvas.captureStream(30);
            for (const track of stream.getTracks()) {
              tracks.push(track);
              const stop = track.stop.bind(track);
              track.stop = () => {
                stoppedTracks++;
                stop();
              };
            }
            return stream;
          }
          const track = Object.assign(new EventTarget(), {
            stop() {
              stoppedTracks++;
            },
          });
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      }),
    });
    if (mockOptions.liveFrames) return;
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: { configurable: true, get: () => 1 },
      videoWidth: { configurable: true, get: () => 2 },
      videoHeight: { configurable: true, get: () => 2 },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() {
        return Reflect.get(this, "cameraStream");
      },
      set(stream) {
        Reflect.set(this, "cameraStream", stream);
      },
    });
    HTMLVideoElement.prototype.play = async () => {
      if (mockOptions.holdPlayback) await playbackBlocked;
      if (mockOptions.playFailureMessage)
        throw new Error(mockOptions.playFailureMessage);
    };
  }, options);
}

test("live camera preview renders frames, switches webcams, and releases streams", async ({
  page,
}, testInfo) => {
  await installMBot2BluetoothMock(page);
  await installCameraMock(page, { liveFrames: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let recognitionCalls = 0;
  await page.route("**/api/recognize-board", async (route) => {
    recognitionCalls++;
    await route.fulfill({ status: 500 });
  });
  await page.goto("/");
  const video = page.locator("#camera-preview");
  const previewStatus = page.getByRole("status", {
    name: "Camera preview status",
  });
  const webcamSelect = page.getByRole("combobox", {
    name: "Webcam",
    exact: true,
  });
  const previewButton = page.locator("#camera-preview-button");
  const stoppedTracks = () =>
    page.evaluate(() => Reflect.get(globalThis, "cameraMock").stoppedTracks);
  const captureRequests = () =>
    page.evaluate(() => Reflect.get(globalThis, "cameraMock").captureRequests);
  const frameColors = () =>
    video.evaluate((element: HTMLVideoElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d")!;
      context.drawImage(element, 0, 0);
      return [100, 540].map((position) =>
        Array.from(context.getImageData(position, 250, 1, 1).data),
      );
    });
  await expect(video).toBeHidden();
  expect(await captureRequests()).toEqual([]);
  await expect(webcamSelect.locator("option")).toHaveCount(3);
  await webcamSelect.selectOption("usb");
  await previewButton.focus();
  await page.keyboard.press("Enter");
  await expect(previewStatus).toHaveText("Camera preview is live.");
  await expect(previewButton).toHaveAttribute("aria-pressed", "true");
  await expect(video).toBeVisible();
  await expect.poll(frameColors).toEqual([
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  const videoGeometry = await video.evaluate((element: HTMLVideoElement) => {
    const bounds = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      left: bounds.left,
      right: bounds.right,
      viewport: window.innerWidth,
      ratio: bounds.width / bounds.height,
      fit: styles.objectFit,
      transform: styles.transform,
    };
  });
  expect(videoGeometry.left).toBeGreaterThanOrEqual(0);
  expect(videoGeometry.right).toBeLessThanOrEqual(videoGeometry.viewport);
  expect(videoGeometry.ratio).toBeCloseTo(4 / 3, 1);
  expect(videoGeometry.fit).toBe("contain");
  expect(videoGeometry.transform).toBe("none");
  await page
    .locator(".pane-controls")
    .screenshot({ path: testInfo.outputPath("live-camera-preview.png") });
  await page.evaluate(() =>
    Reflect.get(globalThis, "cameraMock").paintFrames("lime"),
  );
  await expect.poll(frameColors).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
  ]);
  await page
    .getByRole("button", { name: "Refresh webcams", exact: true })
    .click();
  await expect(previewStatus).toHaveText("Camera preview is live.");
  expect(await captureRequests()).toHaveLength(1);
  expect(await stoppedTracks()).toBe(0);
  await webcamSelect.selectOption("built-in");
  await expect(previewStatus).toHaveText("Camera preview is live.");
  expect(await captureRequests()).toEqual([
    { video: { deviceId: { exact: "usb" } }, audio: false },
    { video: { deviceId: { exact: "built-in" } }, audio: false },
  ]);
  expect(await stoppedTracks()).toBe(1);
  await expect.poll(frameColors).toEqual([
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  await previewButton.click();
  await expect(video).toBeHidden();
  await expect(previewButton).toHaveAttribute("aria-pressed", "false");
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.srcObject),
  ).toBeNull();
  expect(await stoppedTracks()).toBe(2);
  await previewButton.click();
  await expect(previewStatus).toHaveText("Camera preview is live.");
  await page.locator("#reset-button").click();
  await expect(video).toBeHidden();
  expect(await stoppedTracks()).toBe(3);
  await previewButton.click();
  await expect(previewStatus).toHaveText("Camera preview is live.");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(video).toBeHidden();
  expect(await stoppedTracks()).toBe(4);
  await previewButton.click();
  await expect(previewStatus).toHaveText("Camera preview is live.");
  await page.evaluate(() => Reflect.get(globalThis, "cameraMock").endTracks());
  await expect(previewStatus).toHaveText("The webcam disconnected or stopped.");
  await expect(video).toBeHidden();
  expect(await stoppedTracks()).toBe(5);
  await previewButton.click();
  await expect(previewStatus).toHaveText("Camera preview is live.");
  await page.evaluate(() =>
    Reflect.get(globalThis, "cameraMock").setDevices([]),
  );
  await expect(previewStatus).toHaveText(
    "The selected webcam is no longer available.",
  );
  await expect(video).toBeHidden();
  await expect(webcamSelect).toHaveValue("");
  expect(await stoppedTracks()).toBe(6);
  expect(recognitionCalls).toBe(0);
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
});

for (const pendingStage of ["permission", "playback"] as const) {
  test(`camera preview cancels pending ${pendingStage} without replacing a newer stream`, async ({
    page,
  }) => {
    await installMBot2BluetoothMock(page);
    await installCameraMock(page, {
      holdCapture: pendingStage === "permission",
      holdPlayback: pendingStage === "playback",
    });
    await page.goto("/");
    await page.locator("#robot-controls summary").click();
    await page.locator("#robot-connect").click();
    await confirmPenCalibration(page);
    const previewButton = page.locator("#camera-preview-button");
    const previewStatus = page.getByRole("status", {
      name: "Camera preview status",
    });
    const pendingMessage =
      pendingStage === "permission"
        ? "Waiting for camera permission..."
        : "Starting camera preview...";
    await previewButton.click();
    await expect(previewStatus).toHaveText(pendingMessage);
    await expect(page.locator("#camera-device-select")).toBeDisabled();
    await expect(page.locator("#camera-devices-refresh-button")).toBeDisabled();
    await expect(page.locator("#camera-robot-demo-button")).toBeDisabled();
    await expect(previewButton).toBeEnabled();
    await previewButton.click();
    await expect(page.locator("#camera-preview")).toBeHidden();
    await expect(previewStatus).toBeEmpty();
    await expect(page.locator("#camera-robot-demo-button")).toBeEnabled();
    await previewButton.click();
    await expect(previewStatus).toHaveText(pendingMessage);
    await page.evaluate((stage) => {
      const cameraMock = Reflect.get(globalThis, "cameraMock");
      if (stage === "permission") cameraMock.releaseCapture();
      else cameraMock.releasePlayback();
    }, pendingStage);
    await expect(previewStatus).toHaveText("Camera preview is live.");
    await expect(page.locator("#camera-preview")).toBeVisible();
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "cameraMock").stoppedTracks,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "cameraMock").captureRequests,
      ),
    ).toEqual([
      { video: { facingMode: { ideal: "environment" } }, audio: false },
      { video: { facingMode: { ideal: "environment" } }, audio: false },
    ]);
    await expect(page.locator("#camera-robot-demo-button")).toBeEnabled();
    await previewButton.click();
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "cameraMock").stoppedTracks,
      ),
    ).toBe(2);
  });
}

for (const failure of ["permission", "playback", "unavailable"] as const) {
  test(`camera preview reports ${failure} errors and releases camera controls`, async ({
    page,
  }) => {
    await installCameraMock(page, {
      failureMessage:
        failure === "permission" ? "Camera permission denied." : undefined,
      playFailureMessage:
        failure === "playback" ? "Video playback failed." : undefined,
    });
    if (failure === "unavailable") {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: undefined,
        });
      });
    }
    await page.goto("/");
    const previewButton = page.locator("#camera-preview-button");
    const previewStatus = page.getByRole("status", {
      name: "Camera preview status",
    });
    await previewButton.click();
    await expect(previewStatus).toHaveText(
      `Unable to preview webcam: ${
        {
          permission: "Camera permission denied.",
          playback: "Video playback failed.",
          unavailable: "Camera access is unavailable in this browser.",
        }[failure]
      }`,
    );
    await expect(previewStatus).toBeVisible();
    await expect(previewButton).toHaveAccessibleName("Start camera preview");
    await expect(previewButton).toBeEnabled();
    await expect(page.locator("#camera-preview")).toBeHidden();
    await expect(page.locator("#camera-device-select")).toBeEnabled();
    await expect(page.locator("#camera-devices-refresh-button")).toBeEnabled();
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "cameraMock").stoppedTracks,
      ),
    ).toBe(failure === "playback" ? 1 : 0);
    await page.locator("#reset-button").click();
    await expect(previewStatus).toBeEmpty();
  });
}

test("webcam discovery unlocks selection without recognizing or moving", async ({
  page,
}, testInfo) => {
  await installMBot2BluetoothMock(page);
  await installCameraMock(page, {
    hideDevicesUntilPermission: true,
    holdCapture: true,
  });
  let recognitionCalls = 0;
  await page.route("**/api/recognize-board", async (route) => {
    recognitionCalls++;
    await route.fulfill({ status: 500 });
  });
  await page.goto("/");
  const webcamSelect = page.getByRole("combobox", {
    name: "Webcam",
    exact: true,
  });
  const refreshButton = page.getByRole("button", {
    name: "Refresh webcams",
    exact: true,
  });
  const webcamStatus = page.getByRole("status", {
    name: "Webcam status",
    exact: true,
  });
  await expect(webcamSelect.locator("option")).toHaveText(["Automatic"]);
  expect(
    await page.evaluate(
      () => Reflect.get(globalThis, "cameraMock").captureRequests,
    ),
  ).toEqual([]);
  await refreshButton.focus();
  await page.keyboard.press("Enter");
  await expect(webcamStatus).toHaveText("Waiting for camera permission...");
  await expect(webcamSelect).toBeDisabled();
  await expect(refreshButton).toBeDisabled();
  await page.evaluate(() =>
    Reflect.get(globalThis, "cameraMock").releaseCapture(),
  );
  await expect(webcamSelect.locator("option")).toHaveText([
    "Automatic",
    "Built-in webcam",
    "USB board webcam",
  ]);
  await expect(webcamSelect).toBeEnabled();
  await expect(refreshButton).toBeEnabled();
  await expect(webcamStatus).toBeEmpty();
  expect(
    await page.evaluate(
      () => Reflect.get(globalThis, "cameraMock").captureRequests,
    ),
  ).toEqual([
    { video: { facingMode: { ideal: "environment" } }, audio: false },
  ]);
  expect(
    await page.evaluate(
      () => Reflect.get(globalThis, "cameraMock").stoppedTracks,
    ),
  ).toBe(1);
  expect(recognitionCalls).toBe(0);
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual([]);
  await webcamSelect.selectOption("usb");
  await page.evaluate(() =>
    Reflect.get(globalThis, "cameraMock").setDevices([
      {
        kind: "videoinput",
        deviceId: "usb",
        label: "USB board webcam with a very long manufacturer and model name",
      },
      { kind: "videoinput", deviceId: "unnamed", label: "" },
    ]),
  );
  await expect(webcamSelect.locator("option")).toHaveText([
    "Automatic",
    "USB board webcam with a very long manufacturer and model name",
    "Webcam 2",
  ]);
  await expect(webcamSelect).toHaveValue("usb");
  await page.locator(".camera-device-control").screenshot({
    path: testInfo.outputPath("webcam-selection.png"),
  });
  const selectorFits = await webcamSelect.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const parent = element.parentElement!;
    return {
      left: bounds.left,
      right: bounds.right,
      viewport: window.innerWidth,
      scrollWidth: parent.scrollWidth,
      clientWidth: parent.clientWidth,
    };
  });
  expect(selectorFits.left).toBeGreaterThanOrEqual(0);
  expect(selectorFits.right).toBeLessThanOrEqual(selectorFits.viewport);
  expect(selectorFits.scrollWidth).toBe(selectorFits.clientWidth);
  await page.evaluate(() =>
    Reflect.get(globalThis, "cameraMock").setDevices([]),
  );
  await expect(webcamSelect.locator("option")).toHaveText(["Automatic"]);
  await expect(webcamSelect).toHaveValue("");
});

test("mBot2 controls expand below the canvas and fit the viewport", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.locator("#turtle-canvas");
  const panel = page.locator("#robot-controls");
  await expect(canvas).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");

  const canvasBox = await canvas.boundingBox();
  const panelBox = await panel.boundingBox();
  const drivePadBox = await page.locator(".robot-drive-pad").boundingBox();
  if (canvasBox === null || panelBox === null || drivePadBox === null) {
    throw new Error("expected the robot panel and canvas to be laid out");
  }

  expect(panelBox.y).toBeGreaterThan(canvasBox.y + canvasBox.height - 2);
  expect(drivePadBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(drivePadBox.x + drivePadBox.width).toBeLessThanOrEqual(
    panelBox.x + panelBox.width,
  );
});

test("default pen settings allow forward 20 after manual pen commands without lift measurements", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  await expect(page.locator("#robot-pen-down-angle")).toHaveValue("90");
  await expect(page.locator("#robot-pen-raised-angle")).toHaveValue("115");
  await expect(page.locator("#robot-pen-settle")).toHaveValue("200");
  await expect(page.locator("#robot-pen-measured-lift")).toHaveValue("");
  await expect(page.locator("#robot-pen-lift")).toHaveValue("");
  await expect(page.locator("#robot-pen-up")).toBeDisabled();
  await page.locator("#robot-pen-confirm").click();
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual([]);
  await page.locator("#robot-pen-up").click();
  await expect(page.locator("#robot-pen-state")).toHaveText("up");
  await page.locator("#robot-pen-down").click();
  await expect(page.locator("#robot-pen-state")).toHaveText("down");
  await page.locator(".cm-content").fill("forward 20");
  const runButton = page.getByRole("button", {
    name: "Run on turtlebot",
    exact: true,
  });
  await runButton.click();
  await expect(runButton).toBeEnabled();
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual([
    "(mbot2.servo_set(115,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.straight(2,speed=30),1)[1]",
    "(mbot2.EM_stop(),1)[1]",
    "(mbot2.servo_set(115,3),1)[1]",
  ]);
  await page.locator(".cm-content").fill("pen_down\nforward 20\npen_up");
  await runButton.click();
  await expect(runButton).toBeEnabled();
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts.slice(5)),
  ).toEqual([
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.straight(2,speed=30),1)[1]",
    "(mbot2.servo_set(115,3),1)[1]",
    "(mbot2.EM_stop(),1)[1]",
    "(mbot2.servo_set(115,3),1)[1]",
  ]);
});

test("Run on turtlebot executes whole motion phases and updates the virtual turtle", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Run on turtlebot", exact: true }),
  ).toBeDisabled();
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  const editor = page.locator(".cm-content");
  await confirmPenCalibration(page);
  await editor.fill(":sides = 18\nforward 40\nright 360 / :sides\nprint 42");
  await page
    .getByRole("button", { name: "Run on turtlebot", exact: true })
    .click();
  await expect(page.locator("#run-log")).toContainText("42");
  await expect(
    page.getByRole("status", { name: "Turtle state" }),
  ).toContainText("x 0 y 40 heading 20");
  await expect(
    page.getByRole("button", { name: "Run on turtlebot", exact: true }),
  ).toBeEnabled();
  const scripts = await page.evaluate(
    () => globalThis.robotBluetoothMock?.scripts ?? [],
  );
  const lateralOffset = 26 * Math.tan((20 * Math.PI) / 360);
  expect(scripts.slice(0, -2)).toEqual([
    "(mbot2.straight(4,speed=30),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    `(mbot2.straight(${(126 - lateralOffset) / 10},speed=30),1)[1]`,
    "(mbot2.turn(20,speed=30),1)[1]",
    `(mbot2.straight(${-(126 + lateralOffset) / 10},speed=30),1)[1]`,
  ]);
  expect(scripts.slice(-2)).toEqual([
    "(mbot2.EM_stop(),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
  ]);
  expect(scripts.filter((script) => script.includes("servo_set"))).toEqual([
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
  ]);
  let horizontal = 26;
  let vertical = -126;
  let heading = 0;
  for (const script of scripts) {
    const motion =
      /^\(mbot2\.(straight|turn)\(([^,]+),speed=30\),1\)\[1\]$/.exec(script);
    if (motion === null) continue;
    const amount = Number(motion[2]);
    if (motion[1] === "turn") {
      expect(Math.abs(amount)).toBeLessThanOrEqual(5_000);
      heading += amount;
    } else {
      expect(Math.abs(amount)).toBeLessThanOrEqual(1_000);
      horizontal += amount * 10 * Math.sin((heading * Math.PI) / 180);
      vertical += amount * 10 * Math.cos((heading * Math.PI) / 180);
    }
  }
  const radians = (heading * Math.PI) / 180;
  expect(heading).toBeCloseTo(20, 8);
  expect(
    horizontal + 126 * Math.sin(radians) - 26 * Math.cos(radians),
  ).toBeCloseTo(0, 8);
  expect(
    vertical + 126 * Math.cos(radians) + 26 * Math.sin(radians),
  ).toBeCloseTo(40, 8);
});

for (const livePreview of [false, true]) {
  test(
    livePreview
      ? "camera preview captures the displayed frame and runs the recognized program"
      : "production preview captures, recognizes, and runs a board program",
    async ({ page }, testInfo) => {
      await installMBot2BluetoothMock(page, {
        holdProgramAcknowledgement: true,
      });
      await installCameraMock(page, {
        holdCapture: !livePreview,
        liveFrames: livePreview,
      });
      let recognitionRequest: unknown;
      let releaseRecognition!: () => void;
      const recognitionBlocked = new Promise<void>((resolve) => {
        releaseRecognition = resolve;
      });
      await page.route("**/api/recognize-board", async (route) => {
        recognitionRequest = route.request().postDataJSON();
        await recognitionBlocked;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            blocks: [
              {
                id: "forward-1",
                kind: "command",
                name: "forward",
                arguments: ["20"],
                bounds: { x: 0, y: 0, width: 2, height: 2 },
                confidence: 1,
                children: [],
              },
            ],
          }),
        });
      });
      await page.goto("/");
      const cameraStatus = page.getByRole("status", {
        name: "Camera to turtlebot status",
      });
      const webcamSelect = page.getByRole("combobox", {
        name: "Webcam",
        exact: true,
      });
      await expect(webcamSelect.locator("option")).toHaveText([
        "Automatic",
        "Built-in webcam",
        "USB board webcam",
      ]);
      await webcamSelect.selectOption("usb");
      await expect(cameraStatus).toHaveText(
        "Connect turtlebot to use the camera.",
      );
      await page.locator("#robot-controls summary").click();
      await page.locator("#robot-connect").click();
      await expect(cameraStatus).toContainText("Confirm pen calibration");
      await confirmPenCalibration(page);
      await expect(cameraStatus).toContainText("Ready to capture");
      let displayedImage: string | undefined;
      if (livePreview) {
        await page.locator("#camera-preview-button").click();
        await expect(
          page.getByRole("status", { name: "Camera preview status" }),
        ).toHaveText("Camera preview is live.");
        displayedImage = await page
          .locator("#camera-preview")
          .evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d")!.drawImage(video, 0, 0);
            return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
          });
      }
      await page.locator("#camera-robot-demo-button").click();
      if (!livePreview) {
        await expect(cameraStatus).toHaveAttribute("data-status", "capturing");
        await expect(cameraStatus).toContainText("Step 1 of 3");
        await expect(cameraStatus).toBeInViewport();
      }
      await expect(page.locator("#camera-robot-demo-button")).toBeDisabled();
      await expect(page.locator("#camera-preview-button")).toBeDisabled();
      await expect(webcamSelect).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Refresh webcams", exact: true }),
      ).toBeDisabled();
      expect(
        await page.evaluate(
          () => Reflect.get(globalThis, "cameraMock").captureRequests,
        ),
      ).toEqual([{ video: { deviceId: { exact: "usb" } }, audio: false }]);
      if (!livePreview) {
        expect(recognitionRequest).toBeUndefined();
        await page.evaluate(() =>
          Reflect.get(globalThis, "cameraMock").releaseCapture(),
        );
      }
      await expect(cameraStatus).toHaveAttribute("data-status", "recognizing");
      await expect(cameraStatus).toContainText("Step 2 of 3");
      await expect(webcamSelect).toHaveValue("usb");
      await expect.poll(() => recognitionRequest).toBeDefined();
      await expect(page.locator("#camera-preview")).toBeHidden();
      expect(
        await page.evaluate(
          () => Reflect.get(globalThis, "cameraMock").stoppedTracks,
        ),
      ).toBe(1);
      if (livePreview) {
        expect(displayedImage).toBeTruthy();
        expect(
          Object.values(recognitionRequest as Record<string, unknown>),
        ).toContain(displayedImage);
      }
      expect(
        await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
      ).toEqual([]);
      await page.locator(".pane-controls").screenshot({
        path: testInfo.outputPath("camera-recognition.png"),
      });
      const statusFits = await cameraStatus.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          viewport: window.innerWidth,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(statusFits.left).toBeGreaterThanOrEqual(0);
      expect(statusFits.right).toBeLessThanOrEqual(statusFits.viewport);
      expect(statusFits.scrollWidth).toBe(statusFits.clientWidth);
      releaseRecognition();
      await expect(cameraStatus).toHaveAttribute("data-status", "running");
      await expect(cameraStatus).toContainText("Step 3 of 3");
      await expect(cameraStatus).toContainText("acknowledgements");
      await expect
        .poll(() =>
          page.evaluate(() => globalThis.robotBluetoothMock?.scripts.length),
        )
        .toBeGreaterThan(0);
      await page.evaluate(() =>
        globalThis.robotBluetoothMock?.releaseMovement(),
      );

      await expect(page.locator("#camera-robot-demo-status")).toHaveText(
        "Recognized program completed on turtlebot.",
      );
      await expect(webcamSelect).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Refresh webcams", exact: true }),
      ).toBeEnabled();
      await expect(page.locator(".cm-content")).toHaveText("forward 20");
      expect(recognitionRequest).toMatchObject({
        imageWidth: livePreview ? 640 : 2,
        imageHeight: livePreview ? 360 : 2,
        imageMimeType: "image/jpeg",
      });
      expect(
        await page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
      ).toContain("(mbot2.straight(2,speed=30),1)[1]");

      await page.unroute("**/api/recognize-board");
      const previewResponse = await page.request.get("/api/recognize-board");
      expect(previewResponse.status()).toBe(405);
    },
  );
}

for (const failure of ["camera", "recognition", "preflight"] as const) {
  test(`camera workflow reports ${failure} failures beside the button`, async ({
    page,
  }) => {
    await installMBot2BluetoothMock(page);
    await installCameraMock(
      page,
      failure === "camera"
        ? { failureMessage: "Camera permission denied." }
        : {},
    );
    let recognitionCalls = 0;
    await page.route("**/api/recognize-board", async (route) => {
      recognitionCalls++;
      await route.fulfill({
        status: failure === "recognition" ? 502 : 200,
        json:
          failure === "recognition"
            ? { error: "Vision model unavailable." }
            : {
                blocks: [
                  {
                    id: "forward-1",
                    kind: "command",
                    name: "forward",
                    arguments: ["100000"],
                    bounds: { x: 0, y: 0, width: 2, height: 2 },
                    confidence: 1,
                    children: [],
                  },
                ],
              },
      });
    });
    await page.goto("/");
    await page.locator("#robot-controls summary").click();
    await page.locator("#robot-connect").click();
    await confirmPenCalibration(page);
    await page.locator("#camera-robot-demo-button").click();
    const cameraStatus = page.getByRole("status", {
      name: "Camera to turtlebot status",
    });
    await expect(cameraStatus).toHaveAttribute("data-status", "failed");
    await expect(cameraStatus).toContainText("Camera to turtlebot failed:");
    await expect(cameraStatus).toContainText(
      {
        camera: "Camera permission denied.",
        recognition: "Vision model unavailable.",
        preflight: "Robot program exceeds 500 motion segments.",
      }[failure],
    );
    await expect(cameraStatus).toBeVisible();
    expect(recognitionCalls).toBe(failure === "camera" ? 0 : 1);
    const scripts = await page.evaluate(
      () => globalThis.robotBluetoothMock?.scripts ?? [],
    );
    expect(scripts.filter((script) => /straight|turn\(/.test(script))).toEqual(
      [],
    );
    const failureText = await cameraStatus.textContent();
    await page.locator("#robot-disconnect").click();
    await expect(page.locator("#robot-connect")).toBeEnabled();
    await expect(cameraStatus).toHaveText(failureText!);
    await expect(
      page.getByRole("combobox", { name: "Webcam", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, "cameraMock").captureRequests,
      ),
    ).toEqual([
      { video: { facingMode: { ideal: "environment" } }, audio: false },
    ]);
    if (failure === "camera") {
      await page
        .getByRole("button", { name: "Refresh webcams", exact: true })
        .click();
      await expect(
        page.getByRole("status", { name: "Webcam status", exact: true }),
      ).toHaveText("Unable to refresh webcams: Camera permission denied.");
      await expect(
        page.getByRole("combobox", { name: "Webcam", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Refresh webcams", exact: true }),
      ).toBeEnabled();
      await expect(cameraStatus).toHaveText(failureText!);
    }
  });
}

test("compensated turns restore only the current explicit down intent", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  await confirmPenCalibration(page);
  await page
    .locator(".cm-content")
    .fill("pen_down\nright 90\npen_up\nleft 90\nprint 42");
  const runButton = page.getByRole("button", {
    name: "Run on turtlebot",
    exact: true,
  });
  await runButton.click();
  await expect(page.locator("#run-log")).toContainText("42");
  await expect(runButton).toBeEnabled();
  const scripts = await page.evaluate(
    () => globalThis.robotBluetoothMock?.scripts ?? [],
  );
  expect(scripts.filter((script) => script.includes("servo_set"))).toEqual([
    "(mbot2.servo_set(60,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.servo_set(60,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
  ]);
  await expect(
    page.getByRole("status", { name: "Turtle state" }),
  ).toContainText("x 0 y 0 heading 0");
});

test("Run on turtlebot displays preflight failures without moving", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  await page.locator(".cm-content").fill("forward 10\nclear_screen");
  await confirmPenCalibration(page);
  await page
    .getByRole("button", { name: "Run on turtlebot", exact: true })
    .click();
  await expect(page.locator("#robot-status")).toContainText(
    "Robot runs do not support clear_screen.",
  );
  await expect(page.locator("#robot-forward")).toBeEnabled();
  const scripts = await page.evaluate(
    () => globalThis.robotBluetoothMock?.scripts ?? [],
  );
  expect(
    scripts.filter((script) => /mbot2\.(straight|turn)\(/.test(script)),
  ).toEqual([]);
  expect(scripts).toContain("(mbot2.EM_stop(),1)[1]");
  expect(scripts).toContain("(mbot2.servo_set(90,3),1)[1]");
});

test("Run on turtlebot waits for acknowledgement and reset blocks late playback", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page, { holdProgramAcknowledgement: true });
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  await page.locator(".cm-content").fill("forward 40\nright 90\nforward 20");
  await confirmPenCalibration(page);
  await page
    .getByRole("button", { name: "Run on turtlebot", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => globalThis.robotBluetoothMock?.scripts))
    .toEqual(["(mbot2.straight(4,speed=30),1)[1]"]);
  await expect(
    page.getByRole("status", { name: "Turtle state" }),
  ).toContainText("x 0 y 0");
  await expect(page.locator("#robot-forward")).toBeDisabled();
  await page.locator("#run-toggle-button").click();
  await page.locator("#reset-button").click();
  await page.evaluate(() => globalThis.robotBluetoothMock?.releaseMovement());
  await expect(
    page.getByRole("button", { name: "Run on turtlebot", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status", { name: "Turtle state" }),
  ).toContainText("x 0 y 0");
  const scripts = await page.evaluate(
    () => globalThis.robotBluetoothMock?.scripts ?? [],
  );
  expect(scripts.filter((script) => script.includes("straight("))).toEqual([
    "(mbot2.straight(4,speed=30),1)[1]",
  ]);
  expect(scripts.filter((script) => script.includes("turn("))).toEqual([]);
  expect(scripts).toContain("(mbot2.EM_stop(),1)[1]");
});

test("manual pen calibration does not actuate until requested and shares lift travel", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();
  await expect(page.locator("#robot-pen-up")).toBeDisabled();
  await confirmPenCalibration(page);
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual([]);
  const turtleBefore = await page.locator("#turtle-state").textContent();
  await page.locator("#robot-pen-up").click();
  await expect(page.locator("#robot-pen-state")).toHaveText("up");
  await page.locator("#robot-pen-down").click();
  await expect(page.locator("#robot-pen-state")).toHaveText("down");
  expect(await page.locator("#turtle-state").textContent()).toBe(turtleBefore);
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts),
  ).toEqual(["(mbot2.servo_set(90,3),1)[1]", "(mbot2.servo_set(60,3),1)[1]"]);
  await page.locator("#robot-pen-lift").fill("10");
  await expect(page.locator("#robot-pen-up")).toBeDisabled();
  await page.locator("#robot-pen-confirm").click();
  await page.locator("#robot-pen-up").click();
  await expect(page.locator("#robot-pen-state")).toHaveText("up");
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts.at(-1)),
  ).toBe("(mbot2.servo_set(120,3),1)[1]");
  await page.locator("#robot-disconnect").click();
  await page.locator("#robot-connect").click();
  await expect(page.locator("#robot-pen-calibration-status")).toHaveText(
    "Not confirmed",
  );
  await expect(page.locator("#robot-pen-up")).toBeDisabled();
});

test("mBot2 controls report unsupported Chromium contexts without enabling drive", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");
  await page.locator("#robot-controls summary").click();

  await expect(page.locator("#robot-status")).toHaveText(
    "Web Bluetooth is unavailable in this browser.",
  );
  await expect(page.locator("#robot-connect")).toBeDisabled();
  await expect(page.locator("#robot-forward")).toBeDisabled();
  await expect(page.locator("#robot-stop")).toBeDisabled();
});

test("mBot2 reconnects when Chromium drops GATT before service discovery", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page, {
    disconnectAfterFirstConnect: true,
  });
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();

  await expect(page.locator("#robot-status")).toHaveText(
    "Connected to CyberPi browser test.",
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({
        connectCount: globalThis.robotBluetoothMock?.connectCount,
        disconnectCount: globalThis.robotBluetoothMock?.disconnectCount,
      })),
    )
    .toEqual({ connectCount: 2, disconnectCount: 0 });
});

test("mBot2 controls lock finite movement while keeping emergency stop available", async ({
  page,
}) => {
  await installMBot2BluetoothMock(page);
  await page.goto("/");
  await page.locator("#robot-controls summary").click();
  await page.locator("#robot-connect").click();

  await expect(page.locator("#robot-status")).toHaveText(
    "Connected to CyberPi browser test.",
  );
  await page.locator("#robot-speed").fill("10");
  await page.locator("#robot-duration").selectOption("0.2");
  await page.locator("#robot-forward").click();
  await expect(page.locator("#robot-forward")).toBeDisabled();
  await expect(page.locator("#robot-speed")).toBeDisabled();
  await expect(page.locator("#robot-duration")).toBeDisabled();
  await expect(page.locator("#robot-stop")).toBeEnabled();

  await page.locator("#robot-stop").click();
  await page.evaluate(() => globalThis.robotBluetoothMock?.releaseMovement());
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    )
    .toContain("(mbot2.EM_stop(),1)[1]");
  await expect(page.locator("#robot-forward")).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    )
    .toContain("(mbot2.forward(10,0.2),1)[1]");

  await page.locator("#robot-speed").fill("100");
  await page.locator("#robot-duration").selectOption("2");
  await page.locator("#robot-forward").click();
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    )
    .toContain("(mbot2.forward(100,2),1)[1]");

  await page.locator("#robot-refresh").click();
  await expect(page.locator("#robot-battery")).toHaveText("87%");
  await expect(page.locator("#robot-distance")).toHaveText("31 cm");
  await page.locator("#robot-disconnect").click();
  await expect(page.locator("#robot-status")).toHaveText("Robot disconnected.");
  await expect(page.locator("#robot-forward")).toBeDisabled();
  await expect(page.locator("#robot-stop")).toBeDisabled();
  await expect(page.locator("#robot-connect")).toBeEnabled();
});
