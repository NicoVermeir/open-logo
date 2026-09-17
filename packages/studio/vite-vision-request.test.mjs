import assert from "node:assert/strict";
import test from "node:test";
import { createVisionRequest } from "./vite-vision-request.mjs";

const board = {
  imageBase64: "cGl4ZWxz",
  imageMimeType: "image/jpeg",
  imageWidth: 1280,
  imageHeight: 720,
  instructions: "Recognize only supported magnets.",
  magnetCatalog: [{ name: "forward", arguments: ["distance"] }],
};
const environment = { OPENLOGO_LLM_MODEL: "gpt-5-mini" };

function serializedRequest(body, env) {
  return JSON.parse(JSON.stringify(createVisionRequest(body, env)));
}

test("vision request preserves the model, prompt, catalog, and image", () => {
  assert.deepEqual(serializedRequest(board, environment), {
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Recognize only supported magnets. Return exactly {"blocks":[...]} with each block containing name, arguments, bounds, confidence, and children. Bounds must use this image coordinate space: width 1280, height 720. The supported magnet catalog is: [{"name":"forward","arguments":["distance"]}]',
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Recognize this OpenLogo magnetic board." },
          {
            type: "image_url",
            image_url: {
              url: "data:image/jpeg;base64,cGl4ZWxz",
              detail: "low",
            },
          },
        ],
      },
    ],
  });
});

for (const effort of ["minimal", "low", "medium", "high"]) {
  test(`vision request changes only reasoning effort when set to ${effort}`, () => {
    assert.deepEqual(
      serializedRequest(board, {
        ...environment,
        OPENLOGO_LLM_REASONING_EFFORT: effort,
      }),
      { ...serializedRequest(board, environment), reasoning_effort: effort },
    );
  });
}

test("vision request omits blank reasoning effort for non-reasoning models", () => {
  const nonReasoningEnvironment = { OPENLOGO_LLM_MODEL: "gpt-4.1" };
  assert.deepEqual(
    serializedRequest(board, {
      ...nonReasoningEnvironment,
      OPENLOGO_LLM_REASONING_EFFORT: "",
    }),
    serializedRequest(board, nonReasoningEnvironment),
  );
});

test("vision request retains defaults for omitted inputs and settings", () => {
  const request = serializedRequest({}, {});
  assert.equal(Object.hasOwn(request, "model"), false);
  assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
  assert.equal(
    request.messages[0].content,
    ' Return exactly {"blocks":[...]} with each block containing name, arguments, bounds, confidence, and children. Bounds must use this image coordinate space: width unknown, height unknown. The supported magnet catalog is: []',
  );
  assert.deepEqual(request.messages[1].content[1].image_url, {
    url: "data:image/png;base64,",
    detail: "low",
  });
});
