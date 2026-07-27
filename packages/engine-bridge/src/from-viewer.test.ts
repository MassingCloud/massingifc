import { ok, type Result } from "@massingifc/core-kernel";
import type { ModelRecord, TwinObjectRecord } from "@massingifc/project-schema";
import type {
  ElementProperties,
  PropertyService,
  SpatialTreeNode,
  SpatialTreeService,
} from "@massingifc/viewer-runtime";
import { describe, expect, it } from "vitest";
import { createSceneQuery, createViewerScenePackageProvider, toRealityLayer } from "./index.js";

const MODEL: ModelRecord = {
  id: "struct",
  name: "Structure",
  role: "reference",
  format: "fragments",
  version: "C01",
  geoReference: { sourceCrs: "EPSG:27700", units: "mm", verticalDatum: "ODN", method: "survey" },
};

const ref = (globalId: string) => ({ modelId: "struct", globalId });

const TREE: SpatialTreeNode = {
  id: "root",
  label: "Federation",
  // A grouping the viewer invented: no element, so it must not become a scene node.
  children: [
    {
      id: "s1",
      label: "Level 1",
      ifcClass: "IfcBuildingStorey",
      element: ref("0Level00000000000000L1"),
      children: [
        {
          id: "w1",
          label: "External wall",
          ifcClass: "IfcWallStandardCase",
          element: ref("1Wall00000000000000W01"),
          children: [
            {
              id: "d1",
              label: "Entrance door",
              ifcClass: "IfcDoor",
              element: ref("2Door00000000000000D01"),
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const tree = (root: SpatialTreeNode = TREE): SpatialTreeService => ({
  build: async () => ok(root),
  buildFederated: async () => ok([root]),
});

const PROPERTIES: Readonly<Record<string, ElementProperties>> = {
  "1Wall00000000000000W01": {
    element: ref("1Wall00000000000000W01"),
    ifcClass: "IfcWallStandardCase",
    attributes: {},
    propertySets: {
      Pset_WallCommon: { IsExternal: true, FireRating: "60", Nested: { unsupported: 1 } },
    },
    quantities: { NetArea: 12.5 },
  },
};

const properties: PropertyService = {
  get: async (element) => ok(PROPERTIES[element.globalId] ?? { element, attributes: {} }),
  getMany: async (elements) =>
    ok(elements.map((element) => PROPERTIES[element.globalId] ?? { element, attributes: {} })),
  find: async () => ok([]),
};

const provider = (overrides: Partial<Parameters<typeof createViewerScenePackageProvider>[0]> = {}) =>
  createViewerScenePackageProvider({
    properties,
    tree: tree(),
    models: () => [MODEL],
    now: () => "2026-07-27T12:00:00.000Z",
    sourceUnits: "mm",
    ...overrides,
  });

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

describe("scene packages from the viewer contracts", () => {
  it("turns the spatial tree into GlobalId-keyed nodes", async () => {
    const scene = unwrap(await provider().build());
    const query = createSceneQuery(scene);

    expect(scene.nodes).toHaveLength(3);
    expect(query.node("1Wall00000000000000W01")?.name).toBe("External wall");
    expect(query.byClass("IFCDOOR")).toHaveLength(1);
  });

  it("skips grouping nodes that carry no element", async () => {
    // The federation root has no GlobalId, so it has no identity and cannot be addressed.
    expect(unwrap(await provider().build()).nodes.map((node) => node.name)).not.toContain(
      "Federation",
    );
  });

  it("reparents children of a grouping node onto the real element above it", async () => {
    const scene = unwrap(await provider().build());
    const query = createSceneQuery(scene);
    expect(query.node("0Level00000000000000L1")?.parentGlobalId).toBeUndefined();
    expect(query.ancestors("2Door00000000000000D01").map((node) => node.globalId)).toEqual([
      "1Wall00000000000000W01",
      "0Level00000000000000L1",
    ]);
  });

  it("stamps the containing storey onto everything beneath it", async () => {
    const query = createSceneQuery(unwrap(await provider().build()));
    expect(query.byLevel("0Level00000000000000L1").map((node) => node.globalId)).toEqual([
      "1Wall00000000000000W01",
      "2Door00000000000000D01",
    ]);
    // The storey is not on its own level.
    expect(query.node("0Level00000000000000L1")?.levelGlobalId).toBeUndefined();
  });

  it("carries the model's georeference and revision", async () => {
    const scene = unwrap(await provider().build());
    expect(scene.geoReference?.sourceCrs).toBe("EPSG:27700");
    expect(scene.sources[0]?.revision).toBe("C01");
    expect(scene.sourceUnits).toBe("mm");
    expect(scene.units).toBe("m");
  });

  it("refuses a scope whose models disagree about the CRS", async () => {
    const other: ModelRecord = {
      ...MODEL,
      id: "arch",
      geoReference: { sourceCrs: "EPSG:3857", units: "m" },
    };
    const result = await provider({ models: () => [MODEL, other] }).build();
    // Two CRSs in one package means the models are not in the same space. Picking one would hide
    // a problem that has to be fixed upstream.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/different coordinate reference/);
  });

  it("only includes properties when asked", async () => {
    expect(unwrap(await provider().build()).properties).toBeUndefined();

    const scene = unwrap(await provider().build({ includeProperties: true }));
    const query = createSceneQuery(scene);
    expect(query.property("1Wall00000000000000W01", "FireRating")).toBe("60");
    expect(query.property("1Wall00000000000000W01", "NetArea", "Quantities")).toBe(12.5);
  });

  it("drops non-scalar property values rather than stringifying them", async () => {
    const scene = unwrap(await provider().build({ includeProperties: true }));
    const sets = createSceneQuery(scene).properties("1Wall00000000000000W01");
    // "[object Object]" is indistinguishable from a real value; an absent key is not.
    expect(sets[0]?.properties).not.toHaveProperty("Nested");
    expect(sets[0]?.properties["IsExternal"]).toBe(true);
  });

  it("emits containment edges only when asked", async () => {
    expect(unwrap(await provider().build()).relationships).toBeUndefined();

    const scene = unwrap(await provider().build({ includeRelationships: true }));
    expect(
      createSceneQuery(scene).relationships(
        "2Door00000000000000D01",
        "IFCRELCONTAINEDINSPATIALSTRUCTURE",
      ),
    ).toHaveLength(1);
  });

  it("reports an empty scope instead of exporting nothing", async () => {
    const result = await provider().build({ modelIds: ["absent"] });
    expect(result.ok).toBe(false);
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await provider().build({ signal: controller.signal });
    expect(result.ok).toBe(false);
  });
});

describe("reality layers", () => {
  const splat: TwinObjectRecord = {
    id: "splat-1",
    name: "Facade capture",
    kind: "gaussian-splat",
    sourceUri: "blob:splat",
    transform: [],
    aligned: true,
    provenance: { source: "drone" },
    createdAt: "2026-07-01T00:00:00.000Z",
    geoReference: { sourceCrs: "EPSG:27700", units: "m" },
  };

  it("marks a bare radiance field as not measurable", () => {
    const layer = toRealityLayer(splat);
    expect(layer.measurable).toBe(false);
    expect(layer.geoReference?.sourceCrs).toBe("EPSG:27700");
  });

  it("marks it measurable once a mesh exists", () => {
    expect(toRealityLayer({ ...splat, derivatives: { meshUri: "blob:mesh" } }).measurable).toBe(true);
  });

  it("honours a visualization-only declaration on a point cloud", () => {
    expect(
      toRealityLayer({ ...splat, kind: "point-cloud", purpose: "visualization" }).measurable,
    ).toBe(false);
  });

  it("reaches the package through the provider", async () => {
    const scene = unwrap(await provider({ realityObjects: () => [splat] }).build());
    expect(scene.realityLayers).toHaveLength(1);
    expect(scene.realityLayers?.[0]?.measurable).toBe(false);
  });

  it("leaves out a layer an engine could never resolve", async () => {
    const { sourceUri: _dropped, ...unresolvable } = splat;
    const scene = unwrap(await provider({ realityObjects: () => [unresolvable] }).build());
    // In the scene tree but never loading is worse than absent.
    expect(scene.realityLayers).toBeUndefined();
  });
});
