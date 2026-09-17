import type {
  Lesson,
  TutorBrief,
  VoiceTutorEvent,
  VoiceTutorInteractionMode,
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
import {
  OL_CHECK_PROFILES,
  OL_KEYWORDS,
  OL_PROFILE_KEYWORDS,
  parse,
  profilePrimitiveNames,
  type CheckProfile,
} from "@openlogo/parser";
import type { TutorHintStage } from "@openlogo/core";
import type { RunController } from "./run-controller.js";
import type {
  StudioState,
  StudioStateStore,
  Unsubscribe,
} from "./state-model.js";

export type VoiceTutorControllerStatus =
  | "off"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "unavailable";

export interface VoiceTutorTranscriptEntry {
  readonly id: number;
  readonly speaker: "learner" | "tutor";
  readonly text: string;
  readonly final: boolean;
  readonly interrupted: boolean;
  readonly label: string;
}

export interface VoiceTutorControllerView {
  readonly status: VoiceTutorControllerStatus;
  readonly statusText: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly interactionMode: VoiceTutorInteractionMode;
  readonly primaryActionLabel: string;
  readonly primaryActionPressed: boolean;
  readonly canTalk: boolean;
  readonly canExpandResponse: boolean;
  readonly canRequestHint: boolean;
  readonly transcript: readonly VoiceTutorTranscriptEntry[];
}

export interface VoiceTutorController {
  getView(): VoiceTutorControllerView;
  subscribe(listener: (view: VoiceTutorControllerView) => void): Unsubscribe;
  setEnabled(enabled: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setInteractionMode(mode: VoiceTutorInteractionMode): Promise<void>;
  toggleEnabled(): Promise<void>;
  toggleMuted(): Promise<void>;
  startListening(): Promise<void>;
  finishListening(): Promise<void>;
  stopTutor(): Promise<void>;
  cancelTurn(): Promise<void>;
  tellMeMore(): Promise<void>;
  sayThatAgain(): Promise<void>;
  giveAnotherHint(): Promise<void>;
  dispose(): Promise<void>;
}

export interface VoiceTutorControllerOptions {
  readonly state: StudioStateStore;
  readonly session?: VoiceTutorSession;
  readonly runController: Pick<RunController, "run">;
  readonly lookupLesson?: (lessonId: string) => Lesson | undefined;
  readonly scheduleGroundingUpdate?: (
    update: () => void,
    delayMilliseconds: number,
  ) => () => void;
}

const GROUNDING_UPDATE_DELAY_MILLISECONDS = 200;

const STATUS_TEXT: Readonly<Record<VoiceTutorControllerStatus, string>> = {
  off: "Voice tutor is off.",
  connecting: "Connecting to your voice tutor.",
  ready: "Voice tutor is ready. Hold the button while you talk.",
  listening: "Voice tutor is listening.",
  thinking: "Voice tutor is thinking.",
  speaking: "Voice tutor is speaking.",
  error: "Voice tutor needs attention.",
  unavailable:
    "Voice tutor is unavailable. You can still use OpenLogo hints and lessons.",
};

const PUSH_TO_TALK_ACTION_LABEL: Readonly<
  Record<VoiceTutorControllerStatus, string>
> = {
  off: "Hold to talk",
  connecting: "Connecting…",
  ready: "Hold to talk",
  listening: "Listening… release when finished",
  thinking: "Tutor thinking…",
  speaking: "Tutor speaking…",
  error: "Reconnect voice tutor",
  unavailable: "Voice tutor unavailable",
};

function primaryActionLabel(
  status: VoiceTutorControllerStatus,
  interactionMode: VoiceTutorInteractionMode,
): string {
  if (interactionMode === "push-to-talk") {
    return PUSH_TO_TALK_ACTION_LABEL[status];
  }
  if (status === "connecting") return "Connecting…";
  if (status === "error") return "Reconnect tutor";
  if (status === "unavailable") return "Voice tutor unavailable";
  return status === "off" ? "Start conversation" : "End conversation";
}

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
  let interactionMode: VoiceTutorInteractionMode = "conversation";
  let transcript: readonly VoiceTutorTranscriptEntry[] = [];
  let nextTranscriptId = 1;
  let priorHintStage: TutorHintStage | undefined;
  let lastGrounding = options.state.getState();
  let listeningRequested = false;
  let cancelScheduledGroundingUpdate: (() => void) | undefined;

  const scheduleGroundingUpdate =
    options.scheduleGroundingUpdate ??
    ((update: () => void) => {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) update();
      });
      return () => {
        cancelled = true;
      };
    });

  function getView(): VoiceTutorControllerView {
    return {
      status,
      statusText: STATUS_TEXT[status],
      enabled,
      muted,
      interactionMode,
      primaryActionLabel: primaryActionLabel(status, interactionMode),
      primaryActionPressed:
        interactionMode === "conversation" ? enabled : status === "listening",
      canTalk:
        interactionMode === "conversation"
          ? status !== "connecting" && status !== "unavailable"
          : status === "off" ||
            status === "ready" ||
            status === "listening" ||
            status === "speaking" ||
            status === "error",
      canExpandResponse:
        enabled &&
        transcript.some((entry) => entry.speaker === "tutor" && entry.final),
      canRequestHint: enabled && status !== "connecting",
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
    const pendingIndex = transcript.findIndex(
      (entry) =>
        entry.speaker === speaker && !entry.final && !entry.interrupted,
    );
    if (pendingIndex >= 0) {
      const pending = transcript[pendingIndex];
      if (!pending) return;
      const updatedText = final ? text || pending.text : pending.text + text;
      transcript = transcript.map((entry, index) =>
        index === pendingIndex
          ? {
              ...pending,
              text: updatedText,
              final,
              interrupted: false,
              label: `${speaker === "learner" ? "You" : "Tutor"}: ${updatedText}`,
            }
          : entry,
      );
    } else if (text.length > 0) {
      transcript = [
        ...transcript,
        {
          id: nextTranscriptId++,
          speaker,
          text,
          final,
          interrupted: false,
          label: `${speaker === "learner" ? "You" : "Tutor"}: ${text}`,
        },
      ];
    }
    publish();
  }

  function markTutorTranscriptInterrupted(): void {
    const last = transcript.at(-1);
    if (last?.speaker !== "tutor" || last.final || last.interrupted) return;
    transcript = [
      ...transcript.slice(0, -1),
      {
        ...last,
        interrupted: true,
        label: `${last.label} (interrupted)`,
      },
    ];
    publish();
  }

  function updateGroundingNow(): void {
    if (cancelScheduledGroundingUpdate === undefined) return;
    cancelScheduledGroundingUpdate?.();
    cancelScheduledGroundingUpdate = undefined;
    if (!enabled || !options.session) return;
    void options.session
      .updateGrounding(buildBrief(lastGrounding, lookup, priorHintStage))
      .catch(() => setStatus("error"));
  }

  function deferGroundingUpdate(): void {
    cancelScheduledGroundingUpdate?.();
    cancelScheduledGroundingUpdate = scheduleGroundingUpdate(
      updateGroundingNow,
      GROUNDING_UPDATE_DELAY_MILLISECONDS,
    );
  }

  async function executeTool(
    name: string,
    argumentsJson: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const argumentsValue = toolArguments(argumentsJson);
    const state = options.state.getState();
    switch (name) {
      case "get_openlogo_reference": {
        const profile = argumentsValue.profile;
        if (
          typeof profile !== "string" ||
          !OL_CHECK_PROFILES.some((candidate) => candidate === profile)
        ) {
          throw new Error(`Unknown OpenLogo profile: ${String(profile)}.`);
        }
        const checkedProfile = profile as CheckProfile;
        return {
          specVersion: "0.1.0",
          profile: checkedProfile,
          coreKeywords: OL_KEYWORDS,
          profileKeywords:
            (
              OL_PROFILE_KEYWORDS as Readonly<Record<string, readonly string[]>>
            )[checkedProfile] ?? [],
          primitives: profilePrimitiveNames(checkedProfile),
        };
      }
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
      case "run_program": {
        options.runController.run();
        const resultState = options.state.getState();
        return {
          runStatus: resultState.runStatus,
          visualPlaybackInProgress: resultState.runStatus === "running",
          output: resultState.output,
          diagnostics: resultState.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            sourceSpan: diagnostic.source_span,
          })),
        };
      }
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
        if (event.status === "listening") updateGroundingNow();
        if (
          event.status === "listening" &&
          (status === "speaking" || status === "thinking")
        ) {
          markTutorTranscriptInterrupted();
        }
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
      deferGroundingUpdate();
    }
  });

  async function setEnabled(nextEnabled: boolean): Promise<void> {
    if (!options.session) {
      setStatus("unavailable");
      return;
    }
    enabled = nextEnabled;
    publish();
    if (!nextEnabled) {
      listeningRequested = false;
      cancelScheduledGroundingUpdate?.();
      cancelScheduledGroundingUpdate = undefined;
      await options.session.disconnect();
      setStatus("off");
      return;
    }
    setStatus("connecting");
    try {
      await options.session.setInteractionMode(interactionMode);
      await options.session.updateGrounding(
        buildBrief(options.state.getState(), lookup, priorHintStage),
      );
      await options.session.connect();
      muted = interactionMode === "push-to-talk";
      await options.session.setMuted(muted);
      publish();
    } catch (error) {
      enabled = false;
      setStatus(
        error instanceof Error && error.message.includes("(503)")
          ? "unavailable"
          : "error",
      );
    }
  }

  async function setMuted(nextMuted: boolean): Promise<void> {
    muted = nextMuted;
    publish();
    await options.session?.setMuted(nextMuted);
  }

  async function setInteractionMode(
    nextInteractionMode: VoiceTutorInteractionMode,
  ): Promise<void> {
    interactionMode = nextInteractionMode;
    muted = nextInteractionMode === "push-to-talk";
    publish();
    if (!options.session) return;
    await options.session.setInteractionMode(nextInteractionMode);
    if (enabled) await options.session.setMuted(muted);
  }

  async function startListening(): Promise<void> {
    if (!options.session) {
      setStatus("unavailable");
      return;
    }
    listeningRequested = true;
    if (!enabled) {
      await setEnabled(true);
    }
    if (!listeningRequested || !enabled) {
      return;
    }
    muted = false;
    publish();
    await options.session.startListening();
  }

  async function finishListening(): Promise<void> {
    listeningRequested = false;
    if (
      !options.session ||
      !enabled ||
      interactionMode === "conversation" ||
      status !== "listening"
    ) {
      return;
    }
    muted = interactionMode === "push-to-talk";
    publish();
    await options.session.finishListening();
  }

  async function cancelTurn(): Promise<void> {
    listeningRequested = false;
    if (!options.session || !enabled) {
      return;
    }
    muted = true;
    publish();
    await options.session.cancelTurn();
  }

  async function stopTutor(): Promise<void> {
    if (!options.session || !enabled) return;
    markTutorTranscriptInterrupted();
    await options.session.cancelResponse();
    setStatus("ready");
  }

  async function requestFollowUp(instruction: string): Promise<void> {
    if (!options.session || !enabled) return;
    await options.session.requestResponse(instruction);
  }

  async function tellMeMore(): Promise<void> {
    await requestFollowUp(
      "Studio follow-up action: expand your most recent teaching point with one additional concise explanation or example. Stay on the same concept, do not advance the hint ladder, and do not provide a complete program.",
    );
  }

  async function sayThatAgain(): Promise<void> {
    await requestFollowUp(
      "Studio follow-up action: restate your most recent completed answer more clearly and briefly. Do not add a new hint or new concept.",
    );
  }

  async function giveAnotherHint(): Promise<void> {
    if (!options.session || !enabled) return;
    const result = await executeTool("give_hint", "{}");
    await options.session.requestResponse(
      `Studio follow-up action: voice exactly this next deterministic OpenLogo hint rung in natural child-friendly language. Do not reveal anything beyond it and do not call give_hint again. Hint result JSON: ${JSON.stringify(result)}`,
    );
  }

  return {
    getView,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled,
    setMuted,
    setInteractionMode,
    async toggleEnabled() {
      await setEnabled(!enabled);
    },
    async toggleMuted() {
      await setMuted(!muted);
    },
    startListening,
    finishListening,
    stopTutor,
    cancelTurn,
    tellMeMore,
    sayThatAgain,
    giveAnotherHint,
    async dispose() {
      cancelScheduledGroundingUpdate?.();
      unsubscribeState();
      unsubscribeSession?.();
      await options.session?.disconnect();
    },
  };
}
