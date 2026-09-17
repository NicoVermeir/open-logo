import type {
  MovePayload,
  PenChangePayload,
  ProcedureEnterPayload,
  ProcedureExitPayload,
  SourceSpan,
  TraceEvent,
} from "@openlogo/core";
import { execute } from "@openlogo/runtime";
import { check, isPrimitiveCommandName, parse, walk } from "@openlogo/parser";
import {
  INITIAL_TURTLE_SCENE,
  INITIAL_TURTLE_WORLD_STATE,
  reduceTurtleScene,
  reduceTurtleWorldState,
} from "@openlogo/turtle";
import { collectOutput } from "./execution-host.js";
import {
  robotPenAngle,
  type MBot2ManualRobot,
  type RobotPenSettings,
} from "./mbot2-manual-robot.js";
import type { StudioStateStore } from "./state-model.js";
import type { RunController } from "./run-controller.js";
import type { RobotControlPanelController } from "./robot-control-panel.js";

const SUPPORTED_EVENTS = new Set([
  "instruction",
  "move",
  "turn",
  "draw-segment",
  "pen-change",
  "color-change",
  "width-change",
  "background-change",
  "shape-change",
  "visibility-change",
  "print",
  "procedure-enter",
  "procedure-exit",
  "return",
]);

export interface RobotProgramOptions {
  readonly state: StudioStateStore;
  readonly repaint: () => void;
  readonly cancelled: () => boolean;
  readonly penSettings?: Readonly<RobotPenSettings>;
}

