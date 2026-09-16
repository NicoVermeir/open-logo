import type { Unsubscribe } from "./state-model.js";

export interface VoiceTutorPanelView {
  readonly expanded: boolean;
  readonly actionLabel: string;
}

export interface VoiceTutorPanelController {
  getView(): VoiceTutorPanelView;
  subscribe(listener: (view: VoiceTutorPanelView) => void): Unsubscribe;
  toggle(): void;
}

export function createVoiceTutorPanelController(): VoiceTutorPanelController {
  let expanded = false;
  const listeners = new Set<(view: VoiceTutorPanelView) => void>();

  function getView(): VoiceTutorPanelView {
    return {
      expanded,
      actionLabel: expanded ? "Close voice tutor" : "Open voice tutor",
    };
  }

  function publish(): void {
    const view = getView();
    for (const listener of listeners) listener(view);
  }

  return {
    getView,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle() {
      expanded = !expanded;
      publish();
    },
  };
}
