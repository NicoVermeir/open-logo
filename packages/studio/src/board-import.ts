import {
  readBoard,
  type BoardReadResult,
  type BoardReaderOptions,
  type BoardRecognitionProvider,
  type RasterImage,
} from "@openlogo/board-reader";
import type { EditorController } from "./editor.js";

export type BoardImportStatus = "idle" | "recognizing" | "succeeded" | "failed";

export interface BoardImportState {
  readonly status: BoardImportStatus;
  readonly result: BoardReadResult | null;
  readonly error: string | null;
}

export interface BoardImportController {
  getState(): BoardImportState;
  importImage(image: RasterImage): Promise<BoardReadResult | null>;
  cancel(): void;
}

export interface BoardImportOptions extends BoardReaderOptions {
  readonly onStateChange?: (state: BoardImportState) => void;
}

export function createBoardImportController(
  editor: EditorController,
  provider: BoardRecognitionProvider,
  options: BoardImportOptions = {},
): BoardImportController {
  let state: BoardImportState = {
    status: "idle",
    result: null,
    error: null,
  };
  let cancellation: { aborted: boolean } | null = null;

  const publish = (nextState: BoardImportState): void => {
    state = nextState;
    options.onStateChange?.(state);
  };

  return {
    getState: () => state,
    async importImage(image) {
      cancellation = { aborted: false };
      publish({ status: "recognizing", result: null, error: null });
      try {
        const result = await readBoard(image, provider, {
          ...options,
          signal: cancellation,
        });
        if (cancellation.aborted) {
          return null;
        }
        const recognitionFailure = result.issues.find(
          (issue) => issue.code === "recognition-failed",
        );
        if (recognitionFailure) {
          publish({
            status: "failed",
            result,
            error: recognitionFailure.message,
          });
          return null;
        }
        if (result.source.length > 0) {
          editor.setTextAndSelection(
            result.source,
            selectionAtEnd(result.source),
          );
        }
        publish({ status: "succeeded", result, error: null });
        return result;
      } catch (error) {
        if (cancellation.aborted) {
          publish({ status: "idle", result: null, error: null });
          return null;
        }
        const message =
          error instanceof Error ? error.message : "Board import failed.";
        publish({ status: "failed", result: null, error: message });
        return null;
      } finally {
        cancellation = null;
      }
    },
    cancel() {
      if (cancellation) {
        cancellation.aborted = true;
      }
    },
  };
}

function selectionAtEnd(source: string) {
  const lines = source.split("\n");
  const position = [lines.length, (lines.at(-1)?.length ?? 0) + 1] as const;
  return { anchor: position, head: position };
}
