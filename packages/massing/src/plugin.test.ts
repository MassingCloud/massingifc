import type { MassingMetrics, MassingObjectRecord, Vec3 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MassingToken,
  MassPromotionHandlerToken,
  MASSING_COMMANDS,
  MetricsToken,
  OptionToken,
  ProfileToken,
  StoryToken,
} from "./contracts.js";
import { createMassingPlugin } from "./plugin.js";

/** 20 x 10 rectangle. */
const RECT: Vec3[] = [
  [0, 0, 0],
  [20, 0, 0],
  [20, 10, 0],
  [0, 10, 0],
];

let harness: TestHarness;

const setup = async (): Promise<void> => {
  harness = createTestHarness();
  await harness.load(
    createMassingPlugin({ clock: createFixedClock(), ids: createCountingIdFactory() }),
  );
};

const profiles = () => harness.kernel.capabilities.require(ProfileToken);
const masses = () => harness.kernel.capabilities.require(MassingToken);
const stories = () => harness.kernel.capabilities.require(StoryToken);
const metrics = () => harness.kernel.capabilities.require(MetricsToken);
const options = () => harness.kernel.capabilities.require(OptionToken);

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

/** Sketch a footprint and raise a mass on it. */
const makeMass = async (
  storyCount = 3,
  overrides: Record<string, unknown> = {},
): Promise<MassingObjectRecord> => {
  const profileId = unwrapOk(
    await harness.kernel.commands.execute<string>(MASSING_COMMANDS.sketchProfile, { points: RECT }),
  );
  return unwrapOk(
    await harness.kernel.commands.execute<MassingObjectRecord>(MASSING_COMMANDS.createMass, {
      name: "Tower",
      profileId,
      storyCount,
      storyHeight: 3,
      ...overrides,
    }),
  );
};

beforeEach(setup);

describe("massing plugin activation", () => {
  it("provides every massing capability", () => {
    for (const token of [ProfileToken, MassingToken, StoryToken, MetricsToken, OptionToken]) {
      expect(harness.kernel.capabilities.has(token)).toBe(true);
    }
  });

  it("contributes panel, toolbar and inspector surfaces", () => {
    expect(harness.kernel.ui.byPoint("panel").map((c) => c.id)).toContain("massing.panel");
    expect(harness.kernel.ui.byPoint("toolbar").map((c) => c.commandId)).toContain(
      MASSING_COMMANDS.sketchProfile,
    );
  });

  it("releases everything on deactivate", async () => {
    await harness.kernel.plugins.deactivate("massingifc.massing");

    expect(harness.kernel.capabilities.has(MassingToken)).toBe(false);
    expect(harness.kernel.commands.has(MASSING_COMMANDS.createMass)).toBe(false);
    expect(harness.kernel.state.hasSlice("massingifc.massing/objects")).toBe(false);
  });
});

describe("sketch profiles", () => {
  it("creates a profile from a sketched outline", async () => {
    const service = unwrapOk(profiles());
    const created = await service.create(RECT, { name: "Footprint" });

    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.closed).toBe(true);
  });

  it("refuses a self-intersecting outline", async () => {
    const service = unwrapOk(profiles());
    const bowtie: Vec3[] = [
      [0, 0, 0],
      [10, 10, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];

    const created = await service.create(bowtie);

    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain("crosses itself");
  });

  it("refuses an opening that escapes the footprint", async () => {
    const service = unwrapOk(profiles());
    const profile = unwrapOk(await service.create(RECT));

    const added = await service.addHole(profile.id, [
      [30, 3, 0],
      [34, 3, 0],
      [34, 7, 0],
      [30, 7, 0],
    ]);

    expect(added.ok).toBe(false);
  });
});