export async function runRobotProgram(
  robot: MBot2ManualRobot,
  options: RobotProgramOptions,
): Promise<void> {
  const { state, repaint, cancelled } = options;
  const source = state.getState().source;
  const parsed = parse(source, "studio.logo");
  const diagnostics = [
    ...parsed.diagnostics,
    ...check(parsed.ast, {
      profiles: ["core-language", "turtle-rendering"],
      source,
    }).diagnostics,
  ];
  state.setDiagnostics(diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error("Fix the program diagnostics before running on the robot.");
  }
  const sourceLines = source.split("\n");
  const lines = [...sourceLines];
  const wrappers = new Map<
    string,
    { span: SourceSpan; command: "left" | "right" }
  >();
  const definitions: string[] = [];
  const commands = new Set([
    "forward",
    "back",
    "left",
    "right",
    "pen_up",
    "pen_down",
    "print",
    "set_color",
    "set_width",
    "set_background",
    "show_turtle",
    "hide_turtle",
  ]);
  walk(parsed.ast, (node) => {
    if (node.kind !== "Call" && node.kind !== "ParenCall") return;
    const name = node.canonical ?? node.callee.name;
    if (isPrimitiveCommandName(name) && !commands.has(name)) {
      throw new Error(`Robot runs do not support ${name}.`);
    }
    if (name === "left" || name === "right") {
      let suffix = wrappers.size;
      let wrapper: string;
      do {
        wrapper = `r${(suffix++).toString(36).padStart(name.length - 1, "0")}`;
      } while (source.toLowerCase().includes(wrapper) || wrappers.has(wrapper));
      if (wrapper.length !== name.length)
        throw new Error("Robot program contains too many turn commands.");
      wrappers.set(wrapper, {
        span: node.source_span,
        command: name,
      });
      const [line, column] = node.callee.source_span.start;
      lines[line - 1] =
        lines[line - 1]!.slice(0, column - 1) +
        wrapper +
        lines[line - 1]!.slice(column - 1 + name.length);
      definitions.push(
        `define ${wrapper} :robot_turn_value\n${name} :robot_turn_value\nend`,
      );
    }
  });
  const result = execute(
    `${lines.join("\n")}\n${definitions.join("\n")}`,
    "studio.logo",
    { instructionBudget: 5_000 },
  );
  state.setDiagnostics(
    result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      source_span:
        diagnostic.source_span.start[0] > lines.length
          ? [...wrappers.values()][
              Math.floor(
                (diagnostic.source_span.start[0] - lines.length - 1) / 3,
              )
            ]!.span
          : diagnostic.source_span,
    })),
  );
  if (result.diagnostics.length > 0) {
    throw new Error("Fix the program diagnostics before running on the robot.");
  }
  const turns = new Map<number, RobotTurn>();
  const events: TraceEvent[] = [];
  let activeTurn: (RobotTurn & { span: SourceSpan }) | undefined;
  for (const event of result.events) {
    if (event.kind === "procedure-enter") {
      const payload = event.payload as ProcedureEnterPayload;
      const wrapper = wrappers.get(payload.name);
      if (wrapper !== undefined) {
        const amount = payload.args[0];
        if (typeof amount !== "number" || !Number.isFinite(amount))
          throw new Error("Robot turns require a finite numeric angle.");
        activeTurn = {
          span: wrapper.span,
          command: wrapper.command,
          angle: amount * (wrapper.command === "left" ? -1 : 1),
        };
        continue;
      }
    }
    if (
      event.kind === "procedure-exit" &&
      wrappers.has((event.payload as ProcedureExitPayload).name)
    )
      continue;
    if (event.kind === "turn" && activeTurn !== undefined) {
      turns.set(event.seq, activeTurn);
      events.push({ ...event, source_span: activeTurn.span });
      activeTurn = undefined;
    } else if (event.source_span.start[0] <= lines.length) {
      events.push(event);
    }
  }
  const sourceTurn = (event: TraceEvent): RobotTurn => {
    const turn = turns.get(event.seq);
    if (turn === undefined)
      throw new Error("Robot turn has no supported source command.");
    return turn;
  };
  const turnPlans = new Map<number, readonly RobotMotion[]>();
  let segmentCount = 0;
  for (const event of events) {
    if (!SUPPORTED_EVENTS.has(event.kind) || event.turtle_id !== undefined) {
      throw new Error(
        `Robot runs do not support ${event.kind} or multiple turtles.`,
      );
    }
    if (event.kind === "move") {
      segmentCount += Math.max(
        1,
        Math.ceil(Math.abs(movementDistance(event)) / 20),
      );
    }
    if (event.kind === "turn") {
      const plan = compensatedTurn(sourceTurn(event));
      turnPlans.set(event.seq, plan);
      for (const motion of plan) segmentCount += motionSegments(motion);
    }
  }
  if (segmentCount > 500)
    throw new Error("Robot program exceeds 500 motion segments.");
  if (options.penSettings === undefined)
    throw new Error("Confirm pen calibration before running on the robot.");
  const penSettings = Object.freeze({ ...options.penSettings });
  robotPenAngle(false, penSettings);
  state.setTurtleWorld(INITIAL_TURTLE_WORLD_STATE);
  state.setTurtleScene(INITIAL_TURTLE_SCENE);
  state.setOutput([]);
  state.setTutorOutput([]);
  repaint();

  const checkActive = (): void => {
    if (cancelled()) throw new Error("Robot run stopped.");
    if (!robot.connected) throw new Error("Robot disconnected during the run.");
  };
  const sourceCommand = (span: SourceSpan): string => {
    const [startLine, startColumn] = span.start;
    const [endLine, endColumn] = span.end;
    const commandLines = sourceLines.slice(startLine - 1, endLine);
    commandLines[0] = commandLines[0]!.slice(startColumn - 1);
    commandLines[commandLines.length - 1] = commandLines[
      commandLines.length - 1
    ]!.slice(0, endColumn - (startLine === endLine ? startColumn : 1));
    return commandLines.join(" ").replaceAll(/\s+/g, " ").trim();
  };
  const showCommand = robot.showStatus
    ? async (event: TraceEvent): Promise<void> => {
        await robot.showStatus!(sourceCommand(event.source_span));
        checkActive();
      }
    : undefined;
  const apply = (event: TraceEvent): void => {
    state.setTurtleWorld(
      reduceTurtleWorldState(state.getState().turtleWorld, event),
    );
    state.setTurtleScene(
      reduceTurtleScene(state.getState().turtleScene, event),
    );
  };
  let programPenDown = false;
  checkActive();
  for (let index = 0; index < events.length; index++) {
    checkActive();
    const event = events[index]!;
    if (event.kind === "instruction")
      state.setCurrentInstructionSourceSpan(event.source_span);
    if (event.kind === "turn") {
      const plan = turnPlans.get(event.seq)!;
      if (plan.length > 0) {
        if (showCommand) await showCommand(event);
        await robot.setPenDown(false, penSettings);
        checkActive();
        for (const motion of plan) {
          if (motion.amount === 0) continue;
          checkActive();
          if (motion.kind === "move")
            await robot.moveCentimeters(motion.amount / 10, cancelled);
          else await robot.turnDegrees(motion.amount, cancelled);
          checkActive();
        }
        if (programPenDown) {
          await robot.setPenDown(true, penSettings);
          checkActive();
        }
      }
      apply(event);
      repaint();
      continue;
    }
    if (event.kind === "move") {
      const amount = movementDistance(event);
      const following = events[index + 1];
      const drawing =
        following?.kind === "draw-segment" ? following : undefined;
      checkActive();
      if (showCommand) await showCommand(event);
      await robot.moveCentimeters(amount / 10, cancelled);
      checkActive();
      apply(event);
      if (drawing !== undefined) apply(drawing);
      repaint();
      if (drawing !== undefined) index++;
    } else {
      if (event.kind === "pen-change") {
        if (showCommand) await showCommand(event);
        await robot.setPenDown(
          (event.payload as PenChangePayload).to === "down",
          penSettings,
        );
        checkActive();
        programPenDown = (event.payload as PenChangePayload).to === "down";
      }
      apply(event);
      if (event.kind === "print")
        state.setOutput([
          ...state.getState().output,
          ...collectOutput([event]),
        ]);
      repaint();
    }
  }
}

