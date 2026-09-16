import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaneLayoutController,
  createPaneResizeController,
} from "../dist/pane-layout.js";

test("pane layout defaults favor editor and drawing and persists bounded user changes", () => {
  const values = new Map([
    ["openlogo.pane-layout.lesson", "invalid"],
    ["openlogo.pane-layout.editor", "60"],
    ["openlogo.pane-layout.turtle", "100"],
  ]);
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const controller = createPaneLayoutController(storage);
  const views = [];
  const unsubscribe = controller.subscribe((view) => views.push(view));

  assert.deepEqual(controller.getView(), {
    lesson: 20,
    editor: 60,
    turtle: 42,
  });

  controller.setShare("lesson", 5);
  controller.setShare("editor", 45.6);
  controller.setShare("turtle", 90);
  unsubscribe();
  controller.setShare("editor", 50);

  assert.deepEqual(views, [
    { lesson: 10, editor: 60, turtle: 42 },
    { lesson: 10, editor: 46, turtle: 42 },
    { lesson: 10, editor: 46, turtle: 80 },
  ]);
  assert.equal(values.get("openlogo.pane-layout.lesson"), "10");
  assert.equal(values.get("openlogo.pane-layout.editor"), "50");
  assert.equal(values.get("openlogo.pane-layout.turtle"), "80");
});

test("pane resize gestures preserve pair share while clamping both panes", () => {
  const layout = createPaneLayoutController();
  const resize = createPaneResizeController(layout);

  resize.move(50);
  resize.start("editor", "turtle", 100, 0);
  resize.move(150);
  resize.start("editor", "turtle", 100, 1000);
  resize.move(200);
  assert.deepEqual(layout.getView(), {
    lesson: 20,
    editor: 57,
    turtle: 33,
  });

  resize.move(5000);
  assert.deepEqual(layout.getView(), {
    lesson: 20,
    editor: 80,
    turtle: 10,
  });

  resize.stop();
  resize.move(0);
  assert.deepEqual(layout.getView(), {
    lesson: 20,
    editor: 80,
    turtle: 10,
  });
});
