import { ThatOpenViewer } from "../src/viewer.js";

/**
 * Boots the viewer in a real browser and reports what happened on `window`.
 *
 * Everything else about this adapter is verified by typechecking against the published `.d.ts`,
 * which proves the API is used correctly but not that it *runs*. This is the only place a real
 * WebGL context, a real camera and a real scene graph are exercised.
 */

declare global {
  interface Window {
    smokeResult?: {
      initialised: boolean;
      hasWebGLContext: boolean;
      canvasAttached: boolean;
      hasScene: boolean;
      hasCamera: boolean;
      childrenAfterInit: number;
      disposedCleanly: boolean;
      error?: string;
    };
  }
}

async function run(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>("#viewport");
  if (!container) throw new Error("no container");

  const viewer = new ThatOpenViewer({ workerUrl: "" });

  try {
    const started = await viewer.initialize({ container, showGrid: true });
    if (!started.ok) {
      window.smokeResult = {
        initialised: false,
        hasWebGLContext: false,
        canvasAttached: false,
        hasScene: false,
        hasCamera: false,
        childrenAfterInit: 0,
        disposedCleanly: false,
        error: started.error.message,
      };
      return;
    }

    const canvas = container.querySelector("canvas");
    const gl =
      canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null;

    const world = viewer.world!;
    const result = {
      initialised: true,
      hasWebGLContext: gl !== null,
      canvasAttached: canvas !== null && canvas.isConnected,
      hasScene: world.scene?.three !== undefined,
      hasCamera: world.camera?.three !== undefined,
      // A grid and default lighting are added by setup(), so an initialised world is not empty.
      childrenAfterInit: world.scene.three.children.length,
      disposedCleanly: false,
    };

    viewer.dispose();
    result.disposedCleanly = viewer.world === undefined && viewer.components === undefined;

    window.smokeResult = result;
  } catch (thrown) {
    window.smokeResult = {
      initialised: false,
      hasWebGLContext: false,
      canvasAttached: false,
      hasScene: false,
      hasCamera: false,
      childrenAfterInit: 0,
      disposedCleanly: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

void run();