interface RobotTurn {
  readonly command: "left" | "right";
  readonly angle: number;
}

interface RobotMotion {
  readonly kind: "move" | "turn";
  readonly amount: number;
}

function motionSegments(motion: RobotMotion): number {
  return Math.ceil(
    Math.abs(motion.amount) / (motion.kind === "move" ? 20 : 10),
  );
}

function compensatedTurn({ angle }: RobotTurn): readonly RobotMotion[] {
  if (angle === 0) return [];
  if (Math.abs(angle) === 360) {
    const fullTurnCorrectionDegrees = 7;
    return [
      {
        kind: "turn",
        amount: angle + Math.sign(angle) * fullTurnCorrectionDegrees,
      },
    ];
  }
  if (Math.abs(angle) === 450) {
    const direction = Math.sign(angle);
    const turnCommand = angle > 0 ? "right" : "left";
    return [
      ...compensatedTurn({ command: turnCommand, angle: direction * 360 }),
      ...compensatedTurn({ command: turnCommand, angle: direction * 90 }),
    ];
  }
  const forwardOffsetMillimeters = 126;
  const leftOffsetMillimeters = 26;
  const radians = ((angle % 360) * Math.PI) / 180;
  const lateralCompensationMillimeters =
    leftOffsetMillimeters * Math.tan(radians / 2);
  if (Math.abs(lateralCompensationMillimeters) <= forwardOffsetMillimeters) {
    const hardwareTurnDegrees =
      Math.abs(angle) === 90 ? angle + Math.sign(angle) : angle;
    return [
      {
        kind: "move",
        amount: forwardOffsetMillimeters - lateralCompensationMillimeters,
      },
      { kind: "turn", amount: hardwareTurnDegrees },
      {
        kind: "move",
        amount: -(forwardOffsetMillimeters + lateralCompensationMillimeters),
      },
    ];
  }
  const clockwiseHalfTurnLeftCorrectionMillimeters = angle === 180 ? 13.3 : 0;
  const horizontal =
    leftOffsetMillimeters * (Math.cos(radians) - 1) -
    forwardOffsetMillimeters * Math.sin(radians) -
    clockwiseHalfTurnLeftCorrectionMillimeters;
  const vertical =
    forwardOffsetMillimeters * (1 - Math.cos(radians)) -
    leftOffsetMillimeters * Math.sin(radians);
  const distance = Math.hypot(horizontal, vertical);
  const translationHeading = (Math.atan2(horizontal, vertical) * 180) / Math.PI;
  return [
    { kind: "turn", amount: translationHeading },
    { kind: "move", amount: distance },
    { kind: "turn", amount: angle - translationHeading },
  ];
}

