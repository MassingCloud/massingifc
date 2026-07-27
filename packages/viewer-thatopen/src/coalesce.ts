/**
 * Frame coalescing for camera-driven updates.
 *
 * Fragment rendering is camera-driven: the runtime streams and culls against the active camera, so
 * every camera move asks for an update. Those fire many times per frame, and running a full pass on
 * each is strictly wasted work — only the last one before the paint can affect what the user sees.
 *
 * Extracted from the adapter and given a clock and scheduler so it is testable without a browser,
 * which is the whole reason this file exists separately.
 */

export interface Scheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface Coalesced {
  /** Ask for a pass. At most one runs per scheduled frame however often this is called. */
  trigger(): void;
  /** Drop a pending pass, e.g. because a full-quality pass is about to supersede it. */
  cancel(): void;
  readonly pending: boolean;
}

export function coalesce(run: () => void, scheduler: Scheduler): Coalesced {
  let handle: number | undefined;

  return {
    trigger() {
      if (handle !== undefined) return;
      handle = scheduler.request(() => {
        handle = undefined;
        run();
      });
    },
    cancel() {
      if (handle === undefined) return;
      scheduler.cancel(handle);
      handle = undefined;
    },
    get pending() {
      return handle !== undefined;
    },
  };
}

/** Scheduler backed by `requestAnimationFrame`, for a browser host. */
export function animationFrameScheduler(): Scheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/**
 * Caps the device pixel ratio.
 *
 * A 4K display shades every pixel of a tall tower at 2x for ever, and dropping to 1x is a 4x cut in
 * fragment work — the cheapest large win available on a heavy model. Degrade quickly, because the
 * user is suffering now; recover slowly, to be sure the improvement holds rather than oscillating.
 */
export function nextPixelRatio(
  current: number,
  frameMs: number,
  options: { readonly min?: number; readonly max: number; readonly targetMs?: number } = { max: 2 },
): number {
  const min = options.min ?? 1;
  const target = options.targetMs ?? 1000 / 60;

  if (frameMs > target * 2) return Math.max(min, current - 0.5);
  if (frameMs < target * 0.75) return Math.min(options.max, current + 0.25);
  return current;
}
