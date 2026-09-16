import type {
  LearnerLevel,
  Lesson,
  TutorBrief,
  VoiceTutorEvent,
  VoiceTutorSession,
} from "@openlogo/edu";
import {
  buildTutorBrief,
  findLessonById,
  getLessonsByLevel,
  hint,
  isLearnerLevel,
  LESSONS,
} from "@openlogo/edu";
import { parse } from "@openlogo/parser";
import type { TutorHintStage } from "@openlogo/core";
import type { RunController } from "./run-controller.js";
import type {
  StudioState,
  StudioStateStore,
  Unsubscribe,
} from "./state-model.js";

export type VoiceTutorControllerStatus =
  "off" | "connecting" | "listening" | "speaking" | "error" | "unavailable";

export interface VoiceTutorTranscriptEntry {
  readonly id: number;
  readonly speaker: "learner" | "tutor";
  readonly text: string;
  readonly final: boolean;
  readonly label: string;
}

export interface VoiceTutorControllerView {
  readonly status: VoiceTutorControllerStatus;
  readonly statusText: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly transcript: readonly VoiceTutorTranscriptEntry[];
}

export interface VoiceTutorController {
  getView(): VoiceTutorControllerView;
  subscribe(listener: (view: VoiceTutorControllerView) => void): Unsubscribe;
  setEnabled(enabled: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  toggleEnabled(): Promise<void>;
  toggleMuted(): Promise<void>;
  dispose(): Promise<void>;
}

export interface VoiceTutorControllerOptions {
  readonly state: StudioStateStore;
  readonly session?: VoiceTutorSession;
  readonly runController: Pick<RunController, "run">;
  readonly lookupLesson?: (lessonId: string) => Lesson | undefined;
}

const STATUS_TEXT: Readonly<Record<VoiceTutorControllerStatus, string>> = {
  off: "Voice tutor is off.",
  connecting: "Connecting to your voice tutor.",
  listening: "Voice tutor is listening.",
  speaking: "Voice tutor is speaking.",
  error: "Voice tutor needs attention.",
  unavailable:
    "Voice tutor is unavailable. You can still use OpenLogo hints and lessons.",
};

function activeLesson(
  state: StudioState,
  lookup: (lessonId: string) => Lesson | undefined,
): Lesson | undefined {
  return state.lesson.lessonId === null
    ? undefined
    : lookup(state.lesson.lessonId);
}

function buildBrief(
  state: StudioState,
  lookup: (lessonId: string) => Lesson | undefined,
  priorHintStage: TutorHintStage | undefined,
): TutorBrief {
  const lesson = activeLesson(state, lookup);
  return buildTutorBrief({
    level: lesson?.level ?? "1",
    lesson,
    currentSource: state.source,
    diagnostics: state.diagnostics,
    recentTraceEvents: [],
    priorHintStage,
  });
}

function toolArguments(argumentsJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("Tool arguments are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function lineSelection(source: string, line: number) {
  const lines = source.split("\n");
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new Error(`Line ${line} is outside the current program.`);
  }
  const column = (lines[line - 1]?.length ?? 0) + 1;
  return { anchor: [line, 1] as const, head: [line, column] as const };
}

export function createVoiceTutorController(
  options: VoiceTutorControllerOptions,
): VoiceTutorController {
  const lookup = options.lookupLesson ?? findLessonById;
  const listeners = new Set<(view: VoiceTutorControllerView) => void>();
  let status: VoiceTutorControllerStatus = options.session
    ? "off"
    : "unavailable";
  let enabled = false;
  let muted = false;
  let transcript: readonly VoiceTutorTranscriptEntry[] = [];
  let nextTranscriptId = 1;
  let priorHintStage: TutorHintStage | undefined;
  let lastGrounding = options.state.getState();

  function getView(): VoiceTutorControllerView {
    return {
      status,
      statusText: STATUS_TEXT[status],
      enabled,
      muted,
      transcript,
    };
  }

  function publish(): void {
    const view = getView();
    for (const listener of listeners) listener(view);
  }

  function setStatus(next: VoiceTutorControllerStatus): void {
    status = next;
    publish();
  }

  function recordTranscript(
    speaker: VoiceTutorTranscriptEntry["speaker"],
    text: string,
    final: boolean,
  ): void {
    const last = transcript.at(-1);
    if (last?.speaker === speaker && !last.final) {
      transcript = [
        ...transcript.slice(0, -1),
        { ...last, text: final ? text || last.text : last.text + text, final },
      ];
    } else if (text.length > 0) {
      transcript = [
        ...transcript,
        {
          id: nextTranscriptId++,
          speaker,
          text,
          final,
          label: `${speaker === "learner" ? "You" : "Tutor"}: ${text}`,
        },
      ];
    }
    if (last?.speaker === speaker && !last.final) {
      const updated = transcript.at(-1);
      if (updated) {
        transcript = [
          ...transcript.slice(0, -1),
          {
            ...updated,
            label: `${speaker === "learner" ? "You" : "Tutor"}: ${updated.text}`,
          },
        ];
      }
    }
    publish();
  }

  async function executeTool(
    name: string,
    argumentsJson: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const argumentsValue = toolArguments(argumentsJson);
    const state = options.state.getState();
    switch (name) {
      case "get_program":
        return { source: state.source };
      case "get_lesson_progress": {
        const lesson = activeLesson(state, lookup);
        return {
          lessonId: lesson?.id ?? null,
          lessonTitle: lesson?.title ?? null,
          level: lesson?.level ?? "1",
          runStatus: state.runStatus,
          diagnosticCount: state.diagnostics.length,
        };
      }
      case "run_program":
        options.runController.run();
        return { runStatus: options.state.getState().runStatus };
      case "give_hint": {
        const lesson = activeLesson(state, lookup);
        const output = hint({
          command: "hint",
          program: parse(state.source, "studio-session").ast,
          events: [],
          diagnostics: state.diagnostics,
          level: lesson?.level ?? "1",
          priorHintStage,
        });
        if (output.command !== "hint") {
          throw new Error(
            "Deterministic hint provider returned the wrong output.",
          );
        }
        priorHintStage = output.stage;
        return { segments: output.segments, stage: output.stage };
      }
      case "next_lesson": {
        const currentIndex = LESSONS.findIndex(
          (lesson) => lesson.id === state.lesson.lessonId,
        );
        const lesson = LESSONS[currentIndex + 1] ?? LESSONS[0];
        if (!lesson) throw new Error("No curriculum lessons are registered.");
        options.state.setLesson({ lessonId: lesson.id, title: lesson.title });
        return {
          lessonId: lesson.id,
          title: lesson.title,
          level: lesson.level,
        };
      }
      case "load_lesson": {
        const level = argumentsValue.level;
        if (!isLearnerLevel(level)) {
          throw new Error(`Unknown learner level: ${String(level)}.`);
        }
        const lesson = getLessonsByLevel(level)[0];
        if (!lesson) {
          throw new Error(`No lesson is registered for level ${level}.`);
        }
        options.state.setLesson({ lessonId: lesson.id, title: lesson.title });
        return {
          lessonId: lesson.id,
          title: lesson.title,
          level: lesson.level,
        };
      }
      case "highlight_line": {
        const line = argumentsValue.line;
        if (typeof line !== "number") {
          throw new Error("highlight_line requires a numeric line.");
        }
        options.state.setSelection(lineSelection(state.source, line));
        return { line };
      }
      default:
        throw new Error(`Unknown voice tutor tool: ${name}.`);
    }
  }

  async function handleToolCall(
    callId: string,
    name: string,
    argumentsJson: string,
  ): Promise<void> {
    if (!options.session) return;
    try {
      const result = await executeTool(name, argumentsJson);
      await options.session.sendToolResult(callId, { ok: true, result });
    } catch (error) {
      await options.session.sendToolResult(callId, {
        ok: false,
        error:
          error instanceof Error ? error.message : "Voice tutor tool failed.",
      });
    }
  }

  function handleSessionEvent(event: VoiceTutorEvent): void {
    switch (event.kind) {
      case "status":
        if (event.status === "disconnected") enabled = false;
        setStatus(event.status === "disconnected" ? "off" : event.status);
        return;
      case "learner-transcript":
        recordTranscript("learner", event.text, event.final);
        return;
      case "tutor-transcript":
        recordTranscript("tutor", event.text, event.final);
        return;
      case "tool-call":
        void handleToolCall(event.callId, event.name, event.argumentsJson);
        return;
      case "error":
        setStatus("error");
    }
  }

  const unsubscribeSession = options.session?.subscribe(handleSessionEvent);
  const unsubscribeState = options.state.subscribe((next) => {
    const groundingChanged =
      next.source !== lastGrounding.source ||
      next.lesson.lessonId !== lastGrounding.lesson.lessonId ||
      next.diagnostics !== lastGrounding.diagnostics ||
      next.lastRunResult !== lastGrounding.lastRunResult;
    lastGrounding = next;
    if (groundingChanged && enabled && options.session) {
      void options.session
        .updateGrounding(buildBrief(next, lookup, priorHintStage))
        .catch(() => setStatus("error"));
    }
  });

  return {
    getView,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setEnabled(nextEnabled) {
      if (!options.session) {
        setStatus("unavailable");
        return;
      }
      enabled = nextEnabled;
      publish();
      if (!nextEnabled) {
        await options.session.disconnect();
        setStatus("off");
        return;
      }
      setStatus("connecting");
      try {
        await options.session.updateGrounding(
          buildBrief(options.state.getState(), lookup, priorHintStage),
        );
        await options.session.connect();
      } catch (error) {
        enabled = false;
        setStatus(
          error instanceof Error && error.message.includes("(503)")
            ? "unavailable"
            : "error",
        );
      }
    },
    async setMuted(nextMuted) {
      muted = nextMuted;
      publish();
      await options.session?.setMuted(nextMuted);
    },
    async toggleEnabled() {
      await this.setEnabled(!enabled);
    },
    async toggleMuted() {
      await this.setMuted(!muted);
    },
    async dispose() {
      unsubscribeState();
      unsubscribeSession?.();
      await options.session?.disconnect();
    },
  };
}
