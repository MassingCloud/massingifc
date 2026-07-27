import type { ElementRef } from "@massingifc/project-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  FragmentDataModel,
  FragmentItemData,
  FragmentTreeItem,
} from "./model-data.js";
import { ThatOpenProperties } from "./properties.js";
import { ThatOpenSpatialTree } from "./tree.js";

/**
 * Headless coverage for the semantic services.
 *
 * The port exists so these can be tested without WebGL, a worker or a `.frag` file — and
 * `asDataModel` proves at compile time that the shape a fake satisfies is the shape the real
 * `FragmentsModel` has, which is what stops this suite from passing against a fiction.
 */

const GUIDS: Readonly<Record<number, string>> = {
  1: "0Level00000000000000L1",
  2: "1Wall00000000000000W01",
  3: "2Door00000000000000D01",
  // 4 deliberately absent — an element with no GlobalId.
};

const ITEMS: Readonly<Record<number, FragmentItemData>> = {
  1: { _category: { value: "IFCBUILDINGSTOREY" }, Name: { value: "Level 1" } },
  2: {
    _category: { value: "IFCWALLSTANDARDCASE" },
    Name: { value: "External wall" },
    Description: { value: "Cavity wall to north elevation" },
    IsDefinedBy: [
      {
        Name: { value: "Pset_WallCommon" },
        HasProperties: [
          { Name: { value: "IsExternal" }, NominalValue: { value: true } },
          { Name: { value: "FireRating" }, NominalValue: { value: "60" } },
        ],
      },
      {
        Name: { value: "Qto_WallBaseQuantities" },
        Quantities: [
          { Name: { value: "NetArea" }, AreaValue: { value: 12.5 } },
          { Name: { value: "Length" }, LengthValue: { value: 4.2 } },
        ],
      },
    ],
  },
  3: { _category: { value: "IFCDOOR" }, Name: { value: "Entrance door" } },
  4: { _category: { value: "IFCWALLSTANDARDCASE" }, Name: { value: "Unreferenceable wall" } },
};

const TREE: FragmentTreeItem = {
  category: "IFCPROJECT",
  // The project root carries no local id in a fragments tree.
  localId: null,
  children: [
    {
      category: "IFCBUILDINGSTOREY",
      localId: 1,
      children: [
        {
          category: "IFCWALLSTANDARDCASE",
          localId: 2,
          children: [{ category: "IFCDOOR", localId: 3, children: [] }],
        },
        { category: "IFCWALLSTANDARDCASE", localId: 4, children: [] },
      ],
    },
  ],
};

function fakeModel(overrides: Partial<FragmentDataModel> = {}): FragmentDataModel {
  return {
    getSpatialStructure: async () => TREE,
    getItemsData: async (ids) => ids.map((id) => ITEMS[id] ?? {}),
    getGuidsByLocalIds: async (ids) => ids.map((id) => GUIDS[id] ?? null),
    getLocalIdsByGuids: async (guids) =>
      guids.map((guid) => {
        const entry = Object.entries(GUIDS).find(([, value]) => value === guid);
        return entry ? Number(entry[0]) : null;
      }),
    getItemsOfCategories: async (patterns) => {
      const result: Record<string, number[]> = {};
      for (const [id, item] of Object.entries(ITEMS)) {
        const category = (item["_category"] as { value: string } | undefined)?.value ?? "";
        if (patterns.some((pattern) => pattern.test(category))) {
          (result[category] ??= []).push(Number(id));
        }
      }
      return result;
    },
    getCategories: async () => ["IFCBUILDINGSTOREY", "IFCWALLSTANDARDCASE", "IFCDOOR"],
    ...overrides,
  };
}

const source = (model: FragmentDataModel = fakeModel()) => () => model;
/** A host with nothing loaded. Separate from `source` because passing an explicit `undefined` to a
 *  defaulted parameter silently hands back the default — which would test the opposite case. */
const noModel = () => () => undefined;
const ref = (globalId: string): ElementRef => ({ modelId: "struct", globalId });

const unwrap = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