describe("story-aware massing", () => {
  it("creates a mass with uniform stories", async () => {
    const mass = await makeMass(3);

    expect(mass.storyCount).toBe(3);
    expect(mass.storyHeights).toEqual([3, 3, 3]);
    expect(mass.totalHeight).toBe(9);
  });

  it("generates a story record per floor with cumulative elevations", async () => {
    const mass = await makeMass(3);
    const list = unwrapOk(stories()).stories(mass.id);

    expect(list.map((s) => s.elevation)).toEqual([0, 3, 6]);
  });

  it("adds floors without losing the extras on existing floors", async () => {
    const mass = await makeMass(2);
    const service = unwrapOk(stories());
    await service.editStories(mass.id, (story) => story.index === 0, { programme: "Retail" });

    await service.setStoryCount(mass.id, 5);

    const list = service.stories(mass.id);
    expect(list).toHaveLength(5);
    // Reconciling rather than rebuilding is what preserves this.
    expect(list[0]?.programme).toBe("Retail");
  });

  it("supports a taller ground floor", async () => {
    const mass = await makeMass(3);
    const service = unwrapOk(stories());

    await service.setStoryHeight(mass.id, 0, 6);

    const list = service.stories(mass.id);
    expect(list.map((s) => s.height)).toEqual([6, 3, 3]);
    expect(list.map((s) => s.elevation)).toEqual([0, 6, 9]);
    expect(unwrapOk(masses()).get(mass.id)?.totalHeight).toBe(12);
  });

  it("bulk-edits a range of stories", async () => {
    const mass = await makeMass(10);
    const service = unwrapOk(stories());

    await service.editStories(mass.id, (story) => story.index >= 5, { programme: "Residential" });

    const list = service.stories(mass.id);
    expect(list.filter((s) => s.programme === "Residential")).toHaveLength(5);
    expect(list[4]?.programme).toBeUndefined();
  });

  it("re-elevates every story above a bulk height change", async () => {
    const mass = await makeMass(4);
    const service = unwrapOk(stories());

    await service.editStories(mass.id, (story) => story.index < 2, { height: 5 });

    const list = service.stories(mass.id);
    expect(list.map((s) => s.height)).toEqual([5, 5, 3, 3]);
    expect(list.map((s) => s.elevation)).toEqual([0, 5, 10, 13]);
  });

  it("inserts and removes a story", async () => {
    const mass = await makeMass(3);
    const service = unwrapOk(stories());

    await service.insertStory(mass.id, 1, 4);
    expect(unwrapOk(masses()).get(mass.id)?.storyHeights).toEqual([3, 4, 3, 3]);

    await service.removeStory(mass.id, 0);
    expect(unwrapOk(masses()).get(mass.id)?.storyHeights).toEqual([4, 3, 3]);
  });

  it("rejects a negative story count", async () => {
    const mass = await makeMass(2);
    const result = await unwrapOk(stories()).setStoryCount(mass.id, -1);

    expect(result.ok).toBe(false);
  });
});

describe("metrics", () => {
  it("computes area, GFA and volume", async () => {
    const mass = await makeMass(3);
    const result = unwrapOk(await unwrapOk(metrics()).compute(mass.id));

    expect(result.footprintArea).toBe(200);
    expect(result.grossFloorArea).toBe(600);
    expect(result.volume).toBe(1800);
    expect(result.height).toBe(9);
  });

  it("caches derived quantities onto the record", async () => {
    const mass = await makeMass(2);
    await unwrapOk(metrics()).compute(mass.id);

    const stored = unwrapOk(masses()).get(mass.id);
    expect(stored?.grossFloorArea).toBe(400);
  });

  it("excludes a plant level from GFA but keeps its volume", async () => {
    const mass = await makeMass(3);
    await unwrapOk(stories()).editStories(mass.id, (s) => s.index === 2, {
      excludedFromGfa: true,
    });

    const result = unwrapOk(await unwrapOk(metrics()).compute(mass.id));

    expect(result.grossFloorArea).toBe(400);
    expect(result.volume).toBe(1800);
  });

  it("recomputes automatically after a story change", async () => {
    const mass = await makeMass(2);
    await harness.kernel.commands.execute(MASSING_COMMANDS.setStoryCount, { id: mass.id, count: 4 });

    // The command path refreshes metrics, so the cached value must not be the pre-edit one.
    expect(unwrapOk(masses()).get(mass.id)?.grossFloorArea).toBe(800);
  });

  it("emits a metrics event", async () => {
    const seen: MassingMetrics[] = [];
    harness.kernel.events.on("massing.metrics.computed", (payload) => {
      seen.push((payload as { metrics: MassingMetrics }).metrics);
    });

    const mass = await makeMass(1);
    await unwrapOk(metrics()).compute(mass.id);

    expect(seen.at(-1)?.massingObjectId).toBe(mass.id);
  });

  it("reports a missing mass rather than throwing", async () => {
    const result = await unwrapOk(metrics()).compute("nope");
    expect(result.ok).toBe(false);
  });
});

describe("option studies", () => {
  it("compares two options", async () => {
    const tall = await makeMass(10);
    const squat = await makeMass(3);

    const optionService = unwrapOk(options());
    const optionA = unwrapOk(await optionService.create("Tall", [tall.id]));
    const optionB = unwrapOk(await optionService.create("Squat", [squat.id]));

    const compared = unwrapOk(await optionService.compare([optionA.id, optionB.id]));

    expect(compared).toHaveLength(2);
    expect(compared[0]?.grossFloorArea).toBe(2000);
    expect(compared[1]?.grossFloorArea).toBe(600);
  });

  it("summarises an option against planning limits", async () => {
    const mass = await makeMass(10);
    const optionService = unwrapOk(options());
    const option = unwrapOk(await optionService.create("Scheme A", [mass.id]));

    const summary = unwrapOk(await unwrapOk(metrics()).summarise(option.id));

    expect(summary.grossFloorArea).toBe(2000);
    // No site boundary is set, so compliance is unknown rather than assumed to pass.
    expect(summary.withinLimits).toBeUndefined();
  });

  it("duplicates a mass into another option, carrying story extras", async () => {
    const mass = await makeMass(4);
    await unwrapOk(stories()).editStories(mass.id, (s) => s.index === 0, { programme: "Lobby" });

    const copy = unwrapOk(await unwrapOk(masses()).duplicate(mass.id, { name: "Variant" }));

    expect(copy.id).not.toBe(mass.id);
    expect(unwrapOk(stories()).stories(copy.id)[0]?.programme).toBe("Lobby");
  });

  it("applies a distinguishable palette across an option", async () => {
    const a = await makeMass(2);
    const b = await makeMass(2);
    const optionService = unwrapOk(options());
    const option = unwrapOk(await optionService.create("Compare", [a.id, b.id]));

    const appearance = harness.kernel.capabilities.require(
      (await import("./contracts.js")).AppearanceToken,
    );
    await unwrapOk(appearance).applyOptionStyling(option.id);

    const colours = [a, b].map((mass) => unwrapOk(masses()).get(mass.id)?.color);
    expect(new Set(colours).size).toBe(2);
  });
});

