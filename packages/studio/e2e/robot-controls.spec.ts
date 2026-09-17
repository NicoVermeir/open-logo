import { expect, test, type Page } from "@playwright/test";

declare global {
  var robotBluetoothMock:
    | {
        readonly scripts: string[];
        readonly allScripts: string[];
        readonly buttonReadings: boolean[];
        playButtonPressed: boolean;
        readonly connectCount: number;
        readonly disconnectCount: number;
        releaseMovement(): void;
      }
    | undefined;
}

async function installMBot2BluetoothMock(
  page: Page,
  options: {
    readonly disconnectAfterFirstConnect?: boolean;
    readonly holdProgramAcknowledgement?: boolean;
  } = {},
): Promise<void> {
  await page.addInitScript((mockOptions) => {
    const scripts: string[] = [];
    const buttonReadings: boolean[] = [];
    let playButtonPressed = false;
    const buttonQuery = "(1 if cyberpi.controller.is_press('b') else 0)";
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
        if (script === buttonQuery) buttonReadings.push(playButtonPressed);
        if (script.startsWith("(mbot2.forward(")) await movementBlocked;
        const sensorValue = script.includes("get_battery")
          ? 87
          : script.includes("ultrasonic2.get")
            ? 31
            : script.startsWith("(mbot2.") ||
                script.startsWith("(cyberpi.display.")
              ? 1
              : script === buttonQuery
                ? Number(playButtonPressed)
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
    globalThis.robotBluetoothMock = {
      get scripts() {
        return scripts.filter((script) => script !== buttonQuery);
      },
      allScripts: scripts,
      buttonReadings,
      get playButtonPressed() {
        return playButtonPressed;
      },
      set playButtonPressed(pressed) {
        playButtonPressed = pressed;
      },
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

async function samplePlayButton(page: Page, pressed: boolean): Promise<void> {
  const before = await page.evaluate((value) => {
    const mock = globalThis.robotBluetoothMock!;
    mock.playButtonPressed = value;
    return mock.buttonReadings.length;
  }, pressed);
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock!.buttonReadings.length),
    )
    .toBeGreaterThan(before);
  expect(
    await page.evaluate(() =>
      globalThis.robotBluetoothMock!.buttonReadings.at(-1),
    ),
  ).toBe(pressed);
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

async function installCameraMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const track = { stop() {} };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [track] }),
      },
    });
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
    HTMLVideoElement.prototype.play = async () => undefined;
  });
}

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
    '(cyberpi.display.clear(),cyberpi.display.show_label("forward 20",16,0,40,0),1)[2]',
    "(mbot2.straight(2,speed=30),1)[1]",
    "(mbot2.EM_stop(),1)[1]",
    "(mbot2.servo_set(115,3),1)[1]",
  ]);
  await page.locator(".cm-content").fill("pen_down\nforward 20\npen_up");
  await runButton.click();
  await expect(runButton).toBeEnabled();
  expect(
    await page.evaluate(() => globalThis.robotBluetoothMock?.scripts.slice(6)),
  ).toEqual([
    '(cyberpi.display.clear(),cyberpi.display.show_label("pen_down",16,0,40,0),1)[2]',
    "(mbot2.servo_set(90,3),1)[1]",
    '(cyberpi.display.clear(),cyberpi.display.show_label("forward 20",16,0,40,0),1)[2]',
    "(mbot2.straight(2,speed=30),1)[1]",
    '(cyberpi.display.clear(),cyberpi.display.show_label("pen_up",16,0,40,0),1)[2]',
    "(mbot2.servo_set(115,3),1)[1]",
    "(mbot2.EM_stop(),1)[1]",
    "(mbot2.servo_set(115,3),1)[1]",
  ]);
});

