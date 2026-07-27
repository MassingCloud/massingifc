import { describe, expect, it } from "vitest";
import { isMeasurable, type GeoReference, type TwinObjectRecord } from "@massingifc/project-schema";
import { isRealityKind, measurabilityIssue, validateRealityDataset } from "./reality.js";

const BRITISH_NATIONAL_GRID: GeoReference = {
  sourceCrs: "EPSG:27700",
  units: "m",
  verticalDatum: "ODN",
  method: "survey",
  originOffset: [530000, 180000, 0],
};

function twin(overrides: Partial<TwinObjectRecord> = {}): TwinObjectRecord {
  return {
    id: "twin-1",
    name: "West elevation scan",
    kind: "point-cloud",
    transform: [],
    aligned: true,
    provenance: { source: "terrestrial-scan", confidence: 0.9 },
    createdAt: "2026-07-01T09:00:00.000Z",
    ...overrides,
  };
}

const codes = (issues: readonly { readonly code: string }[]): readonly string[] =>
  issues.map((issue) => issue.code);

describe("reality dataset validation", () => {
  it("treats a missing georeference on captured reality as an error", async () => {
    const report = await validateRealityDataset(twin());
    expect(report.valid).toBe(false);
    expect(codes(report.issues)).toContain("missing-georeference");
  });

  it("does not demand a georeference from generated content", async () => {
    const report = await validateRealityDataset(twin({ kind: "three-group" }));
    expect(report.errors).toBe(0);
    expect(codes(report.issues)).not.toContain("missing-georeference");
    expect(isRealityKind("three-group")).toBe(false);
  });

  it("accepts a fully described survey-grade dataset without complaint", async () => {
    const report = await validateRealityDataset(
      twin({
        geoReference: BRITISH_NATIONAL_GRID,
        extent: { xmin: 0, ymin: 0, xmax: 42, ymax: 30 },
      }),
    );
    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("flags an unqualified CRS code", async () => {
    const report = await validateRealityDataset(
      twin({ geoReference: { ...BRITISH_NATIONAL_GRID, sourceCrs: "British National Grid" } }),
    );
    expect(codes(report.issues)).toContain("unqualified-crs");
  });

  it("distinguishes an assumed georeference from a surveyed one", async () => {
    const assumed = await validateRealityDataset(
      twin({ geoReference: { ...BRITISH_NATIONAL_GRID, method: "assumed" } }),
    );
    expect(codes(assumed.issues)).toContain("unverified-georeference");
    // A warning, not an error: unverified data is usable, it just must not be mistaken for survey.
    expect(assumed.valid).toBe(true);
  });

  it("rejects an inverted extent", async () => {
    const report = await validateRealityDataset(
      twin({
        geoReference: BRITISH_NATIONAL_GRID,
        extent: { xmin: 100, ymin: 0, xmax: 10, ymax: 30 },
      }),
    );
    expect(report.valid).toBe(false);
    expect(codes(report.issues)).toContain("invalid-extent");
  });

  it("reads an extent in its declared units before judging plausibility", async () => {
    // 40000 mm is 40 m — a normal building. Judged as metres it would look like a 40 km capture.
    const report = await validateRealityDataset(
      twin({
        geoReference: { ...BRITISH_NATIONAL_GRID, units: "mm" },
        extent: { xmin: 0, ymin: 0, xmax: 40_000, ymax: 30_000 },
      }),
    );
    expect(codes(report.issues)).not.toContain("implausible-extent");
  });

  it("warns when an extent is larger than any real capture", async () => {
    const report = await validateRealityDataset(
      twin({
        geoReference: BRITISH_NATIONAL_GRID,
        extent: { xmin: 0, ymin: 0, xmax: 400_000, ymax: 300_000 },
      }),
    );
    expect(codes(report.issues)).toContain("implausible-extent");
  });

  it("warns when large projected coordinates carry no origin offset", async () => {
    const { originOffset: _dropped, ...withoutOffset } = BRITISH_NATIONAL_GRID;
    const report = await validateRealityDataset(
      twin({
        geoReference: withoutOffset,
        extent: { xmin: 530_000, ymin: 180_000, xmax: 530_042, ymax: 180_030 },
      }),
    );
    expect(codes(report.issues)).toContain("missing-origin-offset");
  });

  it("does not warn about an offset when coordinates are already local", async () => {
    const { originOffset: _dropped, ...withoutOffset } = BRITISH_NATIONAL_GRID;
    const report = await validateRealityDataset(
      twin({ geoReference: withoutOffset, extent: { xmin: 0, ymin: 0, xmax: 42, ymax: 30 } }),
    );
    expect(codes(report.issues)).not.toContain("missing-origin-offset");
  });

  it("reports derivative links that cannot be resolved", async () => {
    const report = await validateRealityDataset(
      twin({
        geoReference: BRITISH_NATIONAL_GRID,
        derivatives: { orthomosaicUri: "blob:ortho", meshUri: "blob:missing" },
      }),
      { resolveUri: async (uri) => uri === "blob:ortho" },
    );
    const unresolved = report.issues.filter((issue) => issue.code === "unresolved-derivative");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.subject).toBe("blob:missing");
  });

  it("treats a resolver that throws as a link that cannot be followed", async () => {
    const report = await validateRealityDataset(
      twin({ geoReference: BRITISH_NATIONAL_GRID, derivatives: { meshUri: "blob:mesh" } }),
      {
        resolveUri: async () => {
          throw new Error("network down");
        },
      },
    );
    expect(codes(report.issues)).toContain("unresolved-derivative");
  });

  it("leaves derivative links unchecked when no resolver is supplied", async () => {
    const report = await validateRealityDataset(
      twin({ geoReference: BRITISH_NATIONAL_GRID, derivatives: { meshUri: "blob:mesh" } }),
    );
    expect(codes(report.issues)).not.toContain("unresolved-derivative");
  });

  it("notes a splat with no derived surface as information, not failure", async () => {
    const report = await validateRealityDataset(
      twin({ kind: "gaussian-splat", geoReference: BRITISH_NATIONAL_GRID }),
    );
    expect(codes(report.issues)).toContain("splat-without-surface");
    expect(report.valid).toBe(true);
    expect(report.warnings).toBe(0);
  });
});

describe("measurability", () => {
  it("refuses to measure against a bare radiance field", () => {
    const splat = twin({ kind: "gaussian-splat" });
    expect(isMeasurable(splat)).toBe(false);
    expect(measurabilityIssue(splat)?.code).toBe("splat-without-surface");
  });

  it("accepts a splat once a mesh has been derived from it", () => {
    const splat = twin({ kind: "gaussian-splat", derivatives: { meshUri: "blob:mesh" } });
    expect(isMeasurable(splat)).toBe(true);
    expect(measurabilityIssue(splat)).toBeUndefined();
  });

  it("honours a dataset declared for visualization only", () => {
    const scan = twin({ purpose: "visualization" });
    expect(isMeasurable(scan)).toBe(false);
    expect(measurabilityIssue(scan)?.code).toBe("purpose-not-measurable");
  });

  it("measures against a point cloud without ceremony", () => {
    expect(isMeasurable(twin({ purpose: "analysis" }))).toBe(true);
  });
});
