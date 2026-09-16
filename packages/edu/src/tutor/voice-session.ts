import type { TutorBrief } from "./tutor-brief.js";

/** Connection states exposed by a provider-neutral voice tutor session. */
export type VoiceTutorStatus =
  "disconnected" | "connecting" | "listening" | "speaking";

/** Events emitted by a {@link VoiceTutorSession}. */
export type VoiceTutorEvent =
  | {
      readonly kind: "status";
      readonly status: VoiceTutorStatus;
    }
  | {
      readonly kind: "learner-transcript";
      readonly text: string;
      readonly final: boolean;
    }
  | {
      readonly kind: "tutor-transcript";
      readonly text: string;
      readonly final: boolean;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly recoverable: boolean;
    };

/** Receives one provider-neutral voice tutor event. */
export type VoiceTutorEventListener = (event: VoiceTutorEvent) => void;

/**
 * Transport-neutral voice tutor session.
 *
 * Browser audio, WebRTC, provider authentication, and UI state belong to the host adapter,
 * not to `@openlogo/edu`.
 */
export interface VoiceTutorSession {
  /** Opens the underlying provider session. */
  connect(): Promise<void>;
  /** Closes the session and releases its transport resources. */
  disconnect(): Promise<void>;
  /** Enables or disables capture from the learner's microphone. */
  setMuted(muted: boolean): Promise<void>;
  /** Replaces the current lesson and program grounding. */
  updateGrounding(brief: TutorBrief): Promise<void>;
  /** Returns a completed tool call to the provider so it can continue its response. */
  sendToolResult(
    callId: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Subscribes to session events and returns an unsubscribe function. */
  subscribe(listener: VoiceTutorEventListener): () => void;
}