test("Run on turtlebot sends whole motion phases with command labels and updates the virtual turtle", async ({
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
  expect(scripts.slice(0, -2)).toEqual([
    '(cyberpi.display.clear(),cyberpi.display.show_label("forward 40",16,0,40,0),1)[2]',
    "(mbot2.straight(4,speed=30),1)[1]",
    '(cyberpi.display.clear(),cyberpi.display.show_label("right 360 / :sides",16,0,40,0),1)[2]',
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.straight(12.14154985015799,speed=30),1)[1]",
    "(mbot2.turn(20,speed=30),1)[1]",
    "(mbot2.straight(-13.058450149842008,speed=30),1)[1]",
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
      heading += amount;
    } else {
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

for (const trigger of ["screen", "robot"] as const) {
  test(`production preview captures and runs whole board motions with screen status from ${trigger}`, async ({
    page,
  }) => {
    await installMBot2BluetoothMock(page);
    await installCameraMock(page);
    let recognitionRequest: unknown;
    let recognitionCount = 0;
    await page.route("**/api/recognize-board", async (route) => {
      recognitionCount++;
      recognitionRequest = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          blocks: [
            {
              id: "forward-1",
              kind: "command",
              name: "forward",
              arguments: ["100"],
              bounds: { x: 0, y: 0, width: 2, height: 2 },
              confidence: 1,
              children: [],
            },
            {
              id: "right-1",
              kind: "command",
              name: "right",
              arguments: ["360"],
              bounds: { x: 0, y: 3, width: 2, height: 2 },
              confidence: 1,
              children: [],
            },
          ],
        }),
      });
    });
    await page.goto("/");
    if (trigger === "robot") {
      await page.evaluate(() => {
        globalThis.robotBluetoothMock!.playButtonPressed = true;
      });
    }
    await page.locator("#robot-controls summary").click();
    await page.locator("#robot-connect").click();
    expect(
      await page.evaluate(() => globalThis.robotBluetoothMock!.buttonReadings),
    ).toEqual([]);
    await confirmPenCalibration(page);
    if (trigger === "robot") {
      await samplePlayButton(page, true);
      await samplePlayButton(page, true);
      expect(recognitionCount).toBe(0);
      await samplePlayButton(page, false);
      await samplePlayButton(page, true);
    } else {
      await page.locator("#camera-robot-demo-button").click();
    }

    await expect(page.locator("#camera-robot-demo-status")).toHaveText(
      "Recognized program completed on turtlebot.",
    );
    await expect(page.locator(".cm-content")).toHaveText(
      "forward 100right 360",
    );
    expect(recognitionRequest).toMatchObject({
      imageWidth: 2,
      imageHeight: 2,
      imageMimeType: "image/jpeg",
    });
    expect(
      await page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    ).toEqual([
      '(cyberpi.display.clear(),cyberpi.display.show_label("Taking photo",16,0,40,0),1)[2]',
      '(cyberpi.display.clear(),cyberpi.display.show_label("Reading board",16,0,40,0),1)[2]',
      '(cyberpi.display.clear(),cyberpi.display.show_label("Running",16,0,40,0),1)[2]',
      '(cyberpi.display.clear(),cyberpi.display.show_label("forward 100",16,0,40,0),1)[2]',
      "(mbot2.straight(10,speed=30),1)[1]",
      '(cyberpi.display.clear(),cyberpi.display.show_label("right 360",16,0,40,0),1)[2]',
      "(mbot2.servo_set(90,3),1)[1]",
      "(mbot2.turn(367,speed=30),1)[1]",
      "(mbot2.EM_stop(),1)[1]",
      "(mbot2.servo_set(90,3),1)[1]",
      '(cyberpi.display.clear(),cyberpi.display.show_label("Done",16,0,40,0),1)[2]',
    ]);
    await expect(page.locator("#turtle-state")).toContainText(
      "x 0 y 100 heading 0",
    );
    const allScripts = await page.evaluate(
      () => globalThis.robotBluetoothMock!.allScripts,
    );
    const commands = await page.evaluate(
      () => globalThis.robotBluetoothMock!.scripts,
    );
    const start = allScripts.indexOf(commands[0]!);
    expect(allScripts.slice(start, start + commands.length)).toEqual(commands);

    if (trigger === "robot") {
      await samplePlayButton(page, true);
      await samplePlayButton(page, true);
      expect(recognitionCount).toBe(1);
      await samplePlayButton(page, false);
      await samplePlayButton(page, true);
      await expect.poll(() => recognitionCount).toBe(2);
      await expect(page.locator("#camera-robot-demo-status")).toHaveText(
        "Recognized program completed on turtlebot.",
      );
      await samplePlayButton(page, true);
      expect(recognitionCount).toBe(2);
    }

    await page.unroute("**/api/recognize-board");
    const previewResponse = await page.request.get("/api/recognize-board");
    expect(previewResponse.status()).toBe(405);
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
  await page.locator(".cm-content").fill("forward 40");
  await confirmPenCalibration(page);
  await page
    .getByRole("button", { name: "Run on turtlebot", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => globalThis.robotBluetoothMock?.scripts))
    .toEqual([
      '(cyberpi.display.clear(),cyberpi.display.show_label("forward 40",16,0,40,0),1)[2]',
      "(mbot2.straight(4,speed=30),1)[1]",
    ]);
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
