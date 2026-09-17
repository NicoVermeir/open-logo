import type { SourceSpan } from "@openlogo/core";
import type { MBot2WebBluetoothTransport } from "./mbot2-web-bluetooth.js";

export const MBOT2_MINIMUM_SPEED = 10;
export const MBOT2_MAXIMUM_SPEED = 100;
export const MBOT2_MINIMUM_DURATION_SECONDS = 0.1;
export const MBOT2_MAXIMUM_DURATION_SECONDS = 2;
export const MBOT2_MAXIMUM_STRAIGHT_SEGMENT_CENTIMETERS = 2;
export const MBOT2_MAXIMUM_TURN_SEGMENT_DEGREES = 10;

const ROBOT_SCREEN_WIDTH = 128;
const ROBOT_SCREEN_HEIGHT = 128;
const ROBOT_CODE_FONT_SIZE = 16;
const ROBOT_CODE_ROWS = 7;

export interface RobotPenSettings {
  downAngle: number;
  raisedAngle: number;
  measuredLiftMillimeters: number;
  liftMillimeters: number;
  settleMilliseconds: number;
}

export function robotPenAngle(
  down: boolean,
  settings: RobotPenSettings,
): number {
  const {
    downAngle,
    raisedAngle,
    measuredLiftMillimeters,
    liftMillimeters,
    settleMilliseconds,
  } = settings;
  const useEndpoints =
    Number.isNaN(measuredLiftMillimeters) && Number.isNaN(liftMillimeters);
  if (
    ![downAngle, raisedAngle, settleMilliseconds].every(Number.isFinite) ||
    !Number.isInteger(downAngle) ||
    !Number.isInteger(raisedAngle) ||
    downAngle < 0 ||
    downAngle > 180 ||
    raisedAngle < 0 ||
    raisedAngle > 180 ||
    downAngle === raisedAngle ||
    (!useEndpoints &&
      (!Number.isFinite(measuredLiftMillimeters) ||
        !Number.isFinite(liftMillimeters) ||
        measuredLiftMillimeters <= 0 ||
        liftMillimeters <= 0 ||
        liftMillimeters > measuredLiftMillimeters)) ||
    settleMilliseconds < 100 ||
    settleMilliseconds > 2000
  ) {
    throw new Error(
      "Calibrate the pen: distinct safe angles (0-180 degrees), positive lift within the measured range, and settling time of 100-2000 ms are required.",
    );
  }
  return down
    ? downAngle
    : useEndpoints
      ? raisedAngle
      : Math.round(
          downAngle +
            ((raisedAngle - downAngle) * liftMillimeters) /
              measuredLiftMillimeters,
        );
}

export interface MBot2ManualRobot {
  readonly deviceName: string;
  readonly connected: boolean;
  showStatus?(text: string): Promise<void>;
  showProgram?(
    source: string,
    currentInstruction: SourceSpan,
    showMarker?: boolean,
  ): Promise<void>;
  isPlayButtonPressed?(): Promise<boolean>;
  forward(speed: number, durationSeconds: number): Promise<void>;
  backward(speed: number, durationSeconds: number): Promise<void>;
  turnLeft(speed: number, durationSeconds: number): Promise<void>;
  turnRight(speed: number, durationSeconds: number): Promise<void>;
  moveCentimeters(distance: number, cancelled?: () => boolean): Promise<void>;
  turnDegrees(angle: number, cancelled?: () => boolean): Promise<void>;
  setPenAngle(angle: number, settleMilliseconds: number): Promise<void>;
  setPenDown(down: boolean, settings: RobotPenSettings): Promise<void>;
  stop(): Promise<void>;
  battery(): Promise<number | undefined>;
  distance(): Promise<number | undefined>;
  disconnect(): void;
}

