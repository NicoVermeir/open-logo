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

test("a newer import owns cancellation and ignores the older result", async () => {
  const editor = editorSpy();
  const recognitions = [];
  const controller = createBoardImportController(editor, {
    name: "ordered",
    recognize(_image, signal) {
      return new Promise((resolve) => recognitions.push({ resolve, signal }));
    },
  });

  const firstImport = controller.importImage(image);
  const secondImport = controller.importImage(image);
  recognitions[0].resolve([block]);
  assert.equal(await firstImport, null);
  assert.equal(recognitions[0].signal.aborted, true);

  recognitions[1].resolve([{ ...block, arguments: ["20"] }]);
  assert.equal((await secondImport).source, "forward 20");
  assert.deepEqual(
    editor.calls.map((call) => call.source),
    ["forward 20"],
  );
  assert.equal(controller.getState().status, "succeeded");
});

test("ignores a result cancelled after recognition has validated it", async () => {
  const editor = editorSpy();
  const controller = createBoardImportController(editor, {
    get name() {
      controller.cancel();
      return "cancel-at-completion";
    },
    async recognize() {
      return [block];
    },
  });
  assert.equal(await controller.importImage(image), null);
  assert.deepEqual(editor.calls, []);
  assert.equal(controller.getState().status, "idle");
});

test("an externally aborted import clears its own recognizing state", async () => {
  const editor = editorSpy();
  const signal = { aborted: false };
  const states = [];
  const controller = createBoardImportController(editor, {
    name: "external-abort",
    async recognize() {
      signal.aborted = true;
      throw new Error("cancelled");
    },
  }, {
    createCancellationController: () => ({ signal, abort() { signal.aborted = true; } }),
    onStateChange: (state) => states.push(state.status),
  });
  assert.equal(await controller.importImage(image), null);
  assert.deepEqual(editor.calls, []);
  assert.deepEqual(states, ["recognizing", "idle"]);
});

test("empty recognition leaves the editor unchanged and publishes success", async () => {
  const editor = editorSpy();
  const controller = createBoardImportController(editor, createStaticBoardRecognitionProvider([]));
  assert.equal((await controller.importImage(image)).source, "");
  assert.deepEqual(editor.calls, []);
  assert.equal(controller.getState().status, "succeeded");
});

test("reports invalid input and non-Error editor failures", async () => {
  const controller = createBoardImportController({
    setTextAndSelection() { throw "editor unavailable"; },
  }, createStaticBoardRecognitionProvider([block]));
  assert.equal(await controller.importImage({ ...image, width: 0 }), null);
  assert.equal(controller.getState().status, "failed");
  assert.match(controller.getState().error, /RGBA bytes/);
  assert.equal(await controller.importImage(image), null);
  assert.equal(controller.getState().error, "Board import failed.");
});

test("a throwing failure observer releases the import for a multiline retry", async () => {
  const editor = editorSpy();
  const failure = new Error("observer unavailable");
  const controller = createBoardImportController(editor,
    createStaticBoardRecognitionProvider([
      block,
      { ...block, id: "forward-2", arguments: ["20"], bounds: { ...block.bounds, y: 20 } },
    ]), {
      onStateChange(state) {
        if (state.status === "failed") throw failure;
      },
    });
  await assert.rejects(controller.importImage({ ...image, width: 0 }), (error) => error === failure);
  assert.equal((await controller.importImage(image)).source, "forward 10\nforward 20");
  assert.deepEqual(editor.calls, [{
    source: "forward 10\nforward 20",
    selection: { anchor: [2, 11], head: [2, 11] },
  }]);
  assert.equal(controller.getState().status, "succeeded");
});
