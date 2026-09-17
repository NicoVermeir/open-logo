import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStudioState,
  createVoiceTutorController,
} from "@openlogo/studio";

class FakeSession {
  listeners = new Set();
  connected = 0;
  disconnected = 0;
  muted = [];
  interactionModes = [];
  grounding = [];
  results = [];
  responseRequests = [];
  connectError = null;

  async connect() {
    if (this.connectError) throw this.connectError;
    this.connected++;
    this.emit({ kind: "status", status: "ready" });
  }

  async disconnect() {
    this.disconnected++;
    this.emit({ kind: "status", status: "disconnected" });
  }

  async setMuted(value) {
    this.muted.push(value);
  }

  async setInteractionMode(value) {
    this.interactionModes.push(value);
  }

  async startListening() {
    this.muted.push(false);
    this.emit({ kind: "status", status: "listening" });
  }

  async finishListening() {
    this.muted.push(true);
    this.emit({ kind: "status", status: "thinking" });
  }

  async cancelResponse() {
    this.emit({ kind: "status", status: "ready" });
  }

  async requestResponse(instruction) {
    this.responseRequests.push(instruction);
    this.emit({ kind: "status", status: "thinking" });
  }

  async cancelTurn() {
    this.muted.push(true);
    this.emit({ kind: "status", status: "ready" });
  }

  async updateGrounding(brief) {
    this.grounding.push(brief);
  }

  async sendToolResult(callId, result) {
    this.results.push({ callId, result });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

const lesson = {
  id: "lesson-one",
  title: "One",
  level: "2",
  objective: "Repeat a pattern.",
  workedExamples: [{ source: "repeat 2 [ forward 1 ]", explanation: "Twice." }],
  exercisePrompt: "Change one number.",
};

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test("controller defaults to continuous conversation and accumulates transcripts", async () => {
  const state = createStudioState({
    source: "forward 10",
    lesson: { lessonId: lesson.id, title: lesson.title },
  });

  const session = new FakeSession();
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
    lookupLesson: (id) => (id === lesson.id ? lesson : undefined),
  });

  await controller.setEnabled(true);
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().primaryActionLabel, "End conversation");
  assert.equal(controller.getView().interactionMode, "conversation");
  assert.deepEqual(session.interactionModes, ["conversation"]);
  assert.deepEqual(session.muted, [false]);
  assert.equal(session.grounding[0].grounding.learnerLevel, "2");
  await controller.setInteractionMode("push-to-talk");
  assert.equal(controller.getView().primaryActionLabel, "Hold to talk");
  await controller.startListening();
  assert.equal(controller.getView().status, "listening");
  assert.equal(controller.getView().primaryActionPressed, true);
  await controller.finishListening();
  assert.equal(controller.getView().status, "thinking");
  session.emit({ kind: "status", status: "speaking" });
  session.emit({ kind: "learner-transcript", text: "I see", final: false });
  session.emit({ kind: "tutor-transcript", text: "Look ", final: false });
  session.emit({ kind: "tutor-transcript", text: "again.", final: false });
  session.emit({
    kind: "learner-transcript",
    text: "I see it.",
    final: true,
  });
  session.emit({
    kind: "tutor-transcript",
    text: "Look again.",
    final: true,
  });
  assert.equal(controller.getView().status, "speaking");
  assert.deepEqual(
    controller.getView().transcript.map((entry) => entry.text),
    ["I see it.", "Look again."],
  );

  await controller.setMuted(true);
  assert.equal(controller.getView().muted, true);
  assert.deepEqual(session.muted, [false, true, false, true, true]);
  await controller.setEnabled(false);
  assert.equal(controller.getView().status, "off");
  await controller.dispose();
  assert.ok(session.disconnected >= 2);
});

test("controller stops tutor speech and marks only incomplete transcript as interrupted", async () => {
  const state = createStudioState({ source: "forward 10" });
  const session = new FakeSession();
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
  });
  await controller.setEnabled(true);

  session.emit({ kind: "status", status: "speaking" });
  session.emit({
    kind: "tutor-transcript",
    text: "First thought",
    final: false,
  });
  await controller.stopTutor();
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().transcript[0].interrupted, true);
  assert.match(controller.getView().transcript[0].label, /\(interrupted\)$/);

  session.emit({ kind: "status", status: "speaking" });
  session.emit({ kind: "tutor-transcript", text: "Complete.", final: true });
  session.emit({ kind: "status", status: "listening" });
  assert.equal(controller.getView().transcript[1].interrupted, false);
  await controller.dispose();
});

test("follow-up actions expand, repeat, and advance exactly one deterministic hint rung", async () => {
  const state = createStudioState({
    source: "repeat 3 [ forward 100 right 90 ]",
  });
  const session = new FakeSession();
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
  });
  await controller.setEnabled(true);
  assert.equal(controller.getView().canExpandResponse, false);
  assert.equal(controller.getView().canRequestHint, true);

  session.emit({
    kind: "tutor-transcript",
    text: "What should the turns add up to?",
    final: true,
  });
  assert.equal(controller.getView().canExpandResponse, true);
  await controller.tellMeMore();
  await controller.sayThatAgain();
  await controller.giveAnotherHint();

  assert.match(session.responseRequests[0], /same concept/);
  assert.match(session.responseRequests[1], /more clearly and briefly/);
  assert.match(session.responseRequests[2], /deterministic OpenLogo hint rung/);
  assert.match(session.responseRequests[2], /"stage":"nudge"/);
  assert.equal(session.responseRequests.length, 3);
  await controller.dispose();
});

