import type { Id, ModelRecord, ProjectRecord } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  FEDERATION_COMMANDS,
  FederationToken,
  ModelLoaderPortToken,
  SessionStateToken,
} from "./contracts.js";
import {
  createFederationService,
  createFederationStores,
  createSessionStateService,
} from "./services.js";

export interface FederationPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
}

/**
 * The federation capability.
 *
 * Owns which models belong to a project, which revision each is at, and what is on screen. Kept
 * apart from the viewer runtime because the two answer different questions: the runtime knows how
 * to load a payload, federation knows which payloads a project consists of.
 */
export function createFederationPlugin(options: FederationPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.federation",
    version: "0.1.0",
    name: "Federation",
    description: "Multi-model project composition, load state and revision replacement.",

    activate(context) {
      const stores = createFederationStores(context);
      const runtime = {
        context,
        clock,
        ids,
        loader: () => context.capabilities.get(ModelLoaderPortToken),
      };

      const federation = createFederationService(runtime, stores);
      const session = createSessionStateService(runtime, stores);

      context.capabilities.provide(FederationToken, federation, { version: "0.1.0" });
      context.capabilities.provide(SessionStateToken, session, { version: "0.1.0" });

      context.commands.register<{ project: ProjectRecord }, void>({
        id: FEDERATION_COMMANDS.openProject,
        title: "Open project",
        handler: async ({ project }) => {
          const opened = await federation.openProject(project);
          if (!opened.ok) throw opened.error;
        },
      });

      context.commands.register<Record<string, never>, void>({
        id: FEDERATION_COMMANDS.closeProject,
        title: "Close project",
        handler: async () => {
          const closed = await federation.closeProject();
          if (!closed.ok) throw closed.error;
        },
      });

      context.commands.register<{ record: ModelRecord }, void>({
        id: FEDERATION_COMMANDS.addModel,
        title: "Add model",
        handler: async ({ record }) => {
          const added = await federation.addModel(record);
          if (!added.ok) throw added.error;
        },
        createInverse: (params) => ({
          commandId: "federation.model.remove",
          params: { modelId: params.record.id },
        }),
      });

      context.commands.register<{ modelId: Id }, void>({
        id: "federation.model.remove",
        handler: async ({ modelId }) => {
          const removed = await federation.removeModel(modelId);
          if (!removed.ok) throw removed.error;
        },
      });

      context.commands.register<{ modelId: Id; record: ModelRecord }, void>({
        id: FEDERATION_COMMANDS.replaceRevision,
        title: "Issue new revision",
        handler: async ({ modelId, record }) => {
          const replaced = await federation.replaceRevision(modelId, record);
          if (!replaced.ok) throw replaced.error;
        },
      });

      context.commands.register<Record<string, never>, unknown>({
        id: FEDERATION_COMMANDS.saveSession,
        title: "Save session",
        handler: async () => {
          const captured = await session.capture();
          if (!captured.ok) throw captured.error;
          return captured.value;
        },
      });

      context.ui.register({ id: "federation.panel", point: "panel", title: "Models", placement: "left", order: 10 });

      context.logger.info("Federation ready");
    },
  });
}

export const federationPlugin = createFederationPlugin();
