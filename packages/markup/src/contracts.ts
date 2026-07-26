/**
 * `@massingifc/markup` — first-class markup, issues and review contracts.
 *
 * Markup is a capability family rather than a viewer overlay because everything else consumes it:
 * a clash becomes an issue, a field inspection attaches a redline, a change impact cites a review
 * snapshot. Anchoring, threading and status flow therefore belong to a shared contract, not to
 * whichever plugin happened to draw the pin.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  AnchorReference,
  CommentRecord,
  CommentThread,
  ElementRef,
  Id,
  IssueRecord,
  MarkupRecord,
  MarkupStatus,
  ReviewSession,
  ReviewSnapshot,
} from "@massingifc/project-schema";

/**
 * Tells markup whether an element still exists.
 *
 * Provided by whatever owns loaded models. Markup must not import the viewer — it has to work in a
 * headless review service and a test — so the one thing it genuinely needs from the runtime is
 * behind this port.
 */
export interface ElementResolver {
  exists(modelId: Id, globalId: string): boolean;
  /** Elements present in a model, used to re-anchor after a revision. */
  globalIds(modelId: Id): readonly string[];
}

export const ElementResolverToken = createCapabilityToken<ElementResolver>("markup.element-resolver");

/** Supplies and restores camera state for review snapshots. */
export interface ViewpointProvider {
  capture(name?: string): Promise<Result<{ readonly id: Id }>>;
  apply(viewpointId: Id): Promise<Result<void>>;
}

export const ViewpointProviderToken =
  createCapabilityToken<ViewpointProvider>("markup.viewpoint-provider");

/**
 * Permitted issue status moves.
 *
 * An explicit matrix rather than free assignment: "closed" going straight back to "resolved"
 * without passing through "open" loses the fact that it was reopened, and status histories that
 * cannot be trusted are the reason people stop using issue tracking in a model.
 */
export const ISSUE_TRANSITIONS: Readonly<Record<MarkupStatus, readonly MarkupStatus[]>> =
  Object.freeze({
    open: ["in-review", "resolved", "closed"],
    "in-review": ["open", "resolved"],
    resolved: ["open", "closed"],
    closed: ["open"],
  });

export interface MarkupQuery {
  readonly modelId?: Id;
  readonly viewpointId?: Id;
  readonly status?: MarkupStatus;
  readonly assignee?: Id;
  readonly kind?: MarkupRecord["kind"];
}

export interface MarkupService {
  create(markup: Omit<MarkupRecord, "id" | "createdAt">): Promise<Result<MarkupRecord>>;
  update(id: Id, changes: Partial<MarkupRecord>): Promise<Result<MarkupRecord>>;
  remove(id: Id): Promise<Result<void>>;
  get(id: Id): MarkupRecord | undefined;
  query(query?: MarkupQuery): readonly MarkupRecord[];
}

export const MarkupToken = createCapabilityToken<MarkupService>("markup.service");

/**
 * Keeps markup attached as models change.
 *
 * `reanchor` runs after a model revision. Markup that can no longer bind is reported as orphaned
 * rather than being quietly moved or deleted — a pin that silently relocates is worse than one
 * that admits it has lost its target, because the reviewer cannot tell it happened.
 */
export interface AnchorService {
  anchor(markupId: Id, target: { element?: ElementRef; worldPosition?: readonly number[] }): Promise<Result<AnchorReference>>;
  resolve(markupId: Id): AnchorReference | undefined;
  reanchor(modelId: Id): Promise<Result<{ readonly resolved: number; readonly orphaned: readonly Id[] }>>;
  orphaned(): readonly AnchorReference[];
}

export const AnchorToken = createCapabilityToken<AnchorService>("markup.anchors");

export interface IssueService {
  create(issue: Omit<IssueRecord, "id" | "createdAt">): Promise<Result<IssueRecord>>;
  update(id: Id, changes: Partial<IssueRecord>): Promise<Result<IssueRecord>>;
  transition(id: Id, status: MarkupStatus, note?: string): Promise<Result<IssueRecord>>;
  assign(id: Id, assignee: Id): Promise<Result<IssueRecord>>;
  get(id: Id): IssueRecord | undefined;
  query(query?: {
    readonly status?: MarkupStatus;
    readonly assignee?: Id;
    readonly responsibility?: string;
    readonly overdue?: boolean;
  }): readonly IssueRecord[];
}

export const IssueToken = createCapabilityToken<IssueService>("markup.issues");

export interface CommentService {
  thread(subjectId: Id, subjectKind: string): CommentThread | undefined;
  post(subjectId: Id, subjectKind: string, body: string): Promise<Result<CommentRecord>>;
  edit(commentId: Id, body: string): Promise<Result<CommentRecord>>;
  resolveThread(threadId: Id): Promise<Result<CommentThread>>;
}

export const CommentToken = createCapabilityToken<CommentService>("markup.comments");

export interface ReviewService {
  snapshot(name?: string): Promise<Result<ReviewSnapshot>>;
  /** Restores the models, viewpoint and markup captured at review time. */
  restore(snapshotId: Id): Promise<Result<void>>;
  startSession(name: string, participants: readonly Id[]): Promise<Result<ReviewSession>>;
  endSession(sessionId: Id): Promise<Result<ReviewSession>>;
  sessions(): readonly ReviewSession[];
}

export const ReviewToken = createCapabilityToken<ReviewService>("markup.review");

export interface MarkupEvents {
  "markup.created": { readonly markup: MarkupRecord };
  "markup.updated": { readonly markup: MarkupRecord };
  "markup.removed": { readonly markupId: Id };
  "markup.orphaned": { readonly markupIds: readonly Id[] };
  "issue.created": { readonly issue: IssueRecord };
  "issue.transitioned": { readonly issue: IssueRecord; readonly from: MarkupStatus };
}

export const MARKUP_COMMANDS = {
  createPin: "markup.pin.create",
  createRedline: "markup.redline.create",
  removeMarkup: "markup.remove",
  createIssue: "markup.issue.create",
  assignIssue: "markup.issue.assign",
  transitionIssue: "markup.issue.transition",
  captureSnapshot: "markup.review.snapshot",
} as const;

export const MARKUP_PERMISSIONS = {
  create: "markup.create",
  edit: "markup.edit",
  delete: "markup.delete",
  assign: "markup.issue.assign",
  resolve: "markup.issue.resolve",
} as const;
