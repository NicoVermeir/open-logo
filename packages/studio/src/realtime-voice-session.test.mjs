import assert from "node:assert/strict";
import { test } from "node:test";
import { createRealtimeVoiceSession } from "@openlogo/studio";

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeChannel extends FakeEventTarget {
  readyState = "connecting";
  sent = [];
  closed = false;

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = "closed";
  }

  open() {
    this.readyState = "open";
    this.emit("open");
  }
}

class FakePeer extends FakeEventTarget {
  connectionState = "new";
  channel = new FakeChannel();
  tracks = [];
  localDescription = null;
  remoteDescription = null;
  closed = false;

  createDataChannel(label) {
    assert.equal(label, "oai-events");
    return this.channel;
  }

  addTrack(track, stream) {
    this.tracks.push({ track, stream });
  }

  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  close() {
    this.closed = true;
  }
}

function response({ ok = true, status = 200, json, text = "" }) {
  return {
    ok,
    status,
    async json() {
      return json;
    },
    async text() {
      return text;
    },
  };
}

function setup(fetchOverride) {
  const peer = new FakePeer();
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const localStream = { getTracks: () => [track] };
  const audioStreams = [];
  const calls = [];
  const fetch =
    fetchOverride ??
    (async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response({
            json: {
              value: "ephemeral",
              expiresAt: 123,
              callsUrl:
                "https://voice.openai.azure.com/openai/v1/realtime/calls",
              model: "gpt-realtime",
              voice: "coral",
              transcriptionModel: "gpt-4o-transcribe",
            },
          })
        : response({ text: "answer-sdp" });
    });
  const session = createRealtimeVoiceSession({
    fetch,
    createPeerConnection: () => peer,
    getUserMedia: async () => localStream,
    audioSink: { setStream: (stream) => audioStreams.push(stream) },
  });
  return { session, peer, track, localStream, audioStreams, calls };
}

test("connect mints an ephemeral token, posts SDP, attaches audio, grounds on channel open, and cleans up", async () => {
  const { session, peer, track, localStream, audioStreams, calls } = setup();
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.updateGrounding({
    instructions: "Ask first.",
    grounding: {
      learnerLevel: "1",
      lesson: undefined,
      currentSource: "forward 10",
      diagnostics: [],
      recentTraceEvents: [],
      priorHintStage: undefined,
    },
  });
  await session.setInteractionMode("push-to-talk");

  await session.connect();
  assert.equal(calls[0].url, "/api/realtime-token");
  assert.equal(calls[1].init.headers.Authorization, "Bearer ephemeral");
  assert.equal(calls[1].init.headers["content-type"], "application/sdp");
  assert.equal(calls[1].init.body, "offer-sdp");
  assert.equal(
    calls[1].url,
    "https://voice.openai.azure.com/openai/v1/realtime/calls?model=gpt-realtime",
  );
  assert.deepEqual(peer.localDescription, { type: "offer", sdp: "offer-sdp" });
  assert.deepEqual(peer.remoteDescription, {
    type: "answer",
    sdp: "answer-sdp",
  });
  assert.equal(peer.tracks[0].stream, localStream);

  peer.emit("track", { streams: [{ getTracks: () => [] }] });
  assert.equal(audioStreams.length, 1);
  peer.channel.open();
  assert.equal(peer.channel.sent[0].type, "session.update");
  assert.equal(peer.channel.sent[0].session.audio.input.turn_detection, null);
  assert.equal(
    peer.channel.sent[0].session.audio.input.transcription.model,
    "gpt-4o-transcribe",
  );
  assert.equal(peer.channel.sent[0].session.audio.output.speed, 1.1);
  assert.equal(peer.channel.sent[0].session.max_output_tokens, 4096);
  assert.equal(peer.channel.sent[0].session.tool_choice, "auto");
  assert.ok(
    peer.channel.sent[0].session.tools.some(
      (tool) => tool.name === "get_openlogo_reference",
    ),
  );
  assert.match(peer.channel.sent[0].session.instructions, /forward 10/);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["status", "status"],
  );

  assert.equal(track.enabled, false);
  await session.startListening();
  assert.equal(track.enabled, true);
  assert.equal(events.at(-1).status, "listening");
  await session.finishListening();
  assert.equal(track.enabled, false);
  assert.equal(events.at(-1).status, "thinking");
  assert.deepEqual(
    peer.channel.sent.slice(-2).map((event) => event.type),
    ["input_audio_buffer.commit", "response.create"],
  );
  assert.match(
    peer.channel.sent.at(-1).response.instructions,
    /source below is OpenLogo/,
  );
  await session.startListening();
  await session.cancelTurn();
  assert.equal(track.enabled, false);
  assert.equal(peer.channel.sent.at(-1).type, "input_audio_buffer.clear");
  assert.equal(events.at(-1).status, "ready");
  await session.setMuted(true);
  assert.equal(track.enabled, false);
  await session.setMuted(false);
  assert.equal(track.enabled, true);
  await session.disconnect();
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.closed, true);
  assert.equal(audioStreams.at(-1), null);
});