export function createMBot2ManualRobot(
  transport: MBot2WebBluetoothTransport,
): MBot2ManualRobot {
  const setPenAngle = async (
    angle: number,
    settleMilliseconds: number,
  ): Promise<void> => {
    if (
      !Number.isInteger(angle) ||
      angle < 0 ||
      angle > 180 ||
      !Number.isFinite(settleMilliseconds) ||
      settleMilliseconds < 100 ||
      settleMilliseconds > 2000
    ) {
      throw new Error(
        "A safe integer servo angle (0-180 degrees) and settling time (100-2000 ms) are required.",
      );
    }
    if (!transport.connected) throw new Error("The robot disconnected.");
    const response = await transport.evaluate(
      `(mbot2.servo_set(${angle},3),1)[1]`,
    );
    if (response !== 1)
      throw new Error(
        "Pen command was not acknowledged. Check the robot before trying again.",
      );
    await new Promise<void>((resolve) => {
      const host = globalThis as unknown as {
        setTimeout(callback: () => void, delay: number): unknown;
      };
      host.setTimeout(resolve, settleMilliseconds);
    });
    if (!transport.connected) throw new Error("The robot disconnected.");
  };
  const move = async (
    command: "forward" | "backward" | "turn_left" | "turn_right",
    speed: number,
    durationSeconds: number,
  ): Promise<void> => {
    const response = await transport.evaluate(
      `(mbot2.${command}(${clampInteger(speed, MBOT2_MINIMUM_SPEED, MBOT2_MAXIMUM_SPEED)},${formatDuration(durationSeconds)}),1)[1]`,
      4_000,
    );
    if (response !== 1)
      throw new Error(
        "Robot movement was not acknowledged. Check the robot before trying again.",
      );
  };

  return {
    deviceName: transport.deviceName,
    get connected() {
      return transport.connected;
    },
    isPlayButtonPressed: async () => {
      if (!transport.connected) throw new Error("The robot disconnected.");
      const response = await transport.evaluate(
        "(1 if cyberpi.controller.is_press('b') else 0)",
      );
      if (response !== 0 && response !== 1)
        throw new Error("Robot button state was not acknowledged.");
      return response === 1;
    },
    showStatus: async (text) => {
      if (!transport.connected) throw new Error("The robot disconnected.");
      const screenText = text.slice(0, 40);
      const response = await transport.evaluate(
        `(cyberpi.display.clear(),cyberpi.display.show_label(${JSON.stringify(screenText)},16,0,40,0),1)[2]`,
      );
      if (response !== 1)
        throw new Error("Robot screen update was not acknowledged.");
    },
    showProgram: async (source, currentInstruction, showMarker = true) => {
      if (!transport.connected) throw new Error("The robot disconnected.");
      const rows = robotProgramRows(source, currentInstruction, showMarker);
      const top =
        (ROBOT_SCREEN_HEIGHT - ROBOT_CODE_ROWS * ROBOT_CODE_FONT_SIZE) / 2;
      const response = await transport.evaluate(
        `(cyberpi.display.clear(),cyberpi.display.show_label(${JSON.stringify(rows.join("\n"))},${ROBOT_CODE_FONT_SIZE},0,${top},0),1)[2]`,
      );
      if (response !== 1)
        throw new Error("Robot screen update was not acknowledged.");
      if (!transport.connected) throw new Error("The robot disconnected.");
    },
    forward: (speed, durationSeconds) =>
      move("forward", speed, durationSeconds),
    backward: (speed, durationSeconds) =>
      move("backward", speed, durationSeconds),
    turnLeft: (speed, durationSeconds) =>
      move("turn_left", speed, durationSeconds),
    turnRight: (speed, durationSeconds) =>
      move("turn_right", speed, durationSeconds),
    moveCentimeters: (distance, cancelled) =>
      acknowledgedMotion(
        transport,
        "straight",
        distance,
        MBOT2_MAXIMUM_STRAIGHT_SEGMENT_CENTIMETERS,
        cancelled,
      ),
    turnDegrees: (angle, cancelled) =>
      acknowledgedMotion(
        transport,
        "turn",
        angle,
        MBOT2_MAXIMUM_TURN_SEGMENT_DEGREES,
        cancelled,
      ),
    setPenAngle,
    setPenDown: async (down, settings) =>
      setPenAngle(robotPenAngle(down, settings), settings.settleMilliseconds),
    stop: async () => {
      const response = await transport.evaluate("(mbot2.EM_stop(),1)[1]");
      if (response !== 1)
        throw new Error(
          "Emergency Stop was not acknowledged. Keep clear of the robot and disconnect it manually.",
        );
    },
    battery: () => evaluateNumber(transport, "cyberpi.get_battery()"),
    distance: () => evaluateNumber(transport, "cyberpi.ultrasonic2.get(1)"),
    disconnect: () => transport.disconnect(),
  };
}

