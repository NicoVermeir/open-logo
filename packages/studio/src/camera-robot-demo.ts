import type { BoardReadResult, RasterImage } from "@openlogo/board-reader";

export type CameraRobotDemoStatus =
  "idle" | "capturing" | "recognizing" | "running" | "succeeded" | "failed";

export interface CameraRobotDemoState {
  readonly status: CameraRobotDemoStatus;
  readonly error: string | null;
}

export interface CameraFrameSource {
  captureFrame(): Promise<RasterImage>;
  cancelCapture(): void;
}

export interface CameraRobotDemoController {
  getState(): CameraRobotDemoState;
  run(): Promise<void>;
  cancel(): Promise<boolean>;
}

export interface CameraRobotDemoOptions {
  readonly onStateChange?: (state: CameraRobotDemoState) => void;
}

interface BoardImporter {
  getState(): { readonly error: string | null };
  importImage(image: RasterImage): Promise<BoardReadResult | null>;
  cancel(): void;
}

interface RobotRunner {
  runOnRobot(): Promise<boolean>;
  reset(): Promise<void>;
}

export function createCameraRobotDemoController(
  frameSource: CameraFrameSource,
  boardImporter: BoardImporter,
  robotRunner: RobotRunner,
  options: CameraRobotDemoOptions = {},
): CameraRobotDemoController {
  let state: CameraRobotDemoState = { status: "idle", error: null };
  let active = false;
  let revision = 0;
  let cancellation: Promise<boolean> | undefined;

  const publish = (nextState: CameraRobotDemoState): void => {
    state = nextState;
    options.onStateChange?.(state);
  };

  return {
    getState: () => state,
    cancel() {
      if (cancellation !== undefined) return cancellation;
      const cancellationRevision = ++revision;
      if (!active) {
        publish({ status: "idle", error: null });
        return Promise.resolve(false);
      }
      frameSource.cancelCapture();
      boardImporter.cancel();
      cancellation = (async () => {
        try {
          await robotRunner.reset();
          if (cancellationRevision === revision)
            publish({ status: "idle", error: null });
        } catch (error) {
          if (cancellationRevision === revision)
            publish({
              status: "failed",
              error:
                error instanceof Error ? error.message : "Robot reset failed.",
            });
          throw error;
        } finally {
          if (cancellationRevision === revision) active = false;
          cancellation = undefined;
        }
        return true;
      })();
      return cancellation;
    },
    async run() {
      if (active) return;
      active = true;
      const currentRevision = ++revision;
      const cancelled = () => currentRevision !== revision;
      try {
        publish({ status: "capturing", error: null });
        const image = await frameSource.captureFrame();
        if (cancelled()) return;
        publish({ status: "recognizing", error: null });
        const result = await boardImporter.importImage(image);
        if (cancelled()) return;
        if (result === null) {
          publish({
            status: "failed",
            error:
              boardImporter.getState().error ?? "Board recognition failed.",
          });
          return;
        }
        publish({ status: "running", error: null });
        const completed = await robotRunner.runOnRobot();
        if (cancelled()) return;
        if (!completed) throw new Error("Robot run did not complete.");
        publish({ status: "succeeded", error: null });
      } catch (error) {
        if (cancelled()) return;
        publish({
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Camera-to-robot demo failed.",
        });
      } finally {
        if (!cancelled()) active = false;
      }
    },
  };
}