test("provider events emit transcript, status, tool, and explicit errors; tool results continue the response", async () => {
  const { session, peer } = setup();
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.updateGrounding({
    instructions: "Ask first.",
    grounding: {
      learnerLevel: "1",
      lesson: undefined,
      currentSource: "forward 10",
      diagnostics: [],
      recentTraceEvents: [],
      priorHintStage: undefined,
    },
  });
  await session.connect();
  peer.channel.open();

  for (const payload of [
    { type: "input_audio_buffer.speech_started" },
    { type: "response.output_audio_transcript.delta", delta: "Try " },
    { type: "response.audio_transcript.delta", delta: "one turn." },
    {
      type: "response.output_audio_transcript.done",
      transcript: "Try one turn.",
    },
    {
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Wh",
    },
    {
      type: "conversation.item.input_audio_transcription.delta",
      delta: "y?",
    },
    {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Why?",
    },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "conversation.item.created", item: null },
    {
      type: "conversation.item.created",
      item: { role: "assistant", content: [] },
    },
    {
      type: "conversation.item.created",
      item: { role: "user", content: null },
    },
    {
      type: "conversation.item.created",
      item: { role: "user", content: [null, { type: "input_text" }] },
    },
    {
      type: "conversation.item.created",
      item: { role: "user", content: [{ type: "input_audio" }] },
    },
    {
      type: "conversation.item.added",
      item: { role: "user", content: [{ type: "input_audio" }] },
    },
    { type: "response.created" },
    {
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "get_program",
      arguments: "{}",
    },
    { type: "error", error: { message: "provider problem" } },
  ]) {
    peer.channel.emit("message", { data: JSON.stringify(payload) });
  }
  peer.channel.emit("message", { data: "not-json" });

  assert.ok(
    events.some(
      (event) => event.kind === "learner-transcript" && event.text === "Why?",
    ),
  );
  assert.deepEqual(
    events.filter(
      (event) => event.kind === "learner-transcript" && !event.final,
    ),
    [
      { kind: "learner-transcript", text: "Wh", final: false },
      { kind: "learner-transcript", text: "y?", final: false },
    ],
  );
  assert.equal(
    peer.channel.sent.filter((event) => event.type === "response.create")
      .length,
    1,
  );
  assert.match(
    peer.channel.sent.find((event) => event.type === "response.create").response
      .instructions,
    /currentSource/,
  );
  assert.ok(
    events.some(
      (event) => event.kind === "tool-call" && event.callId === "call-1",
    ),
  );
  assert.ok(events.filter((event) => event.kind === "error").length >= 2);

  await session.sendToolResult("call-1", { ok: true });
  assert.deepEqual(peer.channel.sent.at(-2), {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-1",
      output: '{"ok":true}',
    },
  });
  assert.equal(peer.channel.sent.at(-1).type, "response.create");
  assert.match(
    peer.channel.sent.at(-1).response.instructions,
    /source below is OpenLogo/,
  );
});

test("conversation mode keeps the microphone open and interrupts active tutor audio", async () => {
  const { session, peer, track } = setup();
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.updateGrounding({
    instructions: "Ask first.",
    grounding: {
      learnerLevel: "1",
      lesson: undefined,
      currentSource: "forward 10",
      diagnostics: [],
      recentTraceEvents: [],
      priorHintStage: undefined,
    },
  });
  await session.connect();
  peer.channel.open();

  const groundingUpdate = peer.channel.sent[0];
  assert.equal(
    groundingUpdate.session.audio.input.turn_detection.interrupt_response,
    true,
  );
  assert.equal(
    groundingUpdate.session.audio.input.turn_detection.create_response,
    false,
  );
  assert.equal(
    groundingUpdate.session.audio.input.turn_detection.silence_duration_ms,
    200,
  );

  await session.setMuted(false);
  assert.equal(track.enabled, true);
  peer.channel.emit("message", {
    data: JSON.stringify({
      type: "response.created",
      response: { id: "cancelled-response" },
    }),
  });
  peer.channel.emit("message", {
    data: JSON.stringify({ type: "output_audio_buffer.started" }),
  });
  await session.startListening();
  assert.deepEqual(
    peer.channel.sent.slice(-2).map((event) => event.type),
    ["response.cancel", "output_audio_buffer.clear"],
  );
  peer.channel.emit("message", {
    data: JSON.stringify({
      type: "response.output_audio_transcript.delta",
      response_id: "cancelled-response",
      delta: "stale",
    }),
  });
  assert.equal(
    events.some(
      (event) => event.kind === "tutor-transcript" && event.text === "stale",
    ),
    false,
  );
  await session.finishListening();
  assert.equal(track.enabled, true);
  assert.equal(events.at(-1).status, "listening");

  await session.requestResponse("Tell me more.");
  assert.deepEqual(peer.channel.sent.at(-2), {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Tell me more." }],
    },
  });
  assert.equal(peer.channel.sent.at(-1).type, "response.create");
  assert.match(
    peer.channel.sent.at(-1).response.instructions,
    /source below is OpenLogo/,
  );
  assert.equal(events.at(-1).status, "thinking");
});

test("connect failure reports the cause and releases every acquired resource", async () => {
  const { session, peer, track, audioStreams } = setup(async () =>
    response({ ok: false, status: 503, text: "not configured" }),
  );
  const events = [];
  session.subscribe((event) => events.push(event));

  await assert.rejects(session.connect(), /503.*not configured/);
  assert.equal(peer.closed, false);
  assert.equal(track.stopped, false);
  assert.equal(audioStreams.at(-1), null);
  assert.equal(events.at(-1).kind, "error");
});

test("invalid token shape and closed-channel tool delivery fail explicitly", async () => {
  const { session } = setup(async () => response({ json: {} }));
  await assert.rejects(session.connect(), /missing required fields/);
  await assert.rejects(
    session.sendToolResult("call", { ok: true }),
    /data channel is not open/,
  );
});