function robotProgramRows(
  source: string,
  currentInstruction: SourceSpan,
  showMarker: boolean,
): string[] {
  const rows: string[] = [];
  let activeRow = 0;
  for (const [lineIndex, line] of source.split(/\r\n?|\n/).entries()) {
    let row = "";
    let width = 0;
    let column = 1;
    for (const character of line) {
      const active =
        lineIndex + 1 === currentInstruction.start[0] &&
        column === currentInstruction.start[1];
      const text = character === "\t" ? "  " : character;
      const characterWidth =
        character === "\t" || character.codePointAt(0)! > 127
          ? ROBOT_CODE_FONT_SIZE
          : ROBOT_CODE_FONT_SIZE / 2;
      const markedWidth =
        characterWidth + (active ? ROBOT_CODE_FONT_SIZE / 2 : 0);
      if (width + markedWidth > ROBOT_SCREEN_WIDTH) {
        rows.push(row);
        row = "";
        width = 0;
      }
      if (active) activeRow = rows.length;
      row += (active ? (showMarker ? ">" : " ") : "") + text;
      width += markedWidth;
      column += character.length;
    }
    rows.push(row);
  }
  if (rows.length <= ROBOT_CODE_ROWS) return rows;
  const firstRow = activeRow - Math.floor(ROBOT_CODE_ROWS / 2);
  return Array.from(
    { length: ROBOT_CODE_ROWS },
    (_, index) => rows[firstRow + index] ?? "",
  );
}

async function acknowledgedMotion(
  transport: MBot2WebBluetoothTransport,
  command: "straight" | "turn",
  amount: number,
  maximumSegmentSize: number,
  cancelled: () => boolean = () => false,
): Promise<void> {
  if (!Number.isFinite(amount) || Math.abs(amount) > maximumSegmentSize * 500) {
    throw new Error("Robot movement exceeds the bounded motion size.");
  }
  if (cancelled()) throw new Error("Robot run stopped.");
  if (!transport.connected) throw new Error("The robot disconnected.");
  if (amount === 0) return;
  const response = await transport.evaluate(
    `(mbot2.${command}(${amount},speed=30),1)[1]`,
    3_000 + Math.ceil(Math.abs(amount) / maximumSegmentSize) * 1_000,
  );
  if (cancelled()) throw new Error("Robot run stopped.");
  if (!transport.connected) throw new Error("The robot disconnected.");
  if (response !== 1) {
    throw new Error(
      "Robot movement was not acknowledged. Check the robot before running again.",
    );
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finiteValue = Number.isFinite(value) ? value : minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, finiteValue)));
}

function formatDuration(value: number): string {
  const finiteValue = Number.isFinite(value)
    ? value
    : MBOT2_MINIMUM_DURATION_SECONDS;
  const duration = Math.min(
    MBOT2_MAXIMUM_DURATION_SECONDS,
    Math.max(MBOT2_MINIMUM_DURATION_SECONDS, finiteValue),
  );
  return String(Math.round(duration * 10) / 10);
}

async function evaluateNumber(
  transport: MBot2WebBluetoothTransport,
  expression: string,
): Promise<number | undefined> {
  const value = await transport.evaluate(expression);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
