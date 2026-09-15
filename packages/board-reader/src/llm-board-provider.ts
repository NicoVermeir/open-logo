import type {
  BoardBlockKind,
  BoardRecognitionProvider,
  CancellationSignal,
  ImageBounds,
  RasterImage,
  RecognizedBlock,
} from "./board-reader.js";

export interface BoardMagnetDescription {
  readonly name: string;
  readonly kind: BoardBlockKind;
  readonly description: string;
  readonly argumentDescription?: string;
}

export interface LlmBoardRecognitionRequest {
  readonly imageBase64: string;
  readonly imageMimeType: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly magnetCatalog: readonly BoardMagnetDescription[];
  readonly instructions: string;
}

export interface LlmBoardRecognitionClient {
  readonly name: string;
  recognize(
    request: LlmBoardRecognitionRequest,
    signal?: CancellationSignal,
  ): Promise<unknown>;
}

export interface LlmBoardProviderOptions {
  readonly magnetCatalog: readonly BoardMagnetDescription[];
  readonly instructions?: string;
}

export const DEFAULT_MAGNET_DESCRIPTIONS: readonly BoardMagnetDescription[] = [
  {
    name: "forward",
    kind: "command",
    description: "Move the turtle forward.",
    argumentDescription: "one number",
  },
  {
    name: "back",
    kind: "command",
    description: "Move the turtle backward.",
    argumentDescription: "one number",
  },
  {
    name: "left",
    kind: "command",
    description: "Turn the turtle left.",
    argumentDescription: "one number",
  },
  {
    name: "right",
    kind: "command",
    description: "Turn the turtle right.",
    argumentDescription: "one number",
  },
  {
    name: "repeat",
    kind: "repeat",
    description: "Repeat the nested statements.",
    argumentDescription: "one number and a nested body",
  },
  {
    name: "if",
    kind: "if",
    description: "Run the nested body when a condition is true.",
    argumentDescription: "one condition and a nested body",
  },
  {
    name: "while",
    kind: "while",
    description: "Run the nested body while a condition is true.",
    argumentDescription: "one condition and a nested body",
  },
  {
    name: "forever",
    kind: "forever",
    description: "Repeat the nested body forever.",
    argumentDescription: "a nested body",
  },
  { name: "pen_up", kind: "command", description: "Lift the pen." },
  { name: "pen_down", kind: "command", description: "Lower the pen." },
  { name: "clear_screen", kind: "command", description: "Clear the drawing." },
  {
    name: "print",
    kind: "command",
    description: "Print a value.",
    argumentDescription: "one value",
  },
];

const DEFAULT_INSTRUCTIONS = [
  "Recognize only magnets from the supplied catalog.",
  "Return JSON only. Do not return Markdown or OpenLogo source.",
  "Read visible parameters exactly; return arguments as strings and use an empty arguments array when none are visible.",
  "Infer nesting from physical containment or explicit block connectors.",
  "Do not guess uncertain labels or arguments: lower confidence and use the best visible candidate.",
  "Coordinates use the original image pixels, with x/y at the top-left.",
  'Each block\'s "bounds" must be a JSON object with numeric keys x, y, width, and height — never an array.',
].join(" ");

export function createLlmBoardRecognitionProvider(
  client: LlmBoardRecognitionClient,
  options: LlmBoardProviderOptions = {
    magnetCatalog: DEFAULT_MAGNET_DESCRIPTIONS,
  },
): BoardRecognitionProvider {
  const magnetCatalog = options.magnetCatalog;
  const catalogByName = new Map(
    magnetCatalog.map((entry) => [entry.name, entry]),
  );
  const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;

  return {
    name: `llm:${client.name}`,
    async recognize(image, signal) {
      validateRaster(image);
      throwIfCancelled(signal);
      const response = await client.recognize(
        {
          imageBase64: image.encodedImageBase64 ?? toBase64(image.rgba),
          imageMimeType: image.mimeType ?? "image/png",
          imageWidth: image.width,
          imageHeight: image.height,
          magnetCatalog,
          instructions,
        },
        signal,
      );
      throwIfCancelled(signal);
      return validateRecognitionResponse(response, catalogByName, image);
    },
  };
}

function validateRecognitionResponse(
  response: unknown,
  catalogByName: ReadonlyMap<string, BoardMagnetDescription>,
  image: RasterImage,
): readonly RecognizedBlock[] {
  if (!isRecord(response) || !Array.isArray(response.blocks)) {
    throw new TypeError("LLM response must contain a blocks array.");
  }
  const boundsScale = computeBoundsScale(response.blocks, image);
  return response.blocks.map((block, index) =>
    validateBlock(
      block,
      `llm-block-${index + 1}`,
      catalogByName,
      image,
      boundsScale,
    ),
  );
}

