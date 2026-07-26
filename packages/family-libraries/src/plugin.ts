import type { FamilyRepositoryRecord, Id, Matrix4 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  KERNEL_API_VERSION,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  FAMILY_COMMANDS,
  FAMILY_PERMISSIONS,
  FamilyLibraryRegistryToken,
  FamilyParameterToken,
  FamilyPlacementToken,
  FamilyRepositoryAdapterToken,
  FamilyResolverToken,
  FamilyVersionToken,
} from "./contracts.js";
import {
  createFamilyStores,
  createParameterService,
  createPlacementService,
  createRegistryService,
  createResolverService,
  createVersionService,
} from "./services.js";

export interface FamilyPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Platform API version packages are validated against. */
  readonly apiVersion?: string;
}

/**
 * The family library capability.
 *
 * Repositories are adapters, not integrations. Git, a cloud API, an enterprise registry and a
 * project folder differ only in how bytes are fetched, so hard-coding any one of them would mean a
 * new content source required a platform change rather than a new plugin.
 */
export function createFamilyPlugin(options: FamilyPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const apiVersion = options.apiVersion ?? KERNEL_API_VERSION;

  return definePlugin({
    id: "massingifc.families",
    version: "0.1.0",
    name: "Family libraries",
    description: "Pluggable, versioned reusable content.",
    permissions: Object.values(FAMILY_PERMISSIONS),

    activate(context) {
      const stores = createFamilyStores(context);
      const runtime = {
        context,
        clock,
        ids,
        apiVersion,
        adapters: () => context.capabilities.getAll(FamilyRepositoryAdapterToken).map((p) => p.value),
      };

      const registry = createRegistryService(runtime, stores);
      const resolver = createResolverService(runtime, stores);
      const placement = createPlacementService(runtime, stores);
      const parameters = createParameterService(stores);
      const versions = createVersionService(runtime, stores);

      context.capabilities.provide(FamilyLibraryRegistryToken, registry, { version: "0.1.0" });
      context.capabilities.provide(FamilyResolverToken, resolver, { version: "0.1.0" });
      context.capabilities.provide(FamilyPlacementToken, placement, { version: "0.1.0" });
      context.capabilities.provide(FamilyParameterToken, parameters, { version: "0.1.0" });
      context.capabilities.provide(FamilyVersionToken, versions, { version: "0.1.0" });

      context.commands.register<FamilyRepositoryRecord, void>({
        id: FAMILY_COMMANDS.addRepository,
        title: "Add family repository",
        permission: FAMILY_PERMISSIONS.manageRepositories,
        handler: async (record) => {
          const added = await registry.addRepository(record);
          if (!added.ok) throw added.error;
        },
      });

      context.commands.register<{ repositoryId?: Id }, unknown>({
        id: FAMILY_COMMANDS.syncRepositories,
        title: "Sync family repositories",
        permission: FAMILY_PERMISSIONS.manageRepositories,
        handler: async ({ repositoryId }) => {
          const synced = await registry.sync(repositoryId);
          if (!synced.ok) throw synced.error;
          return synced.value;
        },
      });

      context.commands.register<
        { packageId: Id; version: string; transform: Matrix4; parameters?: Record<string, unknown> },
        unknown
      >({
        id: FAMILY_COMMANDS.placeInstance,
        title: "Place family",
        permission: FAMILY_PERMISSIONS.place,
        handler: async ({ packageId, version, transform, parameters: values }) => {
          const placed = await placement.place(packageId, version, {
            transform,
            ...(values === undefined ? {} : { parameters: values }),
          });
          if (!placed.ok) throw placed.error;
          return placed.value;
        },
        createInverse: (_params, instance) => ({
          commandId: "family.instance.remove",
          params: { instanceId: (instance as { id: Id }).id },
        }),
      });

      context.commands.register<{ instanceId: Id }, void>({
        id: "family.instance.remove",
        permission: FAMILY_PERMISSIONS.place,
        handler: async ({ instanceId }) => {
          const removed = await placement.remove(instanceId);
          if (!removed.ok) throw removed.error;
        },
      });

      context.commands.register<{ instanceIds: readonly Id[]; toVersion: string }, unknown>({
        id: FAMILY_COMMANDS.upgradeInstances,
        title: "Upgrade family instances",
        permission: FAMILY_PERMISSIONS.place,
        handler: async ({ instanceIds, toVersion }) => {
          const upgraded = await versions.upgrade(instanceIds, toVersion);
          if (!upgraded.ok) throw upgraded.error;
          return upgraded.value;
        },
      });

      context.ui.register({ id: "families.panel", point: "panel", title: "Families", placement: "left", order: 30 });

      context.logger.info("Family libraries ready");
    },
  });
}

export const familyPlugin = createFamilyPlugin();
