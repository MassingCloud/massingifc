import type { ElementRef } from "@massingifc/project-schema";
import { describe, expect, it, vi } from "vitest";
import { coalesce, nextPixelRatio, type Scheduler } from "./coalesce.js";
import { ThatOpenSelection } from "./selection.js";

/**
 * Headless coverage for the adapter.
 *
 * The renderer itself needs WebGL and is not exercised here — what is covered is everything that
 * decides *correctness* rather than pixels: the update-coalescing policy, the pixel-ratio governor,
 * and the selection boundary where engine ids must become GlobalIds.
 */

/** Deterministic scheduler: frames run only when the test says so. */
function manualScheduler(): Scheduler & { flush(): void; readonly queued: number } {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    request(callback) {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    flush() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
    },
    get queued() {
      return queue.size;
    },
  };
}

describe("update coalescing", () => {
  it("runs once per frame however many times it is triggered", () => {
    const scheduler = manualScheduler();
    const run = vi.fn();
    const pass = coalesce(run, scheduler);

    for (let i = 0; i < 50; i++) pass.trigger();
    expect(run).not.toHaveBeenCalled();

    scheduler.flush();

    // Only the last trigger before the paint can affect what the user sees; the other 49 would be
    // a full fragments pass each, for nothing.
    expect(run).toHaveBeenCalledOnce();
  });

  it("schedules again after a frame has run", () => {
    const scheduler = manualScheduler();
    const run = vi.fn();
    const pass = coalesce(run, scheduler);

    pass.trigger();
    scheduler.flush();
    pass.trigger();
    scheduler.flush();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending pass so a full-quality pass can supersede it", () => {
    const scheduler = manualScheduler();
    const run = vi.fn();
    const pass = coalesce(run, scheduler);

    pass.trigger();
    expect(pass.pending).toBe(true);

    // This is what happens on camera `rest`: the expensive full pass replaces the cheap one.
    pass.cancel();
    scheduler.flush();

    expect(run).not.toHaveBeenCalled();
    expect(pass.pending).toBe(false);
  });

  it("tolerates cancelling when nothing is pending", () => {
    const scheduler = manualScheduler();
    const pass = coalesce(() => {}, scheduler);
    expect(() => pass.cancel()).not.toThrow();
  });
});

describe("pixel ratio governor", () => {
  it("degrades quickly when frames are slow", () => {
    // The user is suffering now, so give back resolution in one step.
    expect(nextPixelRatio(2, 40, { max: 2 })).toBe(1.5);
  });

  it("recovers slowly when frames are fast", () => {
    // Recover in quarter steps, to be sure the improvement holds rather than oscillating.
    expect(nextPixelRatio(1, 8, { max: 2 })).toBe(1.25);
  });

  it("holds steady in the middle band", () => {
    expect(nextPixelRatio(1.5, 16, { max: 2 })).toBe(1.5);
  });

  it("respects the floor and the ceiling", () => {
    expect(nextPixelRatio(1, 100, { max: 2 })).toBe(1);
    expect(nextPixelRatio(2, 1, { max: 2 })).toBe(2);
  });
});

describe("selection boundary", () => {
  const ref = (globalId: string, localId?: number): ElementRef => ({
    modelId: "arch",
    globalId,
    ...(localId === undefined ? {} : { localId }),
  });

  it("holds GlobalId-bearing references", () => {
    const selection = new ThatOpenSelection();
    selection.set([ref("GUID-A", 41)]);

    // The type makes publishing a bare engine id impossible; downstream families inherit stable
    // identity for free.
    expect(selection.get()[0]?.globalId).toBe("GUID-A");
  });

  it("de-duplicates on identity, not on the transient handle", () => {
    const selection = new ThatOpenSelection();
    selection.set([ref("GUID-A", 41)]);

    // Same element, renumbered by a re-convert. It is still one element.
    selection.add([ref("GUID-A", 987), ref("GUID-B", 42)]);

    expect(selection.get()).toHaveLength(2);
    expect(selection.get()[0]?.localId).toBe(41);
  });

  it("saves and restores named sets", () => {
    const selection = new ThatOpenSelection();
    const setId = selection.saveSet("level-1", [ref("GUID-A"), ref("GUID-B")]);

    selection.clear();
    expect(selection.get()).toHaveLength(0);
    expect(selection.restoreSet(setId)).toHaveLength(2);
    expect(selection.restoreSet("nope")).toHaveLength(0);
  });

  it("does not alias the array it was handed", () => {
    const selection = new ThatOpenSelection();
    const source = [ref("GUID-A")];
    selection.set(source);
    source.push(ref("GUID-B"));

    expect(selection.get()).toHaveLength(1);
  });
});
