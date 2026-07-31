import type { ElementRef, SavedViewpoint, Vec3 } from "@massingifc/project-schema";
import { describe, expect, it, vi } from "vitest";
import type { FragmentAppearanceModel } from "./model-data.js";
import { ThatOpenSectioning, normalise, planeConstant, type ClippingSink } from "./sectioning.js";
import { ThatOpenVisibility, parseColor } from "./visibility.js";
import { ThatOpenViewpoints, type CameraPort } from "./viewpoints.js";

const GUIDS: Readonly<Record<string, number>> = {
  "1Wall00000000000000W01": 2,
  "2Door00000000000000D01": 3,
};

interface Recorded {
  readonly call: string;
  readonly ids: number[] | undefined;
  readonly value?: unknown;
}

function fakeAppearance(delayMs = 0): FragmentAppearanceModel & { readonly log: Recorded[] } {
  const log: Recorded[] = [];
  const settle = async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
  return {
    log,
    async setVisible(ids, visible) {
      await settle();
      log.push({ call: "setVisible", ids, value: visible });
    },
    async resetVisible() {
      await settle();
      log.push({ call: "resetVisible", ids: undefined });
    },
    async setColor(ids, color) {
      await settle();
      log.push({ call: "setColor", ids, value: color });
    },
    async resetHighlight(ids) {
      await settle();
      log.push({ call: "resetHighlight", ids });
    },
    async getLocalIdsByGuids(guids) {
      await settle();
      return guids.map((guid) => GUIDS[guid] ?? null);
    },
  };
}

const ref = (globalId: string): ElementRef => ({ modelId: "struct", globalId });
const WALL = ref("1Wall00000000000000W01");
const DOOR = ref("2Door00000000000000D01");

describe("visibility overrides", () => {
  it("reports hidden elements the instant the call returns", () => {
    const visibility = new ThatOpenVisibility(() => fakeAppearance(5));

    visibility.hide([WALL]);

    // The engine has not answered yet. A panel reading back what it just wrote must not see stale
    // state, so the bookkeeping is synchronous even though the engine is not.
    expect(visibility.hiddenElements().map((element) => element.globalId)).toEqual([
      WALL.globalId,
    ]);
  });

  it("resolves GlobalIds to local ids before touching the engine", async () => {
    const model = fakeAppearance();
    const visibility = new ThatOpenVisibility(() => model);

    visibility.hide([WALL, DOOR]);
    await visibility.settled();

    expect(model.log).toEqual([{ call: "setVisible", ids: [2, 3], value: false }]);
  });

  it("lets the last call win when two overlap", async () => {
    // hide() then show() issue overlapping worker round trips. The first one here is deliberately
    // the slow one: run concurrently, show() would land first and the wall would end up hidden —
    // the opposite of what the user asked for last. Serialising is what makes the last call decide.
    const latencies = [40, 1];
    const model = fakeAppearance(0);
    let call = 0;
    const varying: FragmentAppearanceModel & { readonly log: Recorded[] } = {
      ...model,
      async setVisible(ids, visible) {
        const delay = latencies[call++] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        model.log.push({ call: "setVisible", ids, value: visible });
      },
    };
    const visibility = new ThatOpenVisibility(() => varying);

    visibility.hide([WALL]);
    visibility.show([WALL]);
    await visibility.settled();

    expect(model.log.map((entry) => entry.value)).toEqual([false, true]);
    expect(visibility.hiddenElements()).toEqual([]);
  });

  it("expresses isolation as everything-off-then-these-on", async () => {
    const model = fakeAppearance();
    const visibility = new ThatOpenVisibility(() => model);

    visibility.isolate([WALL]);
    await visibility.settled();

    expect(model.log).toEqual([
      { call: "setVisible", ids: undefined, value: false },
      { call: "setVisible", ids: [2], value: true },
    ]);
  });

  it("clears an element from the hidden set when it is isolated", async () => {
    const visibility = new ThatOpenVisibility(() => fakeAppearance());
    visibility.hide([WALL, DOOR]);
    visibility.isolate([WALL]);
    await visibility.settled();

    expect(visibility.hiddenElements().map((element) => element.globalId)).toEqual([
      DOOR.globalId,
    ]);
  });

  it("resets every model it has touched without being told which", async () => {
    const model = fakeAppearance();
    const visibility = new ThatOpenVisibility(() => model);

    visibility.hide([WALL]);
    visibility.setColor([DOOR], "#ff0000");
    visibility.resetOverrides();
    await visibility.settled();

    expect(model.log.map((entry) => entry.call)).toEqual([
      "setVisible",
      "setColor",
      "resetHighlight",
      "resetVisible",
    ]);
    expect(visibility.hiddenElements()).toEqual([]);
  });

  it("keeps running after an engine failure instead of freezing the queue", async () => {
    const model = fakeAppearance();
    const failing: FragmentAppearanceModel & { readonly log: Recorded[] } = {
      ...model,
      setVisible: vi
        .fn()
        .mockRejectedValueOnce(new Error("worker died"))
        .mockImplementation(async (ids: number[] | undefined, visible: boolean) => {
          model.log.push({ call: "setVisible", ids, value: visible });
        }),
    };
    const visibility = new ThatOpenVisibility(() => failing);

    visibility.hide([WALL]);
    visibility.show([WALL]);
    await visibility.settled();

    // One transient error must not freeze the panel for the rest of the session.
    expect(visibility.lastError).toBeInstanceOf(Error);
    expect(model.log).toEqual([{ call: "setVisible", ids: [2], value: true }]);
  });

  it("skips a model that is not loaded rather than throwing", async () => {
    const visibility = new ThatOpenVisibility(() => undefined);
    visibility.hide([WALL]);
    await visibility.settled();
    expect(visibility.lastError).toBeUndefined();
  });

  it("ignores elements whose GlobalId does not resolve", async () => {
    const model = fakeAppearance();
    const visibility = new ThatOpenVisibility(() => model);

    visibility.hide([ref("absent")]);
    await visibility.settled();

    expect(model.log).toEqual([]);
  });
});

