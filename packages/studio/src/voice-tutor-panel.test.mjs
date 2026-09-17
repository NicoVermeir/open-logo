import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceTutorPanelController } from "../dist/voice-tutor-panel.js";

test("voice tutor panel starts collapsed and publishes accessible toggle views", () => {
  const controller = createVoiceTutorPanelController();
  const views = [];
  const unsubscribe = controller.subscribe((view) => views.push(view));

  assert.deepEqual(controller.getView(), {
    expanded: false,
    actionLabel: "Open voice tutor",
  });

  controller.toggle();
  controller.toggle();
  unsubscribe();
  controller.toggle();

  assert.deepEqual(views, [
    { expanded: true, actionLabel: "Close voice tutor" },
    { expanded: false, actionLabel: "Open voice tutor" },
  ]);
});
