import { describe, expect, it } from "vitest";
import {
  buildScenePackage,
  createSceneQuery,
  payloadPath,
  readScenePackage,
  validateScenePackage,
  writeScenePackage,
  SCENE_FORMAT_VERSION,
  SCENE_MANIFEST_PATH,
  type SceneArchive,
  type SceneNode,
  type ScenePackage,
  type ScenePackageInput,
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

const STOREY: SceneNode = { globalId: "0Level00000000000000L1", name: "Level 1", ifcClass: "IFCBUILDINGSTOREY" };

const WALL: SceneNode = {
  globalId: "1Wall00000000000000W01",
  name: "External wall",
  ifcClass: "IFCWALLSTANDARDCASE",
  parentGlobalId: STOREY.globalId,
  levelGlobalId: STOREY.globalId,
  payloadId: "geometry-0",
  geometryIndex: 3,
  transientLocalId: 4172,
};

const DOOR: SceneNode = {
  globalId: "2Door00000000000000D01",
  name: "Entrance door",
  ifcClass: "IFCDOOR",
  parentGlobalId: WALL.globalId,
  levelGlobalId: STOREY.globalId,
  payloadId: "geometry-0",
  geometryIndex: 4,
};

function input(overrides: Partial<ScenePackageInput> = {}): ScenePackageInput {
  return {
    generator: "massingifc-test",
    generatedAt: "2026-07-27T12:00:00.000Z",
    payloads: [
      {
        id: "geometry-0",
        role: "geometry",
        path: payloadPath("geometry-0", "glb"),
        encoding: "model/gltf-binary",
        byteLength: 4,
      },
    ],
    nodes: [STOREY, WALL, DOOR],
    ...overrides,
  };
}

const built = (overrides: Partial<ScenePackageInput> = {}): ScenePackage => {
  const result = buildScenePackage(input(overrides));
  if (!result.ok) throw result.error;
  return result.value;
};

describe("scene package construction", () => {
  it("indexes nodes by class, level and identity", () => {
    const scene = built();
    expect(scene.index.byClass["IFCWALLSTANDARDCASE"]).toEqual([1]);
    expect(scene.index.byLevel[STOREY.globalId]).toEqual([1, 2]);
    expect(scene.index.byGlobalId[DOOR.globalId]).toBe(2);
    expect(scene.units).toBe("m");
    expect(scene.formatVersion).toBe(SCENE_FORMAT_VERSION);
  });

  it("refuses duplicate GlobalIds rather than losing one to the index", () => {
    const result = buildScenePackage(input({ nodes: [WALL, { ...WALL, name: "Copy" }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/duplicate GlobalId/i);
  });

  it("refuses a node with no identity", () => {
    const result = buildScenePackage(input({ nodes: [{ globalId: "", name: "Anonymous" }] }));
    expect(result.ok).toBe(false);
  });

  it("converts source units to metres, scaling translation but not rotation", () => {
    const scene = built({
      sourceUnits: "mm",
      nodes: [
        {
          ...WALL,
          // Column-major identity rotation with a 3000 mm translation.
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3000, 1500, 0, 1],
          bounds: [0, 0, 0, 3000, 200, 2400],
        },
      ],
    });
    expect(scene.nodes[0]?.transform?.slice(12)).toEqual([3, 1.5, 0, 1]);
    expect(scene.nodes[0]?.transform?.slice(0, 3)).toEqual([1, 0, 0]);
    expect(scene.nodes[0]?.bounds).toEqual([0, 0, 0, 3, 0.2, 2.4]);
    expect(scene.sourceUnits).toBe("mm");
  });

  it("leaves metres untouched", () => {
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 1.5, 0, 1];
    const scene = built({ sourceUnits: "m", nodes: [{ ...WALL, transform }] });
    expect(scene.nodes[0]?.transform).toEqual(transform);
  });
});

describe("scene package validation", () => {
  it("passes a well-formed package", () => {
    expect(validateScenePackage(built()).valid).toBe(true);
  });

  it("rejects a node pointing at a payload that is not in the package", () => {
    const scene = built({ payloads: [] });
    const report = validateScenePackage(scene);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("unknown-payload-reference");
  });

  it("allows a scoped export whose parent lies outside the package", () => {
    const scene = built({ nodes: [WALL, DOOR] });
    const report = validateScenePackage(scene);
    // A single-storey export is legitimate; the dangling parent is worth saying, not refusing.
    expect(report.valid).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain("unknown-parent");
  });

  it("catches an index that no longer matches the nodes", () => {
    const scene = built();
    const corrupted: ScenePackage = {
      ...scene,
      index: { ...scene.index, byGlobalId: { ...scene.index.byGlobalId, [WALL.globalId]: 2 } },
    };
    const report = validateScenePackage(corrupted);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("stale-index");
  });

  it("flags relationships and property sets attached to absent nodes", () => {
    const scene = built({
      relationships: [
        { type: "IFCRELCONNECTSELEMENTS", fromGlobalId: WALL.globalId, toGlobalId: "3Ghost0000000000000G01" },
      ],
      properties: { "3Ghost0000000000000G01": [{ name: "Pset_Common", properties: { IsExternal: true } }] },
    });
    const codes = validateScenePackage(scene).issues.map((issue) => issue.code);
    expect(codes).toContain("dangling-relationship");
    expect(codes).toContain("properties-without-node");
  });
});

describe("scene package codec", () => {
  it("round-trips a manifest and its payloads", async () => {
    const archive = new MemoryArchive();
    const scene = built();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const written = await writeScenePackage(archive, scene, {
      payloads: new Map([["geometry-0", bytes]]),
    });
    expect(written.ok).toBe(true);
    expect(await archive.entries()).toEqual(["payloads/geometry-0.glb", SCENE_MANIFEST_PATH]);

    const read = await readScenePackage(archive);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.scene.nodes).toHaveLength(3);
    expect(await read.value.readPayload("geometry-0")).toEqual(bytes);
  });

  it("refuses to write a payload whose length disagrees with the manifest", async () => {
    const result = await writeScenePackage(new MemoryArchive(), built(), {
      payloads: new Map([["geometry-0", new Uint8Array([1, 2])]]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/declares 4 bytes but 2/);
  });

  it("refuses to write when a declared payload has no bytes", async () => {
    const result = await writeScenePackage(new MemoryArchive(), built());
    expect(result.ok).toBe(false);
  });

  it("refuses a format major version it does not understand", async () => {
    const archive = new MemoryArchive();
    await archive.write(
      SCENE_MANIFEST_PATH,
      new TextEncoder().encode(JSON.stringify({ ...built(), formatVersion: "2.0" })),
    );
    const read = await readScenePackage(archive);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.message).toMatch(/cannot be read/);
  });

  it("reports an unreadable manifest instead of throwing", async () => {
    const archive = new MemoryArchive();
    await archive.write(SCENE_MANIFEST_PATH, new TextEncoder().encode("{ not json"));
    const read = await readScenePackage(archive);
    expect(read.ok).toBe(false);
  });

  it("reports a package with no manifest at all", async () => {
    const read = await readScenePackage(new MemoryArchive());
    expect(read.ok).toBe(false);
  });

  it("keeps payload paths reversible for ids that are not file-name safe", () => {
    expect(payloadPath("model:1/geometry")).toBe("payloads/model%3A1%2Fgeometry.bin");
  });
});

describe("scene queries", () => {
  const scene = built({
    properties: {
      [WALL.globalId]: [
        { name: "Pset_WallCommon", properties: { IsExternal: true, FireRating: "60" } },
        { name: "Qto_WallBaseQuantities", properties: { NetArea: 12.5 } },
      ],
    },
    relationships: [
      { type: "IFCRELVOIDSELEMENT", fromGlobalId: WALL.globalId, toGlobalId: DOOR.globalId },
      { type: "IFCRELCONNECTSELEMENTS", fromGlobalId: WALL.globalId, toGlobalId: STOREY.globalId },
    ],
  });
  const query = createSceneQuery(scene);

  it("resolves an element by its GlobalId", () => {
    expect(query.node(WALL.globalId)?.name).toBe("External wall");
    expect(query.node("nope")).toBeUndefined();
  });

  it("filters by IFC class and by level", () => {
    expect(query.byClass("IFCDOOR").map((node) => node.globalId)).toEqual([DOOR.globalId]);
    expect(query.byLevel(STOREY.globalId)).toHaveLength(2);
    expect(query.classes()).toEqual(["IFCBUILDINGSTOREY", "IFCDOOR", "IFCWALLSTANDARDCASE"]);
  });

  it("walks the spatial hierarchy in both directions", () => {
    expect(query.children(WALL.globalId).map((node) => node.globalId)).toEqual([DOOR.globalId]);
    expect(query.ancestors(DOOR.globalId).map((node) => node.globalId)).toEqual([
      WALL.globalId,
      STOREY.globalId,
    ]);
  });

  it("terminates on a cyclic parent chain rather than hanging", () => {
    const cyclic = built({
      nodes: [
        { globalId: "A0000000000000000000A1", parentGlobalId: "B0000000000000000000B1" },
        { globalId: "B0000000000000000000B1", parentGlobalId: "A0000000000000000000A1" },
      ],
    });
    // Stops the moment it revisits a node: one real ancestor, then the cycle closes.
    expect(createSceneQuery(cyclic).ancestors("A0000000000000000000A1").map((node) => node.globalId)).toEqual([
      "B0000000000000000000B1",
    ]);
  });

  it("reads properties by name, optionally scoped to a set", () => {
    expect(query.property(WALL.globalId, "FireRating")).toBe("60");
    expect(query.property(WALL.globalId, "NetArea", "Qto_WallBaseQuantities")).toBe(12.5);
    expect(query.property(WALL.globalId, "NetArea", "Pset_WallCommon")).toBeUndefined();
    expect(query.properties(DOOR.globalId)).toEqual([]);
  });

  it("returns relationship edges from either end", () => {
    expect(query.relationships(DOOR.globalId)).toHaveLength(1);
    expect(query.relationships(WALL.globalId)).toHaveLength(2);
    expect(query.relationships(WALL.globalId, "IFCRELVOIDSELEMENT")).toHaveLength(1);
  });

  it("carries the transient viewer id without letting it become identity", () => {
    // Present for debugging, never a key: nothing in the index or the queries uses it.
    expect(query.node(WALL.globalId)?.transientLocalId).toBe(4172);
    expect(Object.keys(scene.index.byGlobalId)).not.toContain("4172");
  });
});
