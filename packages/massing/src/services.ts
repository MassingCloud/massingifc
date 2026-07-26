import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  GridLineRecord,
  Id,
  LevelRecord,
  MassingMetrics,
  MassingObjectRecord,
  MassingStoryRecord,
  OptionSetRecord,
  ProfileRecord,
  SiteBoundaryRecord,
  Vec3,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import {
  computeMassMetrics,
  floorAreaRatio,
  netArea,
  polygonArea,
  resolveStoryHeights,
  toXY,
  validateProfile,
  type Point2,
} from "./geometry.js";
import type {
  AppearanceService,
  ContextService,
  CreateMassingInput,
  MassingService,
  MassPromotionHandler,
  MetricsService,
  OptionService,
  ProfileService,
  PromotionService,
  StoryService,
} from "./contracts.js";

/** Default storey height when a caller supplies none. Ordinary commercial floor-to-floor. */
export const DEFAULT_STORY_HEIGHT = 3.5;

export interface MassingStores {
  readonly profiles: RecordStore<ProfileRecord>;
  readonly masses: RecordStore<MassingObjectRecord>;
  readonly stories: RecordStore<MassingStoryRecord>;
  readonly options: RecordStore<OptionSetRecord>;
  readonly levels: RecordStore<LevelRecord>;
  readonly grids: RecordStore<GridLineRecord>;
  readonly site: RecordStore<SiteBoundaryRecord>;
}

export interface MassingRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
}

