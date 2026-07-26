import type { Id, IssueRecord, MarkupRecord, MarkupStatus } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  AnchorToken,
  CommentToken,
  ElementResolverToken,
  IssueToken,
  MarkupToken,
  MARKUP_COMMANDS,
  MARKUP_PERMISSIONS,
  ReviewToken,
  ViewpointProviderToken,
} from "./contracts.js";
import {
  createAnchorService,
  createCommentService,
  createIssueService,
  createMarkupService,
  createMarkupStores,
  createReviewService,
  type ModelVersionProvider,
} from "./services.js";

export interface MarkupPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Model revisions captured into review snapshots. Supplied by the host's federation layer. */
  readonly modelVersions?: ModelVersionProvider;
}

/**
 * Markup, issues and review, packaged as a plugin.
 *
 * Everything the viewer would normally provide — whether an element still exists, how to capture a
 * viewpoint — arrives through capabilities rather than imports, so this runs unchanged in a browser
 * session, a headless review service and a test.
 */
export function createMarkupPlugin(options: MarkupPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const modelVersions = options.modelVersions ?? (() => []);

  return definePlugin({
    id: "massingifc.markup",
    version: "0.1.0",
    name: "Markup & issues",
    description: "Pins, redlines, anchored issues, comment threads and review snapshots.",
    permissions: Object.values(MARKUP_PERMISSIONS),

    activate(context) {
      const stores = createMarkupStores(context);
      const runtime = {
        context,
        clock,
        ids,
        elements: () => context.capabilities.get(ElementResolverToken),
        viewpoints: () => context.capabilities.get(ViewpointProviderToken),
      };

      const markups = createMarkupService(runtime, stores);
      const anchors = createAnchorService(runtime, stores);
      const issues = createIssueService(runtime, stores);
      const comments = createCommentService(runtime, stores);
      const review = createReviewService(runtime, stores, modelVersions);

      context.capabilities.provide(MarkupToken, markups, { version: "0.1.0" });
      context.capabilities.provide(AnchorToken, anchors, { version: "0.1.0" });
      context.capabilities.provide(IssueToken, issues, { version: "0.1.0" });
      context.capabilities.provide(CommentToken, comments, { version: "0.1.0" });
      context.capabilities.provide(ReviewToken, review, { version: "0.1.0" });

      // A model revision is the moment anchors can break, so re-anchoring is driven by the event
      // rather than left for someone to remember to call.
      context.events.on("federation.model.revised", (payload) => {
        const modelId = (payload as { modelId?: Id }).modelId;
        if (modelId) void anchors.reanchor(modelId);
      });

      context.commands.register<Omit<MarkupRecord, "id" | "createdAt">, MarkupRecord>({
        id: MARKUP_COMMANDS.createPin,
        title: "Add pin",
        permission: MARKUP_PERMISSIONS.create,
        handler: async (params) => {
          const created = await markups.create({ ...params, kind: "pin" });
          if (!created.ok) throw created.error;
          return created.value;
        },
        createInverse: (_params, record) => ({
          commandId: MARKUP_COMMANDS.removeMarkup,
          params: { id: record.id },
        }),
      });

      context.commands.register<Omit<MarkupRecord, "id" | "createdAt">, MarkupRecord>({
        id: MARKUP_COMMANDS.createRedline,
        title: "Add redline",
        permission: MARKUP_PERMISSIONS.create,
        handler: async (params) => {
          const created = await markups.create({ ...params, kind: "redline" });
          if (!created.ok) throw created.error;
          return created.value;
        },
        createInverse: (_params, record) => ({
          commandId: MARKUP_COMMANDS.removeMarkup,
          params: { id: record.id },
        }),
      });

      context.commands.register<{ id: Id }, MarkupRecord | undefined>({
        id: MARKUP_COMMANDS.removeMarkup,
        title: "Delete markup",
        permission: MARKUP_PERMISSIONS.delete,
        handler: async ({ id }) => {
          const snapshot = markups.get(id);
          const removed = await markups.remove(id);
          if (!removed.ok) throw removed.error;
          return snapshot;
        },
        createInverse: (_params, snapshot) =>
          snapshot === undefined
            ? undefined
            : { commandId: "markup.restore", params: { record: snapshot } },
      });

      context.commands.register<{ record: MarkupRecord }, void>({
        id: "markup.restore",
        permission: MARKUP_PERMISSIONS.create,
        handler: ({ record }) => {
          // Restores the original record verbatim, including its id, so anything referencing the
          // markup keeps working after an undo.
          if (!markups.get(record.id)) stores.markups.add(record);
        },
        createInverse: (params) => ({
          commandId: MARKUP_COMMANDS.removeMarkup,
          params: { id: params.record.id },
        }),
      });

      context.commands.register<Omit<IssueRecord, "id" | "createdAt">, IssueRecord>({
        id: MARKUP_COMMANDS.createIssue,
        title: "Raise issue",
        permission: MARKUP_PERMISSIONS.create,
        handler: async (params) => {
          const created = await issues.create(params);
          if (!created.ok) throw created.error;
          return created.value;
        },
      });

      context.commands.register<{ id: Id; assignee: Id }, IssueRecord>({
        id: MARKUP_COMMANDS.assignIssue,
        title: "Assign issue",
        permission: MARKUP_PERMISSIONS.assign,
        handler: async ({ id, assignee }) => {
          const assigned = await issues.assign(id, assignee);
          if (!assigned.ok) throw assigned.error;
          return assigned.value;
        },
      });

      context.commands.register<
        { id: Id; status: MarkupStatus; note?: string },
        { issue: IssueRecord; from: MarkupStatus }
      >({
        id: MARKUP_COMMANDS.transitionIssue,
        title: "Change issue status",
        permission: MARKUP_PERMISSIONS.resolve,
        handler: async ({ id, status, note }) => {
          const before = issues.get(id);
          if (!before) throw new Error(`No issue with id "${id}".`);
          const moved = await issues.transition(id, status, note);
          if (!moved.ok) throw moved.error;
          return { issue: moved.value, from: before.status };
        },
        createInverse: (params, result) => ({
          commandId: MARKUP_COMMANDS.transitionIssue,
          params: { id: params.id, status: result.from },
        }),
      });

      context.commands.register<{ name?: string }, unknown>({
        id: MARKUP_COMMANDS.captureSnapshot,
        title: "Capture review snapshot",
        handler: async ({ name }) => {
          const captured = await review.snapshot(name);
          if (!captured.ok) throw captured.error;
          return captured.value;
        },
      });

      context.ui.register({ id: "markup.panel", point: "panel", title: "Markup", placement: "right", order: 10 });
      context.ui.register({ id: "markup.issues", point: "panel", title: "Issues", placement: "right", order: 20 });
      context.ui.register({
        id: "markup.toolbar.pin",
        point: "toolbar",
        title: "Add pin",
        group: "review",
        order: 10,
        commandId: MARKUP_COMMANDS.createPin,
      });

      context.logger.info("Markup capability ready");
    },
  });
}

export const markupPlugin = createMarkupPlugin();
