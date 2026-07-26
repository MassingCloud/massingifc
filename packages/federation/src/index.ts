/**
 * `@massingifc/federation` — contracts for running many models as one project.
 *
 * Federation is kept apart from the viewer runtime because the two answer different questions.
 * The runtime knows how to load a payload; federation knows which models belong to the project,
 * which revision each is at, and what should be on screen when the project opens.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  Id,
  Matrix4,
  ModelRecord,
  ProjectRecord,
  SessionStateRecord,
} from "@massingifc/project-schema";

export interface ModelLoadState {
  readonly modelId: Id;
  readonly status: "unloaded" | "loading" | "loaded" | "failed";
  readonly visible: boolean;
  readonly error?: string;
  readonly loadedAt?: string;
}

export interface FederationService {
  openProject(project: ProjectRecord): Promise<Result<void>>;
  closeProject(): Promise<Result<void>>;
  currentProject(): ProjectRecord | undefined;

  addModel(record: ModelRecord): Promise<Result<void>>;
  removeModel(modelId: Id): Promise<Result<void>>;
  models(): readonly ModelRecord[];

  load(modelId: Id): Promise<Result<void>>;
  unload(modelId: Id): Promise<Result<void>>;
  /** Loads every model flagged `loadByDefault`, reporting per-model outcomes. */
  loadDefaults(): Promise<Result<readonly ModelLoadState[]>>;
  state(modelId: Id): ModelLoadState | undefined;
  states(): readonly ModelLoadState[];

  setVisible(modelId: Id, visible: boolean): void;
  /** Re-datums a model that arrived on a different origin, without re-importing it. */
  setTransform(modelId: Id, transform: Matrix4): Promise<Result<void>>;

  /**
   * Replaces a model with a newer revision, keeping its id.
   *
   * Preserving the id is the whole point: markups, clash results, 4D links and takeoff rules all
   * reference models by id, and issuing a revision as a new model would orphan every one of them.
   */
  replaceRevision(modelId: Id, record: ModelRecord): Promise<Result<void>>;
}

export const FederationToken = createCapabilityToken<FederationService>("federation.service");

export interface SessionStateService {
  capture(): Promise<Result<SessionStateRecord>>;
  restore(state: SessionStateRecord): Promise<Result<void>>;
}

export const SessionStateToken = createCapabilityToken<SessionStateService>("federation.session");

export interface FederationEvents {
  "federation.project.opened": { readonly project: ProjectRecord };
  "federation.project.closed": Record<string, never>;
  "federation.model.state": { readonly state: ModelLoadState };
  "federation.model.revised": { readonly modelId: Id; readonly version: string };
}

export const FEDERATION_COMMANDS = {
  openProject: "federation.project.open",
  closeProject: "federation.project.close",
  addModel: "federation.model.add",
  replaceRevision: "federation.model.replace-revision",
  saveSession: "federation.session.save",
} as const;