export function createMassingStores(context: PluginContext): MassingStores {
  return {
    profiles: createRecordStore<ProfileRecord>(context.state, "profiles"),
    masses: createRecordStore<MassingObjectRecord>(context.state, "objects"),
    stories: createRecordStore<MassingStoryRecord>(context.state, "stories"),
    options: createRecordStore<OptionSetRecord>(context.state, "options"),
    levels: createRecordStore<LevelRecord>(context.state, "levels"),
    grids: createRecordStore<GridLineRecord>(context.state, "grids"),
    site: createRecordStore<SiteBoundaryRecord>(context.state, "site"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

// --------------------------------------------------------------------------------------------
// Profiles
// --------------------------------------------------------------------------------------------

export function createProfileService(
  runtime: MassingRuntime,
  stores: MassingStores,
): ProfileService {
  const validate = (points: readonly Vec3[], holes: readonly (readonly Vec3[])[] = []): Result<void> => {
    const issues = validateProfile(toXY(points), holes.map(toXY));
    if (issues.length === 0) return ok(undefined);
    return err(
      new KernelError("COMMAND_FAILED", issues.map((issue) => issue.message).join(" "), {
        issues: issues.map((issue) => issue.code),
      }),
    );
  };

  return {
    async create(points, options) {
      const validated = validate(points);
      if (!validated.ok) return err(validated.error);

      const record: ProfileRecord = {
        id: runtime.ids.next("profile"),
        points: [...points],
        closed: true,
        ...(options?.name === undefined ? {} : { name: options.name }),
        ...(options?.baseElevation === undefined ? {} : { baseElevation: options.baseElevation }),
      };
      stores.profiles.add(record);
      runtime.context.events.emit("massing.profile.created", { record });
      return ok(record);
    },

    async update(profileId, points) {
      const existing = stores.profiles.get(profileId);
      if (!existing) return err(notFound("profile", profileId));

      const validated = validate(points, existing.holes ?? []);
      if (!validated.ok) return err(validated.error);

      const updated = stores.profiles.update(profileId, { points: [...points] });
      if (!updated) return err(notFound("profile", profileId));
      // Several masses may share one profile; every one of their metrics is now stale.
      runtime.context.events.emit("massing.profile.updated", { record: updated });
      return ok(updated);
    },

    async addHole(profileId, points) {
      const existing = stores.profiles.get(profileId);
      if (!existing) return err(notFound("profile", profileId));

      const holes = [...(existing.holes ?? []), [...points]];
      const validated = validate(existing.points, holes);
      if (!validated.ok) return err(validated.error);

      const updated = stores.profiles.update(profileId, { holes });
      if (!updated) return err(notFound("profile", profileId));
      runtime.context.events.emit("massing.profile.updated", { record: updated });
      return ok(updated);
    },

    validate: (points) => validate(points),
    get: (profileId) => stores.profiles.get(profileId),
    list: () => stores.profiles.all(),
  };
}

// --------------------------------------------------------------------------------------------
// Stories
// --------------------------------------------------------------------------------------------

/**
 * Brings the story records in line with a mass's `storyCount` and `storyHeights`.
 *
 * Story records exist only to carry the per-story extras the flat `MassingObjectRecord` cannot —
 * programme, GFA exclusion, a setback outline. Reconciling rather than rebuilding preserves those
 * extras when the count changes, which is the difference between adding a floor and losing the
 * annotations on every floor below it.
 */
function reconcileStories(
  runtime: MassingRuntime,
  stores: MassingStores,
  mass: MassingObjectRecord,
): readonly MassingStoryRecord[] {
  const heights = resolveStoryHeights(mass.storyCount, mass.storyHeights, DEFAULT_STORY_HEIGHT);
  const existing = stores.stories
    .query((story) => story.massingObjectId === mass.id)
    .slice()
    .sort((a, b) => a.index - b.index);

  const profile = stores.profiles.get(mass.profileId);
  const baseElevation = profile?.baseElevation ?? 0;

  let elevation = baseElevation;
  const next: MassingStoryRecord[] = [];
  for (let index = 0; index < heights.length; index++) {
    const height = heights[index] ?? DEFAULT_STORY_HEIGHT;
    const previous = existing[index];
    next.push({
      id: previous?.id ?? runtime.ids.next("story"),
      massingObjectId: mass.id,
      index,
      elevation,
      height,
      ...(previous?.name === undefined ? {} : { name: previous.name }),
      ...(previous?.profileId === undefined ? {} : { profileId: previous.profileId }),
      ...(previous?.programme === undefined ? {} : { programme: previous.programme }),
      ...(previous?.excludedFromGfa === undefined
        ? {}
        : { excludedFromGfa: previous.excludedFromGfa }),
    });
    elevation += height;
  }

  stores.stories.removeWhere((story) => story.massingObjectId === mass.id);
  stores.stories.addMany(next);
  return next;
}

export function createStoryService(runtime: MassingRuntime, stores: MassingStores): StoryService {
  const requireMass = (id: Id): Result<MassingObjectRecord> => {
    const mass = stores.masses.get(id);
    return mass ? ok(mass) : err(notFound("massing object", id));
  };

  const applyHeights = (
    mass: MassingObjectRecord,
    heights: readonly number[],
  ): Result<MassingObjectRecord> => {
    const updated = stores.masses.update(mass.id, {
      storyCount: heights.length,
      storyHeights: [...heights],
      totalHeight: heights.reduce((total, value) => total + value, 0),
    });
    if (!updated) return err(notFound("massing object", mass.id));
    reconcileStories(runtime, stores, updated);
    runtime.context.events.emit("massing.stories.changed", {
      massingObjectId: updated.id,
      storyCount: updated.storyCount,
    });
    return ok(updated);
  };

  return {
    stories: (massingObjectId) =>
      stores.stories
        .query((story) => story.massingObjectId === massingObjectId)
        .slice()
        .sort((a, b) => a.index - b.index),

    async setStoryCount(massingObjectId, count) {
      if (!Number.isInteger(count) || count < 0) {
        return err(
          new KernelError("COMMAND_FAILED", `Story count must be a non-negative integer.`, { count }),
        );
      }
      const mass = requireMass(massingObjectId);
      if (!mass.ok) return err(mass.error);
      return applyHeights(mass.value, resolveStoryHeights(count, mass.value.storyHeights, DEFAULT_STORY_HEIGHT));
    },

    async setStoryHeight(massingObjectId, storyIndex, height) {
      if (height <= 0) {
        return err(new KernelError("COMMAND_FAILED", "Story height must be positive.", { height }));
      }
      const mass = requireMass(massingObjectId);
      if (!mass.ok) return err(mass.error);
      if (storyIndex < 0 || storyIndex >= mass.value.storyCount) {
        return err(
          new KernelError("COMMAND_FAILED", `No story at index ${storyIndex}.`, { storyIndex }),
        );
      }

      const heights = resolveStoryHeights(
        mass.value.storyCount,
        mass.value.storyHeights,
        DEFAULT_STORY_HEIGHT,
      );
      heights[storyIndex] = height;
      const applied = applyHeights(mass.value, heights);
      if (!applied.ok) return err(applied.error);

      const story = stores.stories.find(
        (candidate) => candidate.massingObjectId === massingObjectId && candidate.index === storyIndex,
      );
      return story ? ok(story) : err(notFound("story", `${massingObjectId}#${storyIndex}`));
    },

    async editStories(massingObjectId, predicate, changes) {
      const mass = requireMass(massingObjectId);
      if (!mass.ok) return err(mass.error);

      const targets = stores.stories.query(
        (story) => story.massingObjectId === massingObjectId && predicate(story),
      );
      if (targets.length === 0) return ok([]);

      const edited: MassingStoryRecord[] = [];
      for (const story of targets) {
        const updated = stores.stories.update(story.id, changes);
        if (updated) edited.push(updated);
      }

      // A height change in a bulk edit shifts every storey above it, so elevations and the mass's
      // own totals have to be rebuilt rather than patched in place.
      if (changes.height !== undefined) {
        const heights = this.stories(massingObjectId).map((story) => story.height);
        const applied = applyHeights(mass.value, heights);
        if (!applied.ok) return err(applied.error);
        return ok(this.stories(massingObjectId));
      }

      runtime.context.events.emit("massing.stories.changed", {
        massingObjectId,
        storyCount: mass.value.storyCount,
      });
      return ok(edited);
    },

    async insertStory(massingObjectId, atIndex, height) {
      const mass = requireMass(massingObjectId);
      if (!mass.ok) return err(mass.error);
      if (atIndex < 0 || atIndex > mass.value.storyCount) {
        return err(new KernelError("COMMAND_FAILED", `Cannot insert at ${atIndex}.`, { atIndex }));
      }
      const heights = resolveStoryHeights(
        mass.value.storyCount,
        mass.value.storyHeights,
        DEFAULT_STORY_HEIGHT,
      );
      heights.splice(atIndex, 0, height);
      return applyHeights(mass.value, heights);
    },

    async removeStory(massingObjectId, atIndex) {
      const mass = requireMass(massingObjectId);
      if (!mass.ok) return err(mass.error);
      if (atIndex < 0 || atIndex >= mass.value.storyCount) {
        return err(new KernelError("COMMAND_FAILED", `No story at index ${atIndex}.`, { atIndex }));
      }
      const heights = resolveStoryHeights(
        mass.value.storyCount,
        mass.value.storyHeights,
        DEFAULT_STORY_HEIGHT,
      );
      heights.splice(atIndex, 1);
      return applyHeights(mass.value, heights);
    },
  };
}

// --------------------------------------------------------------------------------------------
// Masses
// --------------------------------------------------------------------------------------------

export function createMassingService(
  runtime: MassingRuntime,
  stores: MassingStores,
): MassingService & { restore(record: MassingObjectRecord): Result<MassingObjectRecord> } {
  return {
    async create(input: CreateMassingInput) {
      if (!stores.profiles.has(input.profileId)) {
        return err(notFound("profile", input.profileId));
      }
      if (!Number.isInteger(input.storyCount) || input.storyCount < 0) {
        return err(
          new KernelError("COMMAND_FAILED", "Story count must be a non-negative integer.", {
            storyCount: input.storyCount,
          }),
        );
      }

      const heights = resolveStoryHeights(
        input.storyCount,
        input.storyHeights ?? (input.storyHeight === undefined ? undefined : [input.storyHeight]),
        input.storyHeight ?? DEFAULT_STORY_HEIGHT,
      );

      const record: MassingObjectRecord = {
        id: runtime.ids.next("mass"),
        name: input.name,
        profileId: input.profileId,
        storyCount: heights.length,
        storyHeights: heights,
        totalHeight: heights.reduce((total, value) => total + value, 0),
        editable: true,
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.opacity === undefined ? {} : { opacity: input.opacity }),
        ...(input.optionSetId === undefined ? {} : { optionSetId: input.optionSetId }),
        ...(input.familyTemplateId === undefined
          ? {}
          : { familyTemplateId: input.familyTemplateId }),
      };

      stores.masses.add(record);
      reconcileStories(runtime, stores, record);

      if (input.optionSetId) {
        const option = stores.options.get(input.optionSetId);
        if (option) {
          stores.options.update(option.id, {
            massingObjectIds: [...option.massingObjectIds, record.id],
          });
        }
      }

      runtime.context.events.emit("massing.created", { record });
      return ok(record);
    },

    async update(id, changes) {
      const existing = stores.masses.get(id);
      if (!existing) return err(notFound("massing object", id));
      if (!existing.editable) {
        return err(
          new KernelError("COMMAND_FAILED", `Massing object "${id}" is locked.`, { id }),
        );
      }
      // `id` and the derived story fields are owned elsewhere; accepting them here would let a
      // caller desynchronise storyCount from the actual story records.
      const { id: _ignoredId, storyCount, storyHeights, totalHeight, ...safe } = changes;
      const updated = stores.masses.update(id, safe);
      if (!updated) return err(notFound("massing object", id));
      runtime.context.events.emit("massing.updated", { record: updated });
      return ok(updated);
    },

    async remove(id) {
      if (!stores.masses.has(id)) return err(notFound("massing object", id));
      stores.masses.remove(id);
      stores.stories.removeWhere((story) => story.massingObjectId === id);
      for (const option of stores.options.query((o) => o.massingObjectIds.includes(id))) {
        stores.options.update(option.id, {
          massingObjectIds: option.massingObjectIds.filter((massId) => massId !== id),
        });
      }
      runtime.context.events.emit("massing.removed", { id });
      return ok(undefined);
    },

    /** Reinstates a removed mass verbatim. Exists so `remove` has an exact inverse for undo. */
    restore(record) {
      if (stores.masses.has(record.id)) return ok(record);
      stores.masses.add(record);
      reconcileStories(runtime, stores, record);
      runtime.context.events.emit("massing.created", { record });
      return ok(record);
    },

    get: (id) => stores.masses.get(id),
    list: () => stores.masses.all(),

    async duplicate(id, options) {
      const source = stores.masses.get(id);
      if (!source) return err(notFound("massing object", id));

      const copy: MassingObjectRecord = {
        ...source,
        id: runtime.ids.next("mass"),
        name: options?.name ?? `${source.name} copy`,
        storyHeights: [...source.storyHeights],
        ...(options?.optionSetId === undefined ? {} : { optionSetId: options.optionSetId }),
      };
      stores.masses.add(copy);

      // Copy the per-story extras too — duplicating a scheme and losing its programme allocation
      // would make option studies useless.
      const sourceStories = stores.stories
        .query((story) => story.massingObjectId === id)
        .slice()
        .sort((a, b) => a.index - b.index);
      stores.stories.addMany(
        sourceStories.map((story) => ({
          ...story,
          id: runtime.ids.next("story"),
          massingObjectId: copy.id,
        })),
      );

      runtime.context.events.emit("massing.created", { record: copy });
      return ok(copy);
    },
  };
}

// --------------------------------------------------------------------------------------------
// Appearance
// --------------------------------------------------------------------------------------------

/** Fallback palette for option styling — distinguishable, and readable against a light scene. */
export const OPTION_PALETTE = [
  "#4C78A8",
  "#F58518",
  "#54A24B",
  "#E45756",
  "#72B7B2",
  "#B279A2",
] as const;

export function createAppearanceService(
  runtime: MassingRuntime,
  stores: MassingStores,
): AppearanceService {
  return {
    async setColor(massingObjectId, color) {
      const updated = stores.masses.update(massingObjectId, { color });
      if (!updated) return err(notFound("massing object", massingObjectId));
      runtime.context.events.emit("massing.updated", { record: updated });
      return ok(undefined);
    },

    async setOpacity(massingObjectId, opacity) {
      if (opacity < 0 || opacity > 1) {
        return err(
          new KernelError("COMMAND_FAILED", "Opacity must be between 0 and 1.", { opacity }),
        );
      }
      const updated = stores.masses.update(massingObjectId, { opacity });
      if (!updated) return err(notFound("massing object", massingObjectId));
      runtime.context.events.emit("massing.updated", { record: updated });
      return ok(undefined);
    },

    async applyOptionStyling(optionSetId, palette) {
      const option = stores.options.get(optionSetId);
      if (!option) return err(notFound("option set", optionSetId));

      const colours = palette && palette.length > 0 ? palette : OPTION_PALETTE;
      option.massingObjectIds.forEach((massId, index) => {
        const colour = colours[index % colours.length];
        if (colour) stores.masses.update(massId, { color: colour });
      });
      return ok(undefined);
    },
  };
}

// --------------------------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------------------------

export function createMetricsService(
  runtime: MassingRuntime,
  stores: MassingStores,
): MetricsService {
  const outlineFor = (profileId: Id | undefined): { outer: Point2[]; holes: Point2[][] } | undefined => {
    if (!profileId) return undefined;
    const profile = stores.profiles.get(profileId);
    if (!profile) return undefined;
    return { outer: toXY(profile.points), holes: (profile.holes ?? []).map(toXY) };
  };

  const compute = (massingObjectId: Id): Result<MassingMetrics> => {
    const mass = stores.masses.get(massingObjectId);
    if (!mass) return err(notFound("massing object", massingObjectId));

    const base = outlineFor(mass.profileId);
    if (!base) return err(notFound("profile", mass.profileId));

    const stories = stores.stories
      .query((story) => story.massingObjectId === massingObjectId)
      .slice()
      .sort((a, b) => a.index - b.index);

    const storyOutlines: Record<number, readonly Point2[]> = {};
    const excludedStories: number[] = [];
    for (const story of stories) {
      if (story.excludedFromGfa) excludedStories.push(story.index);
      const override = outlineFor(story.profileId);
      if (override) storyOutlines[story.index] = override.outer;
    }

    const heights =
      stories.length > 0
        ? stories.map((story) => story.height)
        : resolveStoryHeights(mass.storyCount, mass.storyHeights, DEFAULT_STORY_HEIGHT);

    const profile = stores.profiles.get(mass.profileId);
    const result = computeMassMetrics({
      outer: base.outer,
      holes: base.holes,
      storyHeights: heights,
      baseElevation: profile?.baseElevation ?? 0,
      excludedStories,
      storyOutlines,
    });

    const siteArea = stores.site.all()[0]?.area ?? siteAreaFromBoundary(stores);
    const far = floorAreaRatio(result.grossFloorArea, siteArea);

    const metrics: MassingMetrics = {
      massingObjectId,
      footprintArea: result.footprintArea,
      grossFloorArea: result.grossFloorArea,
      volume: result.volume,
      envelopeArea: result.envelopeArea,
      storyCount: result.storyCount,
      height: result.height,
      computedAt: runtime.clock.timestamp(),
      ...(far === undefined ? {} : { floorAreaRatio: far }),
    };

    // Cached back onto the record so the common read path does not recompute geometry.
    stores.masses.update(massingObjectId, {
      area: result.footprintArea,
      grossFloorArea: result.grossFloorArea,
      volume: result.volume,
    });
    runtime.context.events.emit("massing.metrics.computed", { metrics });
    return ok(metrics);
  };

  return {
    async compute(massingObjectId) {
      return compute(massingObjectId);
    },

    async computeAll(optionSetId) {
      const ids = optionSetId
        ? (stores.options.get(optionSetId)?.massingObjectIds ?? [])
        : stores.masses.all().map((mass) => mass.id);

      const results: MassingMetrics[] = [];
      for (const id of ids) {
        const result = compute(id);
        // One unbuildable mass must not hide the metrics for every other option.
        if (result.ok) results.push(result.value);
      }
      return ok(results);
    },

    async summarise(optionSetId) {
      const option = stores.options.get(optionSetId);
      if (!option) return err(notFound("option set", optionSetId));

      let grossFloorArea = 0;
      let volume = 0;
      let footprintArea = 0;
      for (const massId of option.massingObjectIds) {
        const result = compute(massId);
        if (!result.ok) continue;
        grossFloorArea += result.value.grossFloorArea;
        volume += result.value.volume;
        footprintArea += result.value.footprintArea;
      }

      const boundary = stores.site.all()[0];
      const siteArea = boundary?.area ?? siteAreaFromBoundary(stores);
      const far = floorAreaRatio(grossFloorArea, siteArea);
      const maxFar = boundary?.maxFloorAreaRatio;
      const maxHeight = boundary?.maxHeight;

      const tallest = Math.max(
        0,
        ...option.massingObjectIds.map((id) => stores.masses.get(id)?.totalHeight ?? 0),
      );
      const withinLimits =
        maxFar === undefined && maxHeight === undefined
          ? undefined
          : (maxFar === undefined || (far ?? 0) <= maxFar) &&
            (maxHeight === undefined || tallest <= maxHeight);

      return ok({
        grossFloorArea,
        volume,
        footprintArea,
        ...(far === undefined ? {} : { floorAreaRatio: far }),
        ...(withinLimits === undefined ? {} : { withinLimits }),
      });
    },
  };
}

function siteAreaFromBoundary(stores: MassingStores): number | undefined {
  const boundary = stores.site.all()[0];
  if (!boundary) return undefined;
  const area = polygonArea(toXY(boundary.points));
  return area > 0 ? area : undefined;
}

// --------------------------------------------------------------------------------------------
// Options
// --------------------------------------------------------------------------------------------

export function createOptionService(
  runtime: MassingRuntime,
  stores: MassingStores,
  metrics: MetricsService,
): OptionService {
  return {
    async create(name, massingObjectIds = []) {
      const record: OptionSetRecord = {
        id: runtime.ids.next("option"),
        name,
        massingObjectIds: [...massingObjectIds],
        createdAt: runtime.clock.timestamp(),
      };
      stores.options.add(record);
      for (const massId of massingObjectIds) {
        stores.masses.update(massId, { optionSetId: record.id });
      }
      return ok(record);
    },

    async setActive(optionSetId) {
      if (!stores.options.has(optionSetId)) return err(notFound("option set", optionSetId));
      for (const option of stores.options.all()) {
        stores.options.update(option.id, { active: option.id === optionSetId });
      }
      runtime.context.events.emit("massing.option.activated", { optionSetId });
      return ok(undefined);
    },

    async compare(optionSetIds) {
      const results: MassingMetrics[] = [];
      for (const optionSetId of optionSetIds) {
        const computed = await metrics.computeAll(optionSetId);
        if (computed.ok) results.push(...computed.value);
      }
      return ok(results);
    },

    list: () => stores.options.all(),
  };
}

// --------------------------------------------------------------------------------------------
// Context (levels, grids, site)
// --------------------------------------------------------------------------------------------

export function createContextService(
  runtime: MassingRuntime,
  stores: MassingStores,
): ContextService {
  return {
    levels: () => stores.levels.all(),
    grids: () => stores.grids.all(),
    siteBoundary: () => stores.site.all()[0],

    async deriveLevels(massingObjectId) {
      const mass = stores.masses.get(massingObjectId);
      if (!mass) return err(notFound("massing object", massingObjectId));

      const stories = stores.stories
        .query((story) => story.massingObjectId === massingObjectId)
        .slice()
        .sort((a, b) => a.index - b.index);
      if (stories.length === 0) return ok([]);

      const levels: LevelRecord[] = stories.map((story) => ({
        id: runtime.ids.next("level"),
        name: story.name ?? `Level ${story.index + 1}`,
        elevation: story.elevation,
      }));
      // A roof level: downstream authoring needs something to host the roof to.
      const top = stories[stories.length - 1];
      if (top) {
        levels.push({
          id: runtime.ids.next("level"),
          name: "Roof",
          elevation: top.elevation + top.height,
        });
      }

      stores.levels.addMany(levels);
      return ok(levels);
    },
  };
}

// --------------------------------------------------------------------------------------------
// Promotion
// --------------------------------------------------------------------------------------------

/**
 * Promotion delegates rather than implements.
 *
 * Turning a mass into building systems, a family package, or a working model means writing into
 * another capability family's domain. Doing that directly would couple massing to authoring and
 * family-libraries and defeat the plugin architecture, so massing looks for a registered handler
 * and reports honestly when none is installed.
 */
export function createPromotionService(
  runtime: MassingRuntime,
  stores: MassingStores,
  handlers: () => readonly MassPromotionHandler[],
): PromotionService {
  return {
    async promote(massingObjectId, target, options) {
      const mass = stores.masses.get(massingObjectId);
      if (!mass) return err(notFound("massing object", massingObjectId));

      const handler = handlers().find((candidate) => candidate.target === target);
      if (!handler) {
        return err(
          new KernelError(
            "CAPABILITY_NOT_FOUND",
            `No promotion handler is installed for target "${target}".`,
            { target, massingObjectId },
          ),
        );
      }

      const promoted = await handler.promote(mass, options);
      if (!promoted.ok) return err(promoted.error);

      runtime.context.events.emit("massing.promoted", {
        massingObjectId,
        target,
        targetId: promoted.value.targetId,
      });
      return ok({ targetId: promoted.value.targetId, target });
    },
  };
}
