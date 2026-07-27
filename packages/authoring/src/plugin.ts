import type { Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  AUTHORING_COMMANDS,
  AUTHORING_PERMISSIONS,
  AuthoringSessionToken,
  ConstraintToken,
  EditCommandToken,
  EditHistoryToken,
  GeometryBackendToken,
  LevelSourceToken,
  PublishToken,
  SketchPlaneToken,
  type EditOperation,
} from "./contracts.js";
import {
  createAuthoringSessionService,
  createAuthoringStores,
  createConstraintService,
  createEditCommandService,
  createEditHistoryService,
  createPublishService,
  createSketchPlaneService,
} from "./services.js";

export interface AuthoringPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Grid spacing for sketch snapping, in project units. 0 disables snapping. */
  readonly gridSpacing?: number;
}

/**
 * The authoring capability.
 *
 * Editing is gated behind an explicit session: a working change set held apart from the read-only
 * references it sits against, published deliberately. An editor that wrote straight into the loaded
 * model would make "which version did the consultant actually receive?" unanswerable.
 */
export function createAuthoringPlugin(options: AuthoringPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.authoring",
    version: "0.1.0",
    name: "Authoring",
    description: "Edit sessions, reversible history, publishing, constraints and sketch planes.",
    permissions: Object.values(AUTHORING_PERMISSIONS),

    activate(context) {
      const stores = createAuthoringStores(context);
      const runtime = {
        context,
        clock,
        ids,
        geometry: () => context.capabilities.get(GeometryBackendToken),
        levels: () => context.capabilities.get(LevelSourceToken),
      };

      const sessions = createAuthoringSessionService(runtime, stores);
      const edits = createEditCommandService(runtime, stores, sessions);
      const history = createEditHistoryService(runtime, stores, sessions);
      const publish = createPublishService(runtime, stores, sessions);
      const constraints = createConstraintService(runtime, stores);
      const planes = createSketchPlaneService(runtime, stores, {
        ...(options.gridSpacing === undefined ? {} : { gridSpacing: options.gridSpacing }),
      });

      context.capabilities.provide(AuthoringSessionToken, sessions, { version: "0.1.0" });
      context.capabilities.provide(EditCommandToken, edits, { version: "0.1.0" });
      context.capabilities.provide(EditHistoryToken, history, { version: "0.1.0" });
      context.capabilities.provide(PublishToken, publish, { version: "0.1.0" });
      context.capabilities.provide(ConstraintToken, constraints, { version: "0.1.0" });
      context.capabilities.provide(SketchPlaneToken, planes, { version: "0.1.0" });

      context.commands.register<{ modelId: Id }, unknown>({
        id: AUTHORING_COMMANDS.openSession,
        title: "Open authoring session",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: async ({ modelId }) => {
          const opened = await sessions.open(modelId);
          if (!opened.ok) throw opened.error;
          return opened.value;
        },
      });

      context.commands.register<{ sessionId: Id }, void>({
        id: AUTHORING_COMMANDS.discardSession,
        title: "Discard authoring session",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: async ({ sessionId }) => {
          const discarded = await sessions.discard(sessionId);
          if (!discarded.ok) throw discarded.error;
        },
      });

      context.commands.register<{ operations: readonly EditOperation[] }, unknown>({
        id: "authoring.edit.apply",
        title: "Apply edits",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: async ({ operations }) => {
          const applied = await edits.apply(operations);
          if (!applied.ok) throw applied.error;
          return applied.value;
        },
      });

      context.commands.register<{ sessionId: Id; version: string; requireUpToDate?: boolean }, unknown>({
        id: AUTHORING_COMMANDS.publish,
        title: "Publish",
        permission: AUTHORING_PERMISSIONS.publish,
        handler: async ({ sessionId, version, requireUpToDate }) => {
          const published = await publish.publish(sessionId, {
            version,
            ...(requireUpToDate === undefined ? {} : { requireUpToDate }),
          });
          if (!published.ok) throw published.error;
          return published.value;
        },
      });

      context.commands.register<Record<string, never>, void>({
        id: AUTHORING_COMMANDS.undo,
        title: "Undo edit",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: async () => {
          const undone = await history.undo();
          if (!undone.ok) throw undone.error;
        },
      });

      context.commands.register<Record<string, never>, void>({
        id: AUTHORING_COMMANDS.redo,
        title: "Redo edit",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: async () => {
          const redone = await history.redo();
          if (!redone.ok) throw redone.error;
        },
      });

      context.commands.register<{ planeId: Id }, void>({
        id: AUTHORING_COMMANDS.setActiveSketchPlane,
        title: "Set sketch plane",
        permission: AUTHORING_PERMISSIONS.edit,
        handler: ({ planeId }) => {
          const set = planes.setActive(planeId);
          if (!set.ok) throw set.error;
        },
      });

      context.ui.register({ id: "authoring.panel", point: "panel", title: "Authoring", placement: "left", order: 25 });
      context.ui.register({
        id: "authoring.toolbar.publish",
        point: "toolbar",
        title: "Publish",
        group: "authoring",
        order: 90,
        commandId: AUTHORING_COMMANDS.publish,
      });

      context.logger.info("Authoring ready");
    },
  });
}

export const authoringPlugin = createAuthoringPlugin();