describe("colour parsing", () => {
  it("reads hex in both lengths", () => {
    expect(parseColor("#ff0000")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseColor("#0f0")).toEqual({ r: 0, g: 1, b: 0 });
    expect(parseColor("0000ff")).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("reads comma triples in either range", () => {
    expect(parseColor("255,0,0")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseColor("0,1,0")).toEqual({ r: 0, g: 1, b: 0 });
  });

  it("falls back to magenta rather than black", () => {
    // Painting elements the colour of a shadow is how a broken override goes unnoticed.
    expect(parseColor("rebeccapurple")).toEqual({ r: 1, g: 0, b: 1 });
    expect(parseColor("")).toEqual({ r: 1, g: 0, b: 1 });
  });
});

describe("sectioning", () => {
  const sink = (): ClippingSink & { readonly pushed: unknown[][] } => {
    const pushed: unknown[][] = [];
    return { pushed, setPlanes: (planes) => pushed.push([...planes]) };
  };

  it("puts a plane through the given point", () => {
    // A horizontal plane at z = 3 has constant -3 in the ax+by+cz+d=0 form.
    expect(planeConstant([0, 0, 1], [0, 0, 3])).toBe(-3);
    expect(normalise([0, 0, 5])).toEqual([0, 0, 1]);
  });

  it("survives a zero normal instead of producing NaNs", () => {
    // NaNs in a clipping plane turn the whole scene invisible with no error anywhere.
    expect(normalise([0, 0, 0])).toEqual([0, 0, 1]);
    expect(planeConstant([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("pushes only enabled planes to the renderer", () => {
    const target = sink();
    const sectioning = new ThatOpenSectioning({ sink: target });

    const plane = sectioning.create([0, 0, 1], [0, 0, 3]);
    sectioning.update(plane.id, { enabled: false });

    // The plane stays listed so a UI can offer it back, but must stop cutting the model.
    expect(sectioning.list()).toHaveLength(1);
    expect(target.pushed.at(-1)).toEqual([]);
  });

  it("moves a plane without recreating it", () => {
    const target = sink();
    const sectioning = new ThatOpenSectioning({ sink: target });
    const plane = sectioning.create([0, 0, 1], [0, 0, 3]);

    sectioning.update(plane.id, { constant: -5 });

    expect(sectioning.list()[0]?.constant).toBe(-5);
    expect(target.pushed.at(-1)).toEqual([{ normal: [0, 0, 1], constant: -5 }]);
  });

  it("ignores an update to a plane that is gone", () => {
    const target = sink();
    const sectioning = new ThatOpenSectioning({ sink: target });
    sectioning.update("nope", { constant: 1 });
    expect(target.pushed).toEqual([]);
  });

  it("clears and restores whole sets", () => {
    const target = sink();
    const sectioning = new ThatOpenSectioning({ sink: target });
    sectioning.create([0, 0, 1], [0, 0, 3]);

    sectioning.clear();
    expect(sectioning.list()).toEqual([]);
    expect(target.pushed.at(-1)).toEqual([]);

    sectioning.restore([{ normal: [1, 0, 0], constant: -2 }]);
    expect(sectioning.list()).toHaveLength(1);
    expect(target.pushed.at(-1)).toEqual([{ normal: [1, 0, 0], constant: -2 }]);
  });

  it("does not push when clearing an already-empty set", () => {
    const target = sink();
    new ThatOpenSectioning({ sink: target }).clear();
    expect(target.pushed).toEqual([]);
  });
});

describe("viewpoints", () => {
  function fakeCamera(): CameraPort & { readonly moves: { position: Vec3; animate: boolean }[] } {
    const moves: { position: Vec3; animate: boolean }[] = [];
    let position: Vec3 = [10, 10, 10];
    let target: Vec3 = [0, 0, 0];
    return {
      moves,
      getPosition: () => position,
      getTarget: () => target,
      getProjection: () => "perspective",
      async setLookAt(next, nextTarget, animate) {
        position = next;
        target = nextTarget;
        moves.push({ position: next, animate });
      },
    };
  }

  const build = () => {
    const camera = fakeCamera();
    const sectioning = new ThatOpenSectioning({ sink: { setPlanes: () => {} } });
    const visibility = new ThatOpenVisibility(() => fakeAppearance());
    const viewpoints = new ThatOpenViewpoints({
      camera,
      now: () => "2026-07-27T12:00:00.000Z",
      visibility,
      sectioning,
    });
    return { camera, sectioning, visibility, viewpoints };
  };

  it("captures the camera, the hidden set and the active sections together", async () => {
    const { viewpoints, visibility, sectioning } = build();
    visibility.hide([WALL]);
    sectioning.create([0, 0, 1], [0, 0, 3]);

    const captured = await viewpoints.capture("North elevation");
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    // "Look at this" is useless if the recipient sees the whole model.
    expect(captured.value.name).toBe("North elevation");
    expect(captured.value.position).toEqual([10, 10, 10]);
    expect(captured.value.hidden?.map((element) => element.globalId)).toEqual([WALL.globalId]);
    expect(captured.value.sectionPlanes).toEqual([{ normal: [0, 0, 1], constant: -3 }]);
    expect(captured.value.projection).toBe("perspective");
  });

  it("omits an empty hidden set and empty sections rather than storing noise", async () => {
    const { viewpoints } = build();
    const captured = await viewpoints.capture();
    if (!captured.ok) throw captured.error;

    expect(captured.value.hidden).toBeUndefined();
    expect(captured.value.sectionPlanes).toBeUndefined();
    expect(captured.value.name).toBeUndefined();
  });

  it("restores scene state before moving the camera", async () => {
    const { viewpoints, visibility, sectioning, camera } = build();
    const saved: SavedViewpoint = {
      id: "vp-1",
      position: [1, 2, 3],
      target: [0, 0, 0],
      hidden: [DOOR],
      sectionPlanes: [{ normal: [1, 0, 0], constant: -2 }],
      createdAt: "2026-07-27T12:00:00.000Z",
    };

    const applied = await viewpoints.apply(saved, true);
    expect(applied.ok).toBe(true);

    // Restoring after the move means the animation plays against the old visibility and the model
    // visibly re-shuffles when it lands.
    expect(visibility.hiddenElements().map((element) => element.globalId)).toEqual([DOOR.globalId]);
    expect(sectioning.list()).toHaveLength(1);
    expect(camera.moves).toEqual([{ position: [1, 2, 3], animate: true }]);
  });

  it("clears previous overrides when a viewpoint carries none", async () => {
    const { viewpoints, visibility } = build();
    visibility.hide([WALL]);

    await viewpoints.apply({
      id: "vp-2",
      position: [0, 0, 1],
      target: [0, 0, 0],
      createdAt: "2026-07-27T12:00:00.000Z",
    });

    expect(visibility.hiddenElements()).toEqual([]);
  });

  it("prefers isolation over the hidden set when both are present", async () => {
    const { viewpoints, visibility } = build();
    await viewpoints.apply({
      id: "vp-3",
      position: [0, 0, 1],
      target: [0, 0, 0],
      isolated: [WALL],
      hidden: [DOOR],
      createdAt: "2026-07-27T12:00:00.000Z",
    });
    await visibility.settled();

    expect(visibility.hiddenElements()).toEqual([]);
  });

  it("adopts a viewpoint that arrived from elsewhere", async () => {
    const { viewpoints } = build();
    // A shared issue or an imported BCF should become listable without a separate save step.
    await viewpoints.apply({
      id: "external",
      position: [1, 1, 1],
      target: [0, 0, 0],
      createdAt: "2026-07-27T12:00:00.000Z",
    });

    expect(viewpoints.list().map((viewpoint) => viewpoint.id)).toEqual(["external"]);
  });

  it("reports a camera failure as a Result", async () => {
    const camera = fakeCamera();
    camera.setLookAt = async () => {
      throw new Error("controls detached");
    };
    const viewpoints = new ThatOpenViewpoints({ camera, now: () => "2026-07-27T12:00:00.000Z" });

    const applied = await viewpoints.apply({
      id: "vp-4",
      position: [0, 0, 1],
      target: [0, 0, 0],
      createdAt: "2026-07-27T12:00:00.000Z",
    });
    expect(applied.ok).toBe(false);
  });

  it("reports removing a viewpoint that does not exist", async () => {
    const { viewpoints } = build();
    expect((await viewpoints.remove("nope")).ok).toBe(false);

    const captured = await viewpoints.capture();
    if (!captured.ok) throw captured.error;
    expect((await viewpoints.remove(captured.value.id)).ok).toBe(true);
    expect(viewpoints.list()).toEqual([]);
  });
});
