import type { Id, MassingObjectRecord, MassingStoryRecord, Vec3 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  AppearanceToken,
  ContextToken,
  MassingToken,
  MassPromotionHandlerToken,
  MASSING_COMMANDS,
  MASSING_PERMISSIONS,
  MetricsToken,
  OptionToken,
  ProfileToken,
  PromotionToken,
  StoryToken,
  type PromotionTarget,
} from "./contracts.js";
import {
  createAppearanceService,
  createContextService,
  createMassingService,
  createMassingStores,
  createMetricsService,
  createOptionService,
  createProfileService,
  createPromotionService,
  createStoryService,
  DEFAULT_STORY_HEIGHT,
} from "./services.js";

export interface MassingPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Auto-recompute metrics when geometry changes. Defaults to true. */
  readonly autoComputeMetrics?: boolean;
}

/**
 * The massing capability, packaged as a plugin.
 *
 * Every mutation is exposed as a command with an inverse, so massing participates in the kernel's
 * undo history rather than maintaining its own. That is what makes "sketch, extrude, add two
 * floors, change the colour, undo four times" behave the way a designer expects — including across
 * a sequence that touches profiles, stories and appearance.
 */
export function createMassingPlugin(options: MassingPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const autoCompute = options.autoComputeMetrics ?? true;

  return definePlugin({
    id: "massingifc.massing",
    version: "0.1.0",
    name: "Massing",
    description: "Sketch-based, story-aware conceptual massing.",
    permissions: [MASSING_PERMISSIONS.edit, MASSING_PERMISSIONS.promote],

    activate(context) {
      const runtime = { context, clock, ids };
      const stores = createMassingStores(context);

      const profiles = createProfileService(runtime, stores);
      const masses = createMassingService(runtime, stores);
      const stories = createStoryService(runtime, stores);
      const appearance = createAppearanceService(runtime, stores);
      const metrics = createMetricsService(runtime, stores);
      const optionSets = createOptionService(runtime, stores, metrics);
      const projectContext = createContextService(runtime, stores);
      const promotion = createPromotionService(runtime, stores, () =>
        context.capabilities
          .get(MassPromotionHandlerToken) === undefined
          ? []
          : [context.capabilities.get(MassPromotionHandlerToken)!],
      );

      context.capabilities.provide(ProfileToken, profiles, { version: "0.1.0" });
      context.capabilities.provide(MassingToken, masses, { version: "0.1.0" });
      context.capabilities.provide(StoryToken, stories, { version: "0.1.0" });
      context.capabilities.provide(AppearanceToken, appearance, { version: "0.1.0" });
      context.capabilities.provide(MetricsToken, metrics, { version: "0.1.0" });
      context.capabilities.provide(OptionToken, optionSets, { version: "0.1.0" });
      context.capabilities.provide(ContextToken, projectContext, { version: "0.1.0" });
      context.capabilities.provide(PromotionToken, promotion, { version: "0.1.0" });

      /** Metrics are cheap and always-fresh beats sometimes-stale for a design-feedback number. */
      const refresh = (massingObjectId: Id): void => {
        if (autoCompute) void metrics.compute(massingObjectId);
      };

      // ---------------------------------------------------------------------------------------
      // Profiles
      // ---------------------------------------------------------------------------------------

      context.commands.register<{ points: readonly Vec3[]; name?: string; baseElevation?: number }, Id>({
        id: MASSING_COMMANDS.sketchProfile,
        title: "Sketch profile",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ points, name, baseElevation }) => {
          const created = await profiles.create(points, {
            ...(name === undefined ? {} : { name }),
            ...(baseElevation === undefined ? {} : { baseElevation }),
          });
          if (!created.ok) throw created.error;
          return created.value.id;
        },
      });

      // ---------------------------------------------------------------------------------------
      // Masses
      // ---------------------------------------------------------------------------------------

      context.commands.register<
        {
          name: string;
          profileId: Id;
          storyCount: number;
          storyHeight?: number;
          storyHeights?: readonly number[];
          color?: string;
          opacity?: number;
          optionSetId?: Id;
        },
        MassingObjectRecord
      >({
        id: MASSING_COMMANDS.createMass,
        title: "Create mass",
        permission: MASSING_PERMISSIONS.edit,
        handler: async (params) => {
          const created = await masses.create(params);
          if (!created.ok) throw created.error;
          refresh(created.value.id);
          return created.value;
        },
        createInverse: (_params, record) => ({
          commandId: "massing.remove",
          params: { id: record.id },
        }),
      });

      context.commands.register<{ id: Id }, MassingObjectRecord | undefined>({
        id: "massing.remove",
        title: "Delete mass",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id }) => {
          // Captured before removal so the inverse can put back the exact record, including the
          // per-story extras that a fresh create would not reproduce.
          const snapshot = masses.get(id);
          const storySnapshot = stories.stories(id);
          const removed = await masses.remove(id);
          if (!removed.ok) throw removed.error;
          restoreBuffer.set(id, { mass: snapshot, stories: storySnapshot });
          return snapshot;
        },
        createInverse: (params) => ({ commandId: "massing.restore", params: { id: params.id } }),
      });

      const restoreBuffer = new Map<
        Id,
        { mass: MassingObjectRecord | undefined; stories: readonly MassingStoryRecord[] }
      >();

      context.commands.register<{ id: Id }, void>({
        id: "massing.restore",
        title: "Restore mass",
        permission: MASSING_PERMISSIONS.edit,
        handler: ({ id }) => {
          const buffered = restoreBuffer.get(id);
          if (!buffered?.mass) return;
          masses.restore(buffered.mass);
          for (const story of buffered.stories) {
            const current = stores.stories.find(
              (candidate) => candidate.massingObjectId === id && candidate.index === story.index,
            );
            if (current) stores.stories.replace({ ...story, id: current.id });
          }
          refresh(id);
        },
        createInverse: (params) => ({ commandId: "massing.remove", params: { id: params.id } }),
      });

      // ---------------------------------------------------------------------------------------
      // Stories
      // ---------------------------------------------------------------------------------------

      context.commands.register<
        { id: Id; count: number },
        { id: Id; previousHeights: readonly number[] }
      >({
        id: MASSING_COMMANDS.setStoryCount,
        title: "Set story count",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, count }) => {
          const previous = masses.get(id);
          const previousHeights = previous ? [...previous.storyHeights] : [];
          const applied = await stories.setStoryCount(id, count);
          if (!applied.ok) throw applied.error;
          refresh(id);
          return { id, previousHeights };
        },
        // Restoring the heights array restores the count too, and does it without losing a taller
        // ground floor the way replaying "set count" with a uniform height would.
        createInverse: (_params, result) => ({
          commandId: "massing.stories.set-heights",
          params: { id: result.id, heights: result.previousHeights },
        }),
      });

      context.commands.register<
        { id: Id; heights: readonly number[] },
        { id: Id; previousHeights: readonly number[] }
      >({
        id: "massing.stories.set-heights",
        title: "Set story heights",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, heights }) => {
          const previous = masses.get(id);
          if (!previous) throw new Error(`No massing object with id "${id}".`);
          const previousHeights = [...previous.storyHeights];

          const applied = await stories.setStoryCount(id, heights.length);
          if (!applied.ok) throw applied.error;
          for (let index = 0; index < heights.length; index++) {
            const height = heights[index];
            if (height === undefined) continue;
            const set = await stories.setStoryHeight(id, index, height);
            if (!set.ok) throw set.error;
          }
          refresh(id);
          return { id, previousHeights };
        },
        createInverse: (_params, result) => ({
          commandId: "massing.stories.set-heights",
          params: { id: result.id, heights: result.previousHeights },
        }),
      });

      context.commands.register<
        {
          id: Id;
          fromIndex?: number;
          toIndex?: number;
          changes: Partial<Pick<MassingStoryRecord, "height" | "programme" | "excludedFromGfa">>;
        },
        { id: Id; previous: readonly MassingStoryRecord[] }
      >({
        id: MASSING_COMMANDS.editStories,
        title: "Edit stories",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, fromIndex, toIndex, changes }) => {
          const previous = stories.stories(id).map((story) => ({ ...story }));
          const from = fromIndex ?? 0;
          const to = toIndex ?? Number.MAX_SAFE_INTEGER;
          const edited = await stories.editStories(
            id,
            (story) => story.index >= from && story.index <= to,
            changes,
          );
          if (!edited.ok) throw edited.error;
          refresh(id);
          return { id, previous };
        },
        createInverse: (_params, result) => ({
          commandId: "massing.stories.restore",
          params: { id: result.id, stories: result.previous },
        }),
      });

      context.commands.register<{ id: Id; stories: readonly MassingStoryRecord[] }, void>({
        id: "massing.stories.restore",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, stories: snapshot }) => {
          const heights = snapshot.map((story) => story.height);
          if (heights.length > 0) {
            const applied = await stories.setStoryCount(id, heights.length);
            if (!applied.ok) throw applied.error;
          }
          for (const story of snapshot) {
            const current = stores.stories.find(
              (candidate) => candidate.massingObjectId === id && candidate.index === story.index,
            );
            if (current) stores.stories.replace({ ...story, id: current.id });
          }
          refresh(id);
        },
      });

      // ---------------------------------------------------------------------------------------
      // Appearance
      // ---------------------------------------------------------------------------------------

      context.commands.register<{ id: Id; color: string }, { id: Id; previous: string | undefined }>({
        id: MASSING_COMMANDS.setColor,
        title: "Set colour",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, color }) => {
          const previous = masses.get(id)?.color;
          const applied = await appearance.setColor(id, color);
          if (!applied.ok) throw applied.error;
          return { id, previous };
        },
        createInverse: (_params, result) =>
          result.previous === undefined
            ? undefined // nothing to restore to; leave the history clean rather than inventing a value
            : { commandId: MASSING_COMMANDS.setColor, params: { id: result.id, color: result.previous } },
      });

      context.commands.register<
        { id: Id; opacity: number },
        { id: Id; previous: number | undefined }
      >({
        id: MASSING_COMMANDS.setOpacity,
        title: "Set opacity",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ id, opacity }) => {
          const previous = masses.get(id)?.opacity;
          const applied = await appearance.setOpacity(id, opacity);
          if (!applied.ok) throw applied.error;
          return { id, previous };
        },
        createInverse: (_params, result) =>
          result.previous === undefined
            ? undefined
            : {
                commandId: MASSING_COMMANDS.setOpacity,
                params: { id: result.id, opacity: result.previous },
              },
      });

      // ---------------------------------------------------------------------------------------
      // Metrics, options, promotion
      // ---------------------------------------------------------------------------------------

      context.commands.register<{ id: Id }, unknown>({
        id: MASSING_COMMANDS.computeMetrics,
        title: "Compute metrics",
        handler: async ({ id }) => {
          const computed = await metrics.compute(id);
          if (!computed.ok) throw computed.error;
          return computed.value;
        },
      });

      context.commands.register<{ name: string; massingObjectIds?: readonly Id[] }, Id>({
        id: MASSING_COMMANDS.createOption,
        title: "Create option",
        permission: MASSING_PERMISSIONS.edit,
        handler: async ({ name, massingObjectIds }) => {
          const created = await optionSets.create(name, massingObjectIds);
          if (!created.ok) throw created.error;
          return created.value.id;
        },
      });

      context.commands.register<{ optionSetIds: readonly Id[] }, unknown>({
        id: MASSING_COMMANDS.compareOptions,
        title: "Compare options",
        handler: async ({ optionSetIds }) => {
          const compared = await optionSets.compare(optionSetIds);
          if (!compared.ok) throw compared.error;
          return compared.value;
        },
      });

      context.commands.register<
        { id: Id; target: PromotionTarget; options?: Record<string, unknown> },
        unknown
      >({
        id: MASSING_COMMANDS.promote,
        title: "Promote mass",
        permission: MASSING_PERMISSIONS.promote,
        handler: async ({ id, target, options: promotionOptions }) => {
          const promoted = await promotion.promote(id, target, promotionOptions);
          if (!promoted.ok) throw promoted.error;
          return promoted.value;
        },
      });

      // ---------------------------------------------------------------------------------------
      // UI contributions
      // ---------------------------------------------------------------------------------------

      context.ui.register({
        id: "massing.panel",
        point: "panel",
        title: "Massing",
        placement: "left",
        order: 20,
      });
      context.ui.register({
        id: "massing.toolbar.sketch",
        point: "toolbar",
        title: "Sketch mass",
        group: "authoring",
        order: 10,
        commandId: MASSING_COMMANDS.sketchProfile,
      });
      context.ui.register({
        id: "massing.inspector.metrics",
        point: "inspector",
        title: "Massing metrics",
        order: 10,
        when: (ctx) => ctx["selectionKind"] === "massing",
      });

      context.logger.info("Massing capability ready", {
        defaultStoryHeight: DEFAULT_STORY_HEIGHT,
      });
    },
  });
}

/** Ready-to-use instance for hosts that need no injection. */
export const massingPlugin = createMassingPlugin();
