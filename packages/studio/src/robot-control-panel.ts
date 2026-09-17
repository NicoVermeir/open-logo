import {
  robotPenAngle,
  type MBot2ManualRobot,
  type RobotPenSettings,
} from "./mbot2-manual-robot.js";

export type RobotControlConnectionStatus =
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";
export type RobotMovement = "forward" | "backward" | "left" | "right";

export interface RobotControlPanelView {
  readonly status: RobotControlConnectionStatus;
  readonly statusMessage: string;
  readonly deviceName: string;
  readonly robotOwned: boolean;
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
  disconnect(): Promise<void>;
  move(direction: RobotMovement): Promise<void>;
  stop(): Promise<void>;
  showStatus(text: string): Promise<void>;
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
  dispose(): Promise<void>;
}

export function createRobotControlPanelController(
  connectRobot: (() => Promise<MBot2ManualRobot>) | undefined,
  executionLocked: () => boolean = () => false,
): RobotControlPanelController {
  let robot: MBot2ManualRobot | undefined;
  let disposed = false;
  let connectionRevision = 0;
  let connectionPending = false;
  let activeActionCount = 0;
  let cancelProgram: (() => void) | undefined;
  let view: RobotControlPanelView = {
    status: connectRobot === undefined ? "unsupported" : "disconnected",
    statusMessage:
      connectRobot === undefined
        ? "Web Bluetooth is unavailable in this browser."
        : "Robot disconnected.",
    deviceName: "",
    robotOwned: false,
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
    propagateFailure = false,
    reportFailure = true,
  ): Promise<void> => {
    if ((!allowWhileBusy && activeActionCount > 0) || robot === undefined)
      return;
    const actionRobot = robot;
    const actionRevision = connectionRevision;
    const ownsConnection = (): boolean =>
      !disposed &&
      robot === actionRobot &&
      connectionRevision === actionRevision;
    activeActionCount += 1;
    publish({ busy: true });
    try {
      await action();
    } catch (error) {
      if (ownsConnection() && reportFailure)
        publish({
          status: "error",
          penState: "unknown",
          penConfirmed: false,
          statusMessage:
            error instanceof Error ? error.message : "Robot command failed.",
        });
      if (propagateFailure) throw error;
    } finally {
      if (ownsConnection()) {
        activeActionCount -= 1;
        publish({ busy: activeActionCount > 0 });
      }
    }
  };
  const cleanUpAndDisconnect = async (
    activeRobot: MBot2ManualRobot,
    penSettings: Readonly<RobotPenSettings> | undefined,
  ): Promise<void> => {
    if (!activeRobot.connected) {
      activeRobot.disconnect();
      return;
    }
    const failures: unknown[] = [];
    try {
      await activeRobot.stop();
    } catch (error) {
      failures.push(error);
    }
    if (penSettings !== undefined && activeRobot.connected) {
      try {
        await activeRobot.setPenDown(false, penSettings);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      activeRobot.disconnect();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Robot safety cleanup failed.");
  };

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      listener(view);
      return () => listeners.delete(listener);
    },
    async connect() {
      if (
        connectRobot === undefined ||
        connectionPending ||
        view.busy ||
        disposed
      )
        return;
      connectionPending = true;
      const currentRevision = ++connectionRevision;
      publish({
        status: "connecting",
        penState: "unknown",
        penConfirmed: false,
        statusMessage: "Choose an mBot2...",
        busy: true,
      });
      try {
        const connectedRobot = await connectRobot();
        if (disposed || currentRevision !== connectionRevision) {
          connectedRobot.disconnect();
          return;
        }
        robot = connectedRobot;
        publish({
          status: "connected",
          statusMessage: `Connected to ${robot.deviceName}.`,
          deviceName: robot.deviceName,
          robotOwned: true,
        });
      } catch (error) {
        if (disposed || currentRevision !== connectionRevision) return;
        publish({
          status: "error",
          statusMessage:
            error instanceof Error ? error.message : "Could not connect.",
        });
      } finally {
        connectionPending = false;
        if (!disposed && currentRevision === connectionRevision)
          publish({ busy: false });
      }
    },
    async disconnect() {
      const disconnectRevision = ++connectionRevision;
      cancelProgram?.();
      const activeRobot = robot;
      const penSettings = view.penConfirmed ? view.penSettings : undefined;
      if (activeRobot === undefined) {
        publish({
          status: "disconnected",
          penState: "unknown",
          penConfirmed: false,
          statusMessage: "Robot disconnected.",
          deviceName: "",
          robotOwned: false,
          busy: false,
        });
        return;
      }
      publish({
        status: "disconnecting",
        penState: "unknown",
        penConfirmed: false,
        statusMessage: "Stopping robot before disconnecting...",
        robotOwned: true,
        busy: true,
      });
      try {
        await cleanUpAndDisconnect(activeRobot, penSettings);
        if (!disposed && connectionRevision === disconnectRevision) {
          robot = undefined;
          activeActionCount = 0;
          publish({
            status: "disconnected",
            statusMessage: "Robot disconnected.",
            deviceName: "",
            robotOwned: false,
            busy: false,
          });
        }
      } catch (error) {
        if (!disposed && connectionRevision === disconnectRevision) {
          const stillOwned = activeRobot.connected;
          if (!stillOwned) robot = undefined;
          activeActionCount = 0;
          publish({
            status: "error",
            statusMessage:
              error instanceof Error
                ? error.message
                : "Robot safety cleanup failed.",
            deviceName: stillOwned ? activeRobot.deviceName : "",
            robotOwned: stillOwned,
            busy: false,
          });
        }
        throw error;
      }
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
      return runAction(() => robot!.stop(), true, true);
    },
    showStatus(text) {
      return runAction(
        () => robot!.showStatus?.(text) ?? Promise.resolve(),
        false,
        true,
        false,
      );
    },
    refreshStatus() {
      if (executionLocked()) return Promise.resolve();
      const activeRobot = robot;
      return runAction(
        async () => {
          const [battery, distance] = await Promise.all([
            activeRobot!.battery(),
            activeRobot!.distance(),
          ]);
          if (disposed || robot !== activeRobot || !activeRobot!.connected)
            return;
          publish({
            battery,
            distance,
            statusMessage: "Robot status refreshed.",
          });
        },
        false,
        true,
      );
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
      const programRevision = connectionRevision;
      const penSettings = view.penConfirmed
        ? Object.freeze({ ...view.penSettings })
        : undefined;
      return runAction(
        async () => {
          let cancelled = false;
          const cancelThisProgram = () => {
            cancelled = true;
          };
          const ownsProgram = (): boolean =>
            !disposed &&
            robot === activeRobot &&
            connectionRevision === programRevision &&
            cancelProgram === cancelThisProgram;
          cancelProgram = cancelThisProgram;
          try {
            publish({ penState: "unknown" });
            await action(activeRobot, () => cancelled, penSettings);
          } catch (error) {
            if (ownsProgram())
              publish({
                status: activeRobot.connected ? "connected" : "error",
                statusMessage:
                  error instanceof Error ? error.message : "Robot run failed.",
              });
            throw error;
          } finally {
            try {
              if (activeRobot.connected) {
                try {
                  await activeRobot.stop();
                } finally {
                  if (penSettings !== undefined && activeRobot.connected) {
                    await activeRobot.setPenDown(false, penSettings);
                    if (ownsProgram() && activeRobot.connected)
                      publish({ penState: "up" });
                  }
                }
              }
            } finally {
              if (cancelProgram === cancelThisProgram)
                cancelProgram = undefined;
            }
          }
        },
        false,
        true,
        false,
      );
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
    async dispose() {
      disposed = true;
      connectionRevision++;
      cancelProgram?.();
      const activeRobot = robot;
      const penSettings = view.penConfirmed ? view.penSettings : undefined;
      robot = undefined;
      activeActionCount = 0;
      listeners.clear();
      if (activeRobot !== undefined)
        await cleanUpAndDisconnect(activeRobot, penSettings);
    },
  };
}
