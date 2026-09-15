import type { Diagnostic } from "@openlogo/core";
import {
  check,
  DEFAULT_CHECK_PROFILES,
  parse,
  type CheckProfile,
} from "@openlogo/parser";

export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly encodedImageBase64?: string;
  readonly mimeType?: string;
}

export interface ImageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BoardBlockKind = "command" | "repeat" | "if" | "while" | "forever";

export interface RecognizedBlock {
  readonly id: string;
  readonly kind: BoardBlockKind;
  readonly name: string;
  readonly arguments: readonly string[];
  readonly bounds: ImageBounds;
  readonly confidence: number;
  readonly children: readonly RecognizedBlock[];
}

export interface BoardRecognitionProvider {
  readonly name: string;
  recognize(
    image: RasterImage,
    signal?: CancellationSignal,
  ): Promise<readonly RecognizedBlock[]>;
}

export interface CancellationSignal {
  readonly aborted: boolean;
}

export interface BoardReaderIssue {
  readonly code:
    | "invalid-image"
    | "recognition-failed"
    | "low-confidence"
    | "unsupported-block"
    | "invalid-source";
  readonly message: string;
  readonly blockId?: string;
}

export interface BoardReaderOptions {
  readonly profiles?: readonly CheckProfile[];
  readonly minimumConfidence?: number;
  readonly signal?: CancellationSignal;
}

export interface BoardReadResult {
  readonly source: string;
  readonly blocks: readonly RecognizedBlock[];
  readonly languageDiagnostics: readonly Diagnostic[];
  readonly issues: readonly BoardReaderIssue[];
  readonly provider: string;
}

export async function readBoard(
  image: RasterImage,
  provider: BoardRecognitionProvider,
  options: BoardReaderOptions = {},
): Promise<BoardReadResult> {
  validateImage(image);
  throwIfAborted(options.signal);

  let blocks: readonly RecognizedBlock[];
  try {
    blocks = await provider.recognize(image, options.signal);
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted === true) {
      throw error;
    }
    return {
      source: "",
      blocks: [],
      languageDiagnostics: [],
      issues: [
        {
          code: "recognition-failed",
          message:
            error instanceof Error
              ? error.message
              : "Board recognition failed.",
        },
      ],
      provider: provider.name,
    };
  }

  throwIfAborted(options.signal);
  const minimumConfidence = options.minimumConfidence ?? 0;
  const issues = collectConfidenceIssues(blocks, minimumConfidence);
  const source = blocksToSource(blocks);
  const parsed = parse(source, "<board-reader>");
  const checked = parsed.ast
    ? check(parsed.ast, {
        profiles: options.profiles ?? DEFAULT_CHECK_PROFILES,
        source,
      })
    : { diagnostics: [] };

  return {
    source,
    blocks,
    languageDiagnostics: [...parsed.diagnostics, ...checked.diagnostics],
    issues: [...issues, ...collectUnsupportedIssues(blocks)],
    provider: provider.name,
  };
}

export function blocksToSource(blocks: readonly RecognizedBlock[]): string {
  return blocks.map((block) => blockToSource(block, 0)).join("\n");
}

function blockToSource(block: RecognizedBlock, indentation: number): string {
  const prefix = "  ".repeat(indentation);
  const argumentsText =
    block.arguments.length > 0 ? ` ${block.arguments.join(" ")}` : "";
  if (block.kind === "command") {
    return `${prefix}${block.name}${argumentsText}`;
  }

  const header = `${prefix}${block.name}${argumentsText}`;
  const children = block.children.map((child) =>
    blockToSource(child, indentation + 1),
  );
  return [header, ...children, `${prefix}end ${block.name}`].join("\n");
}

function collectConfidenceIssues(
  blocks: readonly RecognizedBlock[],
  minimumConfidence: number,
): BoardReaderIssue[] {
  return blocks.flatMap((block) => {
    const ownIssue =
      block.confidence < minimumConfidence
        ? [
            {
              code: "low-confidence" as const,
              message: `Block confidence is ${block.confidence.toFixed(2)}.`,
              blockId: block.id,
            },
          ]
        : [];
    return [
      ...ownIssue,
      ...collectConfidenceIssues(block.children, minimumConfidence),
    ];
  });
}

function collectUnsupportedIssues(
  blocks: readonly RecognizedBlock[],
): BoardReaderIssue[] {
  return blocks.flatMap((block) => {
    const ownIssue = ["command", "repeat", "if", "while", "forever"].includes(
      block.kind,
    )
      ? []
      : [
          {
            code: "unsupported-block" as const,
            message: `Block kind '${block.kind}' is not supported.`,
            blockId: block.id,
          },
        ];
    return [...ownIssue, ...collectUnsupportedIssues(block.children)];
  });
}

function validateImage(image: RasterImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.rgba.length !== image.width * image.height * 4
  ) {
    throw new TypeError(
      "RasterImage must contain width * height * 4 RGBA bytes.",
    );
  }
}

function throwIfAborted(signal: CancellationSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new BoardReaderCancellationError();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof BoardReaderCancellationError;
}

class BoardReaderCancellationError extends Error {
  constructor() {
    super("Board recognition was cancelled.");
    this.name = "AbortError";
  }
}
