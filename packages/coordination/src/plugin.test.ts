import type { ElementRef, Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ClashEngineToken,
  ClashToken,
  ModelSnapshotToken,
  ResponsibilityMatrixToken,
  RevisionDiffToken,
  IssueRoutingToken,
  ValidationRuleToken,
  ValidationToken,
  type ClashEngine,
  type ModelSnapshotSource,
  type RawClash,
  type SnapshotElement,
} from "./contracts.js";
import { createCoordinationPlugin } from "./plugin.js";
import { clashSignature, diffSnapshots, type IssueLike } from "./services.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const ref = (globalId: string, modelId = "arch"): ElementRef => ({ modelId, globalId });

let harness: TestHarness;
let clashes: RawClash[];
let issues: IssueLike[];

const engine = (): ClashEngine => ({ intersect: () => clashes });

beforeEach(async () => {
  clashes = [
    { a: ref("BEAM-1", "struct"), b: ref("DUCT-1", "mep"), distance: 0.12 },
    { a: ref("BEAM-2", "struct"), b: ref("DUCT-2", "mep"), distance: 0.05 },
  ];
  issues = [];
  harness = createTestHarness({ identity: { id: "coord", roles: ["coordinator"] } });
  await harness.load(
    createCoordinationPlugin({
      clock: createFixedClock(),
      ids: createCountingIdFactory(),
      elementsOf: (modelId) => [ref("E1", modelId)],
      issues: () => issues,
    }),
  );
  harness.kernel.capabilities.provide(ClashEngineToken, engine());
});

const clash = () => unwrapOk(harness.kernel.capabilities.require(ClashToken));
const validation = () => unwrapOk(harness.kernel.capabilities.require(ValidationToken));
const diffs = () => unwrapOk(harness.kernel.capabilities.require(RevisionDiffToken));
const routing = () => unwrapOk(harness.kernel.capabilities.require(IssueRoutingToken));

const makeTest = async (): Promise<Id> =>
  (
    unwrapOk(
      await clash().defineTest({
        name: "Structure vs MEP",
        selectionA: ["struct"],
        selectionB: ["mep"],
        kind: "hard",
        tolerance: 0,
      }),
    )
  ).id;

describe("clash signatures", () => {
  it("are stable for the same pair", () => {
    const first = clashSignature("t1", ref("A"), ref("B"));
    const second = clashSignature("t1", ref("A"), ref("B"));
    expect(first).toBe(second);
  });

  it("are order-independent", () => {
    // Swapping the two selections in a test must not present every triaged clash as new.
    expect(clashSignature("t1", ref("A"), ref("B"))).toBe(clashSignature("t1", ref("B"), ref("A")));
  });

  it("differ per test and per pair", () => {
    expect(clashSignature("t1", ref("A"), ref("B"))).not.toBe(clashSignature("t2", ref("A"), ref("B")));
    expect(clashSignature("t1", ref("A"), ref("B"))).not.toBe(clashSignature("t1", ref("A"), ref("C")));
  });
});

