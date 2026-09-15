export { blocksToSource, readBoard } from "./board-reader.js";
export {
  createLlmBoardRecognitionProvider,
  DEFAULT_MAGNET_DESCRIPTIONS,
} from "./llm-board-provider.js";
export type {
  BoardBlockKind,
  BoardReadResult,
  BoardReaderIssue,
  BoardReaderOptions,
  BoardRecognitionProvider,
  CancellationSignal,
  ImageBounds,
  RasterImage,
  RecognizedBlock,
} from "./board-reader.js";
export type {
  BoardMagnetDescription,
  LlmBoardProviderOptions,
  LlmBoardRecognitionClient,
  LlmBoardRecognitionRequest,
} from "./llm-board-provider.js";

export function createStaticBoardRecognitionProvider(
  blocks: readonly import("./board-reader.js").RecognizedBlock[],
): import("./board-reader.js").BoardRecognitionProvider {
  return {
    name: "static",
    async recognize(_image, signal) {
      if (signal?.aborted === true) {
        throw new Error("Board recognition was cancelled.");
      }
      return blocks;
    },
  };
}
