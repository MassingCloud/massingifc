import { createKernel, type Kernel } from "@massingifc/core-kernel";
import {
  createCountingIdFactory,
  createFixedClock,
  type Clock,
  type IdFactory,
} from "@massingifc/plugin-sdk";
import { createDefaultMigrationRegistry } from "@massingifc/project-schema";
import type { ElementRef, ModelRecord, ProjectRecord } from "@massingifc/project-schema";

import { createFederationPlugin, FederationToken, ModelLoaderPortToken } from "@massingifc/federation";
import { createMassingPlugin, MassingToken, MetricsToken, ProfileToken } from "@massingifc/massing";
import {
  createMarkupPlugin,
  AnchorToken,
  ElementResolverToken,
  IssueToken,
  MarkupToken,
} from "@massingifc/markup";
import {
  createCoordinationPlugin,
  ClashEngineToken,
  ClashToken,
  ModelSnapshotToken,
  RevisionDiffToken,
  type SnapshotElement,
} from "@massingifc/coordination";
import {
  createEstimatingPlugin,
  BoqToken,
  ClassificationMappingToken,
  CostAssemblyToken,
  EstimateToken,
  fromMajor,
  ModelElementSourceToken,
  QuantityTakeoffToken,
  type TakeoffElement,
} from "@massingifc/estimating-5d";
import {
  createPlanningPlugin,
  ElementFilterSourceToken,
  ScheduleImportToken,
  TaskModelLinkToken,
} from "@massingifc/planning-4d";
import { createAuthoringPlugin, GeometryBackendToken } from "@massingifc/authoring";
import { createFamilyPlugin, FamilyRepositoryAdapterToken, createMemoryRepositoryAdapter } from "@massingifc/family-libraries";
import { createTwinPlugin, TwinRegistryToken } from "@massingifc/digital-twin";
import { createIcddPlugin, IcddToken, MemoryArchive } from "@massingifc/icdd";
import { createInteropPlugin, InteropToken } from "@massingifc/interop";
import { createAnalyticsPlugin, AnalyticsToken, MetricProviderToken } from "@massingifc/analytics";
import { createShellPlugin, ShellToken } from "@massingifc/ui-shell";
import {
  createProcurementPlugin,
  BoqLineSourceToken,
  FieldStatusToken,
  InstallProgressToken,
  PackageToken,
  VendorScopeToken,
} from "@massingifc/procurement-field";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * Cross-plugin integration.
 *
 * The unit suites prove each capability family works. This proves the thing the architecture
 * actually claims: that they compose through the kernel without importing one another, and that
 * the chain from geometry to money to site survives a model revision.
 */

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const PROJECT: ProjectRecord = {
  id: "p1",
  name: "Integration Tower",
  units: { length: "m", area: "m2", volume: "m3", currency: "GBP" },
  modelIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "pm",
};

const model = (version: string): ModelRecord => ({
  id: "struct",
  name: "Structure",
  role: "reference",
  format: "fragments",
  version,
});

/** Element data shared by takeoff, coordination and planning. */
interface FakeElement {
  readonly globalId: string;
  readonly ifcClass: string;
  readonly level: string;
  readonly volume: number;
}

let kernel: Kernel;
let clock: Clock;
let ids: IdFactory;
let elements: FakeElement[];
let snapshots: Map<string, FakeElement[]>;

const asRef = (element: FakeElement): ElementRef => ({ modelId: "struct", globalId: element.globalId });

const asTakeoff = (element: FakeElement): TakeoffElement => ({
  element: asRef(element),
  ifcClass: element.ifcClass,
  properties: { Level: element.level },
  quantities: { NetVolume: element.volume },
});

const asSnapshot = (element: FakeElement): SnapshotElement => ({
  element: asRef(element),
  ifcClass: element.ifcClass,
  properties: { Level: element.level },
  quantities: { NetVolume: element.volume },
  placementHash: `p-${element.globalId}`,
});

