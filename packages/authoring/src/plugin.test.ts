import type { ElementRef, Vec3 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORING_COMMANDS,
  AuthoringSessionToken,
  ConstraintToken,
  EditCommandToken,
  EditHistoryToken,
  GeometryBackendToken,
  LevelSourceToken,
  PublishToken,
  SketchPlaneToken,
  type EditOperation,
  type GeometryBackend,
} from "./contracts.js";
import { createAuthoringPlugin } from "./plugin.js";
import {
  distanceToPlane,
  intersectRayPlane,
  levelPlane,
  planeBasis,
  planeToWorld,
  snap,
  worldToPlane,
} from "./sketch.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const el = (globalId: string): ElementRef => ({ modelId: "m1", globalId });
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let harness: TestHarness;
let applied: EditOperation[];
let version: string;
let changedElements: Set<string>;
let constraintHolds: boolean;

const backend = (): GeometryBackend => ({
  apply: async (operations) => {
    applied.push(...operations);
    return { ok: true, value: operations.map((o) => o.element ?? el("new")) };
  },
  revert: async (operations) => {
    for (const operation of operations) {
      const index = applied.indexOf(operation);
      if (index >= 0) applied.splice(index, 1);
    }
    return { ok: true, value: undefined };
  },
  currentVersion: (modelId) => (modelId === "m1" ? version : undefined),
  changedSince: (element) => changedElements.has(element.globalId),
  publish: async () => ({ ok: true, value: undefined }),
  evaluateConstraint: () => constraintHolds,
});

beforeEach(async () => {
  applied = [];
  version = "C01";
  changedElements = new Set();
  constraintHolds = true;
  harness = createTestHarness({ identity: { id: "author", roles: ["author"] } });
  await harness.load(
    createAuthoringPlugin({ clock: createFixedClock(), ids: createCountingIdFactory(), gridSpacing: 0 }),
  );
  harness.kernel.capabilities.provide(GeometryBackendToken, backend());
});

const sessions = () => unwrapOk(harness.kernel.capabilities.require(AuthoringSessionToken));
const edits = () => unwrapOk(harness.kernel.capabilities.require(EditCommandToken));
const history = () => unwrapOk(harness.kernel.capabilities.require(EditHistoryToken));
const publish = () => unwrapOk(harness.kernel.capabilities.require(PublishToken));
const planes = () => unwrapOk(harness.kernel.capabilities.require(SketchPlaneToken));

const move = (globalId: string): EditOperation => ({
  kind: "move-element",
  element: el(globalId),
  transform: IDENTITY,
});

// ---------------------------------------------------------------------------------------------
// Sketch maths
// ---------------------------------------------------------------------------------------------

