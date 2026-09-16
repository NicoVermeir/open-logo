import type { Unsubscribe } from "./state-model.js";

export type ResizablePane = "lesson" | "editor" | "turtle";

export interface PaneLayoutView {
  readonly lesson: number;
  readonly editor: number;
  readonly turtle: number;
}

export interface PaneLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PaneLayoutController {
  getView(): PaneLayoutView;
  setShare(pane: ResizablePane, share: number): void;
  setPair(
    leftPane: ResizablePane,
    rightPane: ResizablePane,
    leftShare: number,
    rightShare: number,
  ): void;
  subscribe(listener: (view: PaneLayoutView) => void): Unsubscribe;
}

export interface PaneResizeController {
  start(
    leftPane: ResizablePane,
    rightPane: ResizablePane,
    pointerX: number,
    containerWidth: number,
  ): void;
  move(pointerX: number): void;
  stop(): void;
}

const STORAGE_PREFIX = "openlogo.pane-layout.";
const DEFAULT_LAYOUT: PaneLayoutView = {
  lesson: 20,
  editor: 48,
  turtle: 42,
};

function readShare(
  storage: PaneLayoutStorage | undefined,
  pane: ResizablePane,
): number {
  const stored = Number(storage?.getItem(`${STORAGE_PREFIX}${pane}`));
  return Number.isFinite(stored) && stored >= 10 && stored <= 80
    ? stored
    : DEFAULT_LAYOUT[pane];
}

export function createPaneLayoutController(
  storage?: PaneLayoutStorage,
): PaneLayoutController {
  let view: PaneLayoutView = {
    lesson: readShare(storage, "lesson"),
    editor: readShare(storage, "editor"),
    turtle: readShare(storage, "turtle"),
  };
  const listeners = new Set<(next: PaneLayoutView) => void>();

  function publish(): void {
    for (const listener of listeners) listener(view);
  }

  function persist(pane: ResizablePane): void {
    storage?.setItem(`${STORAGE_PREFIX}${pane}`, String(view[pane]));
  }

  return {
    getView() {
      return view;
    },
    setShare(pane, share) {
      const nextShare = Math.min(80, Math.max(10, Math.round(share)));
      view = { ...view, [pane]: nextShare };
      persist(pane);
      publish();
    },
    setPair(leftPane, rightPane, leftShare, rightShare) {
      view = {
        ...view,
        [leftPane]: Math.round(leftShare),
        [rightPane]: Math.round(rightShare),
      };
      persist(leftPane);
      persist(rightPane);
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createPaneResizeController(
  layout: PaneLayoutController,
): PaneResizeController {
  let active:
    | {
        readonly leftPane: ResizablePane;
        readonly rightPane: ResizablePane;
        readonly pointerX: number;
        readonly containerWidth: number;
        readonly leftShare: number;
        readonly rightShare: number;
      }
    | undefined;

  return {
    start(leftPane, rightPane, pointerX, containerWidth) {
      const view = layout.getView();
      active = {
        leftPane,
        rightPane,
        pointerX,
        containerWidth,
        leftShare: view[leftPane],
        rightShare: view[rightPane],
      };
    },
    move(pointerX) {
      if (!active || active.containerWidth <= 0) return;
      const totalShare = active.leftShare + active.rightShare;
      const deltaShare =
        ((pointerX - active.pointerX) / active.containerWidth) * totalShare;
      const minimumLeftShare = Math.max(10, totalShare - 80);
      const maximumLeftShare = Math.min(80, totalShare - 10);
      const leftShare = Math.min(
        maximumLeftShare,
        Math.max(minimumLeftShare, active.leftShare + deltaShare),
      );
      layout.setPair(
        active.leftPane,
        active.rightPane,
        leftShare,
        totalShare - leftShare,
      );
    },
    stop() {
      active = undefined;
    },
  };
}
