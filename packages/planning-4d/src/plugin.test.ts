import type { ElementRef, Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ElementFilterSourceToken,
  PlannedActualToken,
  ScheduleImportToken,
  TaskModelLinkToken,
  TimelinePlaybackToken,
  type ElementFilterSource,
} from "./contracts.js";
import { createPlanningPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

let harness: TestHarness;
let modelElements: { globalId: string; ifcClass: string; level: string }[];

const filterSource = (): ElementFilterSource => ({
  match: (modelId, filter) =>
    modelElements
      .filter((entry) =>
        Object.entries(filter).every(([key, value]) =>
          key === "ifcClass" ? entry.ifcClass === value : entry[key as "level"] === value,
        ),
      )
      .map((entry): ElementRef => ({ modelId, globalId: entry.globalId })),
});

const SCHEDULE = JSON.stringify({
  dataDate: "2026-03-01T00:00:00.000Z",
  tasks: [
    { externalId: "A100", name: "Substructure", plannedStart: "2026-01-01", plannedFinish: "2026-01-31" },
    { externalId: "A200", name: "Frame L1", plannedStart: "2026-02-01", plannedFinish: "2026-02-28" },
  ],
  dependencies: [{ predecessor: "A100", successor: "A200", type: "FS" }],
});

beforeEach(async () => {
  modelElements = [
    { globalId: "F1", ifcClass: "IfcFooting", level: "L0" },
    { globalId: "C1", ifcClass: "IfcColumn", level: "L1" },
    { globalId: "C2", ifcClass: "IfcColumn", level: "L1" },
  ];
  harness = createTestHarness({ identity: { id: "planner", roles: ["planner"] } });
  await harness.load(
    createPlanningPlugin({ clock: createFixedClock(), ids: createCountingIdFactory() }),
  );
  harness.kernel.capabilities.provide(ElementFilterSourceToken, filterSource());
});

const schedule = () => unwrapOk(harness.kernel.capabilities.require(ScheduleImportToken));
const links = () => unwrapOk(harness.kernel.capabilities.require(TaskModelLinkToken));
const playback = () => unwrapOk(harness.kernel.capabilities.require(TimelinePlaybackToken));
const progress = () => unwrapOk(harness.kernel.capabilities.require(PlannedActualToken));

const taskId = (externalId: string): Id =>
  schedule().tasks().find((task) => task.externalId === externalId)!.id;

describe("schedule import", () => {
  it("imports tasks and dependencies from JSON", async () => {
    const summary = unwrapOk(await schedule().import(SCHEDULE, "json"));

    expect(summary.tasks).toBe(2);
    expect(summary.dependencies).toBe(1);
    expect(summary.dataDate).toBe("2026-03-01T00:00:00.000Z");
  });

  it("imports CSV with a flexible header", async () => {
    const csv = ["ID,Name,Start,Finish", "A100,Substructure,2026-01-01,2026-01-31"].join("\n");
    const summary = unwrapOk(await schedule().import(csv, "csv"));

    expect(summary.tasks).toBe(1);
  });

  it("rejects CSV without the columns it needs", async () => {
    expect((await schedule().import("Foo,Bar\n1,2", "csv")).ok).toBe(false);
  });

  it("warns about a task that finishes before it starts", async () => {
    const summary = unwrapOk(
      await schedule().import(
        JSON.stringify({
          tasks: [{ name: "Backwards", plannedStart: "2026-02-01", plannedFinish: "2026-01-01" }],
        }),
        "json",
      ),
    );

    expect(summary.warnings[0]).toContain("finishes before it starts");
  });

  it("refuses a format it cannot faithfully parse", async () => {
    const result = await schedule().import("...", "p6-xer");

    // A half-parser that silently drops relationships is worse than an honest refusal.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not implemented yet");
  });

  it("reports an unparseable payload rather than importing nothing quietly", async () => {
    expect((await schedule().import("{not json", "json")).ok).toBe(false);
  });

  describe("re-import", () => {
    it("preserves model links across a weekly update", async () => {
      await schedule().import(SCHEDULE, "json");
      const frame = taskId("A200");
      await links().linkByRule(frame, "m1", { ifcClass: "IfcColumn" }, "construct");

      const updated = JSON.stringify({
        tasks: [
          { externalId: "A100", name: "Substructure", plannedStart: "2026-01-01", plannedFinish: "2026-01-31" },
          { externalId: "A200", name: "Frame L1", plannedStart: "2026-02-05", plannedFinish: "2026-03-05" },
        ],
      });
      const summary = unwrapOk(await schedule().reimport(updated, "json"));

      expect(summary.updated).toBe(2);
      // Matching on the planner's own id is what saves a day of link work every week.
      expect(links().links(frame)).toHaveLength(1);
      expect(schedule().tasks().find((t) => t.externalId === "A200")?.plannedFinish).toBe("2026-03-05");
    });

    it("removes tasks dropped from the programme, and their links with them", async () => {
      await schedule().import(SCHEDULE, "json");
      await links().linkByRule(taskId("A200"), "m1", { ifcClass: "IfcColumn" }, "construct");

      const shortened = JSON.stringify({
        tasks: [{ externalId: "A100", name: "Substructure", plannedStart: "2026-01-01", plannedFinish: "2026-01-31" }],
      });
      const summary = unwrapOk(await schedule().reimport(shortened, "json"));

      expect(summary.removed).toBe(1);
      // Orphaned links would quietly inflate the next progress calculation.
      expect(links().links()).toHaveLength(0);
    });
  });
});

describe("task-model links", () => {
  beforeEach(async () => {
    await schedule().import(SCHEDULE, "json");
  });

  it("defaults to the task's output relationship", async () => {
    const link = unwrapOk(await links().link(taskId("A100"), [{ modelId: "m1", globalId: "F1" }], "construct"));

    // IfcRelAssignsToProcess is what a task consumes; transposing them still validates.
    expect(link.ifcRelationship).toBe("IfcRelAssignsToProduct");
  });

  it("resolves a rule to elements and keeps the rule", async () => {
    const link = unwrapOk(
      await links().linkByRule(taskId("A200"), "m1", { ifcClass: "IfcColumn" }, "construct"),
    );

    expect(link.elements.map((e) => e.globalId)).toEqual(["C1", "C2"]);
    expect(link.selectionRule?.filter).toEqual({ ifcClass: "IfcColumn" });
    expect(link.linkSource).toBe("rule");
  });

  it("re-resolves rule links after a model revision", async () => {
    const frame = taskId("A200");
    await links().linkByRule(frame, "m1", { ifcClass: "IfcColumn" }, "construct");

    modelElements.push({ globalId: "C3", ifcClass: "IfcColumn", level: "L1" });
    harness.kernel.events.emit("federation.model.revised", { modelId: "m1", version: "C02" });
    await Promise.resolve();

    expect(links().links(frame)[0]?.elements).toHaveLength(3);
  });

  it("leaves manual links untouched when re-resolving", async () => {
    const sub = taskId("A100");
    await links().link(sub, [{ modelId: "m1", globalId: "F1" }], "construct");

    modelElements = [];
    await links().reresolve("m1");

    expect(links().links(sub)[0]?.elements).toHaveLength(1);
  });

  it("reports rule links that now match nothing", async () => {
    await links().linkByRule(taskId("A200"), "m1", { ifcClass: "IfcColumn" }, "construct");
    modelElements = modelElements.filter((entry) => entry.ifcClass !== "IfcColumn");

    const result = unwrapOk(await links().reresolve("m1"));

    expect(result.unmatched).toHaveLength(1);
  });

  it("reports the coverage gap before a programme is issued", async () => {
    await links().linkByRule(taskId("A200"), "m1", { ifcClass: "IfcColumn" }, "construct");

    const unlinked = unwrapOk(await links().unlinkedElements("m1"));

    expect(unlinked.map((e) => e.globalId)).toEqual(["F1"]);
  });

  it("refuses to link to a task that does not exist", async () => {
    expect((await links().link("nope", [], "construct")).ok).toBe(false);
  });

  it("undoes a rule link", async () => {
    const frame = taskId("A200");
    await harness.kernel.commands.execute("planning.link.rule", {
      taskId: frame,
      modelId: "m1",
      filter: { ifcClass: "IfcColumn" },
      behaviour: "construct",
    });
    expect(links().links(frame)).toHaveLength(1);

    await harness.kernel.commands.undo();
    expect(links().links(frame)).toHaveLength(0);
  });
});

describe("timeline playback", () => {
  beforeEach(async () => {
    await schedule().import(SCHEDULE, "json");
    await links().link(taskId("A100"), [{ modelId: "m1", globalId: "F1" }], "construct");
    await links().linkByRule(taskId("A200"), "m1", { ifcClass: "IfcColumn" }, "construct");
    await playback().configure({
      name: "Build",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      stepUnit: "week",
      showPlanned: true,
      showActual: false,
    });
  });

  it("shows nothing before the first task starts", async () => {
    const state = unwrapOk(await playback().stateAt("2025-12-01T00:00:00.000Z"));
    expect(state.construct).toHaveLength(0);
  });

  it("accumulates constructed elements as the timeline advances", async () => {
    const midway = unwrapOk(await playback().stateAt("2026-02-10T00:00:00.000Z"));
    expect(midway.construct.map((e) => e.globalId)).toEqual(["F1", "C1", "C2"]);
  });

  it("drops temporary works after their task finishes", async () => {
    const crane = unwrapOk(
      await schedule().import(
        JSON.stringify({
          tasks: [{ externalId: "T1", name: "Crane", plannedStart: "2026-01-01", plannedFinish: "2026-01-15" }],
        }),
        "json",
      ),
    );
    void crane;
    await links().link(taskId("T1"), [{ modelId: "m1", globalId: "CRANE" }], "temporary");
    await playback().configure({
      name: "Build",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-03-31T00:00:00.000Z",
      stepUnit: "week",
      showPlanned: true,
      showActual: false,
    });

    const during = unwrapOk(await playback().stateAt("2026-01-10T00:00:00.000Z"));
    const after = unwrapOk(await playback().stateAt("2026-02-01T00:00:00.000Z"));

    expect(during.temporary).toHaveLength(1);
    expect(after.temporary).toHaveLength(0);
  });

  it("refuses to seek outside the configured window", async () => {
    expect((await playback().seek("2030-01-01T00:00:00.000Z")).ok).toBe(false);
    expect((await playback().seek("2026-02-01T00:00:00.000Z")).ok).toBe(true);
  });

  it("refuses to seek before it has been configured", async () => {
    const bare = createTestHarness();
    await bare.load(createPlanningPlugin({ ids: createCountingIdFactory() }));
    const service = unwrapOk(bare.kernel.capabilities.require(TimelinePlaybackToken));

    expect((await service.seek("2026-01-01T00:00:00.000Z")).ok).toBe(false);
    await bare.dispose();
  });

  it("prefers actual dates over planned when they exist", async () => {
    await schedule().import(
      JSON.stringify({
        tasks: [
          {
            externalId: "E1",
            name: "Early",
            plannedStart: "2026-03-01",
            plannedFinish: "2026-03-31",
            actualStart: "2026-01-05",
            actualFinish: "2026-01-20",
          },
        ],
      }),
      "json",
    );
    await links().link(taskId("E1"), [{ modelId: "m1", globalId: "X" }], "construct");

    const state = unwrapOk(await playback().stateAt("2026-01-10T00:00:00.000Z"));
    expect(state.construct.map((e) => e.globalId)).toContain("X");
  });
});

describe("planned versus actual", () => {
  beforeEach(async () => {
    await schedule().import(
      JSON.stringify({
        tasks: [
          {
            externalId: "A",
            name: "On track",
            plannedStart: "2026-01-01",
            plannedFinish: "2026-01-11",
            percentComplete: 0.5,
          },
          {
            externalId: "B",
            name: "Behind",
            plannedStart: "2026-01-01",
            plannedFinish: "2026-01-11",
            percentComplete: 0.1,
          },
        ],
      }),
      "json",
    );
  });

  it("computes planned progress from elapsed time", async () => {
    const results = unwrapOk(await progress().compare("2026-01-06T00:00:00.000Z"));
    const onTrack = results.find((record) => record.taskId === taskId("A"));

    expect(onTrack?.plannedPercent).toBeCloseTo(0.5, 2);
    expect(onTrack?.scheduleVarianceDays).toBeCloseTo(0, 1);
  });

  it("reports negative variance for a task behind programme", async () => {
    const results = unwrapOk(await progress().compare("2026-01-06T00:00:00.000Z"));
    const behind = results.find((record) => record.taskId === taskId("B"));

    expect(behind?.scheduleVarianceDays ?? 0).toBeLessThan(0);
  });

  it("lists tasks behind programme worst first", async () => {
    const behind = unwrapOk(await progress().behindSchedule("2026-01-06T00:00:00.000Z"));

    expect(behind[0]?.taskId).toBe(taskId("B"));
  });

  it("treats a finished task as complete regardless of percent", async () => {
    await schedule().import(
      JSON.stringify({
        tasks: [
          {
            externalId: "C",
            name: "Done",
            plannedStart: "2026-01-01",
            plannedFinish: "2026-01-11",
            actualFinish: "2026-01-08",
            percentComplete: 0.4,
          },
        ],
      }),
      "json",
    );

    const results = unwrapOk(await progress().compare("2026-01-09T00:00:00.000Z"));
    expect(results[0]?.actualPercent).toBe(1);
  });
});