function movementDistance(event: TraceEvent): number {
  const payload = event.payload as MovePayload;
  const horizontal = payload.to[0] - payload.from[0];
  const vertical = payload.to[1] - payload.from[1];
  const radians = (payload.heading * Math.PI) / 180;
  const distance =
    horizontal * Math.sin(radians) + vertical * Math.cos(radians);
  if (
    !Number.isFinite(distance) ||
    Math.abs(horizontal * Math.cos(radians) - vertical * Math.sin(radians)) >
      0.00001
  ) {
    throw new Error("Robot runs require movement along the turtle heading.");
  }
  return distance;
}

export function createRobotRunController(
  normal: RunController,
  controls: RobotControlPanelController,
  repaint: () => void,
): RunController & {
  resetRobot(): Promise<void>;
  runOnRobot(): Promise<boolean>;
} {
  const { state } = normal;
  let runningRobot = false;
  let revision = 0;
  const resetRobot = async (): Promise<void> => {
    const resetRevision = ++revision;
    if (!runningRobot) {
      normal.reset();
      return;
    }
    try {
      await controls.stop();
      if (resetRevision === revision) normal.reset();
    } catch (error) {
      if (resetRevision === revision)
        state.setNotice({
          level: "warning",
          message:
            error instanceof Error ? error.message : "Robot stop failed.",
        });
      throw error;
    }
  };
  return {
    ...normal,
    run() {
      if (!controls.getView().busy) normal.run();
    },
    step() {
      if (!controls.getView().busy) normal.step();
    },
    stop() {
      if (runningRobot) {
        const stoppingRevision = revision;
        void controls
          .stop()
          .then(() => {
            if (
              stoppingRevision === revision &&
              state.getState().runStatus === "running"
            ) {
              state.setRunStatus("stopped");
              state.setCurrentInstructionSourceSpan(null);
            }
          })
          .catch((error: unknown) => {
            if (stoppingRevision === revision)
              state.setNotice({
                level: "warning",
                message:
                  error instanceof Error ? error.message : "Robot stop failed.",
              });
          });
      } else normal.stop();
    },
    reset() {
      void resetRobot().catch(() => undefined);
    },
    resetRobot,
    deliverKey(key) {
      return runningRobot ? false : normal.deliverKey(key);
    },
    deliverClick() {
      return runningRobot ? false : normal.deliverClick();
    },
    async runOnRobot() {
      if (state.getState().runStatus === "running" || runningRobot)
        return false;
      let completed = false;
      let currentRevision: number | undefined;
      try {
        await controls.runProgram(async (robot, cancelled, penSettings) => {
          normal.reset();
          runningRobot = true;
          currentRevision = ++revision;
          const source = state.getState().source;
          state.setNotice(null);
          state.setRunStatus("running");
          try {
            await runRobotProgram(robot, {
              state,
              repaint,
              cancelled,
              ...(penSettings === undefined ? {} : { penSettings }),
            });
            completed = !cancelled();
          } catch (error) {
            if (!cancelled() && currentRevision === revision) {
              state.setNotice({
                level: "warning",
                message:
                  error instanceof Error ? error.message : "Robot run failed.",
              });
              throw error;
            }
          } finally {
            runningRobot = false;
            if (currentRevision === revision) {
              state.setLastRunResult({
                source,
                output: state.getState().output,
                diagnostics: state.getState().diagnostics,
              });
              state.setCurrentInstructionSourceSpan(null);
            }
          }
        });
        if (currentRevision === revision)
          state.setRunStatus(completed ? "done" : "stopped");
      } catch (error) {
        completed = false;
        if (currentRevision === revision) {
          state.setRunStatus("stopped");
          state.setNotice({
            level: "warning",
            message:
              error instanceof Error ? error.message : "Robot run failed.",
          });
        }
      }
      return completed;
    },
  };
}