beforeEach(async () => {
  clock = createFixedClock();
  ids = createCountingIdFactory();
  elements = [
    { globalId: "C1", ifcClass: "IfcColumn", level: "L1", volume: 4 },
    { globalId: "C2", ifcClass: "IfcColumn", level: "L1", volume: 6 },
    { globalId: "B1", ifcClass: "IfcBeam", level: "L1", volume: 2 },
  ];
  snapshots = new Map([["C01", [...elements]]]);

  kernel = createKernel({ migrator: createDefaultMigrationRegistry() });

  // Every plugin is registered the same way; none of them import one another.
  kernel.use(createFederationPlugin({ clock, ids }));
  kernel.use(createMassingPlugin({ clock, ids }));
  kernel.use(createMarkupPlugin({ clock, ids, modelVersions: () => [{ modelId: "struct", version: "C01" }] }));
  kernel.use(createCoordinationPlugin({ clock, ids, elementsOf: () => elements.map(asRef) }));
  kernel.use(createEstimatingPlugin({ clock, ids, currency: "GBP" }));
  kernel.use(createPlanningPlugin({ clock, ids }));
  kernel.use(createProcurementPlugin({ clock, ids, currency: "GBP" }));
  kernel.use(createAuthoringPlugin({ clock, ids }));
  kernel.use(createFamilyPlugin({ clock, ids }));
  kernel.use(createTwinPlugin({ clock, ids }));
  kernel.use(createIcddPlugin({ clock }));
  kernel.use(createInteropPlugin({ clock }));
  kernel.use(createAnalyticsPlugin({ clock, ids }));
  kernel.use(createShellPlugin({ ids, panels: () => [...kernel.ui.byPoint("panel")] }));

  const report = await kernel.start();
  expect(report.failed).toHaveLength(0);

  // The host wires the ports. This is the only place that knows all the families exist.
  kernel.capabilities.provide(ModelLoaderPortToken, {
    load: async () => ({ ok: true, value: undefined }),
    unload: async () => ({ ok: true, value: undefined }),
    setTransform: async () => ({ ok: true, value: undefined }),
  });
  kernel.capabilities.provide(ModelElementSourceToken, {
    elements: () => elements.map(asTakeoff),
    modelIds: () => ["struct"],
    modelVersion: () => unwrapOk(kernel.capabilities.require(FederationToken)).models()[0]?.version,
  });
  kernel.capabilities.provide(ElementResolverToken, {
    exists: (_modelId, globalId) => elements.some((e) => e.globalId === globalId),
    globalIds: () => elements.map((e) => e.globalId),
  });
  kernel.capabilities.provide(ElementFilterSourceToken, {
    match: (modelId, filter) =>
      elements
        .filter((e) =>
          Object.entries(filter).every(([key, value]) =>
            key === "ifcClass" ? e.ifcClass === value : e.level === value,
          ),
        )
        .map((e) => ({ modelId, globalId: e.globalId })),
  });
  kernel.capabilities.provide(ModelSnapshotToken, {
    modelIds: () => ["struct"],
    versions: () => [...snapshots.keys()],
    snapshot: (_modelId, version) => snapshots.get(version)?.map(asSnapshot),
  });
  kernel.capabilities.provide(ClashEngineToken, {
    intersect: () => [{ a: asRef(elements[0]!), b: asRef(elements[2]!), distance: 0.1 }],
  });
  kernel.capabilities.provide(BoqLineSourceToken, (lineIds) => {
    const boqs = unwrapOk(kernel.capabilities.require(BoqToken));
    const all = boqs.lines("boq-1").map((line) => ({
      id: line.id,
      quantity: line.quantity,
      ...(line.total === undefined ? {} : { total: line.total }),
      elements: (line.quantityIds ?? []).flatMap((qid) =>
        unwrapOk(kernel.capabilities.require(QuantityTakeoffToken)).elementsFor(qid),
      ),
    }));
    return lineIds === undefined ? all : all.filter((line) => lineIds.includes(line.id));
  });

  const federation = unwrapOk(kernel.capabilities.require(FederationToken));
  await federation.openProject(PROJECT);
  await federation.addModel(model("C01"));
  await federation.load("struct");
});

