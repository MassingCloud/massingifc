import { ok } from "@massingifc/core-kernel";
import type { ModelRecord } from "@massingifc/project-schema";
import type {
  PropertyService,
  SpatialTreeNode,
  SpatialTreeService,
} from "@massingifc/viewer-runtime";
import { describe, expect, it } from "vitest";
import {
  createSceneQuery,
  createViewerScenePackageProvider,
  readScenePackage,
  validateScenePackage,
  writeScenePackage,
  FRAGMENTS_ENCODING,
  type SceneArchive,
} from "./index.js";

class MemoryArchive implements SceneArchive {
  readonly files = new Map<string, Uint8Array>();
  async entries(): Promise<readonly string[]> {
    return [...this.files.keys()].sort();
  }
  async read(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path);
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
}

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
    const query = createSceneQuery(built.value.scene);

    // Before the fix every lookup went to the first model, so model b's properties vanished with
    // no error anywhere.
    expect(query.property("1ColA00000000000000C1", "Mark")).toBe("1ColA00000000000000C1");
    expect(query.property("2WallB0000000000000W1", "Mark")).toBe("2WallB0000000000000W1");
  });

  it("carries every model's nodes and sources", async () => {
    const built = await provider.build();
    if (!built.ok) throw built.error;

    expect(built.value.scene.nodes).toHaveLength(4);
    expect(built.value.scene.sources.map((source) => source.modelId)).toEqual(["a", "b"]);
    expect(createSceneQuery(built.value.scene).byClass("IFCWALLSTANDARDCASE")).toHaveLength(1);
  });

  it("keeps each model's level grouping separate", async () => {
    const built = await provider.build();
    if (!built.ok) throw built.error;
    const query = createSceneQuery(built.value.scene);

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
    expect(built.value.scene.nodes.map((node) => node.globalId)).toEqual([
      "0LevelA000000000000L1",
      "1ColA00000000000000C1",
    ]);
  });
});

describe("geometry payloads", () => {
  const bytesFor = (id: string) => new TextEncoder().encode(`fragments-of-${id}`);

  const withGeometry = (geometry: Parameters<typeof createViewerScenePackageProvider>[0]["geometry"]) =>
    createViewerScenePackageProvider({
      properties,
      tree,
      models: () => [model("a", "Structure"), model("b", "Architecture")],
      now: () => "2026-07-27T12:00:00.000Z",
      geometry,
    });

  it("carries the Fragments binary rather than a re-tessellation of it", async () => {
    const built = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!built.ok) throw built.error;

    // Fragments is already the compact open representation of this geometry and the engine-side
    // consumers read it natively; emitting glTF would invent a parallel format.
    expect(built.value.scene.payloads.map((payload) => payload.encoding)).toEqual([
      FRAGMENTS_ENCODING,
      FRAGMENTS_ENCODING,
    ]);
    expect(built.value.scene.payloads.map((payload) => payload.path)).toEqual([
      "payloads/geometry-a.frag",
      "payloads/geometry-b.frag",
    ]);
  });

  it("points every node at the payload of the model it came from", async () => {
    const built = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!built.ok) throw built.error;
    const query = createSceneQuery(built.value.scene);

    expect(query.node("1ColA00000000000000C1")?.payloadId).toBe("geometry-a");
    expect(query.node("2WallB0000000000000W1")?.payloadId).toBe("geometry-b");
  });

  it("hands back the bytes alongside the manifest", async () => {
    const built = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!built.ok) throw built.error;

    // A manifest naming payloads nobody can supply is a promise, not a package.
    expect(built.value.payloads.get("geometry-a")).toEqual(bytesFor("a"));
    expect(built.value.payloads.size).toBe(2);
  });

  it("declares a byte length and a change hash for each payload", async () => {
    const built = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!built.ok) throw built.error;
    const [first, second] = built.value.scene.payloads;

    expect(first?.byteLength).toBe(bytesFor("a").byteLength);
    // The hash exists so an incremental sync can skip a payload that has not changed.
    expect(first?.hash).toMatch(/^fnv1a-/);
    expect(first?.hash).not.toBe(second?.hash);
  });

  it("accepts a scope that mixes converted and unconverted models", async () => {
    const built = await withGeometry(async (m) =>
      m.id === "a" ? { bytes: bytesFor(m.id) } : undefined,
    ).build();
    if (!built.ok) throw built.error;
    const query = createSceneQuery(built.value.scene);

    // A model with no converted geometry is a normal answer, not a failure.
    expect(built.value.scene.payloads).toHaveLength(1);
    expect(query.node("1ColA00000000000000C1")?.payloadId).toBe("geometry-a");
    expect(query.node("2WallB0000000000000W1")?.payloadId).toBeUndefined();
  });

  it("passes validation and reports no geometry only when there is none", async () => {
    const withBytes = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!withBytes.ok) throw withBytes.error;
    const report = validateScenePackage(withBytes.value.scene);
    expect(report.valid).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain("no-geometry");

    const without = await provider.build();
    if (!without.ok) throw without.error;
    expect(validateScenePackage(without.value.scene).issues.map((issue) => issue.code)).toContain(
      "no-geometry",
    );
  });

  it("writes a package whose payloads round-trip", async () => {
    const built = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build();
    if (!built.ok) throw built.error;

    const archive = new MemoryArchive();
    const written = await writeScenePackage(archive, built.value.scene, {
      payloads: built.value.payloads,
    });
    expect(written.ok).toBe(true);

    const read = await readScenePackage(archive);
    if (!read.ok) throw read.error;
    expect(await read.value.readPayload("geometry-b")).toEqual(bytesFor("b"));
  });

  it("honours the abort signal before fetching geometry", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await withGeometry(async (m) => ({ bytes: bytesFor(m.id) })).build({
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
  });
});
