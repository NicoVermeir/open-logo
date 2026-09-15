import assert from "node:assert/strict";
import test from "node:test";
import { createBoardImportController } from "../dist/index.js";
import { createStaticBoardRecognitionProvider } from "@openlogo/board-reader";

const image = { width: 1, height: 1, rgba: new Uint8Array(4) };
const block = {
  id: "forward-1",
  kind: "command",
  name: "forward",
  arguments: ["10"],
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  confidence: 1,
  children: [],
};

function editorSpy() {
  const calls = [];
  return {
    calls,
    setTextAndSelection(source, selection) {
      calls.push({ source, selection });
    },
  };
}

test("imports generated source without running it", async () => {
  const editor = editorSpy();
  const controller = createBoardImportController(
    editor,
    createStaticBoardRecognitionProvider([block]),
  );

  const result = await controller.importImage(image);

  assert.equal(result.source, "forward 10");
  assert.deepEqual(editor.calls[0], {
    source: "forward 10",
    selection: {
      anchor: [1, 11],
      head: [1, 11],
    },
  });
  assert.equal(controller.getState().status, "succeeded");
});

test("preserves the editor when recognition fails", async () => {
  const editor = editorSpy();
  const controller = createBoardImportController(editor, {
    name: "failing",
    async recognize() {
      throw new Error("not a board");
    },
  });

  const result = await controller.importImage(image);

  assert.equal(result, null);
  assert.deepEqual(editor.calls, []);
  assert.equal(controller.getState().status, "failed");
  assert.equal(controller.getState().error, "not a board");
});

test("cancels an in-flight import without changing the editor", async () => {
  const editor = editorSpy();
  let resolveRecognition;
  const controller = createBoardImportController(editor, {
    name: "delayed",
    recognize(_image, signal) {
      return new Promise((resolve) => {
        resolveRecognition = () => {
          assert.equal(signal.aborted, true);
          resolve([block]);
        };
      });
    },
  });

  const importPromise = controller.importImage(image);
  controller.cancel();
  resolveRecognition();

  assert.equal(await importPromise, null);
  assert.deepEqual(editor.calls, []);
  assert.equal(controller.getState().status, "idle");
});
