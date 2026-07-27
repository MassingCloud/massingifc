import { ok } from "@massingifc/core-kernel";
import type { ModelRecord } from "@massingifc/project-schema";
import type {
  PropertyService,
  SpatialTreeNode,
  SpatialTreeService,
} from "@massingifc/viewer-runtime";
import { describe, expect, it } from "vitest";
import { createSceneQuery, createViewerScenePackageProvider } from "./index.js";

/**
 * Federated export.
 *
 * Every other suite here uses a single model, which is exactly why the multi-model property bug
 * survived: nothing asked the provider to keep track of which model a node came from.
 */

const TREES: Readonly<Record<string, SpatialTreeNode>> = {
  a: {
    id: "a",
    label: "Structure",
    ifcClass: "IfcBuildingStorey",
    element: { modelId: "a", globalId: "0LevelA000000000000L1" },
    children: [
      {
        id: "a1",
        label: "Column",
        ifcClass: "IfcColumn",
        element: { modelId: "a", globalId: "1ColA00000000000000C1" },
        children: [],
      },
    ],
  },
  b: {
    id: "b",
    label: "Architecture",
    ifcClass: "IfcBuildingStorey",
    element: { modelId: "b", globalId: "0LevelB000000000000L1" },
    children: [
      {
        id: "b1",
        label: "Wall",
        ifcClass: "IfcWallStandardCase",
        element: { modelId: "b", globalId: "2WallB0000000000000W1" },
        children: [],
      },
    ],
  },
};

const tree: SpatialTreeService = {
  build: async (modelId) => ok(TREES[modelId]!),
  buildFederated: async () => ok(Object.values(TREES)),
};

/** Answers only for elements that actually live in the model it was asked about. */
const properties: PropertyService = {
  get: async (element) => ok({ element, attributes: {} }),
  getMany: async (refs) =>
    ok(
      refs
        .filter((element) => element.globalId.includes(element.modelId === "a" ? "A" : "B"))
        .map((element) => ({
          element,
          attributes: {},
          propertySets: { Pset_Common: { Mark: element.globalId } },
        })),
    ),
  find: async () => ok([]),
};

const model = (id: string, name: string): ModelRecord => ({
  id,
  name,
  role: "reference",
  format: "fragments",
  version: "C01",
});

const provider = createViewerScenePackageProvider({
  properties,
  tree,
  models: () => [model("a", "Structure"), model("b", "Architecture")],
  now: () => "2026-07-27T12:00:00.000Z",
});

describe("federated scene export", () => {
  it("asks each model for its own elements' properties", async () => {
    const built = await provider.build({ includeProperties: true });
    if (!built.ok) throw built.error;
    const query = createSceneQuery(built.value);

    // Before the fix every lookup went to the first model, so model b's properties vanished with
    // no error anywhere.
    expect(query.property("1ColA00000000000000C1", "Mark")).toBe("1ColA00000000000000C1");
    expect(query.property("2WallB0000000000000W1", "Mark")).toBe("2WallB0000000000000W1");
  });

  it("carries every model's nodes and sources", async () => {
    const built = await provider.build();
    if (!built.ok) throw built.error;

    expect(built.value.nodes).toHaveLength(4);
    expect(built.value.sources.map((source) => source.modelId)).toEqual(["a", "b"]);
    expect(createSceneQuery(built.value).byClass("IFCWALLSTANDARDCASE")).toHaveLength(1);
  });

  it("keeps each model's level grouping separate", async () => {
    const built = await provider.build();
    if (!built.ok) throw built.error;
    const query = createSceneQuery(built.value);

    // Two models can both have a "Level 1"; they must not collapse into one.
    expect(query.byLevel("0LevelA000000000000L1").map((node) => node.globalId)).toEqual([
      "1ColA00000000000000C1",
    ]);
    expect(query.byLevel("0LevelB000000000000L1").map((node) => node.globalId)).toEqual([
      "2WallB0000000000000W1",
    ]);
  });

  it("ignores tree entries belonging to a model outside the requested scope", async () => {
    const built = await provider.build({ modelIds: ["a"] });
    if (!built.ok) throw built.error;
    expect(built.value.nodes.map((node) => node.globalId)).toEqual([
      "0LevelA000000000000L1",
      "1ColA00000000000000C1",
    ]);
  });
});