describe("plugin composition", () => {
  it("activates every capability family into one kernel", () => {
    // All fourteen at once. Duplicate command ids or capability tokens would show up here as a
    // quarantined plugin rather than as the two identical strings that caused them.
    expect(kernel.plugins.list().filter((p) => p.status === "active")).toHaveLength(14);
  });

  it("gives every plugin a distinct command and capability namespace", () => {
    const commandIds = kernel.commands.list().map((command) => command.id);
    expect(new Set(commandIds).size).toBe(commandIds.length);

    const tokens = kernel.capabilities.tokens();
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("wires the shell to the panels the plugins actually contributed", () => {
    const shell = unwrapOk(kernel.capabilities.require(ShellToken));
    // The shell reads the kernel's UI registry rather than keeping its own list, so every panel a
    // capability family registered is openable.
    expect(shell.panels().length).toBe(kernel.ui.byPoint("panel").length);
    expect(shell.panels().length).toBeGreaterThan(8);
  });

  it("registers all of their commands and panels on one bus and shell", () => {
    const commands = kernel.commands.list().map((c) => c.id);

    expect(commands).toContain("massing.create");
    expect(commands).toContain("markup.pin.create");
    expect(commands).toContain("estimating.takeoff.run");
    expect(commands).toContain("coordination.clash.run");
    expect(kernel.ui.byPoint("panel").length).toBeGreaterThan(6);
  });

  it("contains a failing plugin without disturbing the others", async () => {
    const broken = {
      manifest: { id: "broken", version: "1.0.0", apiVersion: "^1.0.0" },
      activate: () => {
        throw new Error("bad plugin");
      },
    };
    kernel.use(broken);
    await kernel.plugins.activate("broken");

    expect(kernel.plugins.status("broken")).toBe("quarantined");
    expect(kernel.plugins.isActive("massingifc.estimating")).toBe(true);
    expect(kernel.commands.has("estimating.takeoff.run")).toBe(true);
  });
});

describe("model to money to site", () => {
  const runChain = async (): Promise<{ boqId: string; packageId: string }> => {
    const takeoff = unwrapOk(kernel.capabilities.require(QuantityTakeoffToken));
    const classification = unwrapOk(kernel.capabilities.require(ClassificationMappingToken));
    const assemblies = unwrapOk(kernel.capabilities.require(CostAssemblyToken));
    const boqs = unwrapOk(kernel.capabilities.require(BoqToken));

    await takeoff.addRule({
      name: "Concrete",
      version: 1,
      filter: { ifcClass: "IfcColumn" },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff.run();

    const system = unwrapOk(await classification.addSystem({ name: "Uniclass 2015" }));
    await classification.setMapping({ systemId: system.id, code: "C10", filter: { ifcClass: "IfcColumn" } });
    await classification.classify(system.id);

    const labour = unwrapOk(
      await assemblies.upsertResource({ name: "Gang", type: "labour", unit: "hr", rate: fromMajor(100, "GBP") }),
    );
    await assemblies.upsertAssembly({
      code: "C10",
      name: "Concrete column",
      unit: "m3",
      components: [{ resourceId: labour.id, factor: 1 }],
    });

    // The BOQ id is fixed so the host's BoqLineSource can find it.
    const boq = unwrapOk(await boqs.create("Main", "GBP"));
    await boqs.generate(boq.id);

    const packages = unwrapOk(kernel.capabilities.require(PackageToken));
    const lineIds = boqs.lines(boq.id).map((line) => line.id);
    const pkg = unwrapOk(await packages.fromBoqLines(lineIds, "Columns", "P-01"));
    return { boqId: boq.id, packageId: pkg.id };
  };

  it("carries quantities through cost into a procurement package", async () => {
    const boqs = unwrapOk(kernel.capabilities.require(BoqToken));
    const { boqId, packageId } = await runChain();

    // 4 + 6 = 10 m3 of columns at £100/m3.
    const line = boqs.lines(boqId)[0]!;
    expect(line.quantity).toEqual({ value: 10, unit: "m3" });
    expect(line.total).toEqual(fromMajor(1000, "GBP"));

    const packages = unwrapOk(kernel.capabilities.require(PackageToken));
    expect(packages.list()[0]?.budget).toEqual(fromMajor(1000, "GBP"));
    expect(packageId).toBeTruthy();
  });

  it("records the model revision every quantity was measured against", async () => {
    await runChain();
    const takeoff = unwrapOk(kernel.capabilities.require(QuantityTakeoffToken));

    // The provenance that makes a later change order arguable.
    expect(takeoff.quantities()[0]?.source.modelVersion).toBe("C01");
  });

  it("earns value from element-level site progress", async () => {
    const { packageId } = await runChain();
    const field = unwrapOk(kernel.capabilities.require(FieldStatusToken));
    const vendors = unwrapOk(kernel.capabilities.require(VendorScopeToken));
    const progress = unwrapOk(kernel.capabilities.require(InstallProgressToken));

    const vendor = unwrapOk(await vendors.upsertVendor({ name: "Acme" }));
    await vendors.award(packageId, vendor.id, fromMajor(1000, "GBP"));

    await field.record({
      element: { modelId: "struct", globalId: "C1" },
      state: "installed",
      packageId,
      quantityInstalled: 4,
      unit: "m3",
      observedAt: "2026-02-01T00:00:00.000Z",
      observedBy: "site",
    });

    // 4 of 10 m3 installed against a £1,000 award.
    expect(unwrapOk(await progress.earnedValue(packageId, "2026-03-01T00:00:00.000Z"))).toEqual(
      fromMajor(400, "GBP"),
    );
  });
});

describe("a model revision propagates across families", () => {
  it("orphans markup, re-resolves 4D links and changes quantities, from one event", async () => {
    const markups = unwrapOk(kernel.capabilities.require(MarkupToken));
    const anchors = unwrapOk(kernel.capabilities.require(AnchorToken));
    const schedule = unwrapOk(kernel.capabilities.require(ScheduleImportToken));
    const links = unwrapOk(kernel.capabilities.require(TaskModelLinkToken));
    const takeoff = unwrapOk(kernel.capabilities.require(QuantityTakeoffToken));
    const federation = unwrapOk(kernel.capabilities.require(FederationToken));

    // Markup anchored to a beam that the next revision deletes.
    const pin = unwrapOk(
      await markups.create({ kind: "pin", modelId: "struct", createdBy: "eng", text: "Check" }),
    );
    await anchors.anchor(pin.id, { element: { modelId: "struct", globalId: "B1" } });

    // A 4D link expressed as a rule over columns.
    await schedule.import(
      JSON.stringify({
        tasks: [{ externalId: "A100", name: "Columns L1", plannedStart: "2026-01-01", plannedFinish: "2026-01-31" }],
      }),
      "json",
    );
    const taskId = schedule.tasks()[0]!.id;
    await links.linkByRule(taskId, "struct", { ifcClass: "IfcColumn" }, "construct");
    expect(links.links(taskId)[0]?.elements).toHaveLength(2);

    await takeoff.addRule({
      name: "Columns",
      version: 1,
      filter: { ifcClass: "IfcColumn" },
      metric: "NetVolume",
      unit: "m3",
      enabled: true,
    });
    await takeoff.run();
    expect(takeoff.quantities()).toHaveLength(2);

    // Revision C02: the beam is gone and a third column appears.
    elements = [
      { globalId: "C1", ifcClass: "IfcColumn", level: "L1", volume: 4 },
      { globalId: "C2", ifcClass: "IfcColumn", level: "L1", volume: 6 },
      { globalId: "C3", ifcClass: "IfcColumn", level: "L1", volume: 5 },
    ];
    snapshots.set("C02", [...elements]);

    await federation.replaceRevision("struct", model("C02"));
    await Promise.resolve();
    await Promise.resolve();

    // One event; three families react without knowing about each other.
    expect(anchors.orphaned()).toHaveLength(1);
    expect(links.links(taskId)[0]?.elements).toHaveLength(3);

    await takeoff.run();
    expect(takeoff.quantities()).toHaveLength(3);
  });

  it("prices the revision diff against the agreed rate", async () => {
    const diffs = unwrapOk(kernel.capabilities.require(RevisionDiffToken));
    const federation = unwrapOk(kernel.capabilities.require(FederationToken));

    elements = [...elements, { globalId: "C3", ifcClass: "IfcColumn", level: "L1", volume: 5 }];
    snapshots.set("C02", [...elements]);
    await federation.replaceRevision("struct", model("C02"));

    const diff = unwrapOk(await diffs.compare("struct", "C01", "C02"));

    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.kind).toBe("added");
    // The quantity delta is what estimating turns into money.
    expect(diff.entries[0]?.quantityDelta).toEqual({ NetVolume: 5 });
  });
});

describe("coordination feeds review", () => {
  it("raises a markup issue from a clash across the plugin boundary", async () => {
    const clash = unwrapOk(kernel.capabilities.require(ClashToken));
    const issues = unwrapOk(kernel.capabilities.require(IssueToken));

    const test = unwrapOk(
      await clash.defineTest({
        name: "Columns vs beams",
        selectionA: ["struct"],
        selectionB: ["struct"],
        kind: "hard",
        tolerance: 0,
      }),
    );
    await clash.run(test.id);
    const found = clash.results(test.id)[0]!;

    const issueId = unwrapOk(await clash.promoteToIssue(found.id));

    // Coordination does not import markup; the issue was created through the command bus.
    expect(issues.get(issueId)?.title).toContain("Clash");
    expect(clash.results(test.id)[0]?.issueId).toBe(issueId);
  });
});

describe("massing feeds the same kernel", () => {
  it("produces metrics and undoes through the shared command history", async () => {
    const profiles = unwrapOk(kernel.capabilities.require(ProfileToken));
    const masses = unwrapOk(kernel.capabilities.require(MassingToken));
    const metrics = unwrapOk(kernel.capabilities.require(MetricsToken));

    const profile = unwrapOk(
      await profiles.create([
        [0, 0, 0],
        [20, 0, 0],
        [20, 10, 0],
        [0, 10, 0],
      ]),
    );
    await kernel.commands.execute("massing.create", {
      name: "Block A",
      profileId: profile.id,
      storyCount: 5,
      storyHeight: 3,
    });

    const created = masses.list()[0]!;
    expect(unwrapOk(await metrics.compute(created.id)).grossFloorArea).toBe(1000);

    await kernel.commands.undo();
    expect(masses.list()).toHaveLength(0);
  });
});

describe("persistence across the whole platform", () => {
  it("round-trips every plugin's state through one container", async () => {
    const markups = unwrapOk(kernel.capabilities.require(MarkupToken));
    await markups.create({ kind: "pin", modelId: "struct", createdBy: "eng", text: "Persisted" });

    const container = unwrapOk(
      await kernel.containers.create("massingifc.project", { containerId: "c1", name: "Tower" }),
    );
    // One snapshot holds every family's slice; nothing has to know which plugins were loaded.
    const snapshot = kernel.state.snapshot();
    await container.writeDocument("state.json", "massingifc.project", snapshot);
    await kernel.containers.save();

    const loadedDoc = unwrapOk(await container.readDocument<Record<string, unknown>>("state.json"));
    expect(Object.keys(loadedDoc?.data ?? {})).toContain("massingifc.markup/markups");

    const fresh = createKernel({ migrator: createDefaultMigrationRegistry() });
    fresh.state.restore(loadedDoc!.data as Record<string, unknown>);
    fresh.use(createMarkupPlugin({ clock, ids: createCountingIdFactory() }));
    await fresh.start();

    // The plugin activates after the restore and still finds its state waiting.
    const restored = unwrapOk(fresh.capabilities.require(MarkupToken));
    expect(restored.query()).toHaveLength(1);
    expect(restored.query()[0]?.text).toBe("Persisted");
  });
});

describe("the remaining families compose too", () => {
  it("authoring, families, twin, icdd, interop and analytics all expose their capabilities", () => {
    for (const token of [
      GeometryBackendToken,
      FamilyRepositoryAdapterToken,
      TwinRegistryToken,
      IcddToken,
      InteropToken,
      AnalyticsToken,
      ShellToken,
    ]) {
      // Ports the host supplies are absent; capabilities the plugins own are present.
      const owned = [TwinRegistryToken, IcddToken, InteropToken, AnalyticsToken, ShellToken];
      expect(kernel.capabilities.has(token)).toBe(owned.includes(token as never));
    }
  });

  it("packages a project as an ISO 21597 container", async () => {
    const icdd = unwrapOk(kernel.capabilities.require(IcddToken));
    const archive = new MemoryArchive();

    const written = await icdd.write(archive, {
      description: { id: "c1", name: "Integration Tower", conformanceIndicator: "ICDD-Part1-Container" },
      parties: [],
      documents: [
        { id: "model", kind: "internal", name: "Structure", filename: "struct.ifc", filetype: "ifc" },
      ],
      linksets: [],
    });
    expect(written.ok).toBe(true);

    await archive.write("Payload documents/struct.ifc", new TextEncoder().encode("ISO-10303-21;"));
    const validated = unwrapOk(await icdd.validate(archive));
    expect(validated.conformant).toBe(true);
  });

  it("feeds a family library and a twin object into the same kernel", async () => {
    kernel.capabilities.provide(
      FamilyRepositoryAdapterToken,
      createMemoryRepositoryAdapter([
        {
          id: "col-1",
          repositoryId: "repo-1",
          name: "Column",
          slug: "massingcloud/column",
          version: "1.0.0",
          license: "MIT",
          parameters: [],
        },
      ]),
    );
    const twins = unwrapOk(kernel.capabilities.require(TwinRegistryToken));
    const registered = await twins.register({
      id: "scan-1",
      name: "Site scan",
      kind: "point-cloud",
      transform: [],
      aligned: false,
      provenance: { source: "probe" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(registered.ok).toBe(true);
    // A twin object and a BIM-derived quantity coexist in one project without either converting.
    expect(twins.list()).toHaveLength(1);
  });

  it("collects metrics from whichever families provide them", async () => {
    kernel.capabilities.provide(MetricProviderToken, {
      definitions: [{ id: "clash.open", label: "Open clashes", unit: "count", domain: "coordination" }],
      sample: async (metricId) => ({
        ok: true,
        value: [{ metricId, at: "2026-01-01T00:00:00.000Z", value: 3 }],
      }),
    });

    const analytics = unwrapOk(kernel.capabilities.require(AnalyticsToken));
    const points = unwrapOk(await analytics.sample(["clash.open"]));
    expect(points[0]?.value).toBe(3);
  });
});