describe("undo through the kernel command bus", () => {
  it("undoes a mass creation", async () => {
    const mass = await makeMass(3);
    expect(unwrapOk(masses()).list()).toHaveLength(1);

    await harness.kernel.commands.undo();

    expect(unwrapOk(masses()).list()).toHaveLength(0);
  });

  it("redoes it again", async () => {
    await makeMass(3);
    await harness.kernel.commands.undo();
    await harness.kernel.commands.redo();

    expect(unwrapOk(masses()).list()).toHaveLength(1);
  });

  it("restores story heights, not merely the count", async () => {
    const mass = await makeMass(3);
    await harness.kernel.commands.execute("massing.stories.set-heights", {
      id: mass.id,
      heights: [6, 3, 3],
    });
    expect(unwrapOk(masses()).get(mass.id)?.totalHeight).toBe(12);

    await harness.kernel.commands.execute(MASSING_COMMANDS.setStoryCount, { id: mass.id, count: 5 });
    await harness.kernel.commands.undo();

    // Replaying "set count 3" with a uniform height would silently flatten the tall ground floor.
    expect(unwrapOk(masses()).get(mass.id)?.storyHeights).toEqual([6, 3, 3]);
  });

  it("undoes a colour change back to the previous colour", async () => {
    const mass = await makeMass(2, { color: "#111111" });
    await harness.kernel.commands.execute(MASSING_COMMANDS.setColor, {
      id: mass.id,
      color: "#ff0000",
    });
    expect(unwrapOk(masses()).get(mass.id)?.color).toBe("#ff0000");

    await harness.kernel.commands.undo();

    expect(unwrapOk(masses()).get(mass.id)?.color).toBe("#111111");
  });

  it("does not record an inverse when there was no previous colour", async () => {
    const mass = await makeMass(2);
    const before = harness.kernel.commands.historySize.undo;

    await harness.kernel.commands.execute(MASSING_COMMANDS.setColor, {
      id: mass.id,
      color: "#00ff00",
    });

    // Inventing a "previous" colour would undo to something the user never chose.
    expect(harness.kernel.commands.historySize.undo).toBe(before);
  });

  it("restores per-story extras when undoing a bulk edit", async () => {
    const mass = await makeMass(4);
    await harness.kernel.commands.execute(MASSING_COMMANDS.editStories, {
      id: mass.id,
      changes: { programme: "Office" },
    });
    expect(unwrapOk(stories()).stories(mass.id)[0]?.programme).toBe("Office");

    await harness.kernel.commands.undo();

    expect(unwrapOk(stories()).stories(mass.id)[0]?.programme).toBeUndefined();
  });
});

describe("permissions", () => {
  it("blocks editing for an identity without the role", async () => {
    const restricted = createTestHarness({
      identity: { id: "viewer", roles: ["viewer"] },
      permissionEvaluator: { evaluate: (identity) => identity.roles.includes("author") },
    });
    await restricted.load(createMassingPlugin({ ids: createCountingIdFactory() }));

    const result = await restricted.kernel.commands.execute(MASSING_COMMANDS.sketchProfile, {
      points: RECT,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
    await restricted.dispose();
  });
});

describe("promotion", () => {
  it("reports honestly when no handler is installed", async () => {
    const mass = await makeMass(3);
    const result = await harness.kernel.commands.execute(MASSING_COMMANDS.promote, {
      id: mass.id,
      target: "family",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("delegates to a registered handler", async () => {
    // Massing must not import family-libraries, so promotion goes through a capability.
    harness.kernel.capabilities.provide(MassPromotionHandlerToken, {
      target: "family",
      promote: async (mass) => ({ ok: true, value: { targetId: `family-of-${mass.id}` } }),
    });

    const mass = await makeMass(3);
    const result = await harness.kernel.commands.execute<{ targetId: string }>(
      MASSING_COMMANDS.promote,
      { id: mass.id, target: "family" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.targetId).toBe(`family-of-${mass.id}`);
  });
});

describe("levels", () => {
  it("derives a level per story plus a roof", async () => {
    const mass = await makeMass(3);
    const contextService = harness.kernel.capabilities.require(
      (await import("./contracts.js")).ContextToken,
    );

    const levels = unwrapOk(await unwrapOk(contextService).deriveLevels(mass.id));

    expect(levels.map((l) => l.elevation)).toEqual([0, 3, 6, 9]);
    expect(levels.at(-1)?.name).toBe("Roof");
  });
});
