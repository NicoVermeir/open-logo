import assert from "node:assert/strict";
import test from "node:test";
import {
  blocksToSource,
  createStaticBoardRecognitionProvider,
  readBoard,
} from "../dist/index.js";

const image = { width: 1, height: 1, rgba: new Uint8Array(4) };
const bounds = { x: 0, y: 0, width: 10, height: 10 };

function command(id, name, args = [], confidence = 1) {
  return {
    id,
    kind: "command",
    name,
    arguments: args,
    bounds,
    confidence,
    children: [],
  };
}

test("generates and validates a simple program", async () => {
  const blocks = [
    command("forward-1", "forward", ["10"]),
    command("right-1", "right", ["90"]),
  ];
  const result = await readBoard(
    image,
    createStaticBoardRecognitionProvider(blocks),
    {
      profiles: ["core-language", "turtle-rendering"],
    },
  );

  assert.equal(result.source, "forward 10\nright 90");
  assert.equal(result.languageDiagnostics.length, 0);
  assert.deepEqual(result.issues, []);
});

test("generates nested long-form control blocks", () => {
  const blocks = [
    {
      id: "repeat-1",
      kind: "repeat",
      name: "repeat",
      arguments: ["4"],
      bounds,
      confidence: 1,
      children: [command("forward-1", "forward", ["10"])],
    },
  ];

  assert.equal(blocksToSource(blocks), "repeat 4\n  forward 10\nend repeat");
});

test("reports low-confidence blocks and parser findings", async () => {
  const result = await readBoard(
    image,
    createStaticBoardRecognitionProvider([
      command("unknown-1", "not_a_command", [], 0.2),
    ]),
    { minimumConfidence: 0.7 },
  );

  assert.equal(result.issues[0].code, "low-confidence");
  assert.equal(result.languageDiagnostics[0].code, "ol-unknown-command");
});

test("rejects malformed raster images", async () => {
  await assert.rejects(
    readBoard(
      { width: 1, height: 1, rgba: new Uint8Array(1) },
      createStaticBoardRecognitionProvider([]),
    ),
    /width \* height \* 4/,
  );
});

test("preserves provider failures as recognition issues", async () => {
  const result = await readBoard(image, {
    name: "failing",
    async recognize() {
      throw new Error("model unavailable");
    },
  });

  assert.equal(result.issues[0].code, "recognition-failed");
  assert.equal(result.issues[0].message, "model unavailable");
});
