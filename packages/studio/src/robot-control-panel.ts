import {
  robotPenAngle,
  type MBot2ManualRobot,
  type RobotPenSettings,
} from "./mbot2-manual-robot.js";

export type RobotControlConnectionStatus =
  "unsupported" | "disconnected" | "connecting" | "connected" | "error";
export type RobotMovement = "forward" | "backward" | "left" | "right";

export interface RobotControlPanelView {
  readonly status: RobotControlConnectionStatus;
  readonly statusMessage: string;
  readonly deviceName: string;
  readonly speed: number;
  readonly durationSeconds: number;
  readonly battery: number | undefined;
  readonly distance: number | undefined;
  readonly busy: boolean;
  readonly penSettings: Readonly<RobotPenSettings>;
  readonly penConfirmed: boolean;
  readonly penState: "unknown" | "up" | "down";
}

export interface RobotControlPanelController {
  getView(): RobotControlPanelView;
  subscribe(listener: (view: RobotControlPanelView) => void): () => void;
  connect(): Promise<void>;
  disconnect(): void;
  move(direction: RobotMovement): Promise<void>;
  stop(): Promise<void>;
  refreshStatus(): Promise<void>;
  setPenSettings(settings: Partial<RobotPenSettings>): void;
  confirmPenSettings(): void;
  setPenDown(down: boolean): Promise<void>;
  testPenAngle(endpoint: "downAngle" | "raisedAngle"): Promise<void>;
  runProgram(
    action: (
      robot: MBot2ManualRobot,
      cancelled: () => boolean,
      penSettings: Readonly<RobotPenSettings> | undefined,
    ) => Promise<void>,
  ): Promise<void>;
  setSpeed(speed: number): void;
  setDuration(durationSeconds: number): void;
  dispose(): void;
}