function validateBlock(
  value: unknown,
  id: string,
  catalogByName: ReadonlyMap<string, BoardMagnetDescription>,
  image: RasterImage,
  boundsScale: BoundsScale,
): RecognizedBlock {
  if (!isRecord(value)) {
    throw new TypeError(`LLM block '${id}' must be an object.`);
  }
  const name = value.name;
  const entry = typeof name === "string" ? catalogByName.get(name) : undefined;
  if (!entry) {
    throw new TypeError(`LLM returned unsupported block '${String(name)}'.`);
  }
  const bounds = validateBounds(value.bounds, image, boundsScale);
  const argumentsValue = value.arguments;
  const confidence = value.confidence;
  const children = value.children;
  if (
    !Array.isArray(argumentsValue) ||
    typeof confidence !== "number" ||
    confidence < 0 ||
    confidence > 1 ||
    !Array.isArray(children)
  ) {
    throw new TypeError(
      `LLM block '${id}' has invalid arguments, confidence, or children.`,
    );
  }
  return {
    id,
    kind: entry.kind,
    name: entry.name,
    arguments: argumentsValue.map(normalizeArgument),
    bounds,
    confidence,
    children: children.map((child, childIndex) =>
      validateBlock(
        child,
        `${id}-${childIndex + 1}`,
        catalogByName,
        image,
        boundsScale,
      ),
    ),
  };
}

interface BoundsScale {
  readonly x: number;
  readonly y: number;
}

function computeBoundsScale(
  blocks: readonly unknown[],
  image: RasterImage,
): BoundsScale {
  const extents = collectBoundsExtents(blocks, {
    right: image.width,
    bottom: image.height,
  });
  return {
    x: extents.right > image.width ? image.width / extents.right : 1,
    y: extents.bottom > image.height ? image.height / extents.bottom : 1,
  };
}

function collectBoundsExtents(
  blocks: readonly unknown[],
  extents: { right: number; bottom: number },
): { right: number; bottom: number } {
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    const bounds = readRawBounds(block.bounds);
    if (bounds) {
      extents.right = Math.max(extents.right, bounds.x + bounds.width);
      extents.bottom = Math.max(extents.bottom, bounds.y + bounds.height);
    }
    if (Array.isArray(block.children)) {
      collectBoundsExtents(block.children, extents);
    }
  }
  return extents;
}

function normalizeArgument(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  throw new TypeError(
    "LLM block arguments must be strings, numbers, or booleans.",
  );
}

function validateBounds(
  value: unknown,
  image: RasterImage,
  boundsScale: BoundsScale,
): ImageBounds {
  const rawBounds = readRawBounds(value);
  const { x, y, width, height } = rawBounds
    ? {
        x: rawBounds.x * boundsScale.x,
        y: rawBounds.y * boundsScale.y,
        width: rawBounds.width * boundsScale.x,
        height: rawBounds.height * boundsScale.y,
      }
    : { x: undefined, y: undefined, width: undefined, height: undefined };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError("LLM block bounds must fit inside the image.");
  }

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(image.width, x + width);
  const bottom = Math.min(image.height, y + height);
  if (right <= left || bottom <= top) {
    throw new TypeError("LLM block bounds must fit inside the image.");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function readRawBounds(value: unknown): ImageBounds | undefined {
  // Some LLMs return [x, y, width, height] despite instructions; accept both shapes.
  const { x, y, width, height } = Array.isArray(value)
    ? { x: value[0], y: value[1], width: value[2], height: value[3] }
    : isRecord(value)
      ? value
      : { x: undefined, y: undefined, width: undefined, height: undefined };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRaster(image: RasterImage): void {
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

function throwIfCancelled(signal: CancellationSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Board recognition was cancelled.");
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return encodeBase64(binary);
}

function encodeBase64(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const hasSecond = index + 1 < value.length;
    const hasThird = index + 2 < value.length;
    const first = value.charCodeAt(index);
    const second = hasSecond ? value.charCodeAt(index + 1) : 0;
    const third = hasThird ? value.charCodeAt(index + 2) : 0;
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | (second >> 4)];
    output += hasSecond ? alphabet[((second & 15) << 2) | (third >> 6)] : "=";
    output += hasThird ? alphabet[third & 63] : "=";
  }
  return output;
}
