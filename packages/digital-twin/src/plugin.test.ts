import type { TwinObjectRecord, Vec3 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTransform, solveAlignment } from "./alignment.js";
import {
  TwinAlignmentToken,
  TwinObjectFactoryToken,
  TwinObservationToken,
  TwinPromotionToken,
  TwinRegistryToken,
  TwinTimelineToken,
} from "./contracts.js";
import { createTwinPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

let harness: TestHarness;

const twin = (overrides: Partial<TwinObjectRecord> = {}): TwinObjectRecord => ({
  id: "scan-1",
  name: "Site scan",
  kind: "point-cloud",
  transform: [],
  aligned: false,
  provenance: { source: "Leica RTC360", confidence: 0.9 },
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

beforeEach(async () => {
  harness = createTestHarness({ identity: { id: "surveyor", roles: ["field"] } });
  await harness.load(createTwinPlugin({ clock: createFixedClock(), ids: createCountingIdFactory() }));
});

const registry = () => unwrapOk(harness.kernel.capabilities.require(TwinRegistryToken));
const alignment = () => unwrapOk(harness.kernel.capabilities.require(TwinAlignmentToken));
const observations = () => unwrapOk(harness.kernel.capabilities.require(TwinObservationToken));
const promotion = () => unwrapOk(harness.kernel.capabilities.require(TwinPromotionToken));

describe("alignment maths", () => {
  it("solves a pure translation from one pair", () => {
    const solution = solveAlignment([{ source: [0, 0, 0], target: [10, 5, 2] }])!;

    // One pair carries no rotation information; solving for one would be inventing it.
    expect(solution.rotationRadians).toBe(0);
    expect(solution.translation).toEqual([10, 5, 2]);
    expect(solution.rmsError).toBeCloseTo(0, 9);
  });

  it("solves a 90 degree rotation about Z plus translation", () => {
    const pairs = [
      { source: [0, 0, 0] as Vec3, target: [5, 5, 0] as Vec3 },
      { source: [10, 0, 0] as Vec3, target: [5, 15, 0] as Vec3 },
    ];
    const solution = solveAlignment(pairs)!;

    expect(solution.rotationRadians).toBeCloseTo(Math.PI / 2, 6);
    expect(solution.rmsError).toBeCloseTo(0, 6);
    for (const pair of pairs) {
      const mapped = applyTransform(solution.transform, pair.source);
      expect(mapped[0]).toBeCloseTo(pair.target[0], 6);
      expect(mapped[1]).toBeCloseTo(pair.target[1], 6);
    }
  });

  it("reports residual rather than absorbing error into a tilt", () => {
    const solution = solveAlignment([
      { source: [0, 0, 0], target: [0, 0, 0] },
      { source: [10, 0, 0], target: [10, 0, 0] },
      // Third point is inconsistent by 1 unit in Z — a full 3D fit would tilt to hide this.
      { source: [5, 5, 0], target: [5, 5, 1] },
    ])!;

    expect(solution.rmsError).toBeGreaterThan(0.4);
  });

  it("returns undefined with no pairs", () => {
    expect(solveAlignment([])).toBeUndefined();
  });
});

describe("registry", () => {
  it("defaults an unset transform to identity", async () => {
    const record = unwrapOk(await registry().register(twin()));
    expect(record.transform).toHaveLength(16);
  });

  it("materialises through a kind-matched factory", async () => {
    const dispose = vi.fn();
    harness.kernel.capabilities.provide(TwinObjectFactoryToken, {
      kind: "point-cloud",
      create: async () => ({ ok: true as const, value: { mesh: "cloud" } }),
      dispose,
    });
    await registry().register(twin());

    const object = unwrapOk(await registry().materialise("scan-1"));
    expect(object).toEqual({ mesh: "cloud" });

    // Repeated calls return the same instance rather than rebuilding it.
    expect(unwrapOk(await registry().materialise("scan-1"))).toBe(object);

    await registry().unregister("scan-1");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports honestly when no factory handles the kind", async () => {
    await registry().register(twin({ kind: "gltf" }));

    const result = await registry().materialise("scan-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("survives a factory that throws on disposal", async () => {
    harness.kernel.capabilities.provide(TwinObjectFactoryToken, {
      kind: "point-cloud",
      create: async () => ({ ok: true as const, value: {} }),
      dispose: () => {
        throw new Error("gpu teardown failed");
      },
    });
    await registry().register(twin());
    await registry().materialise("scan-1");

    expect((await registry().unregister("scan-1")).ok).toBe(true);
    expect(registry().get("scan-1")).toBeUndefined();
  });

  it("coexists with generated scene objects", async () => {
    harness.kernel.capabilities.provide(TwinObjectFactoryToken, {
      kind: "three-group",
      create: async (record) => ({ ok: true as const, value: { group: record.factoryId } }),
      dispose: () => {},
    });
    await registry().register(
      twin({ id: "gen-1", kind: "three-group", factoryId: "img2threejs:tree" }),
    );

    expect(unwrapOk(await registry().materialise("gen-1"))).toEqual({ group: "img2threejs:tree" });
    expect(registry().list({ kind: "three-group" })).toHaveLength(1);
  });

  it("links a twin object to BIM elements without converting it", async () => {
    await registry().register(twin());
    const linked = unwrapOk(
      await registry().link("scan-1", [{ modelId: "arch", globalId: "WALL-1" }]),
    );

    expect(linked.linkedElements).toHaveLength(1);
    expect(linked.kind).toBe("point-cloud");
  });
});

describe("alignment service", () => {
  beforeEach(async () => {
    await registry().register(twin());
  });

  it("aligns by control points and records confidence", async () => {
    const record = unwrapOk(
      await alignment().alignByPoints("scan-1", [
        { source: [0, 0, 0], target: [10, 0, 0] },
        { source: [1, 0, 0], target: [11, 0, 0] },
        { source: [0, 1, 0], target: [10, 1, 0] },
      ]),
    );

    expect(record.method).toBe("three-point");
    expect(record.rmsError).toBeCloseTo(0, 6);
    expect(registry().get("scan-1")?.aligned).toBe(true);
    expect(registry().get("scan-1")?.alignmentConfidence).toBeCloseTo(1, 3);
  });

  it("lowers confidence as residual grows", async () => {
    await alignment().alignByPoints("scan-1", [
      { source: [0, 0, 0], target: [0, 0, 0] },
      { source: [10, 0, 0], target: [10, 0, 0] },
      { source: [5, 5, 0], target: [5, 5, 5] },
    ]);

    // A 5 cm registration is not the same fact as a 5 m one.
    expect(registry().get("scan-1")?.alignmentConfidence ?? 1).toBeLessThan(0.5);
  });

  it("keeps a history and can revert to an earlier alignment", async () => {
    await alignment().setTransform("scan-1", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
    const first = alignment().history("scan-1")[0]!;
    await alignment().setTransform("scan-1", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 0, 0, 1]);
    expect(registry().get("scan-1")?.transform[12]).toBe(9);

    await alignment().revert(first.id);
    expect(registry().get("scan-1")?.transform[12]).toBe(1);
  });

  it("refuses to refine when there is nothing to refine against", async () => {
    await alignment().setTransform("scan-1", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const result = await alignment().refine("scan-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no control points");
  });

  it("rejects alignment with no pairs", async () => {
    expect((await alignment().alignByPoints("scan-1", [])).ok).toBe(false);
  });
});

describe("observations", () => {
  beforeEach(async () => {
    await registry().register(twin({ kind: "sensor" }));
  });

  it("returns the latest reading by observation time, not insertion order", async () => {
    await observations().record({
      twinObjectId: "scan-1",
      metric: "temperature",
      value: 20,
      observedAt: "2026-01-02T00:00:00.000Z",
    });
    // A late-arriving earlier reading must not become "latest".
    await observations().record({
      twinObjectId: "scan-1",
      metric: "temperature",
      value: 18,
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(observations().latest("scan-1", "temperature")?.value).toBe(20);
  });

  it("filters by window and quality", async () => {
    await observations().recordMany([
      { twinObjectId: "scan-1", metric: "t", value: 1, observedAt: "2026-01-01T00:00:00.000Z", quality: "good" },
      { twinObjectId: "scan-1", metric: "t", value: 2, observedAt: "2026-02-01T00:00:00.000Z", quality: "suspect" },
    ]);

    expect(observations().query({ twinObjectId: "scan-1", quality: "good" })).toHaveLength(1);
    expect(
      observations().query({ twinObjectId: "scan-1", to: "2026-01-15T00:00:00.000Z" }),
    ).toHaveLength(1);
  });

  it("refuses an observation for an unknown twin object", async () => {
    expect(
      (
        await observations().record({
          twinObjectId: "nope",
          metric: "t",
          value: 1,
          observedAt: "2026-01-01T00:00:00.000Z",
        })
      ).ok,
    ).toBe(false);
  });

  it("builds a timeline in observation order", async () => {
    await observations().recordMany([
      { twinObjectId: "scan-1", metric: "t", value: 2, observedAt: "2026-01-02T00:00:00.000Z" },
      { twinObjectId: "scan-1", metric: "t", value: 1, observedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const timelines = unwrapOk(harness.kernel.capabilities.require(TwinTimelineToken));

    const timeline = unwrapOk(
      await timelines.build("scan-1", "t", "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"),
    );

    expect(timeline.observationIds).toHaveLength(2);
    expect((await timelines.seek(timeline.id, "2026-06-01T00:00:00.000Z")).ok).toBe(false);
  });
});

describe("promotion", () => {
  it("refuses to promote an unaligned twin object", async () => {
    await registry().register(twin());

    // Promoting unaligned evidence puts geometry in the wrong place and blames the model for it.
    const result = await promotion().promote("scan-1", "family");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not aligned");
  });

  it("records the provenance link back to the observation", async () => {
    await registry().register(twin());
    await alignment().alignByPoints("scan-1", [{ source: [0, 0, 0], target: [0, 0, 0] }]);

    const promoted = unwrapOk(await promotion().promote("scan-1", "authoring", { name: "wall-42" }));

    expect(promotion().originOf("wall-42")?.twinObjectId).toBe("scan-1");
    expect(promotion().history("scan-1")).toHaveLength(1);
    expect(promoted.promotedBy).toBe("surveyor");
  });
});