export function createRobotControlPanelController(
  connectRobot: (() => Promise<MBot2ManualRobot>) | undefined,
  executionLocked: () => boolean = () => false,
): RobotControlPanelController {
  let robot: MBot2ManualRobot | undefined;
  let disposed = false;
  let activeActionCount = 0;
  let cancelProgram: (() => void) | undefined;
  let view: RobotControlPanelView = {
    status: connectRobot === undefined ? "unsupported" : "disconnected",
    statusMessage:
      connectRobot === undefined
        ? "Web Bluetooth is unavailable in this browser."
        : "Robot disconnected.",
    deviceName: "",
    speed: 50,
    durationSeconds: 0.5,
    battery: undefined,
    distance: undefined,
    busy: false,
    penSettings: Object.freeze({
      downAngle: 90,
      raisedAngle: 115,
      measuredLiftMillimeters: NaN,
      liftMillimeters: NaN,
      settleMilliseconds: 200,
    }),
    penConfirmed: false,
    penState: "unknown",
  };
  const listeners = new Set<(view: RobotControlPanelView) => void>();
  const publish = (changes: Partial<RobotControlPanelView>): void => {
    view = { ...view, ...changes };
    for (const listener of listeners) listener(view);
  };
  const runAction = async (
    action: () => Promise<void>,
    allowWhileBusy = false,
  ): Promise<void> => {
    if ((!allowWhileBusy && activeActionCount > 0) || robot === undefined)
      return;
    activeActionCount += 1;
    publish({ busy: true });
    try {
      await action();
    } catch (error) {
      publish({
        status: "error",
        penState: "unknown",
        penConfirmed: false,
        statusMessage:
          error instanceof Error ? error.message : "Robot command failed.",
      });
    } finally {
      activeActionCount -= 1;
      publish({ busy: activeActionCount > 0 });
    }
  };

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      listener(view);
      return () => listeners.delete(listener);
    },
    async connect() {
      if (connectRobot === undefined || view.busy || disposed) return;
      publish({
        status: "connecting",
        penState: "unknown",
        penConfirmed: false,
        statusMessage: "Choose an mBot2...",
        busy: true,
      });
      try {
        robot = await connectRobot();
        publish({
          status: "connected",
          statusMessage: `Connected to ${robot.deviceName}.`,
          deviceName: robot.deviceName,
        });
      } catch (error) {
        publish({
          status: "error",
          statusMessage:
            error instanceof Error ? error.message : "Could not connect.",
        });
      } finally {
        publish({ busy: false });
      }
    },
    disconnect() {
      cancelProgram?.();
      robot?.disconnect();
      robot = undefined;
      publish({
        status: "disconnected",
        penState: "unknown",
        penConfirmed: false,
        statusMessage: "Robot disconnected.",
        deviceName: "",
      });
    },
    move(direction) {
      if (executionLocked()) return Promise.resolve();
      return runAction(() => {
        const actions = {
          forward: robot!.forward,
          backward: robot!.backward,
          left: robot!.turnLeft,
          right: robot!.turnRight,
        };
        return actions[direction](view.speed, view.durationSeconds);
      });
    },
    stop() {
      cancelProgram?.();
      return runAction(() => robot!.stop(), true);
    },
    refreshStatus() {
      if (executionLocked()) return Promise.resolve();
      return runAction(async () => {
        const [battery, distance] = await Promise.all([
          robot!.battery(),
          robot!.distance(),
        ]);
        publish({
          battery,
          distance,
          statusMessage: "Robot status refreshed.",
        });
      });
    },
    runProgram(action) {
      if (
        executionLocked() ||
        view.busy ||
        robot === undefined ||
        !robot.connected
      )
        return Promise.resolve();
      const activeRobot = robot;
      const penSettings = view.penConfirmed
        ? Object.freeze({ ...view.penSettings })
        : undefined;
      return runAction(async () => {
        let cancelled = false;
        cancelProgram = () => {
          cancelled = true;
        };
        try {
          publish({ penState: "unknown" });
          await action(activeRobot, () => cancelled, penSettings);
        } catch (error) {
          publish({
            status: activeRobot.connected ? "connected" : "error",
            statusMessage:
              error instanceof Error ? error.message : "Robot run failed.",
          });
        } finally {
          try {
            if (activeRobot.connected) {
              try {
                await activeRobot.stop();
              } finally {
                if (penSettings !== undefined && activeRobot.connected) {
                  await activeRobot.setPenDown(false, penSettings);
                  if (robot === activeRobot && activeRobot.connected)
                    publish({ penState: "up" });
                }
              }
            }
          } finally {
            cancelProgram = undefined;
          }
        }
      });
    },
    setPenSettings(settings) {
      if (disposed || view.busy || executionLocked()) return;
      publish({
        penSettings: Object.freeze({ ...view.penSettings, ...settings }),
        penConfirmed: false,
        penState: "unknown",
      });
    },
    confirmPenSettings() {
      if (disposed || view.busy || executionLocked() || !robot?.connected)
        return;
      try {
        robotPenAngle(false, view.penSettings);
        publish({
          penConfirmed: true,
          status: "connected",
          statusMessage: "Pen calibration confirmed for socket 3.",
        });
      } catch (error) {
        publish({
          penConfirmed: false,
          statusMessage: (error as Error).message,
        });
      }
    },
    setPenDown(down) {
      if (disposed || executionLocked() || !view.penConfirmed)
        return Promise.resolve();
      const activeRobot = robot;
      const settings = { ...view.penSettings };
      return runAction(async () => {
        publish({ penState: "unknown" });
        await activeRobot!.setPenDown(down, settings);
        if (robot === activeRobot && activeRobot!.connected)
          publish({ penState: down ? "down" : "up" });
      });
    },
    testPenAngle(endpoint) {
      if (disposed || executionLocked()) return Promise.resolve();
      const activeRobot = robot;
      const settings = { ...view.penSettings };
      return runAction(async () => {
        publish({ penState: "unknown", penConfirmed: false });
        await activeRobot!.setPenAngle(
          settings[endpoint],
          settings.settleMilliseconds,
        );
        if (robot === activeRobot && activeRobot!.connected)
          publish({
            status: "connected",
            statusMessage: "Calibration angle command completed.",
          });
      });
    },
    setSpeed(speed) {
      publish({ speed });
    },
    setDuration(durationSeconds) {
      publish({ durationSeconds });
    },
    dispose() {
      disposed = true;
      cancelProgram?.();
      robot?.disconnect();
      robot = undefined;
      listeners.clear();
    },
  };
}
