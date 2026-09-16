import type {
  TutorBrief,
  VoiceTutorEvent,
  VoiceTutorEventListener,
  VoiceTutorSession,
  VoiceTutorStatus,
} from "@openlogo/edu";

export interface RealtimeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type RealtimeFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<RealtimeFetchResponse>;

export interface RealtimeMediaTrack {
  enabled: boolean;
  stop(): void;
}

export interface RealtimeMediaStream {
  getTracks(): readonly RealtimeMediaTrack[];
}

export interface RealtimeSessionDescription {
  readonly type: "offer" | "answer";
  readonly sdp: string;
}

export interface RealtimeDataChannel {
  readonly readyState: string;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

export interface RealtimePeerConnection {
  addEventListener(
    type: "track" | "connectionstatechange",
    listener: (event: {
      readonly streams?: readonly RealtimeMediaStream[];
    }) => void,
  ): void;
  readonly connectionState: string;
  addTrack(track: RealtimeMediaTrack, stream: RealtimeMediaStream): void;
  createDataChannel(label: string): RealtimeDataChannel;
  createOffer(): Promise<RealtimeSessionDescription>;
  setLocalDescription(description: RealtimeSessionDescription): Promise<void>;
  setRemoteDescription(description: RealtimeSessionDescription): Promise<void>;
  close(): void;
}

export interface RealtimeAudioSink {
  setStream(stream: RealtimeMediaStream | null): void;
}

export interface RealtimeVoiceSessionOptions {
  readonly fetch: RealtimeFetch;
  readonly createPeerConnection: () => RealtimePeerConnection;
  readonly getUserMedia: () => Promise<RealtimeMediaStream>;
  readonly audioSink: RealtimeAudioSink;
  readonly tokenUrl?: string;
}

interface RealtimeToken {
  readonly value: string;
  readonly expiresAt: number;
  readonly callsUrl: string;
  readonly model: string;
  readonly voice: string;
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_program",
    description: "Read the learner's current OpenLogo program.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_lesson_progress",
    description: "Read current lesson and run progress.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "run_program",
    description: "Run the learner's unchanged OpenLogo program.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "give_hint",
    description: "Request the next deterministic OpenLogo hint.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "next_lesson",
    description: "Load the next registered curriculum lesson.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "load_lesson",
    description: "Load the first registered lesson for a learner level.",
    parameters: {
      type: "object",
      properties: { level: { type: "string" } },
      required: ["level"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "highlight_line",
    description: "Select one line in the editor without changing the program.",
    parameters: {
      type: "object",
      properties: { line: { type: "integer", minimum: 1 } },
      required: ["line"],
      additionalProperties: false,
    },
  },
] as const;

function asRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readToken(value: unknown): RealtimeToken {
  const token = asRecord(value, "Realtime token response");
  if (
    typeof token.value !== "string" ||
    typeof token.expiresAt !== "number" ||
    typeof token.callsUrl !== "string" ||
    typeof token.model !== "string" ||
    typeof token.voice !== "string"
  ) {
    throw new Error("Realtime token response is missing required fields.");
  }
  return token as unknown as RealtimeToken;
}

function messageText(value: unknown): string {
  const record = asRecord(value, "Realtime event");
  const error =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined;
  if (error && typeof error.message === "string") {
    return error.message;
  }
  return typeof record.message === "string"
    ? record.message
    : "Realtime provider reported an error.";
}

export function createRealtimeVoiceSession(
  options: RealtimeVoiceSessionOptions,
): VoiceTutorSession {
  const listeners = new Set<VoiceTutorEventListener>();
  let peer: RealtimePeerConnection | null = null;
  let channel: RealtimeDataChannel | null = null;
  let localStream: RealtimeMediaStream | null = null;
  let grounding: TutorBrief | null = null;
  let muted = false;
  let status: VoiceTutorStatus = "disconnected";

  function emit(event: VoiceTutorEvent): void {
    for (const listener of listeners) listener(event);
  }

  function setStatus(next: VoiceTutorStatus): void {
    if (status === next) return;
    status = next;
    emit({ kind: "status", status: next });
  }

  function cleanup(): void {
    channel?.close();
    peer?.close();
    for (const track of localStream?.getTracks() ?? []) track.stop();
    channel = null;
    peer = null;
    localStream = null;
    options.audioSink.setStream(null);
  }

  function requireOpenChannel(): RealtimeDataChannel {
    if (channel?.readyState !== "open") {
      throw new Error("Realtime voice data channel is not open.");
    }
    return channel;
  }

  function send(value: Readonly<Record<string, unknown>>): void {
    requireOpenChannel().send(JSON.stringify(value));
  }

  function sendGrounding(): void {
    if (grounding === null || channel?.readyState !== "open") return;
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: `${grounding.instructions}\n\nCurrent grounding JSON:\n${JSON.stringify(grounding.grounding)}`,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        audio: {
          input: {
            transcription: { model: "gpt-4o-transcribe" },
            turn_detection: { type: "server_vad" },
          },
        },
      },
    });
  }

  function handleProviderEvent(raw: unknown): void {
    try {
      const event = asRecord(
        typeof raw === "string" ? JSON.parse(raw) : raw,
        "Realtime event",
      );
      const type = event.type;
      if (typeof type !== "string") {
        throw new Error("Realtime event is missing type.");
      }
      if (
        type === "response.audio_transcript.delta" ||
        type === "response.output_audio_transcript.delta"
      ) {
        if (typeof event.delta === "string") {
          setStatus("speaking");
          emit({ kind: "tutor-transcript", text: event.delta, final: false });
        }
        return;
      }
      if (type === "response.output_audio.delta") {
        setStatus("speaking");
        return;
      }
      if (
        type === "response.audio_transcript.done" ||
        type === "response.output_audio_transcript.done"
      ) {
        const transcript =
          typeof event.transcript === "string" ? event.transcript : "";
        emit({ kind: "tutor-transcript", text: transcript, final: true });
        setStatus("listening");
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        if (typeof event.transcript !== "string") {
          throw new Error("Learner transcript event is missing transcript.");
        }
        emit({
          kind: "learner-transcript",
          text: event.transcript,
          final: true,
        });
        return;
      }
      if (type === "response.function_call_arguments.done") {
        if (
          typeof event.call_id !== "string" ||
          typeof event.name !== "string" ||
          typeof event.arguments !== "string"
        ) {
          throw new Error("Tool-call event is missing required fields.");
        }
        emit({
          kind: "tool-call",
          callId: event.call_id,
          name: event.name,
          argumentsJson: event.arguments,
        });
        return;
      }
      if (type === "error") {
        emit({ kind: "error", message: messageText(event), recoverable: true });
        return;
      }
      if (type === "response.done" || type === "response.output_audio.done") {
        setStatus("listening");
      }
    } catch (error) {
      emit({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not process realtime provider event.",
        recoverable: true,
      });
    }
  }

  async function connect(): Promise<void> {
    if (status !== "disconnected") return;
    setStatus("connecting");
    try {
      const tokenResponse = await options.fetch(
        options.tokenUrl ?? "/api/realtime-token",
        { method: "POST" },
      );
      if (!tokenResponse.ok) {
        throw new Error(
          `Realtime token request failed (${tokenResponse.status}): ${await tokenResponse.text()}`,
        );
      }
      const token = readToken(await tokenResponse.json());
      const nextPeer = options.createPeerConnection();
      const nextChannel = nextPeer.createDataChannel("oai-events");
      peer = nextPeer;
      channel = nextChannel;
      nextChannel.addEventListener("message", (event) => {
        handleProviderEvent(event.data);
      });
      nextChannel.addEventListener("error", () => {
        emit({
          kind: "error",
          message: "Realtime voice data channel failed.",
          recoverable: true,
        });
      });
      nextChannel.addEventListener("close", () => setStatus("disconnected"));
      nextChannel.addEventListener("open", () => {
        sendGrounding();
        setStatus("listening");
      });
      nextPeer.addEventListener("track", (event) => {
        const stream = event.streams?.[0];
        if (stream) options.audioSink.setStream(stream);
      });
      nextPeer.addEventListener("connectionstatechange", () => {
        if (
          nextPeer.connectionState === "failed" ||
          nextPeer.connectionState === "disconnected"
        ) {
          emit({
            kind: "error",
            message: `Realtime peer connection ${nextPeer.connectionState}.`,
            recoverable: true,
          });
        }
      });

      localStream = await options.getUserMedia();
      for (const track of localStream.getTracks()) {
        track.enabled = !muted;
        nextPeer.addTrack(track, localStream);
      }
      const offer = await nextPeer.createOffer();
      await nextPeer.setLocalDescription(offer);
      const callsUrl = `${token.callsUrl}&model=${encodeURIComponent(token.model)}`;
      const answerResponse = await options.fetch(callsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!answerResponse.ok) {
        throw new Error(
          `Realtime SDP request failed (${answerResponse.status}): ${await answerResponse.text()}`,
        );
      }
      await nextPeer.setRemoteDescription({
        type: "answer",
        sdp: await answerResponse.text(),
      });
    } catch (error) {
      cleanup();
      setStatus("disconnected");
      const message =
        error instanceof Error ? error.message : "Realtime connection failed.";
      emit({ kind: "error", message, recoverable: true });
      throw new Error(message);
    }
  }

  return {
    connect,
    async disconnect() {
      cleanup();
      setStatus("disconnected");
    },
    async setMuted(nextMuted) {
      muted = nextMuted;
      for (const track of localStream?.getTracks() ?? []) {
        track.enabled = !muted;
      }
    },
    async updateGrounding(brief) {
      grounding = brief;
      sendGrounding();
    },
    async sendToolResult(callId, result) {
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      });
      send({ type: "response.create" });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
