import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  AnchorReference,
  CommentRecord,
  CommentThread,
  Id,
  IssueRecord,
  MarkupRecord,
  MarkupStatus,
  ReviewSession,
  ReviewSnapshot,
  Vec3,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import {
  ISSUE_TRANSITIONS,
  type AnchorService,
  type CommentService,
  type ElementResolver,
  type IssueService,
  type MarkupQuery,
  type MarkupService,
  type ReviewService,
  type ViewpointProvider,
} from "./contracts.js";

export interface MarkupStores {
  readonly markups: RecordStore<MarkupRecord>;
  readonly anchors: RecordStore<AnchorReference>;
  readonly issues: RecordStore<IssueRecord>;
  readonly threads: RecordStore<CommentThread>;
  readonly snapshots: RecordStore<ReviewSnapshot>;
  readonly sessions: RecordStore<ReviewSession>;
}

export interface MarkupRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly elements: () => ElementResolver | undefined;
  readonly viewpoints: () => ViewpointProvider | undefined;
}

export function createMarkupStores(context: PluginContext): MarkupStores {
  return {
    markups: createRecordStore<MarkupRecord>(context.state, "markups"),
    anchors: createRecordStore<AnchorReference>(context.state, "anchors"),
    issues: createRecordStore<IssueRecord>(context.state, "issues"),
    threads: createRecordStore<CommentThread>(context.state, "threads"),
    snapshots: createRecordStore<ReviewSnapshot>(context.state, "snapshots"),
    sessions: createRecordStore<ReviewSession>(context.state, "sessions"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

const missingCapability = (what: string): KernelError =>
  new KernelError("CAPABILITY_NOT_FOUND", `No ${what} is installed.`, {});

// ---------------------------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------------------------

export function createMarkupService(runtime: MarkupRuntime, stores: MarkupStores): MarkupService {
  const matches = (record: MarkupRecord, query: MarkupQuery): boolean =>
    (query.modelId === undefined || record.modelId === query.modelId) &&
    (query.viewpointId === undefined || record.viewpointId === query.viewpointId) &&
    (query.status === undefined || record.status === query.status) &&
    (query.assignee === undefined || record.assignee === query.assignee) &&
    (query.kind === undefined || record.kind === query.kind);

  return {
    async create(markup) {
      const record: MarkupRecord = {
        ...markup,
        id: runtime.ids.next("markup"),
        createdAt: runtime.clock.timestamp(),
        status: markup.status ?? "open",
      };
      stores.markups.add(record);
      runtime.context.events.emit("markup.created", { markup: record });
      return ok(record);
    },

    async update(id, changes) {
      const updated = stores.markups.update(id, changes);
      if (!updated) return err(notFound("markup", id));
      runtime.context.events.emit("markup.updated", { markup: updated });
      return ok(updated);
    },

    async remove(id) {
      if (!stores.markups.remove(id)) return err(notFound("markup", id));
      stores.anchors.removeWhere((anchor) => anchor.markupId === id);
      // An issue that loses its last markup is not deleted — the conversation on it still matters.
      for (const issue of stores.issues.query((candidate) => candidate.markupIds.includes(id))) {
        stores.issues.update(issue.id, {
          markupIds: issue.markupIds.filter((markupId) => markupId !== id),
        });
      }
      runtime.context.events.emit("markup.removed", { markupId: id });
      return ok(undefined);
    },

    get: (id) => stores.markups.get(id),
    query: (query) => (query ? stores.markups.query((record) => matches(record, query)) : stores.markups.all()),
  };
}

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

/**
 * Keeps markup attached across model revisions.
 *
 * The rule throughout is that a lost anchor is *reported*, never quietly relocated. Markup that
 * silently snaps to the origin, or to whatever element happens to occupy the old id, is worse than
 * markup that admits it lost its target — the reviewer cannot tell the first case happened.
 */
export function createAnchorService(runtime: MarkupRuntime, stores: MarkupStores): AnchorService {
  return {
    async anchor(markupId, target) {
      const markup = stores.markups.get(markupId);
      if (!markup) return err(notFound("markup", markupId));

      const modelId = target.element?.modelId ?? markup.modelId;
      const globalId = target.element?.globalId;
      const resolver = runtime.elements();
      const resolved =
        globalId === undefined || modelId === undefined
          ? target.worldPosition !== undefined
          : (resolver?.exists(modelId, globalId) ?? true);

      // Narrowed rather than cast: a caller passing a two-element array would otherwise produce a
      // record whose type says Vec3 and whose value is not one.
      const position = target.worldPosition;
      const worldPosition: Vec3 | undefined =
        position !== undefined && position.length >= 3
          ? [position[0]!, position[1]!, position[2]!]
          : undefined;

      const record: AnchorReference = {
        id: runtime.ids.next("anchor"),
        markupId,
        resolved,
        ...(modelId === undefined ? {} : { modelId }),
        ...(globalId === undefined ? {} : { globalId }),
        ...(worldPosition === undefined ? {} : { worldPosition }),
        ...(resolved ? { resolvedAt: runtime.clock.timestamp() } : {}),
      };

      stores.anchors.removeWhere((existing) => existing.markupId === markupId);
      stores.anchors.add(record);
      return ok(record);
    },

    resolve: (markupId) => stores.anchors.find((anchor) => anchor.markupId === markupId),

    async reanchor(modelId) {
      const resolver = runtime.elements();
      if (!resolver) return err(missingCapability("element resolver"));

      const present = new Set(resolver.globalIds(modelId));
      const orphaned: Id[] = [];
      let resolved = 0;

      for (const anchor of stores.anchors.query((candidate) => candidate.modelId === modelId)) {
        // A positional anchor has nothing to lose when elements change.
        if (anchor.globalId === undefined) {
          resolved++;
          continue;
        }
        const stillThere = present.has(anchor.globalId);
        stores.anchors.update(anchor.id, {
          resolved: stillThere,
          ...(stillThere ? { resolvedAt: runtime.clock.timestamp() } : {}),
        });
        if (stillThere) resolved++;
        else orphaned.push(anchor.markupId);
      }

      if (orphaned.length > 0) {
        runtime.context.events.emit("markup.orphaned", { markupIds: orphaned });
      }
      return ok({ resolved, orphaned });
    },

    orphaned: () => stores.anchors.query((anchor) => !anchor.resolved),
  };
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

export function createIssueService(runtime: MarkupRuntime, stores: MarkupStores): IssueService {
  return {
    async create(issue) {
      const record: IssueRecord = {
        ...issue,
        id: runtime.ids.next("issue"),
        createdAt: runtime.clock.timestamp(),
      };
      stores.issues.add(record);
      runtime.context.events.emit("issue.created", { issue: record });
      return ok(record);
    },

    async update(id, changes) {
      // Status has its own transition rules; letting `update` set it would route around them.
      const { status: _ignored, ...safe } = changes;
      const updated = stores.issues.update(id, safe);
      return updated ? ok(updated) : err(notFound("issue", id));
    },

    async transition(id, status, note) {
      const issue = stores.issues.get(id);
      if (!issue) return err(notFound("issue", id));
      if (issue.status === status) return ok(issue);

      const allowed = ISSUE_TRANSITIONS[issue.status] ?? [];
      if (!allowed.includes(status)) {
        return err(
          new KernelError(
            "COMMAND_FAILED",
            `An issue cannot move from "${issue.status}" to "${status}".`,
            { issueId: id, from: issue.status, to: status, allowed },
          ),
        );
      }

      const updated = stores.issues.update(id, {
        status,
        ...(status === "closed" ? { closedAt: runtime.clock.timestamp() } : {}),
      });
      if (!updated) return err(notFound("issue", id));

      if (note) {
        stores.threads.addMany([
          {
            id: runtime.ids.next("thread"),
            subjectId: id,
            subjectKind: "issue",
            resolved: false,
            createdAt: runtime.clock.timestamp(),
            comments: [
              {
                id: runtime.ids.next("comment"),
                body: note,
                authorId: runtime.context.permissions.identity.id,
                createdAt: runtime.clock.timestamp(),
              },
            ],
          },
        ]);
      }

      runtime.context.events.emit("issue.transitioned", { issue: updated, from: issue.status });
      return ok(updated);
    },

    async assign(id, assignee) {
      const updated = stores.issues.update(id, { assignee });
      if (!updated) return err(notFound("issue", id));
      runtime.context.events.emit("issue.assigned", { issue: updated });
      return ok(updated);
    },

    get: (id) => stores.issues.get(id),

    query(query) {
      if (!query) return stores.issues.all();
      const now = runtime.clock.timestamp();
      return stores.issues.query(
        (issue) =>
          (query.status === undefined || issue.status === query.status) &&
          (query.assignee === undefined || issue.assignee === query.assignee) &&
          (query.responsibility === undefined || issue.responsibility === query.responsibility) &&
          (query.overdue === undefined ||
            // Overdue means past its date AND still actionable; a closed issue is not overdue.
            query.overdue ===
              (issue.dueDate !== undefined &&
                issue.dueDate < now &&
                issue.status !== "closed" &&
                issue.status !== "resolved")),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

export function createCommentService(runtime: MarkupRuntime, stores: MarkupStores): CommentService {
  const find = (subjectId: Id, subjectKind: string): CommentThread | undefined =>
    stores.threads.find(
      (thread) => thread.subjectId === subjectId && thread.subjectKind === subjectKind,
    );

  return {
    thread: (subjectId, subjectKind) => find(subjectId, subjectKind),

    async post(subjectId, subjectKind, body) {
      if (body.trim() === "") {
        return err(new KernelError("COMMAND_FAILED", "A comment cannot be empty.", {}));
      }
      const comment: CommentRecord = {
        id: runtime.ids.next("comment"),
        body,
        authorId: runtime.context.permissions.identity.id,
        createdAt: runtime.clock.timestamp(),
      };

      const existing = find(subjectId, subjectKind);
      if (existing) {
        stores.threads.update(existing.id, { comments: [...existing.comments, comment] });
      } else {
        stores.threads.add({
          id: runtime.ids.next("thread"),
          subjectId,
          subjectKind,
          resolved: false,
          createdAt: runtime.clock.timestamp(),
          comments: [comment],
        });
      }
      runtime.context.events.emit("comment.posted", { subjectId, comment });
      return ok(comment);
    },

    async edit(commentId, body) {
      for (const thread of stores.threads.all()) {
        const index = thread.comments.findIndex((comment) => comment.id === commentId);
        if (index === -1) continue;
        const existing = thread.comments[index]!;
        // Edits are stamped, never silent: a changed comment with an unchanged timestamp is how
        // a review record stops being evidence.
        const edited: CommentRecord = { ...existing, body, editedAt: runtime.clock.timestamp() };
        const comments = [...thread.comments];
        comments[index] = edited;
        stores.threads.update(thread.id, { comments });
        return ok(edited);
      }
      return err(notFound("comment", commentId));
    },

    async resolveThread(threadId) {
      const updated = stores.threads.update(threadId, { resolved: true });
      return updated ? ok(updated) : err(notFound("thread", threadId));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export interface ModelVersionProvider {
  (): readonly { readonly modelId: Id; readonly version: string }[];
}

export function createReviewService(
  runtime: MarkupRuntime,
  stores: MarkupStores,
  modelVersions: ModelVersionProvider,
): ReviewService {
  return {
    async snapshot(name) {
      const provider = runtime.viewpoints();
      if (!provider) return err(missingCapability("viewpoint provider"));

      const viewpoint = await provider.capture(name);
      if (!viewpoint.ok) return err(viewpoint.error);

      const record: ReviewSnapshot = {
        id: runtime.ids.next("snapshot"),
        viewpointId: viewpoint.value.id,
        // Captured, not referenced: reopening an old review must show the geometry the reviewer
        // actually saw, not whatever the model has become since.
        modelVersions: modelVersions(),
        markupIds: stores.markups.all().map((markup) => markup.id),
        createdAt: runtime.clock.timestamp(),
        createdBy: runtime.context.permissions.identity.id,
        ...(name === undefined ? {} : { name }),
      };
      stores.snapshots.add(record);
      runtime.context.events.emit("review.snapshot", { snapshot: record });
      return ok(record);
    },

    async restore(snapshotId) {
      const snapshot = stores.snapshots.get(snapshotId);
      if (!snapshot) return err(notFound("snapshot", snapshotId));

      const provider = runtime.viewpoints();
      if (!provider) return err(missingCapability("viewpoint provider"));

      const applied = await provider.apply(snapshot.viewpointId);
      if (!applied.ok) return err(applied.error);

      // Report drift rather than hiding it — the snapshot is still viewable, but the reviewer
      // needs to know the models underneath have moved on.
      const current = new Map(modelVersions().map((entry) => [entry.modelId, entry.version]));
      const drifted = snapshot.modelVersions.filter(
        (entry) => current.get(entry.modelId) !== entry.version,
      );
      if (drifted.length > 0) {
        runtime.context.events.emit("review.snapshot.drifted", {
          snapshotId,
          models: drifted.map((entry) => entry.modelId),
        });
      }
      return ok(undefined);
    },

    async startSession(name, participants) {
      const record: ReviewSession = {
        id: runtime.ids.next("session"),
        name,
        participants: [...participants],
        snapshotIds: [],
        issueIds: [],
        startedAt: runtime.clock.timestamp(),
      };
      stores.sessions.add(record);
      return ok(record);
    },

    async endSession(sessionId) {
      const session = stores.sessions.get(sessionId);
      if (!session) return err(notFound("session", sessionId));
      if (session.endedAt) return ok(session);

      const started = session.startedAt;
      const updated = stores.sessions.update(sessionId, {
        endedAt: runtime.clock.timestamp(),
        // Attribute what happened during the session, so the record is useful afterwards.
        snapshotIds: stores.snapshots
          .query((snapshot) => snapshot.createdAt >= started)
          .map((snapshot) => snapshot.id),
        issueIds: stores.issues
          .query((issue) => issue.createdAt >= started)
          .map((issue) => issue.id),
      });
      return updated ? ok(updated) : err(notFound("session", sessionId));
    },

    sessions: () => stores.sessions.all(),
  };
}
