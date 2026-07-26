import type { Id, TwinObjectRecord } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  TWIN_COMMANDS,
  TWIN_PERMISSIONS,
  TwinAlignmentToken,
  TwinObjectFactoryToken,
  TwinObservationToken,
  TwinPromotionToken,
  TwinRegistryToken,
  TwinTimelineToken,
  type PointPairInput,
} from "./contracts.js";
import {
  createTwinAlignmentService,
  createTwinObservationService,
  createTwinPromotionService,
  createTwinRegistryService,
  createTwinStores,
  createTwinTimelineService,
} from "./services.js";

export interface TwinPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
}

/**
 * The digital twin capability.
 *
 * Twins stay loosely coupled to BIM semantics. A scan, a sensor feed and a generated scene object
 * are evidence about the world; forcing them into IFC on arrival destroys the uncertainty and
 * provenance that make them worth having. Promotion into authored geometry is an explicit later
 * decision, and it is refused for anything not yet aligned.
 */
export function createTwinPlugin(options: TwinPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.twin",
    version: "0.1.0",
    name: "Digital twin",
    description: "Observed and generated objects alongside the authored model.",
    permissions: Object.values(TWIN_PERMISSIONS),

    activate(context) {
      const stores = createTwinStores(context);
      const runtime = {
        context,
        clock,
        ids,
        factories: () => context.capabilities.getAll(TwinObjectFactoryToken).map((p) => p.value),
      };

      const registry = createTwinRegistryService(runtime, stores);
      const alignment = createTwinAlignmentService(runtime, stores);
      const observations = createTwinObservationService(runtime, stores);
      const timeline = createTwinTimelineService(runtime, stores, observations);
      const promotion = createTwinPromotionService(runtime, stores);

      context.capabilities.provide(TwinRegistryToken, registry, { version: "0.1.0" });
      context.capabilities.provide(TwinAlignmentToken, alignment, { version: "0.1.0" });
      context.capabilities.provide(TwinObservationToken, observations, { version: "0.1.0" });
      context.capabilities.provide(TwinTimelineToken, timeline, { version: "0.1.0" });
      context.capabilities.provide(TwinPromotionToken, promotion, { version: "0.1.0" });

      context.commands.register<TwinObjectRecord, TwinObjectRecord>({
        id: TWIN_COMMANDS.register,
        title: "Register twin object",
        permission: TWIN_PERMISSIONS.register,
        handler: async (record) => {
          const registered = await registry.register(record);
          if (!registered.ok) throw registered.error;
          return registered.value;
        },
        createInverse: (_params, record) => ({
          commandId: "twin.unregister",
          params: { twinObjectId: record.id },
        }),
      });

      context.commands.register<{ twinObjectId: Id }, void>({
        id: "twin.unregister",
        permission: TWIN_PERMISSIONS.register,
        handler: async ({ twinObjectId }) => {
          const removed = await registry.unregister(twinObjectId);
          if (!removed.ok) throw removed.error;
        },
      });

      context.commands.register<{ twinObjectId: Id; pairs: readonly PointPairInput[] }, unknown>({
        id: TWIN_COMMANDS.alignByPoints,
        title: "Align by control points",
        permission: TWIN_PERMISSIONS.align,
        handler: async ({ twinObjectId, pairs }) => {
          const aligned = await alignment.alignByPoints(twinObjectId, pairs);
          if (!aligned.ok) throw aligned.error;
          return aligned.value;
        },
      });

      context.commands.register<{ twinObjectId: Id; target: "authoring" | "family" | "asset" }, unknown>({
        id: TWIN_COMMANDS.promote,
        title: "Promote twin object",
        permission: TWIN_PERMISSIONS.promote,
        handler: async ({ twinObjectId, target }) => {
          const promoted = await promotion.promote(twinObjectId, target);
          if (!promoted.ok) throw promoted.error;
          return promoted.value;
        },
      });

      context.ui.register({ id: "twin.panel", point: "panel", title: "Twin", placement: "right", order: 50 });

      context.logger.info("Digital twin ready");
    },
  });
}

export const twinPlugin = createTwinPlugin();
