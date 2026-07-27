/**
 * `@massingifc/authoring` — contracts for editing models rather than only reviewing them.
 *
 * Authoring is gated behind an explicit *session*. Editing a federated project means holding a
 * working model apart from the read-only references it sits against, tracking a change set, and
 * publishing deliberately — an editor that wrote straight into the loaded model would make
 * "which version did the consultant actually receive?" unanswerable.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type { ElementRef, Id, IsoTimestamp, Matrix4, Vec3 } from "@massingifc/project-schema";

export type AuthoringSessionStatus = "open" | "publishing" | "published" | "discarded";

export interface AuthoringSession {
  readonly id: Id;
  readonly modelId: Id;
  readonly status: AuthoringSessionStatus;
  readonly startedAt: IsoTimestamp;
  readonly startedBy: Id;
  readonly changeCount: number;
  /** Base revision the session was opened against, for conflict detection at publish. */
  readonly baseVersion: string;
}

/**
 * Performs the actual geometry mutation.
 *
 * Everything above this port — session lifecycle, serializable history, conflict detection at
 * publish, constraint bookkeeping — is independent of how geometry is stored, and is testable
 * without a geometry kernel. Only the mutation itself needs one.
 */
export interface GeometryBackend {
  apply(operations: readonly EditOperation[]): Promise<Result<readonly ElementRef[]>>;
  /** Reverses a previously applied batch. Used by undo and by discarding a session. */
  revert(operations: readonly EditOperation[]): Promise<Result<void>>;
  /** Current revision of a model, or undefined if it is unknown. */
  currentVersion(modelId: Id): string | undefined;
  /** Whether an element has changed since a given revision — the basis of conflict detection. */
  changedSince(element: ElementRef, sinceVersion: string): boolean;
  publish(modelId: Id, version: string): Promise<Result<void>>;
  evaluateConstraint(constraint: ConstraintRecord): boolean;
}

export const GeometryBackendToken = createCapabilityToken<GeometryBackend>("authoring.geometry");

/** Supplies levels a sketch plane can be derived from. */
export interface LevelSource {
  levels(): readonly { readonly id: Id; readonly name: string; readonly elevation: number }[];
}

export const LevelSourceToken = createCapabilityToken<LevelSource>("authoring.levels");

export interface AuthoringSessionService {
  open(modelId: Id): Promise<Result<AuthoringSession>>;
  current(): AuthoringSession | undefined;
  discard(sessionId: Id): Promise<Result<void>>;
  close(sessionId: Id): Promise<Result<AuthoringSession>>;
}

export const AuthoringSessionToken = createCapabilityToken<AuthoringSessionService>("authoring.session");

export type EditKind =
  | "create-element"
  | "delete-element"
  | "move-element"
  | "set-property"
  | "replace-geometry";

export interface EditOperation {
  readonly kind: EditKind;
  readonly element?: ElementRef;
  readonly transform?: Matrix4;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
}

/**
 * Applies edits as reversible operations.
 *
 * Edits are expressed as data rather than as closures so that history is serializable: an edit
 * session must survive a reload, and an inverse computed as a closure cannot be written to disk.
 */
export interface EditCommandService {
  apply(operations: readonly EditOperation[]): Promise<Result<readonly ElementRef[]>>;
  /** Validates without applying — used to disable UI affordances before the user commits. */
  canApply(operations: readonly EditOperation[]): Result<void>;
}

export const EditCommandToken = createCapabilityToken<EditCommandService>("authoring.edit");

export interface EditHistoryEntry {
  readonly id: Id;
  readonly sessionId: Id;
  readonly label: string;
  readonly operations: readonly EditOperation[];
  readonly at: IsoTimestamp;
  readonly by: Id;
}

export interface EditHistoryService {
  entries(): readonly EditHistoryEntry[];
  undo(): Promise<Result<void>>;
  redo(): Promise<Result<void>>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Collapses a run of operations into one undo step, e.g. a drag that emitted many moves. */
  coalesce(label: string, entryIds: readonly Id[]): Promise<Result<EditHistoryEntry>>;
}

export const EditHistoryToken = createCapabilityToken<EditHistoryService>("authoring.history");

export interface PublishOptions {
  readonly version: string;
  readonly notes?: string;
  /** Refuse to publish if the base revision moved underneath the session. Defaults to true. */
  readonly requireUpToDate?: boolean;
}

export interface PublishResult {
  readonly modelId: Id;
  readonly version: string;
  readonly publishedAt: IsoTimestamp;
  readonly changedElements: number;
}

export interface PublishService {
  publish(sessionId: Id, options: PublishOptions): Promise<Result<PublishResult>>;
  /** Dry run: what would change, and does anything conflict. */
  preview(sessionId: Id): Promise<Result<{ readonly changed: readonly ElementRef[]; readonly conflicts: readonly ElementRef[] }>>;
}

export const PublishToken = createCapabilityToken<PublishService>("authoring.publish");

export type ConstraintKind = "coincident" | "parallel" | "perpendicular" | "distance" | "angle" | "lock";

export interface ConstraintRecord {
  readonly id: Id;
  readonly kind: ConstraintKind;
  readonly targets: readonly ElementRef[];
  readonly value?: number;
  readonly satisfied: boolean;
}

export interface ConstraintService {
  add(constraint: Omit<ConstraintRecord, "id" | "satisfied">): Promise<Result<ConstraintRecord>>;
  remove(constraintId: Id): Promise<Result<void>>;
  /** Re-solves after an edit; reports the constraints it could not satisfy rather than throwing. */
  solve(): Promise<Result<{ readonly satisfied: number; readonly violated: readonly Id[] }>>;
  list(): readonly ConstraintRecord[];
}

export const ConstraintToken = createCapabilityToken<ConstraintService>("authoring.constraints");

export interface SketchPlane {
  readonly id: Id;
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xAxis?: Vec3;
  readonly levelId?: Id;
  readonly name?: string;
}

export interface SketchPlaneService {
  create(plane: Omit<SketchPlane, "id">): SketchPlane;
  setActive(planeId: Id): Result<void>;
  active(): SketchPlane | undefined;
  /** Derives a plane from a level, the commonest way a user picks one. */
  fromLevel(levelId: Id): Result<SketchPlane>;
  /** Projects a screen ray onto the active plane — the core of sketch input. */
  project(screen: { readonly x: number; readonly y: number }): Result<Vec3>;
  list(): readonly SketchPlane[];
}

export const SketchPlaneToken = createCapabilityToken<SketchPlaneService>("authoring.sketch-plane");

export interface AuthoringEvents {
  "authoring.session.opened": { readonly session: AuthoringSession };
  "authoring.session.published": { readonly result: PublishResult };
  "authoring.edit.applied": { readonly operations: readonly EditOperation[] };
  "authoring.constraints.violated": { readonly constraintIds: readonly Id[] };
}

export const AUTHORING_COMMANDS = {
  openSession: "authoring.session.open",
  discardSession: "authoring.session.discard",
  publish: "authoring.publish",
  undo: "authoring.undo",
  redo: "authoring.redo",
  setActiveSketchPlane: "authoring.sketch-plane.activate",
} as const;

export const AUTHORING_PERMISSIONS = {
  edit: "authoring.edit",
  publish: "authoring.publish",
} as const;
