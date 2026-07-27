import type { BoqRecord, EstimateRecord, Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BoqToken,
  CostAssemblyToken,
  ClassificationMappingToken,
  ESTIMATING_COMMANDS,
  EstimateToken,
  CashflowForecastToken,
  ChangeImpactToken,
  ModelElementSourceToken,
  QuantityTakeoffToken,
  ScheduleBasisToken,
  type ModelElementSource,
  type TakeoffElement,
} from "./contracts.js";
import { evaluateExpression, fromMajor, money, multiplyMoney, sumMoney } from "./math.js";
import { createEstimatingPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

let harness: TestHarness;
let elements: TakeoffElement[];
let modelVersion: string;

const source = (): ModelElementSource => ({
  elements: (modelId) => (modelId === "m1" ? elements : []),
  modelIds: () => ["m1"],
  modelVersion: () => modelVersion,
});

const wall = (globalId: string, volume: number, extra: Record<string, unknown> = {}): TakeoffElement => ({
  element: { modelId: "m1", globalId },
  ifcClass: "IfcWall",
  properties: { LoadBearing: true, ...extra },
  quantities: { NetVolume: volume, Width: 0.2, Height: 3 },
});

beforeEach(async () => {
  modelVersion = "C01";
  elements = [wall("W1", 10), wall("W2", 20)];
  harness = createTestHarness({ identity: { id: "qs", roles: ["estimator"] } });
  await harness.load(
    createEstimatingPlugin({
      clock: createFixedClock(),
      ids: createCountingIdFactory(),
      currency: "GBP",
      // Element-level, keyed by metric — the shape a coordination revision diff actually emits.
      diffs: (diffId) =>
        diffId === "diff-1"
          ? { entries: [{ element: { modelId: "m1", globalId: "W1" }, quantityDelta: { NetVolume: 5 } }] }
          : undefined,
    }),
  );
  harness.kernel.capabilities.provide(ModelElementSourceToken, source());
});

const takeoff = () => unwrapOk(harness.kernel.capabilities.require(QuantityTakeoffToken));
const classification = () => unwrapOk(harness.kernel.capabilities.require(ClassificationMappingToken));
const assemblies = () => unwrapOk(harness.kernel.capabilities.require(CostAssemblyToken));
const boqs = () => unwrapOk(harness.kernel.capabilities.require(BoqToken));
const estimates = () => unwrapOk(harness.kernel.capabilities.require(EstimateToken));

describe("money arithmetic", () => {
  it("keeps minor units as integers", () => {
    expect(fromMajor(12.5, "GBP")).toEqual({ amount: 1250, currency: "GBP" });
    expect(multiplyMoney(money(1250, "GBP"), 3).amount).toBe(3750);
  });

  it("rounds once rather than per component", () => {
    // 3 x 3.33p rounds to 10p, not 3 x 3p = 9p.
    expect(multiplyMoney(money(333, "GBP"), 0.01).amount).toBe(3);
    expect(multiplyMoney(money(1250, "GBP"), 0.335).amount).toBe(419);
  });

  it("refuses to combine currencies", () => {
    const result = sumMoney([money(1, "GBP"), money(1, "EUR")], "GBP");
    expect(result.ok).toBe(false);
  });

  it("refuses a non-finite amount instead of producing NaN money", () => {
    // Math.round(NaN) is NaN, so a single bad factor — a malformed rate in an imported cost
    // library — used to flow silently into a line total, a subtotal and a cashflow.
    expect(() => money(Number.NaN, "GBP")).toThrow(/finite/);
    expect(() => money(Number.POSITIVE_INFINITY, "GBP")).toThrow(/finite/);
    expect(() => multiplyMoney(money(100, "GBP"), Number.NaN)).toThrow(/finite/);
  });
});

describe("takeoff expressions", () => {
  it("evaluates arithmetic with precedence and brackets", () => {
    expect(unwrapOk(evaluateExpression("2 + 3 * 4", {}))).toBe(14);
    expect(unwrapOk(evaluateExpression("(2 + 3) * 4", {}))).toBe(20);
  });

  it("resolves named quantities", () => {
    expect(unwrapOk(evaluateExpression("Width * Height", { Width: 0.2, Height: 3 }))).toBeCloseTo(0.6);
  });

  it("an INHERITED property name is an unknown quantity, not a value", () => {
    // `variables` is a plain object, so `variables["constructor"]` returns Object.prototype's
    // constructor — a function, not `undefined`. A guard that only checks for `undefined` lets it
    // through onto the value stack and the expression evaluates to NaN: a silent, confidently wrong
    // measurement that propagates into the BoQ, the estimate and the cashflow, surfacing far from
    // the rule that caused it. Reported from a downstream adoption where the same bug class had
    // already been hit in an icon lookup.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const result = evaluateExpression(`Width * ${name}`, { Width: 3 });
      expect(result.ok, name).toBe(false);
      expect(result.ok === false && result.error.message, name).toContain(name);
    }
  });

  it("a non-finite quantity is refused rather than propagated", () => {
    // `Record<string, number>` cannot stop NaN or Infinity arriving across a JSON boundary.
    expect(evaluateExpression("Width * 2", { Width: Number.NaN }).ok).toBe(false);
    expect(evaluateExpression("Width * 2", { Width: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("reports an unknown quantity rather than treating it as zero", () => {
    const result = evaluateExpression("Depth * 2", { Width: 1 });
    // Zero would be a confident, wrong measurement.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unknown quantity");
  });

  it("rejects malformed input and division by zero", () => {
    expect(evaluateExpression("2 +", {}).ok).toBe(false);
    expect(evaluateExpression("(2 + 3", {}).ok).toBe(false);
    expect(evaluateExpression("1 / 0", {}).ok).toBe(false);
  });

  it("supports a leading or embedded sign", () => {
    // `Width * -1` and `-5` are ordinary things for a measurement rule to say; both used to be
    // rejected as malformed.
    expect(unwrapOk(evaluateExpression("-5", {}))).toBe(-5);
    expect(unwrapOk(evaluateExpression("W * -1", { W: 3 }))).toBe(-3);
    expect(unwrapOk(evaluateExpression("-W + 10", { W: 4 }))).toBe(6);
    expect(unwrapOk(evaluateExpression("2 * -3 + 1", {}))).toBe(-5);
    expect(unwrapOk(evaluateExpression("3 - -2", {}))).toBe(5);
  });

  it("keeps binary operators left-associative", () => {
    // A right-associative slip here turns 10-3-2 into 9 and 100/5/2 into 40.
    expect(unwrapOk(evaluateExpression("10 - 3 - 2", {}))).toBe(5);
    expect(unwrapOk(evaluateExpression("100 / 5 / 2", {}))).toBe(10);
  });

  it("still rejects an operator with nothing to operate on", () => {
    expect(evaluateExpression("* 5", {}).ok).toBe(false);
    expect(evaluateExpression("5 *", {}).ok).toBe(false);
  });

  it("does not execute arbitrary code", () => {
    // Rules arrive from shared files and cost libraries; `new Function` would make them a vector.
    expect(evaluateExpression("process.exit(1)", {}).ok).toBe(false);
    expect(evaluateExpression("1;console.log(1)", {}).ok).toBe(false);
  });
});

describe("quantity takeoff", () => {
  const addWallRule = async (): Promise<Id> => {
    const rule = unwrapOk(
      await takeoff().addRule({
        name: "Concrete walls",
        version: 1,
        filter: { ifcClass: "IfcWall" },
        metric: "NetVolume",
        unit: "m3",
        enabled: true,
      }),
    );
    return rule.id;
  };

  it("measures matching elements and records the rule and model version", async () => {
    await addWallRule();
    const summary = unwrapOk(await takeoff().run());

    expect(summary.quantities).toBe(2);
    expect(summary.elementsMeasured).toBe(2);

    const quantities = takeoff().quantities();
    expect(quantities[0]?.quantity).toEqual({ value: 10, unit: "m3" });
    expect(quantities[0]?.source).toMatchObject({
      kind: "model-takeoff",
      ruleVersion: 1,
      modelVersion: "C01",
    });
  });

  it("reports elements no rule measured", async () => {
    await addWallRule();
    elements.push({
      element: { modelId: "m1", globalId: "D1" },
      ifcClass: "IfcDoor",
      properties: {},
      quantities: {},
    });

    const summary = unwrapOk(await takeoff().run());

    // Coverage is what decides whether a takeoff is trustworthy.
    expect(summary.unmeasured.map((e) => e.globalId)).toEqual(["D1"]);
  });

  it("keeps the element references behind every number", async () => {
    await addWallRule();
    await takeoff().run();
    const quantity = takeoff().quantities()[0]!;

    expect(takeoff().elementsFor(quantity.id).map((e) => e.globalId)).toEqual(["W1"]);
  });

  it("replaces rather than doubles on a second run", async () => {
    await addWallRule();
    await takeoff().run();
    await takeoff().run();

    expect(takeoff().quantities()).toHaveLength(2);
  });

  it("uses an expression when the rule has one", async () => {
    await takeoff().addRule({
      name: "Wall face area",
      version: 1,
      filter: { ifcClass: "IfcWall" },
      metric: "Area",
      unit: "m2",
      expression: "Width * Height",
      enabled: true,
    });
    await takeoff().run();

    expect(takeoff().quantities({ metric: "Area" })[0]?.quantity.value).toBeCloseTo(0.6);
  });

  it("honours filters on properties", async () => {
    elements.push(wall("W3", 5, { LoadBearing: false }));
    await takeoff().addRule({
      name: "Load bearing only",
      version: 1,
      filter: { ifcClass: "IfcWall", LoadBearing: true },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff().run();

    expect(takeoff().quantities()).toHaveLength(2);
  });

  it("skips disabled rules", async () => {
    const ruleId = await addWallRule();
    takeoff().setRuleEnabled(ruleId, false);

    expect(unwrapOk(await takeoff().run()).quantities).toBe(0);
  });

  it("reports honestly when no element source is installed", async () => {
    const bare = createTestHarness();
    await bare.load(createEstimatingPlugin({ ids: createCountingIdFactory() }));
    const service = unwrapOk(bare.kernel.capabilities.require(QuantityTakeoffToken));

    const result = await service.run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    await bare.dispose();
  });
});

describe("cost assemblies", () => {
  const buildAssembly = async (overrides: Record<string, unknown> = {}): Promise<Id> => {
    const labour = unwrapOk(
      await assemblies().upsertResource({
        name: "Bricklayer",
        type: "labour",
        unit: "hr",
        rate: fromMajor(30, "GBP"),
      }),
    );
    const concrete = unwrapOk(
      await assemblies().upsertResource({
        name: "Concrete",
        type: "material",
        unit: "m3",
        rate: fromMajor(100, "GBP"),
      }),
    );
    const assembly = unwrapOk(
      await assemblies().upsertAssembly({
        code: "C10",
        name: "Concrete wall",
        unit: "m3",
        components: [
          { resourceId: labour.id, factor: 2 },
          { resourceId: concrete.id, factor: 1 },
        ],
        ...overrides,
      }),
    );
    return assembly.id;
  };

  it("computes a composite unit rate", async () => {
    const id = await buildAssembly();
    // 2 hr x £30 + 1 m3 x £100 = £160
    expect(unwrapOk(assemblies().unitRate(id))).toEqual(fromMajor(160, "GBP"));
  });

  it("applies waste to the consumed quantity", async () => {
    const labour = unwrapOk(
      await assemblies().upsertResource({ name: "L", type: "labour", unit: "hr", rate: fromMajor(100, "GBP") }),
    );
    const assembly = unwrapOk(
      await assemblies().upsertAssembly({
        code: "W",
        name: "Wasteful",
        unit: "m3",
        components: [{ resourceId: labour.id, factor: 1, wastePercent: 10 }],
      }),
    );

    expect(unwrapOk(assemblies().unitRate(assembly.id))).toEqual(fromMajor(110, "GBP"));
  });

  it("compounds profit on top of overhead, not alongside it", async () => {
    const id = await buildAssembly({ overheadPercent: 10, profitPercent: 10 });
    // £160 -> £176 -> £193.60. Applying both to £160 would give £192, understating the rate.
    expect(unwrapOk(assemblies().unitRate(id))).toEqual(fromMajor(193.6, "GBP"));
  });

  it("refuses a resource in the wrong currency", async () => {
    const euro = unwrapOk(
      await assemblies().upsertResource({ name: "E", type: "material", unit: "m3", rate: money(100, "EUR") }),
    );
    const assembly = unwrapOk(
      await assemblies().upsertAssembly({
        code: "X",
        name: "Mixed",
        unit: "m3",
        components: [{ resourceId: euro.id, factor: 1 }],
      }),
    );

    expect(assemblies().unitRate(assembly.id).ok).toBe(false);
  });
});

describe("BOQ and estimate", () => {
  const fullChain = async (): Promise<{ boq: BoqRecord; estimate: EstimateRecord }> => {
    await takeoff().addRule({
      name: "Walls",
      version: 1,
      filter: { ifcClass: "IfcWall" },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff().run();

    const system = unwrapOk(await classification().addSystem({ name: "Uniclass 2015" }));
    await classification().setMapping({
      systemId: system.id,
      code: "C10",
      filter: { ifcClass: "IfcWall" },
    });
    await classification().classify(system.id);

    const labour = unwrapOk(
      await assemblies().upsertResource({ name: "L", type: "labour", unit: "hr", rate: fromMajor(10, "GBP") }),
    );
    await assemblies().upsertAssembly({
      code: "C10",
      name: "Concrete wall",
      unit: "m3",
      components: [{ resourceId: labour.id, factor: 1 }],
    });

    const boq = unwrapOk(await boqs().create("Main BOQ", "GBP"));
    await boqs().generate(boq.id);
    const estimate = unwrapOk(await estimates().create("Estimate A", boq.id, { contingencyPercent: 5 }));
    return { boq, estimate };
  };

  it("aggregates classified quantities into priced lines", async () => {
    const { boq } = await fullChain();
    const lines = boqs().lines(boq.id);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toEqual({ value: 30, unit: "m3" });
    expect(lines[0]?.total).toEqual(fromMajor(300, "GBP"));
  });

  it("keeps the audit trail from line back to quantities", async () => {
    const { boq } = await fullChain();
    const line = boqs().lines(boq.id)[0]!;

    expect(line.quantityIds).toHaveLength(2);
    expect(line.rateSource?.kind).toBe("assembly");
    expect(line.quantitySource?.kind).toBe("model-takeoff");
  });

  it("does not merge quantities measured in different units", async () => {
    await takeoff().addRule({
      name: "Wall area",
      version: 1,
      filter: { ifcClass: "IfcWall" },
      metric: "NetVolume",
      unit: "m2",
      enabled: true,
    });
    const { boq } = await fullChain();

    // Same classification code, different unit — two lines, because summing them is nonsense.
    expect(boqs().lines(boq.id).length).toBeGreaterThan(1);
  });

  it("reports lines it could not price", async () => {
    await takeoff().addRule({
      name: "Walls",
      version: 1,
      filter: { ifcClass: "IfcWall" },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff().run();
    const system = unwrapOk(await classification().addSystem({ name: "S" }));
    await classification().setMapping({ systemId: system.id, code: "NOPRICE", filter: { ifcClass: "IfcWall" } });
    await classification().classify(system.id);

    const boq = unwrapOk(await boqs().create("B", "GBP"));
    const generated = unwrapOk(await boqs().generate(boq.id));

    expect(generated.unpriced).toHaveLength(1);
  });

  it("applies contingency to the estimate total", async () => {
    const { estimate } = await fullChain();

    expect(estimate.subtotal).toEqual(fromMajor(300, "GBP"));
    expect(estimate.total).toEqual(fromMajor(315, "GBP"));
  });

  it("records the model revisions it was priced against", async () => {
    const { estimate } = await fullChain();

    expect(estimate.basisModelVersions).toEqual([{ modelId: "m1", version: "C01" }]);
  });

  it("refuses to silently reprice an issued estimate", async () => {
    const { estimate } = await fullChain();
    await estimates().issue(estimate.id);

    const result = await estimates().recalculate(estimate.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("revise it instead");
  });

  it("supersedes rather than overwrites on revision", async () => {
    const { estimate } = await fullChain();
    await estimates().issue(estimate.id);

    const revised = unwrapOk(await estimates().revise(estimate.id, "rev B"));

    expect(revised.supersedesId).toBe(estimate.id);
    expect(estimates().get(estimate.id)?.status).toBe("superseded");
  });

  it("freezes the bill on issue so a later takeoff cannot rewrite it", async () => {
    const { boq, estimate } = await fullChain();
    const issued = unwrapOk(await estimates().issue(estimate.id));

    elements.push(wall("W3", 30));
    await takeoff().run();
    await classification().classify(classification().systems()[0]!.id);
    await boqs().generate(boq.id);

    // The issued document still reports what was issued.
    expect(boqs().lines(issued.boqId)[0]?.quantity.value).toBe(30);
    expect(boqs().lines(boq.id)[0]?.quantity.value).toBe(60);
  });

  it("compares two estimates by classification, not by line id", async () => {
    const { boq, estimate } = await fullChain();
    await estimates().issue(estimate.id);
    elements.push(wall("W3", 30));
    modelVersion = "C02";
    await takeoff().run();
    await classification().classify(classification().systems()[0]!.id);
    await boqs().generate(boq.id); // regenerates with fresh line ids
    const revised = unwrapOk(await estimates().revise(estimate.id));

    const comparison = unwrapOk(await estimates().compare(estimate.id, revised.id));

    // Regenerated lines get new ids; keying on those would report everything as changed.
    expect(comparison.changedLines).toHaveLength(1);
    expect(comparison.deltaTotal.amount).toBeGreaterThan(0);
  });

  it("exports CSV with quoting", async () => {
    const { boq } = await fullChain();
    const csv = new TextDecoder().decode(
      unwrapOk(
        await harness.kernel.commands.execute<Uint8Array>(ESTIMATING_COMMANDS.exportBoq, {
          boqId: boq.id,
          format: "csv",
        }),
      ),
    );

    expect(csv.split("\n")[0]).toContain("Item,Code,Description");
    expect(csv).toContain("C10");
  });
});

describe("cashflow", () => {
  it("spreads an estimate over schedule periods and ties back exactly", async () => {
    harness.kernel.capabilities.provide(ScheduleBasisToken, {
      periods: () => [
        { start: "2026-01-01", end: "2026-01-31", weight: 1 / 3 },
        { start: "2026-02-01", end: "2026-02-28", weight: 1 / 3 },
        { start: "2026-03-01", end: "2026-03-31", weight: 1 / 3 },
      ],
    });
    const boq = unwrapOk(await boqs().create("B", "GBP"));
    await boqs().upsertLine({
      boqId: boq.id,
      itemNumber: "001",
      description: "Work",
      quantity: { value: 1, unit: "item" },
      rate: money(1000, "GBP"),
      total: money(1000, "GBP"),
    });
    const estimate = unwrapOk(await estimates().create("E", boq.id));

    const cashflow = unwrapOk(harness.kernel.capabilities.require(CashflowForecastToken));
    const forecast = unwrapOk(await cashflow.generate(estimate.id, { period: "month" }));

    const total = forecast.periods.reduce((sum, period) => sum + period.plannedSpend.amount, 0);
    // 1000 / 3 does not divide evenly; the last period absorbs the remainder so it still ties.
    expect(total).toBe(estimate.total.amount);
    expect(forecast.periods).toHaveLength(3);
  });

  it("reports honestly when no schedule basis is installed", async () => {
    const boq = unwrapOk(await boqs().create("B", "GBP"));
    const estimate = unwrapOk(await estimates().create("E", boq.id));
    const cashflow = unwrapOk(harness.kernel.capabilities.require(CashflowForecastToken));

    expect((await cashflow.generate(estimate.id)).ok).toBe(false);
  });
});

describe("change impact", () => {
  it("prices a revision delta at the agreed rate", async () => {
    await takeoff().addRule({
      name: "Walls",
      version: 1,
      filter: { ifcClass: "IfcWall" },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff().run();
    const system = unwrapOk(await classification().addSystem({ name: "S" }));
    await classification().setMapping({ systemId: system.id, code: "C10", filter: { ifcClass: "IfcWall" } });
    await classification().classify(system.id);
    const labour = unwrapOk(
      await assemblies().upsertResource({ name: "L", type: "labour", unit: "hr", rate: fromMajor(10, "GBP") }),
    );
    await assemblies().upsertAssembly({
      code: "C10",
      name: "Wall",
      unit: "m3",
      components: [{ resourceId: labour.id, factor: 1 }],
    });
    const boq = unwrapOk(await boqs().create("B", "GBP"));
    await boqs().generate(boq.id);
    const estimate = unwrapOk(await estimates().create("E", boq.id));

    const changes = unwrapOk(harness.kernel.capabilities.require(ChangeImpactToken));
    const impact = unwrapOk(await changes.assess("diff-1", estimate.id));

    // 5 m3 more at £10/m3, resolved element -> quantity -> priced line.
    expect(impact.deltaCost).toEqual(fromMajor(50, "GBP"));
    expect(impact.deltaQuantities).toEqual([{ metric: "NetVolume", delta: { value: 5, unit: "m3" } }]);
    expect(impact.unpricedElements).toBeUndefined();

    await changes.setStatus(impact.id, "approved");
    expect(unwrapOk(changes.totalApproved(estimate.id))).toEqual(fromMajor(50, "GBP"));
  });

  it("reports elements it could not price rather than under-reporting the change", async () => {
    // An added element has not been measured yet, so no quantity and no line exist for it. A delta
    // that silently covered only the measurable half would read as a smaller change than it is.
    const bare = createTestHarness();
    await bare.load(
      createEstimatingPlugin({
        ids: createCountingIdFactory(),
        currency: "GBP",
        diffs: () => ({
          entries: [{ element: { modelId: "m1", globalId: "NEW-1" }, quantityDelta: { NetVolume: 7 } }],
        }),
      }),
    );
    const boqService = unwrapOk(bare.kernel.capabilities.require(BoqToken));
    const estimateService = unwrapOk(bare.kernel.capabilities.require(EstimateToken));
    const boq = unwrapOk(await boqService.create("B", "GBP"));
    const estimate = unwrapOk(await estimateService.create("E", boq.id));

    const changes = unwrapOk(bare.kernel.capabilities.require(ChangeImpactToken));
    const impact = unwrapOk(await changes.assess("any", estimate.id));

    expect(impact.deltaCost).toEqual(money(0, "GBP"));
    expect(impact.unpricedElements?.map((e) => e.globalId)).toEqual(["NEW-1"]);
    await bare.dispose();
  });

  it("reports an unknown diff", async () => {
    const boq = unwrapOk(await boqs().create("B", "GBP"));
    const estimate = unwrapOk(await estimates().create("E", boq.id));
    const changes = unwrapOk(harness.kernel.capabilities.require(ChangeImpactToken));

    expect((await changes.assess("nope", estimate.id)).ok).toBe(false);
  });
});