test("controller cancels an active turn and ignores release before connection completes", async () => {
  const state = createStudioState({ source: "forward 10" });
  const session = new FakeSession();
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
  });

  await controller.setInteractionMode("push-to-talk");
  await controller.startListening();
  assert.equal(controller.getView().status, "listening");
  await controller.cancelTurn();
  assert.equal(controller.getView().status, "ready");
  assert.equal(controller.getView().muted, true);

  await controller.finishListening();
  assert.equal(controller.getView().status, "ready");
  await controller.dispose();
});

test("grounding refreshes only for source, lesson, diagnostics, and completed-run changes", async () => {
  const state = createStudioState({ source: "forward 10" });
  const session = new FakeSession();
  let scheduledUpdate;
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
    scheduleGroundingUpdate(update) {
      scheduledUpdate = update;
      return () => {
        scheduledUpdate = undefined;
      };
    },
  });
  await controller.setEnabled(true);
  const initial = session.grounding.length;
  state.setSelection({ anchor: [1, 1], head: [1, 2] });
  assert.equal(session.grounding.length, initial);
  state.setSource("right 90");
  state.setDiagnostics([]);
  state.setLesson({ lessonId: lesson.id, title: lesson.title });
  state.setLastRunResult({ source: "right 90", output: [], diagnostics: [] });
  assert.equal(session.grounding.length, initial);
  scheduledUpdate();
  await flush();
  assert.equal(session.grounding.length, initial + 1);
  assert.equal(session.grounding.at(-1).grounding.currentSource, "right 90");
  await controller.dispose();
});

test("tools read state, run unchanged source, select lines, and return explicit failures", async () => {
  const state = createStudioState({ source: "forward 10\nright 90" });
  const session = new FakeSession();
  let runs = 0;
  const controller = createVoiceTutorController({
    state,
    session,
    runController: {
      run() {
        runs++;
        state.setOutput(["finished"]);
        state.setDiagnostics([]);
        state.setRunStatus("running");
      },
    },
  });
  await controller.setEnabled(true);

  for (const [callId, name, argumentsJson] of [
    ["reference", "get_openlogo_reference", '{"profile":"core-language"}'],
    ["program", "get_program", "{}"],
    ["progress", "get_lesson_progress", "{}"],
    ["run", "run_program", "{}"],
    ["select", "highlight_line", '{"line":2}'],
    ["bad-json", "get_program", "{"],
    ["bad-name", "edit_program", "{}"],
  ]) {
    session.emit({ kind: "tool-call", callId, name, argumentsJson });
    await flush();
  }

  assert.equal(runs, 1);
  assert.deepEqual(
    session.results.find((item) => item.callId === "run").result.result,
    {
      runStatus: "running",
      visualPlaybackInProgress: true,
      output: ["finished"],
      diagnostics: [],
    },
  );
  assert.ok(
    session.results
      .find((item) => item.callId === "reference")
      .result.result.primitives.includes("print"),
  );
  assert.ok(
    session.results
      .find((item) => item.callId === "reference")
      .result.result.coreKeywords.includes("define"),
  );
  assert.deepEqual(state.getState().selection, {
    anchor: [2, 1],
    head: [2, 9],
  });
  assert.equal(
    session.results.find((item) => item.callId === "program").result.result
      .source,
    state.getState().source,
  );
  assert.equal(
    session.results.find((item) => item.callId === "bad-json").result.ok,
    false,
  );
  assert.match(
    session.results.find((item) => item.callId === "bad-name").result.error,
    /Unknown voice tutor tool/,
  );
  await controller.dispose();
});

test("give_hint routes strictly through deterministic progressive hint without editing source", async () => {
  const source = "repeat 3 [ forward 100 right 90 ]";
  const state = createStudioState({ source });
  const session = new FakeSession();
  const controller = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
  });
  await controller.setEnabled(true);
  session.emit({
    kind: "tool-call",
    callId: "hint-1",
    name: "give_hint",
    argumentsJson: "{}",
  });
  await flush();
  session.emit({
    kind: "tool-call",
    callId: "hint-2",
    name: "give_hint",
    argumentsJson: "{}",
  });
  await flush();

  const hints = session.results.filter((item) =>
    item.callId.startsWith("hint"),
  );
  assert.deepEqual(
    hints.map((item) => item.result.result.stage),
    ["nudge", "concept"],
  );
  assert.equal(state.getState().source, source);
  assert.ok(
    hints.every((item) =>
      item.result.result.segments.every(
        (segment) => !segment.includes("repeat 3 [ forward 100 right 120 ]"),
      ),
    ),
  );
  await controller.dispose();
});

test("missing configuration and token 503 degrade to friendly unavailable state", async () => {
  const state = createStudioState();
  const unavailable = createVoiceTutorController({
    state,
    runController: { run() {} },
  });
  assert.equal(unavailable.getView().status, "unavailable");
  await unavailable.setEnabled(true);
  assert.match(unavailable.getView().statusText, /still use OpenLogo hints/);

  const session = new FakeSession();
  session.connectError = new Error("Realtime token request failed (503)");
  const configured = createVoiceTutorController({
    state,
    session,
    runController: { run() {} },
  });
  await configured.setEnabled(true);
  assert.equal(configured.getView().status, "unavailable");
});
