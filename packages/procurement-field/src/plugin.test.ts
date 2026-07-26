import type { ElementRef, Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BoqLineSourceToken,
  FieldStatusToken,
  InspectionToken,
  InstallProgressToken,
  PackageToken,
  VendorScopeToken,
  type PackageBoqLine,
} from "./contracts.js";
import { createProcurementPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const gbp = (amount: number) => ({ amount, currency: "GBP" });
const el = (globalId: string): ElementRef => ({ modelId: "struct", globalId });

let harness: TestHarness;
let lines: PackageBoqLine[];

beforeEach(async () => {
  lines = [
    {
      id: "line-1",
      quantity: { value: 100, unit: "m3" },
      total: gbp(100_000),
      elements: [el("W1"), el("W2"), el("W3"), el("W4")],
    },
    { id: "line-2", quantity: { value: 50, unit: "m3" }, total: gbp(25_000), elements: [el("S1")] },
  ];
  harness = createTestHarness({ identity: { id: "pm", roles: ["manager"] } });
  await harness.load(
    createProcurementPlugin({
      clock: createFixedClock(),
      ids: createCountingIdFactory(),
      currency: "GBP",
    }),
  );
  harness.kernel.capabilities.provide(
    BoqLineSourceToken,
    (lineIds?: readonly Id[]) =>
      lineIds === undefined ? lines : lines.filter((line) => lineIds.includes(line.id)),
  );
});

const packages = () => unwrapOk(harness.kernel.capabilities.require(PackageToken));
const vendors = () => unwrapOk(harness.kernel.capabilities.require(VendorScopeToken));
const field = () => unwrapOk(harness.kernel.capabilities.require(FieldStatusToken));
const inspections = () => unwrapOk(harness.kernel.capabilities.require(InspectionToken));
const progress = () => unwrapOk(harness.kernel.capabilities.require(InstallProgressToken));

const makePackage = async () =>
  unwrapOk(await packages().fromBoqLines(["line-1"], "Concrete frame", "P-01"));

describe("packages", () => {
  it("carries budget and elements across from the bill", async () => {
    const record = await makePackage();

    // A package priced separately from the bill it came from is how the estimate and the
    // procurement plan quietly stop agreeing.
    expect(record.budget).toEqual(gbp(100_000));
    expect(record.elements).toHaveLength(4);
    expect(record.status).toBe("draft");
  });

  it("refuses to build a package from lines that do not exist", async () => {
    expect((await packages().fromBoqLines(["ghost"], "X", "P-99")).ok).toBe(false);
  });

  it("refuses a line in another currency", async () => {
    lines = [{ id: "line-eur", quantity: { value: 1, unit: "m3" }, total: { amount: 1, currency: "EUR" } }];
    expect((await packages().fromBoqLines(["line-eur"], "X", "P-98")).ok).toBe(false);
  });

  it("reports priced work nobody has been asked to do", async () => {
    await makePackage();
    expect(unwrapOk(await packages().uncoveredScope())).toEqual(["line-2"]);
  });
});

describe("vendor scope", () => {
  const addVendor = async (name: string) =>
    unwrapOk(await vendors().upsertVendor({ name, type: undefined as never, unit: undefined as never } as never));

  it("compares quotes alongside their exclusions", async () => {
    const record = await makePackage();
    const cheap = unwrapOk(await vendors().upsertVendor({ name: "Cheap Ltd" }));
    const full = unwrapOk(await vendors().upsertVendor({ name: "Full Scope Ltd" }));

    await vendors().submitScope({
      packageId: record.id,
      vendorId: cheap.id,
      inclusions: ["supply"],
      exclusions: ["install", "crane", "waste"],
      quotedValue: gbp(60_000),
    } as never);
    await vendors().submitScope({
      packageId: record.id,
      vendorId: full.id,
      inclusions: ["supply", "install"],
      exclusions: [],
      quotedValue: gbp(95_000),
    } as never);

    const comparison = unwrapOk(await vendors().compare(record.id));

    // The cheapest quote is routinely the one that excluded the most.
    expect(comparison[0]?.vendorId).toBe(cheap.id);
    expect(comparison[0]?.exclusionCount).toBe(3);
    expect(comparison[1]?.exclusionCount).toBe(0);
    void addVendor;
  });

  it("awards a package and records the value", async () => {
    const record = await makePackage();
    const vendor = unwrapOk(await vendors().upsertVendor({ name: "Acme" }));

    const awarded = unwrapOk(await vendors().award(record.id, vendor.id, gbp(95_000)));

    expect(awarded.status).toBe("awarded");
    expect(awarded.awardedValue).toEqual(gbp(95_000));
  });

  it("refuses to award twice", async () => {
    const record = await makePackage();
    const vendor = unwrapOk(await vendors().upsertVendor({ name: "Acme" }));
    await vendors().award(record.id, vendor.id, gbp(95_000));

    expect((await vendors().award(record.id, vendor.id, gbp(80_000))).ok).toBe(false);
  });

  it("refuses a scope for an unknown vendor", async () => {
    const record = await makePackage();
    expect(
      (
        await vendors().submitScope({
          packageId: record.id,
          vendorId: "ghost",
          inclusions: [],
          exclusions: [],
        } as never)
      ).ok,
    ).toBe(false);
  });
});

describe("field status", () => {
  it("supersedes rather than accumulates per element", async () => {
    const record = await makePackage();
    await field().record({
      element: el("W1"),
      state: "in-progress",
      packageId: record.id,
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "site",
    });
    await field().record({
      element: el("W1"),
      state: "installed",
      packageId: record.id,
      observedAt: "2026-02-05T00:00:00.000Z",
      observedBy: "site",
    });

    // Progress is a state, not a log; summing a log double-counts every element updated twice.
    expect(field().query()).toHaveLength(1);
    expect(field().current(el("W1"))?.state).toBe("installed");
  });

  it("filters by package, state and date", async () => {
    const record = await makePackage();
    await field().recordMany([
      { element: el("W1"), state: "installed", packageId: record.id, observedAt: "2026-02-01T00:00:00.000Z", observedBy: "s" },
      { element: el("W2"), state: "rework", packageId: record.id, observedAt: "2026-03-01T00:00:00.000Z", observedBy: "s" },
    ]);

    expect(field().query({ state: "installed" })).toHaveLength(1);
    expect(field().query({ since: "2026-02-15T00:00:00.000Z" })).toHaveLength(1);
  });
});

describe("inspection", () => {
  it("advances inspected elements on a pass", async () => {
    const record = await makePackage();
    await field().record({
      element: el("W1"),
      state: "installed",
      packageId: record.id,
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "s",
    });

    await inspections().create({
      name: "Pour 1",
      packageId: record.id,
      elements: [el("W1")],
      outcome: "pass",
      inspectedAt: "2026-02-02T00:00:00.000Z",
      inspectedBy: "qa",
    } as never);

    // Recording the outcome without advancing state leaves progress contradicting the record.
    expect(field().current(el("W1"))?.state).toBe("inspected");
  });

  it("raises issues and marks elements for rework on a failure", async () => {
    let created = 0;
    harness.kernel.commands.register<unknown, { id: Id }>({
      id: "markup.issue.create",
      handler: () => ({ id: `issue-${++created}` }),
    });
    const record = await makePackage();
    await field().record({
      element: el("W2"),
      state: "installed",
      packageId: record.id,
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "s",
    });
    const inspection = unwrapOk(
      await inspections().create({
        name: "Pour 2",
        packageId: record.id,
        outcome: "not-inspected",
        inspectedAt: "2026-02-02T00:00:00.000Z",
        inspectedBy: "qa",
      } as never),
    );

    const issueIds = unwrapOk(
      await inspections().fail(inspection.id, [{ element: el("W2"), note: "Honeycombing" }]),
    );

    expect(issueIds).toHaveLength(1);
    expect(field().current(el("W2"))?.state).toBe("rework");
    expect(inspections().list({ outcome: "fail" })).toHaveLength(1);
  });
});

describe("install progress and earned value", () => {
  const installQuarter = async (packageId: Id): Promise<void> => {
    await field().record({
      element: el("W1"),
      state: "installed",
      packageId,
      quantityInstalled: 25,
      unit: "m3",
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "s",
    });
  };

  it("rolls element quantities up to a package claim", async () => {
    const record = await makePackage();
    await installQuarter(record.id);

    const claim = unwrapOk(await progress().compute(record.id, "2026-03-01T00:00:00.000Z"));

    expect(claim.quantityTotal).toBe(100);
    expect(claim.quantityInstalled).toBe(25);
    expect(claim.percentComplete).toBeCloseTo(0.25, 6);
  });

  it("earns value against the awarded amount, not the budget, once awarded", async () => {
    const record = await makePackage();
    const vendor = unwrapOk(await vendors().upsertVendor({ name: "Acme" }));
    await vendors().award(record.id, vendor.id, gbp(80_000));
    await installQuarter(record.id);

    expect(unwrapOk(await progress().earnedValue(record.id, "2026-03-01T00:00:00.000Z"))).toEqual(
      gbp(20_000),
    );
  });

  it("ignores work observed after the data date", async () => {
    const record = await makePackage();
    await installQuarter(record.id);

    const claim = unwrapOk(await progress().compute(record.id, "2026-01-01T00:00:00.000Z"));
    expect(claim.quantityInstalled).toBe(0);
  });

  it("does not count in-progress work as installed", async () => {
    const record = await makePackage();
    await field().record({
      element: el("W1"),
      state: "in-progress",
      packageId: record.id,
      quantityInstalled: 25,
      unit: "m3",
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "s",
    });

    expect(
      unwrapOk(await progress().compute(record.id, "2026-03-01T00:00:00.000Z")).quantityInstalled,
    ).toBe(0);
  });

  it("falls back to a pro-rata share when quantities were not measured", async () => {
    const record = await makePackage();
    await field().record({
      element: el("W1"),
      state: "installed",
      packageId: record.id,
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "s",
    });

    // One of four elements, coarsely recorded, still reports rather than reading as zero.
    const claim = unwrapOk(await progress().compute(record.id, "2026-03-01T00:00:00.000Z"));
    expect(claim.quantityInstalled).toBeCloseTo(25, 6);
  });

  it("refuses an earned-value claim with no award and no budget", async () => {
    const record = unwrapOk(
      await packages().create({ code: "P-X", name: "Unfunded", status: "draft", boqLineIds: [] }),
    );

    // Inventing a number here would put an unsupported figure on a payment application.
    expect((await progress().earnedValue(record.id, "2026-03-01T00:00:00.000Z")).ok).toBe(false);
  });

  it("keeps one claim per data date", async () => {
    const record = await makePackage();
    await installQuarter(record.id);
    await progress().compute(record.id, "2026-03-01T00:00:00.000Z");
    await progress().compute(record.id, "2026-03-01T00:00:00.000Z");

    expect(progress().history(record.id)).toHaveLength(1);
  });
});