describe("sketch geometry", () => {
  it("builds an orthonormal basis and orthogonalises a supplied axis", () => {
    // A user picking an axis on screen supplies one that is nearly, but not exactly, in plane.
    const basis = planeBasis([0, 0, 0], [0, 0, 1], [1, 0, 0.3])!;

    expect(basis.xAxis[2]).toBeCloseTo(0, 9);
    expect(basis.xAxis[0] ** 2 + basis.xAxis[1] ** 2).toBeCloseTo(1, 9);
    // x, y, normal must be mutually perpendicular.
    expect(basis.xAxis[0] * basis.yAxis[0] + basis.xAxis[1] * basis.yAxis[1]).toBeCloseTo(0, 9);
  });

  it("picks a well-conditioned axis when given no hint", () => {
    for (const normal of [[0, 0, 1], [1, 0, 0], [0, 1, 0]] as Vec3[]) {
      const basis = planeBasis([0, 0, 0], normal)!;
      expect(basis).toBeDefined();
      // The cross product must not have collapsed to a zero-length axis.
      expect(Math.hypot(...basis.xAxis)).toBeCloseTo(1, 9);
    }
  });

  it("refuses a degenerate normal instead of returning a meaningless basis", () => {
    expect(planeBasis([0, 0, 0], [0, 0, 0])).toBeUndefined();
  });

  it("intersects a ray with a plane", () => {
    const plane = levelPlane(10);
    const hit = intersectRayPlane([5, 5, 20], [0, 0, -1], plane)!;

    expect(hit).toEqual([5, 5, 10]);
  });

  it("misses when the ray is parallel or points away", () => {
    const plane = levelPlane(10);

    expect(intersectRayPlane([0, 0, 20], [1, 0, 0], plane)).toBeUndefined();
    // Pointing up, away from a plane below: a normal outcome of moving past the horizon.
    expect(intersectRayPlane([0, 0, 20], [0, 0, 1], plane)).toBeUndefined();
  });

  it("round-trips between world and plane coordinates", () => {
    const plane = planeBasis([1, 2, 3], [0, 0, 1])!;
    const [u, v] = worldToPlane([4, 6, 3], plane);

    expect(planeToWorld(u, v, plane)).toEqual([4, 6, 3]);
  });

  it("measures signed distance either side of the plane", () => {
    const plane = levelPlane(0);
    expect(distanceToPlane([0, 0, 5], plane)).toBe(5);
    expect(distanceToPlane([0, 0, -5], plane)).toBe(-5);
  });

  it("snaps to a grid, and leaves values alone when spacing is zero", () => {
    expect(snap(1.4, 1)).toBe(1);
    expect(snap(1.6, 1)).toBe(2);
    expect(snap(1.6, 0)).toBe(1.6);
  });
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

describe("sessions", () => {
  it("opens against the current revision", async () => {
    const session = unwrapOk(await sessions().open("m1"));

    expect(session.status).toBe("open");
    expect(session.baseVersion).toBe("C01");
    expect(sessions().current()?.id).toBe(session.id);
  });

  it("refuses a second concurrent session", async () => {
    await sessions().open("m1");

    // Two change sets on one project have no defined merge.
    expect((await sessions().open("m1")).ok).toBe(false);
  });

  it("refuses to open on an unknown model", async () => {
    expect((await sessions().open("ghost")).ok).toBe(false);
  });

  it("reverses the edits when a session is discarded", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);
    expect(applied).toHaveLength(1);

    await sessions().discard(session.id);

    // Marking it discarded without undoing would leave changes nobody agreed to publish.
    expect(applied).toHaveLength(0);
    expect(history().entries()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Edits and history
// ---------------------------------------------------------------------------------------------

describe("edits", () => {
  beforeEach(async () => {
    await sessions().open("m1");
  });

  it("refuses edits with no session open", async () => {
    const bare = createTestHarness();
    await bare.load(createAuthoringPlugin({ ids: createCountingIdFactory() }));
    bare.kernel.capabilities.provide(GeometryBackendToken, backend());
    const service = unwrapOk(bare.kernel.capabilities.require(EditCommandToken));

    expect((await service.apply([move("W1")])).ok).toBe(false);
    await bare.dispose();
  });

  it("validates operation shape before touching geometry", async () => {
    const result = await edits().apply([{ kind: "move-element", element: el("W1") }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("4x4 transform");
    expect(applied).toHaveLength(0);
  });

  it("rejects a create with no geometry and a delete with no element", () => {
    expect(edits().canApply([{ kind: "create-element" }]).ok).toBe(false);
    expect(edits().canApply([{ kind: "delete-element" }]).ok).toBe(false);
  });

  it("counts changes on the session", async () => {
    await edits().apply([move("W1"), move("W2")]);
    expect(sessions().current()?.changeCount).toBe(2);
  });

  it("undoes and redoes through the geometry backend", async () => {
    await edits().apply([move("W1")]);
    expect(history().canUndo()).toBe(true);

    await history().undo();
    expect(applied).toHaveLength(0);
    expect(history().canRedo()).toBe(true);

    await history().redo();
    expect(applied).toHaveLength(1);
  });

  it("keeps the redo entry when redo fails", async () => {
    await edits().apply([move("W1")]);
    await history().undo();

    harness.kernel.capabilities.provide(
      GeometryBackendToken,
      { ...backend(), apply: async () => ({ ok: false, error: new Error("backend down") as never }) },
      { priority: 10 },
    );

    expect((await history().redo()).ok).toBe(false);
    // Consuming the entry on failure would lose the user's ability to try again.
    expect(history().canRedo()).toBe(true);
  });

  it("collapses a drag into one undo step", async () => {
    await edits().apply([move("W1")]);
    await edits().apply([move("W1")]);
    await edits().apply([move("W1")]);
    const ids = history().entries().map((entry) => entry.id);

    const merged = unwrapOk(await history().coalesce("Drag wall", ids));

    expect(history().entries()).toHaveLength(1);
    expect(merged.operations).toHaveLength(3);
    expect(merged.label).toBe("Drag wall");
  });
});

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

describe("publishing", () => {
  it("reports what would change", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1"), move("W2")]);

    const preview = unwrapOk(await publish().preview(session.id));

    expect(preview.changed.map((e) => e.globalId).sort()).toEqual(["W1", "W2"]);
    expect(preview.conflicts).toHaveLength(0);
  });

  it("finds no conflicts when the base has not moved", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);
    changedElements.add("W1"); // would conflict, but the base version is unchanged

    expect(unwrapOk(await publish().preview(session.id)).conflicts).toHaveLength(0);
  });

  it("refuses to publish over someone else's change by default", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);

    version = "C02";
    changedElements.add("W1");

    const result = await publish().publish(session.id, { version: "C03" });

    // Publishing over another person's edit silently is what destroys trust in a shared model.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details["conflicts"]).toEqual(["W1"]);
  });

  it("allows an explicit override", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);
    version = "C02";
    changedElements.add("W1");

    const result = unwrapOk(
      await publish().publish(session.id, { version: "C03", requireUpToDate: false }),
    );

    expect(result.changedElements).toBe(1);
    expect(sessions().current()).toBeUndefined();
  });

  it("refuses to publish a session twice", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);
    await publish().publish(session.id, { version: "C02" });

    expect((await publish().publish(session.id, { version: "C03" })).ok).toBe(false);
  });

  it("publishes through its command", async () => {
    const session = unwrapOk(await sessions().open("m1"));
    await edits().apply([move("W1")]);

    const result = await harness.kernel.commands.execute(AUTHORING_COMMANDS.publish, {
      sessionId: session.id,
      version: "C02",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Constraints and planes
// ---------------------------------------------------------------------------------------------

describe("constraints", () => {
  it("requires a value for a dimensional constraint", async () => {
    const constraints = unwrapOk(harness.kernel.capabilities.require(ConstraintToken));

    expect((await constraints.add({ kind: "distance", targets: [el("W1")] })).ok).toBe(false);
    expect(
      (await constraints.add({ kind: "distance", targets: [el("W1")], value: 3 })).ok,
    ).toBe(true);
  });

  it("reports violations rather than refusing to continue", async () => {
    const constraints = unwrapOk(harness.kernel.capabilities.require(ConstraintToken));
    await constraints.add({ kind: "coincident", targets: [el("W1"), el("W2")] });

    constraintHolds = false;
    const result = unwrapOk(await constraints.solve());

    // An editor that stops until every constraint holds is unusable mid-edit.
    expect(result.violated).toHaveLength(1);
    expect(constraints.list()[0]?.satisfied).toBe(false);
  });
});

describe("sketch planes", () => {
  it("derives a plane from a level and makes it active", async () => {
    harness.kernel.capabilities.provide(LevelSourceToken, {
      levels: () => [{ id: "L2", name: "Level 2", elevation: 4.5 }],
    });

    const plane = unwrapOk(planes().fromLevel("L2"));

    expect(plane.origin[2]).toBe(4.5);
    expect(planes().active()?.id).toBe(plane.id);
  });

  it("reports honestly when no level source is installed", () => {
    expect(planes().fromLevel("L2").ok).toBe(false);
  });

  it("projects a camera ray onto the active plane", () => {
    const plane = planes().create({ origin: [0, 0, 2], normal: [0, 0, 1] });
    planes().setActive(plane.id);

    const point = unwrapOk(
      planes().project({ x: 0, y: 0, origin: [3, 4, 10], direction: [0, 0, -1] } as never),
    );
    expect(point).toEqual([3, 4, 2]);
  });

  it("reports a ray that misses the plane", () => {
    const plane = planes().create({ origin: [0, 0, 2], normal: [0, 0, 1] });
    planes().setActive(plane.id);

    const result = planes().project({ x: 0, y: 0, origin: [0, 0, 10], direction: [0, 0, 1] } as never);
    expect(result.ok).toBe(false);
  });

  it("treats a bare screen point as plane-local coordinates", () => {
    const plane = planes().create({ origin: [1, 1, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    planes().setActive(plane.id);

    // A 2D sketch view has no camera ray; local coordinates are the only honest reading.
    expect(unwrapOk(planes().project({ x: 2, y: 3 }))).toEqual([3, 4, 0]);
  });

  it("refuses to project with no active plane", () => {
    expect(planes().project({ x: 0, y: 0 }).ok).toBe(false);
  });

  it("snaps to the grid when spacing is configured", async () => {
    const snapping = createTestHarness();
    await snapping.load(
      createAuthoringPlugin({ ids: createCountingIdFactory(), gridSpacing: 0.5 }),
    );
    snapping.kernel.capabilities.provide(GeometryBackendToken, backend());
    const service = unwrapOk(snapping.kernel.capabilities.require(SketchPlaneToken));

    const plane = service.create({ origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    service.setActive(plane.id);

    expect(unwrapOk(service.project({ x: 1.2, y: 2.4 }))).toEqual([1, 2.5, 0]);
    await snapping.dispose();
  });
});
