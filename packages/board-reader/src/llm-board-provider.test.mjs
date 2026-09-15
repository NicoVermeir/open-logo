import assert from "node:assert/strict";
import test from "node:test";
import { createLlmBoardRecognitionProvider, readBoard } from "../dist/index.js";

const image = {
  width: 2,
  height: 1,
  rgba: new Uint8Array([0, 1, 2, 255, 3, 4, 5, 255]),
};

const response = {
  blocks: [
    {
      name: "forward",
      arguments: ["50"],
      bounds: { x: 0, y: 0, width: 2, height: 1 },
      confidence: 0.92,
      children: [],
    },
  ],
};

test("sends portable image data and validates the structured response", async () => {
  let request;
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize(nextRequest) {
      request = nextRequest;
      return response;
    },
  });

  const blocks = await provider.recognize(image);

  assert.equal(provider.name, "llm:test-vision");
  assert.equal(request.imageBase64, "AAEC/wMEBf8=");
  assert.equal(request.imageWidth, 2);
  assert.equal(request.imageHeight, 1);
  assert.match(request.instructions, /JSON only/);
  assert.equal(blocks[0].name, "forward");
  assert.deepEqual(blocks[0].arguments, ["50"]);
});

test("integrates with source generation and parser validation", async () => {
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      return response;
    },
  });

  const result = await readBoard(image, provider, {
    profiles: ["core-language", "turtle-rendering"],
  });

  assert.equal(result.source, "forward 50");
  assert.equal(result.languageDiagnostics.length, 0);
});

test("normalizes primitive model arguments before source generation", async () => {
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      return {
        blocks: [
          {
            name: "repeat",
            arguments: [4],
            bounds: { x: 0, y: 0, width: 2, height: 1 },
            confidence: 0.96,
            children: [
              {
                name: "forward",
                arguments: [80],
                bounds: { x: 0, y: 0, width: 2, height: 1 },
                confidence: 0.95,
                children: [],
              },
              {
                name: "print",
                arguments: [true],
                bounds: { x: 0, y: 0, width: 2, height: 1 },
                confidence: 0.95,
                children: [],
              },
            ],
          },
        ],
      };
    },
  });

  const result = await readBoard(image, provider, {
    profiles: ["core-language", "turtle-rendering"],
  });

  assert.equal(
    result.source,
    "repeat 4\n  forward 80\n  print true\nend repeat",
  );
  assert.equal(result.languageDiagnostics.length, 0);
});

test("clamps approximate model bounds to the image", async () => {
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      return {
        blocks: [
          {
            name: "right",
            arguments: [90],
            bounds: { x: 1, y: 0, width: 4, height: 3 },
            confidence: 0.96,
            children: [],
          },
        ],
      };
    },
  });

  const blocks = await provider.recognize(image);

  assert.deepEqual(blocks[0].bounds, { x: 0.4, y: 0, width: 1.6, height: 1 });
  assert.deepEqual(blocks[0].arguments, ["90"]);
});

test("scales model coordinate spaces larger than the image", async () => {
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      return {
        blocks: [
          {
            name: "forward",
            arguments: [80],
            bounds: { x: 5, y: 2, width: 5, height: 4 },
            confidence: 0.96,
            children: [],
          },
        ],
      };
    },
  });

  const blocks = await provider.recognize(image);

  assert.equal(blocks[0].bounds.x, 1);
  assert.equal(blocks[0].bounds.y, 1 / 3);
  assert.equal(blocks[0].bounds.width, 1);
  assert.ok(Math.abs(blocks[0].bounds.height - 2 / 3) < Number.EPSILON);
});

test("rejects hallucinated or malformed model output", async () => {
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      return {
        blocks: [
          {
            name: "invented_command",
            arguments: [],
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            confidence: 1,
            children: [],
          },
        ],
      };
    },
  });

  await assert.rejects(provider.recognize(image), /unsupported block/);
});

test("honors cancellation before calling the client", async () => {
  let called = false;
  const provider = createLlmBoardRecognitionProvider({
    name: "test-vision",
    async recognize() {
      called = true;
      return response;
    },
  });

  await assert.rejects(
    provider.recognize(image, { aborted: true }),
    /cancelled/,
  );
  assert.equal(called, false);
});
