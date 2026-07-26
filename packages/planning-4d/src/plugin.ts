import type { Id, IsoTimestamp, TaskLinkBehaviour } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  ElementFilterSourceToken,
  PLANNING_COMMANDS,
  PLANNING_PERMISSIONS,
  PlannedActualToken,
  ScheduleImportToken,
  TaskModelLinkToken,
  TimelinePlaybackToken,
  type ScheduleFormat,
} from "./contracts.js";
import {
  createComparisonService,
  createPlanningStores,
  createScheduleImportService,
  createTaskModelLinkService,
  createTimelinePlaybackService,
} from "./services.js";

export interface PlanningPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
}

/**
 * The 4D capability.
 *
 * Schedules are maintained in a planning tool and models in an authoring tool, by different people.
 * Everything here follows from that: tasks match on the planner's own id so a weekly re-import
 * preserves the links, and links keep their selection rule so a model re-issue re-resolves rather
 * than needing to be rebuilt.
 */
export function createPlanningPlugin(options: PlanningPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.planning",
    version: "0.1.0",
    name: "4D planning",
    description: "Schedule import, task-model links, timeline playback and planned-versus-actual.",
    permissions: Object.values(PLANNING_PERMISSIONS),

    activate(context) {
      const stores = createPlanningStores(context);
      const runtime = {
        context,
        clock,
        ids,
        elements: () => context.capabilities.get(ElementFilterSourceToken),
      };

      const schedule = createScheduleImportService(runtime, stores);
      const links = createTaskModelLinkService(runtime, stores);
      const playback = createTimelinePlaybackService(runtime, stores);
      const comparison = createComparisonService(runtime, stores);

      context.capabilities.provide(ScheduleImportToken, schedule, { version: "0.1.0" });
      context.capabilities.provide(TaskModelLinkToken, links, { version: "0.1.0" });
      context.capabilities.provide(TimelinePlaybackToken, playback, { version: "0.1.0" });
      context.capabilities.provide(PlannedActualToken, comparison, { version: "0.1.0" });

      // A model revision is when rule-based links need re-resolving; driven by the event so it is
      // not something a user has to remember.
      context.events.on("federation.model.revised", (payload) => {
        const modelId = (payload as { modelId?: Id }).modelId;
        if (modelId) void links.reresolve(modelId);
      });

      context.commands.register<{ payload: Uint8Array | string; format: ScheduleFormat }, unknown>({
        id: PLANNING_COMMANDS.importSchedule,
        title: "Import schedule",
        permission: PLANNING_PERMISSIONS.importSchedule,
        handler: async ({ payload, format }) => {
          const imported = await schedule.import(payload, format);
          if (!imported.ok) throw imported.error;
          return imported.value;
        },
      });

      context.commands.register<{ payload: Uint8Array | string; format: ScheduleFormat }, unknown>({
        id: PLANNING_COMMANDS.reimportSchedule,
        title: "Update schedule",
        permission: PLANNING_PERMISSIONS.importSchedule,
        handler: async ({ payload, format }) => {
          const imported = await schedule.reimport(payload, format);
          if (!imported.ok) throw imported.error;
          return imported.value;
        },
      });

      context.commands.register<
        { taskId: Id; modelId: Id; filter: Record<string, unknown>; behaviour: TaskLinkBehaviour },
        unknown
      >({
        id: PLANNING_COMMANDS.linkByRule,
        title: "Link by rule",
        permission: PLANNING_PERMISSIONS.editLinks,
        handler: async ({ taskId, modelId, filter, behaviour }) => {
          const linked = await links.linkByRule(taskId, modelId, filter, behaviour);
          if (!linked.ok) throw linked.error;
          return linked.value;
        },
        createInverse: (_params, link) => ({
          commandId: "planning.link.remove",
          params: { linkId: (link as { id: Id }).id },
        }),
      });

      context.commands.register<{ linkId: Id }, void>({
        id: "planning.link.remove",
        permission: PLANNING_PERMISSIONS.editLinks,
        handler: async ({ linkId }) => {
          const removed = await links.unlink(linkId);
          if (!removed.ok) throw removed.error;
        },
      });

      context.commands.register<{ modelId?: Id }, unknown>({
        id: PLANNING_COMMANDS.reresolveLinks,
        title: "Re-resolve links",
        permission: PLANNING_PERMISSIONS.editLinks,
        handler: async ({ modelId }) => {
          const resolved = await links.reresolve(modelId);
          if (!resolved.ok) throw resolved.error;
          return resolved.value;
        },
      });

      context.commands.register<{ at: IsoTimestamp }, void>({
        id: PLANNING_COMMANDS.seek,
        title: "Seek timeline",
        handler: async ({ at }) => {
          const sought = await playback.seek(at);
          if (!sought.ok) throw sought.error;
        },
      });

      context.commands.register<{ dataDate: IsoTimestamp }, unknown>({
        id: PLANNING_COMMANDS.compareProgress,
        title: "Compare progress",
        handler: async ({ dataDate }) => {
          const compared = await comparison.compare(dataDate);
          if (!compared.ok) throw compared.error;
          return compared.value;
        },
      });

      context.ui.register({ id: "planning.panel", point: "panel", title: "Programme", placement: "bottom", order: 20 });
      context.ui.register({
        id: "planning.toolbar.play",
        point: "toolbar",
        title: "Play timeline",
        group: "4d",
        order: 10,
        commandId: PLANNING_COMMANDS.play,
      });

      context.logger.info("4D planning ready");
    },
  });
}

export const planningPlugin = createPlanningPlugin();