describe("clash detection", () => {
  it("records new clashes on a first run", async () => {
    const testId = await makeTest();
    const summary = unwrapOk(await clash().run(testId));

    expect(summary.total).toBe(2);
    expect(summary.created).toBe(2);
    expect(clash().results(testId).every((record) => record.status === "new")).toBe(true);
  });

  it("preserves triage state across a re-run", async () => {
    const testId = await makeTest();
    await clash().run(testId);
    const first = clash().results(testId)[0]!;
    await clash().setStatus(first.id, "approved");

    const summary = unwrapOk(await clash().run(testId));

    // The whole value of a weekly cycle: last week's decisions survive this week's run.
    expect(summary.created).toBe(0);
    expect(summary.persisted).toBe(2);
    expect(clash().results(testId).find((r) => r.id === first.id)?.status).toBe("approved");
  });

  it("resolves rather than deletes a clash that no longer occurs", async () => {
    const testId = await makeTest();
    await clash().run(testId);
    clashes = clashes.slice(0, 1);

    const summary = unwrapOk(await clash().run(testId));

    expect(summary.resolved).toBe(1);
    // The record that a clash existed and was fixed is the useful part of the history.
    expect(clash().results(testId)).toHaveLength(2);
    expect(clash().results(testId, { status: "resolved" })).toHaveLength(1);
  });

  it("reopens a resolved clash that comes back", async () => {
    const testId = await makeTest();
    await clash().run(testId);
    const removed = clashes.pop()!;
    await clash().run(testId);
    clashes.push(removed);

    await clash().run(testId);

    expect(clash().results(testId, { status: "resolved" })).toHaveLength(0);
  });

  it("does not downgrade an ignored clash back to active", async () => {
    const testId = await makeTest();
    await clash().run(testId);
    const target = clash().results(testId)[0]!;
    await clash().setStatus(target.id, "ignored");

    await clash().run(testId);

    expect(clash().results(testId).find((r) => r.id === target.id)?.status).toBe("ignored");
  });

  it("reports honestly when no clash engine is installed", async () => {
    const bare = createTestHarness();
    await bare.load(createCoordinationPlugin({ ids: createCountingIdFactory() }));
    const service = unwrapOk(bare.kernel.capabilities.require(ClashToken));
    const testId = (
      unwrapOk(
        await service.defineTest({
          name: "T",
          selectionA: [],
          selectionB: [],
          kind: "hard",
          tolerance: 0,
        }),
      )
    ).id;

    const result = await service.run(testId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    await bare.dispose();
  });

  it("raises an issue through the command bus rather than importing markup", async () => {
    // Coordination must not depend on the markup package; identity stays with whoever owns issues.
    harness.kernel.commands.register<{ title: string }, { id: Id }>({
      id: "markup.issue.create",
      handler: ({ title }) => ({ id: `issue-for-${title.slice(0, 5)}` }),
    });
    const testId = await makeTest();
    await clash().run(testId);
    const target = clash().results(testId)[0]!;

    const issueId = unwrapOk(await clash().promoteToIssue(target.id));

    expect(issueId).toContain("issue-for-");
    expect(clash().results(testId).find((r) => r.id === target.id)?.status).toBe("active");
  });

  it("does not raise a second issue for the same clash", async () => {
    let calls = 0;
    harness.kernel.commands.register<unknown, { id: Id }>({
      id: "markup.issue.create",
      handler: () => ({ id: `issue-${++calls}` }),
    });
    const testId = await makeTest();
    await clash().run(testId);
    const target = clash().results(testId)[0]!;

    await clash().promoteToIssue(target.id);
    await clash().promoteToIssue(target.id);

    expect(calls).toBe(1);
  });
});

describe("validation", () => {
  const rule = (id: string, severity: "error" | "warning", findings: number) => ({
    definition: { id, name: `Rule ${id}`, severity, enabled: true },
    check: async () => ({
      ok: true as const,
      value: Array.from({ length: findings }, () => ({
        severity,
        message: `${id} finding`,
        checkedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  });

  it("aggregates findings from every registered rule", async () => {
    harness.kernel.capabilities.provide(ValidationRuleToken, rule("R1", "error", 2));
    harness.kernel.capabilities.provide(ValidationRuleToken, rule("R2", "warning", 1));

    const summary = unwrapOk(await validation().run());

    expect(summary.errors).toBe(2);
    expect(summary.warnings).toBe(1);
  });

  it("skips a disabled rule", async () => {
    harness.kernel.capabilities.provide(ValidationRuleToken, rule("R1", "error", 2));
    validation().rules();
    validation().setEnabled("R1", false);

    expect(unwrapOk(await validation().run()).errors).toBe(0);
  });

  it("keeps running when one rule fails, and reports the failure", async () => {
    harness.kernel.capabilities.provide(ValidationRuleToken, {
      definition: { id: "BAD", name: "Broken", severity: "error", enabled: true },
      check: async () => ({
        ok: false as const,
        error: new Error("rule exploded") as never,
      }),
    });
    harness.kernel.capabilities.provide(ValidationRuleToken, rule("GOOD", "warning", 1));

    const summary = unwrapOk(await validation().run());

    // A pass that aborts on the first bad rule tells you nothing about the model.
    expect(summary.warnings).toBe(1);
    expect(summary.results.some((r) => r.message.includes("failed to run"))).toBe(true);
  });

  it("replaces results rather than accumulating them", async () => {
    harness.kernel.capabilities.provide(ValidationRuleToken, rule("R1", "error", 2));
    await validation().run();
    await validation().run();

    expect(validation().results()).toHaveLength(2);
  });
});

describe("revision diff", () => {
  const element = (
    globalId: string,
    overrides: Partial<SnapshotElement> = {},
  ): SnapshotElement => ({
    element: ref(globalId),
    properties: { FireRating: "60" },
    quantities: { NetVolume: 10 },
    placementHash: "p1",
    ...overrides,
  });

  describe("diffSnapshots", () => {
    it("detects additions and removals with quantity deltas", () => {
      const entries = diffSnapshots([element("A")], [element("B")]);

      expect(entries.find((e) => e.element.globalId === "B")?.kind).toBe("added");
      expect(entries.find((e) => e.element.globalId === "A")?.kind).toBe("removed");
      expect(entries.find((e) => e.element.globalId === "A")?.quantityDelta).toEqual({
        NetVolume: -10,
      });
    });

    it("detects a property change", () => {
      const entries = diffSnapshots(
        [element("A")],
        [element("A", { properties: { FireRating: "120" } })],
      );

      expect(entries[0]?.kind).toBe("modified");
      expect(entries[0]?.changedProperties).toEqual(["FireRating"]);
    });

    it("reports a move as a move even when properties also changed", () => {
      const entries = diffSnapshots(
        [element("A")],
        [element("A", { placementHash: "p2", properties: { FireRating: "120" } })],
      );

      // "It moved" is the fact a reviewer acts on; burying it under "modified" loses it.
      expect(entries[0]?.kind).toBe("moved");
      expect(entries[0]?.changedProperties).toEqual(["FireRating"]);
    });

    it("computes quantity deltas for the 5D hand-off", () => {
      const entries = diffSnapshots(
        [element("A")],
        [element("A", { quantities: { NetVolume: 15 } })],
      );

      expect(entries[0]?.quantityDelta).toEqual({ NetVolume: 5 });
    });

    it("reports nothing for an unchanged element", () => {
      expect(diffSnapshots([element("A")], [element("A")])).toHaveLength(0);
    });
  });

  it("compares two revisions through the service", async () => {
    const snapshots: ModelSnapshotSource = {
      modelIds: () => ["arch"],
      snapshot: (_modelId, version) =>
        version === "C01" ? [element("A"), element("B")] : [element("A")],
    };
    harness.kernel.capabilities.provide(ModelSnapshotToken, snapshots);

    const diff = unwrapOk(await diffs().compare("arch", "C01", "C02"));

    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.kind).toBe("removed");
  });

  it("reports a missing snapshot rather than diffing against nothing", async () => {
    harness.kernel.capabilities.provide(ModelSnapshotToken, {
      modelIds: () => ["arch"],
      snapshot: () => undefined,
    });

    expect((await diffs().compare("arch", "C01", "C02")).ok).toBe(false);
  });
});

describe("issue routing", () => {
  beforeEach(() => {
    harness.kernel.commands.register<{ id: Id; responsibility?: string }, void>({
      id: "markup.issue.update",
      handler: ({ id, responsibility }) => {
        const issue = issues.find((candidate) => candidate.id === id);
        if (issue) {
          issues = issues.map((candidate) =>
            candidate.id === id ? { ...candidate, ...(responsibility ? { responsibility } : {}) } : candidate,
          );
        }
      },
    });
  });

  it("routes by the highest-priority matching rule", async () => {
    await routing().addRule({ name: "Any", match: {}, responsibility: "General", priority: 0 });
    await routing().addRule({
      name: "MEP",
      match: { titleContains: "duct" },
      responsibility: "MEP",
      priority: 10,
    });
    issues = [{ id: "i1", title: "Beam clashes with duct" }];

    const result = unwrapOk(await routing().route());

    // Outcome must not depend on the order rules happened to be added.
    expect(result.routed).toEqual(["i1"]);
    expect(issues[0]?.responsibility).toBe("MEP");
  });

  it("reports issues no rule matched", async () => {
    await routing().addRule({ name: "MEP", match: { titleContains: "duct" }, responsibility: "MEP" });
    issues = [{ id: "i1", title: "Something else" }];

    expect(unwrapOk(await routing().route()).unmatched).toEqual(["i1"]);
  });

  it("leaves an already-routed issue alone", async () => {
    await routing().addRule({ name: "Any", match: {}, responsibility: "General" });
    issues = [{ id: "i1", title: "Already sorted", responsibility: "Structures" }];

    const result = unwrapOk(await routing().route());

    expect(result.routed).toHaveLength(0);
    expect(issues[0]?.responsibility).toBe("Structures");
  });
});

describe("responsibility matrix", () => {
  it("upserts and looks up by scope", async () => {
    const service = unwrapOk(harness.kernel.capabilities.require(ResponsibilityMatrixToken));
    await service.upsert({ scope: "Level 3 MEP", discipline: "MEP", organisation: "Acme" });

    expect(service.responsibleFor("Level 3 MEP")?.organisation).toBe("Acme");
    expect(service.responsibleFor("nothing")).toBeUndefined();
  });
});