describe("properties", () => {
  it("keys results by GlobalId, never by the engine's local id", async () => {
    const properties = new ThatOpenProperties(source());
    const result = unwrap(await properties.get(ref("1Wall00000000000000W01")));

    expect(result.element.globalId).toBe("1Wall00000000000000W01");
    expect(result.name).toBe("External wall");
    expect(result.ifcClass).toBe("IFCWALLSTANDARDCASE");
  });

  it("carries property sets through without flattening them", async () => {
    const result = unwrap(
      await new ThatOpenProperties(source()).get(ref("1Wall00000000000000W01")),
    );
    expect(result.propertySets?.["Pset_WallCommon"]).toEqual({
      IsExternal: true,
      FireRating: "60",
    });
  });

  it("hoists quantities into numbers while leaving them in their set", async () => {
    const result = unwrap(
      await new ThatOpenProperties(source()).get(ref("1Wall00000000000000W01")),
    );
    // Takeoff wants them by name as numbers; a property panel wants them where IFC put them.
    expect(result.quantities).toEqual({ NetArea: 12.5, Length: 4.2 });
    expect(result.propertySets?.["Qto_WallBaseQuantities"]?.["NetArea"]).toBe(12.5);
  });

  it("reads a batch in one call rather than one call per element", async () => {
    const model = fakeModel();
    const spy = vi.spyOn(model, "getItemsData");
    const properties = new ThatOpenProperties(source(model));

    const results = unwrap(
      await properties.getMany([ref("1Wall00000000000000W01"), ref("2Door00000000000000D01")]),
    );

    expect(results).toHaveLength(2);
    // The model answers from a worker; a per-element loop is a round trip each.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps the pairing when a GlobalId does not resolve", async () => {
    const properties = new ThatOpenProperties(source());
    const results = unwrap(
      await properties.getMany([ref("nope"), ref("2Door00000000000000D01")]),
    );

    // A hole would otherwise shift every later element onto the wrong properties.
    expect(results).toHaveLength(1);
    expect(results[0]?.element.globalId).toBe("2Door00000000000000D01");
  });

  it("reports an element that is not in the model", async () => {
    const result = await new ThatOpenProperties(source()).get(ref("absent"));
    expect(result.ok).toBe(false);
  });

  it("reports an unloaded model rather than returning nothing", async () => {
    const result = await new ThatOpenProperties(noModel()).get(ref("anything"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not loaded/);
  });

  it("turns a thrown engine error into a Result", async () => {
    const model = fakeModel({
      getItemsData: async () => {
        throw new Error("worker died");
      },
    });
    const result = await new ThatOpenProperties(source(model)).get(ref("1Wall00000000000000W01"));
    expect(result.ok).toBe(false);
  });
});

describe("property search", () => {
  const properties = () => new ThatOpenProperties(source());

  it("finds by IFC class", async () => {
    const found = unwrap(await properties().find({ modelId: "struct", ifcClass: "IFCDOOR" }));
    expect(found.map((element) => element.globalId)).toEqual(["2Door00000000000000D01"]);
  });

  it("treats a class name as a name, not a pattern", async () => {
    // "IFC.OOR" must not match IFCDOOR, or a search box becomes a regex injection.
    const found = unwrap(await properties().find({ modelId: "struct", ifcClass: "IFC.OOR" }));
    expect(found).toEqual([]);
  });

  it("matches text against name and description", async () => {
    const byName = unwrap(await properties().find({ modelId: "struct", text: "external" }));
    expect(byName.map((element) => element.globalId)).toEqual(["1Wall00000000000000W01"]);

    const byDescription = unwrap(await properties().find({ modelId: "struct", text: "cavity" }));
    expect(byDescription.map((element) => element.globalId)).toEqual(["1Wall00000000000000W01"]);
  });

  it("distinguishes having a property from having it set to a value", async () => {
    const has = unwrap(
      await properties().find({ modelId: "struct", property: { name: "FireRating" } }),
    );
    expect(has).toHaveLength(1);

    const wrong = unwrap(
      await properties().find({ modelId: "struct", property: { name: "FireRating", value: "30" } }),
    );
    expect(wrong).toEqual([]);
  });

  it("searches quantities as well as properties", async () => {
    const found = unwrap(
      await properties().find({ modelId: "struct", property: { name: "NetArea", value: 12.5 } }),
    );
    expect(found.map((element) => element.globalId)).toEqual(["1Wall00000000000000W01"]);
  });

  it("drops matches that have no GlobalId", async () => {
    const found = unwrap(
      await properties().find({ modelId: "struct", ifcClass: "IFCWALLSTANDARDCASE" }),
    );
    // Local id 4 matches the class but cannot be referenced stably.
    expect(found.map((element) => element.globalId)).toEqual(["1Wall00000000000000W01"]);
  });

  it("refuses to guess which model to search", async () => {
    const result = await properties().find({ ifcClass: "IFCDOOR" });
    expect(result.ok).toBe(false);
  });
});

describe("spatial tree", () => {
  const tree = (model: FragmentDataModel = fakeModel()) =>
    new ThatOpenSpatialTree({ models: source(model), modelIds: () => ["struct"] });

  it("resolves the whole tree's identities in batched calls", async () => {
    const model = fakeModel();
    const guids = vi.spyOn(model, "getGuidsByLocalIds");
    const data = vi.spyOn(model, "getItemsData");

    unwrap(await tree(model).build("struct"));

    // Four nodes, two calls — not eight.
    expect(guids).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledTimes(1);
    expect(guids.mock.calls[0]?.[0]).toEqual([1, 2, 3, 4]);
  });

  it("publishes GlobalIds on every node that has one", async () => {
    const root = unwrap(await tree().build("struct"));
    const storey = root.children[0]!;
    const wall = storey.children[0]!;

    expect(root.element).toBeUndefined();
    expect(storey.element?.globalId).toBe("0Level00000000000000L1");
    expect(wall.element?.globalId).toBe("1Wall00000000000000W01");
    expect(wall.children[0]?.element?.globalId).toBe("2Door00000000000000D01");
  });

  it("keeps an unreferenceable node in place without giving it an identity", async () => {
    const storey = unwrap(await tree().build("struct")).children[0]!;
    const orphan = storey.children[1]!;

    // Dropping it would reparent its children onto the wrong ancestor; inventing an id would look
    // valid until somebody re-issued the model.
    expect(orphan.ifcClass).toBe("IFCWALLSTANDARDCASE");
    expect(orphan.element).toBeUndefined();
    expect(orphan.id).toBe("struct:4");
  });

  it("labels nodes by name, falling back to class only when unnamed", async () => {
    const model = fakeModel({ getItemsData: async (ids) => ids.map(() => ({})) });
    const named = unwrap(await tree().build("struct"));
    const unnamed = unwrap(await tree(model).build("struct"));

    expect(named.children[0]?.label).toBe("Level 1");
    // A tree reading "IFCWALLSTANDARDCASE" six hundred times tells the user nothing.
    expect(unnamed.children[0]?.label).toBe("IFCBUILDINGSTOREY");
  });

  it("gives each model its own root rather than merging them", async () => {
    const roots = unwrap(await tree().buildFederated());
    // Two models can both contain a "Level 1"; merging would imply a storey that does not exist.
    expect(roots).toHaveLength(1);
    expect(roots[0]?.ifcClass).toBe("IFCPROJECT");
  });

  it("reports an unloaded model", async () => {
    const service = new ThatOpenSpatialTree({ models: noModel(), modelIds: () => ["x"] });
    expect((await service.build("x")).ok).toBe(false);
    expect((await service.buildFederated()).ok).toBe(false);
  });

  it("turns a thrown engine error into a Result", async () => {
    const model = fakeModel({
      getSpatialStructure: async () => {
        throw new Error("worker died");
      },
    });
    expect((await tree(model).build("struct")).ok).toBe(false);
  });

  it("handles a model with an empty structure", async () => {
    const model = fakeModel({
      getSpatialStructure: async () => ({ category: null, localId: null }),
    });
    const root = unwrap(await tree(model).build("struct"));
    expect(root.children).toEqual([]);
    expect(root.label).toBe("Item");
  });
});
