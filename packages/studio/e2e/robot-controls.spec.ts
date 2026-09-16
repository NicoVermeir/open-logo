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
        if (script.startsWith("mbot2.forward(")) await movementBlocked;
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
    "mbot2.EM_stop()",
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
    "mbot2.EM_stop()",
    "(mbot2.servo_set(115,3),1)[1]",
  ]);
});

test("Run on turtlebot executes whole moves and updates the virtual turtle", async ({
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
    "(mbot2.straight(4,speed=30),1)[1]",
    "(mbot2.servo_set(90,3),1)[1]",
    "(mbot2.straight(10.5,speed=30),1)[1]",
    "(mbot2.turn(20,speed=30),1)[1]",
    "(mbot2.straight(-13.8,speed=30),1)[1]",
  ]);
  expect(scripts.slice(-2)).toEqual([
    "mbot2.EM_stop()",
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
  ).toBeCloseTo(26 - 26 * Math.cos(radians) - 12 * Math.sin(radians), 8);
  expect(
    vertical + 126 * Math.cos(radians) + 26 * Math.sin(radians),
  ).toBeCloseTo(40 - 21 + 26 * Math.sin(radians) - 12 * Math.cos(radians), 8);
});

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
  expect(scripts.filter((script) => script.startsWith("(mbot2."))).toHaveLength(
    1,
  );
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
  expect(scripts.filter((script) => script.startsWith("(mbot2."))).toHaveLength(
    2,
  );
  expect(scripts.filter((script) => script.includes("straight("))).toEqual([
    "(mbot2.straight(4,speed=30),1)[1]",
  ]);
  expect(scripts).toContain("mbot2.EM_stop()");
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
    .toContain("mbot2.EM_stop()");
  await expect(page.locator("#robot-forward")).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    )
    .toContain("mbot2.forward(10,0.2)");

  await page.locator("#robot-speed").fill("100");
  await page.locator("#robot-duration").selectOption("2");
  await page.locator("#robot-forward").click();
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.robotBluetoothMock?.scripts ?? []),
    )
    .toContain("mbot2.forward(100,2)");

  await page.locator("#robot-refresh").click();
  await expect(page.locator("#robot-battery")).toHaveText("87%");
  await expect(page.locator("#robot-distance")).toHaveText("31 cm");
  await page.locator("#robot-disconnect").click();
  await expect(page.locator("#robot-status")).toHaveText("Robot disconnected.");
  await expect(page.locator("#robot-forward")).toBeDisabled();
  await expect(page.locator("#robot-stop")).toBeDisabled();
  await expect(page.locator("#robot-connect")).toBeEnabled();
});
