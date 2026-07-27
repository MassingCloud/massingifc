import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type { ElementRef, Id, Vec3 } from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import {
  intersectRayPlane,
  levelPlane,
  planeBasis,
  snapToPlaneGrid,
  type PlaneBasis,
} from "./sketch.js";
import type {
  AuthoringSession,
  AuthoringSessionService,
  ConstraintRecord,
  ConstraintService,
  EditCommandService,
  EditHistoryEntry,
  EditHistoryService,
  EditOperation,
  GeometryBackend,
  LevelSource,
  PublishOptions,
  PublishResult,
  PublishService,
  SketchPlane,
  SketchPlaneService,
} from "./contracts.js";

export interface AuthoringStores {
  readonly sessions: RecordStore<AuthoringSession>;
  readonly history: RecordStore<EditHistoryEntry>;
  readonly constraints: RecordStore<ConstraintRecord>;
  readonly planes: RecordStore<SketchPlane>;
}

export interface AuthoringRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly geometry: () => GeometryBackend | undefined;
  readonly levels: () => LevelSource | undefined;
}

export function createAuthoringStores(context: PluginContext): AuthoringStores {
  return {
    sessions: createRecordStore<AuthoringSession>(context.state, "sessions"),
    history: createRecordStore<EditHistoryEntry>(context.state, "history"),
    constraints: createRecordStore<ConstraintRecord>(context.state, "constraints"),
    planes: createRecordStore<SketchPlane>(context.state, "sketch-planes"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

const noBackend = (): KernelError =>
  new KernelError("CAPABILITY_NOT_FOUND", "No geometry backend is installed.", {});

const elementKey = (element: ElementRef): string => `${element.modelId}/${element.globalId}`;

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export function createAuthoringSessionService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
): AuthoringSessionService {
  const openSession = (): AuthoringSession | undefined =>
    stores.sessions.find((session) => session.status === "open");

  return {
    async open(modelId) {
      const existing = openSession();
      if (existing) {
        // Two concurrent sessions on one project would produce two change sets with no defined
        // merge, so the second is refused rather than silently interleaved with the first.
        return err(
          new KernelError("COMMAND_FAILED", `An authoring session is already open on "${existing.modelId}".`, {
            sessionId: existing.id,
          }),
        );
      }
      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      const baseVersion = backend.currentVersion(modelId);
      if (baseVersion === undefined) return err(notFound("model", modelId));

      const session: AuthoringSession = {
        id: runtime.ids.next("session"),
        modelId,
        status: "open",
        startedAt: runtime.clock.timestamp(),
        startedBy: runtime.context.permissions.identity.id,
        changeCount: 0,
        baseVersion,
      };
      stores.sessions.add(session);
      runtime.context.events.emit("authoring.session.opened", { session });
      return ok(session);
    },

    current: () => openSession(),

    async discard(sessionId) {
      const session = stores.sessions.get(sessionId);
      if (!session) return err(notFound("session", sessionId));

      // Reverses the edits before dropping the record. Marking a session discarded without undoing
      // its work would leave the model holding changes nobody agreed to publish.
      const backend = runtime.geometry();
      const entries = stores.history
        .query((entry) => entry.sessionId === sessionId)
        .slice()
        .reverse();
      if (backend) {
        for (const entry of entries) {
          await backend.revert(entry.operations);
        }
      }
      stores.history.removeWhere((entry) => entry.sessionId === sessionId);
      stores.sessions.update(sessionId, { status: "discarded", changeCount: 0 });
      return ok(undefined);
    },

    async close(sessionId) {
      const session = stores.sessions.get(sessionId);
      if (!session) return err(notFound("session", sessionId));
      const updated = stores.sessions.update(sessionId, { status: "published" });
      return updated ? ok(updated) : err(notFound("session", sessionId));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

export function validateOperations(operations: readonly EditOperation[]): readonly string[] {
  const problems: string[] = [];
  for (const [index, operation] of operations.entries()) {
    const at = `operation ${index + 1}`;
    switch (operation.kind) {
      case "create-element":
        if (!operation.geometry) problems.push(`${at}: create-element needs geometry.`);
        break;
      case "delete-element":
      case "set-property":
      case "replace-geometry":
        if (!operation.element) problems.push(`${at}: ${operation.kind} needs an element.`);
        break;
      case "move-element":
        if (!operation.element) problems.push(`${at}: move-element needs an element.`);
        if (!operation.transform || operation.transform.length !== 16) {
          problems.push(`${at}: move-element needs a 4x4 transform.`);
        }
        break;
      default:
        problems.push(`${at}: unknown operation kind.`);
    }
    if (operation.kind === "set-property" && !operation.properties) {
      problems.push(`${at}: set-property needs properties.`);
    }
  }
  return problems;
}

export function createEditCommandService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
  sessions: AuthoringSessionService,
): EditCommandService {
  return {
    canApply(operations) {
      if (!sessions.current()) {
        return err(new KernelError("COMMAND_FAILED", "No authoring session is open.", {}));
      }
      const problems = validateOperations(operations);
      return problems.length === 0
        ? ok(undefined)
        : err(new KernelError("COMMAND_FAILED", problems.join(" "), { problems }));
    },

    async apply(operations) {
      const allowed = this.canApply(operations);
      if (!allowed.ok) return err(allowed.error);

      const backend = runtime.geometry();
      if (!backend) return err(noBackend());
      const session = sessions.current()!;

      const applied = await backend.apply(operations);
      if (!applied.ok) return err(applied.error);

      stores.history.add({
        id: runtime.ids.next("edit"),
        sessionId: session.id,
        label: `${operations.length} edit${operations.length === 1 ? "" : "s"}`,
        operations: [...operations],
        at: runtime.clock.timestamp(),
        by: runtime.context.permissions.identity.id,
      });
      stores.sessions.update(session.id, { changeCount: session.changeCount + operations.length });
      runtime.context.events.emit("authoring.edit.applied", { operations });
      return ok(applied.value);
    },
  };
}

export function createEditHistoryService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
  sessions: AuthoringSessionService,
): EditHistoryService {
  /** Entries reversed by undo, newest first, awaiting redo. */
  const redoStack: EditHistoryEntry[] = [];

  const current = (): readonly EditHistoryEntry[] => {
    const session = sessions.current();
    return session ? stores.history.query((entry) => entry.sessionId === session.id) : [];
  };

  return {
    entries: () => current(),
    canUndo: () => current().length > 0,
    canRedo: () => redoStack.length > 0,

    async undo() {
      const entries = current();
      const last = entries[entries.length - 1];
      if (!last) return err(new KernelError("COMMAND_FAILED", "Nothing to undo.", {}));

      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      const reverted = await backend.revert(last.operations);
      if (!reverted.ok) return err(reverted.error);

      stores.history.remove(last.id);
      redoStack.push(last);
      const session = sessions.current();
      if (session) {
        stores.sessions.update(session.id, {
          changeCount: Math.max(0, session.changeCount - last.operations.length),
        });
      }
      return ok(undefined);
    },

    async redo() {
      const entry = redoStack.pop();
      if (!entry) return err(new KernelError("COMMAND_FAILED", "Nothing to redo.", {}));

      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      const applied = await backend.apply(entry.operations);
      if (!applied.ok) {
        // Put it back rather than dropping it: a redo that fails must not silently consume the
        // entry, or the user loses the ability to try again.
        redoStack.push(entry);
        return err(applied.error);
      }
      stores.history.add(entry);
      return ok(undefined);
    },

    async coalesce(label, entryIds) {
      const entries = current().filter((entry) => entryIds.includes(entry.id));
      if (entries.length === 0) {
        return err(new KernelError("COMMAND_FAILED", "No matching history entries.", { entryIds }));
      }
      // A drag emits many moves; collapsing them means one undo reverses the gesture the user
      // actually performed rather than one frame of it.
      const merged: EditHistoryEntry = {
        id: runtime.ids.next("edit"),
        sessionId: entries[0]!.sessionId,
        label,
        operations: entries.flatMap((entry) => entry.operations),
        at: entries[entries.length - 1]!.at,
        by: entries[0]!.by,
      };
      for (const entry of entries) stores.history.remove(entry.id);
      stores.history.add(merged);
      return ok(merged);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------

export function createPublishService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
  sessions: AuthoringSessionService,
): PublishService {
  const touched = (sessionId: Id): ElementRef[] => {
    const seen = new Map<string, ElementRef>();
    for (const entry of stores.history.query((e) => e.sessionId === sessionId)) {
      for (const operation of entry.operations) {
        if (operation.element) seen.set(elementKey(operation.element), operation.element);
      }
    }
    return [...seen.values()];
  };

  return {
    async preview(sessionId) {
      const session = stores.sessions.get(sessionId);
      if (!session) return err(notFound("session", sessionId));

      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      const changed = touched(sessionId);
      const current = backend.currentVersion(session.modelId);
      // A conflict is an element this session edited that somebody else also changed since the
      // session opened. If the base has not moved, nothing can conflict.
      const conflicts =
        current === session.baseVersion
          ? []
          : changed.filter((element) => backend.changedSince(element, session.baseVersion));

      return ok({ changed, conflicts });
    },

    async publish(sessionId, options: PublishOptions) {
      const session = stores.sessions.get(sessionId);
      if (!session) return err(notFound("session", sessionId));
      if (session.status !== "open") {
        return err(
          new KernelError("COMMAND_FAILED", `Session "${sessionId}" is ${session.status}.`, {
            sessionId,
            status: session.status,
          }),
        );
      }

      const preview = await this.preview(sessionId);
      if (!preview.ok) return err(preview.error);

      if ((options.requireUpToDate ?? true) && preview.value.conflicts.length > 0) {
        // Publishing over someone else's change silently is the failure mode that destroys trust
        // in a shared model, so it is refused by default and has to be overridden explicitly.
        return err(
          new KernelError(
            "COMMAND_FAILED",
            `${preview.value.conflicts.length} element(s) changed since this session opened.`,
            {
              sessionId,
              conflicts: preview.value.conflicts.map((element) => element.globalId),
            },
          ),
        );
      }

      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      const published = await backend.publish(session.modelId, options.version);
      if (!published.ok) return err(published.error);

      stores.sessions.update(sessionId, { status: "published" });
      const result: PublishResult = {
        modelId: session.modelId,
        version: options.version,
        publishedAt: runtime.clock.timestamp(),
        changedElements: preview.value.changed.length,
      };
      runtime.context.events.emit("authoring.session.published", { result });
      return ok(result);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------

export function createConstraintService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
): ConstraintService {
  return {
    async add(constraint) {
      if (constraint.targets.length === 0) {
        return err(new KernelError("COMMAND_FAILED", "A constraint needs at least one target.", {}));
      }
      if (
        (constraint.kind === "distance" || constraint.kind === "angle") &&
        constraint.value === undefined
      ) {
        return err(
          new KernelError("COMMAND_FAILED", `A ${constraint.kind} constraint needs a value.`, {}),
        );
      }
      const record: ConstraintRecord = {
        ...constraint,
        id: runtime.ids.next("constraint"),
        satisfied: true,
      };
      stores.constraints.add(record);
      return ok(record);
    },

    async remove(constraintId) {
      return stores.constraints.remove(constraintId)
        ? ok(undefined)
        : err(notFound("constraint", constraintId));
    },

    async solve() {
      const backend = runtime.geometry();
      if (!backend) return err(noBackend());

      let satisfied = 0;
      const violated: Id[] = [];

      for (const constraint of stores.constraints.all()) {
        const holds = backend.evaluateConstraint(constraint);
        stores.constraints.update(constraint.id, { satisfied: holds });
        if (holds) satisfied++;
        else violated.push(constraint.id);
      }

      if (violated.length > 0) {
        // Reported rather than thrown: a violated constraint is information the user acts on, and
        // an editor that refuses to continue until every constraint holds is unusable mid-edit.
        runtime.context.events.emit("authoring.constraints.violated", { constraintIds: violated });
      }
      return ok({ satisfied, violated });
    },

    list: () => stores.constraints.all(),
  };
}

// ---------------------------------------------------------------------------------------------
// Sketch planes
// ---------------------------------------------------------------------------------------------

export function createSketchPlaneService(
  runtime: AuthoringRuntime,
  stores: AuthoringStores,
  options: { readonly gridSpacing?: number } = {},
): SketchPlaneService & { basisOf(planeId: Id): PlaneBasis | undefined } {
  let activeId: Id | undefined;
  const spacing = options.gridSpacing ?? 0;

  const basisFor = (plane: SketchPlane): PlaneBasis | undefined =>
    planeBasis(plane.origin, plane.normal, plane.xAxis);

  return {
    create(plane) {
      const record: SketchPlane = { ...plane, id: runtime.ids.next("plane") };
      stores.planes.add(record);
      if (!activeId) activeId = record.id;
      return record;
    },

    setActive(planeId) {
      if (!stores.planes.has(planeId)) return err(notFound("sketch plane", planeId));
      activeId = planeId;
      return ok(undefined);
    },

    active: () => (activeId === undefined ? undefined : stores.planes.get(activeId)),

    fromLevel(levelId) {
      const source = runtime.levels();
      if (!source) {
        return err(new KernelError("CAPABILITY_NOT_FOUND", "No level source is installed.", {}));
      }
      const level = source.levels().find((candidate) => candidate.id === levelId);
      if (!level) return err(notFound("level", levelId));

      const basis = levelPlane(level.elevation);
      const record: SketchPlane = {
        id: runtime.ids.next("plane"),
        origin: basis.origin,
        normal: basis.normal,
        xAxis: basis.xAxis,
        levelId,
        name: level.name,
      };
      stores.planes.add(record);
      activeId = record.id;
      return ok(record);
    },

    /**
     * Projects a screen ray onto the active plane.
     *
     * The caller supplies the ray because unprojecting a screen point needs the camera, which this
     * package must not know about. What it owns is the intersection and the grid snap.
     */
    project(screen) {
      const plane = activeId === undefined ? undefined : stores.planes.get(activeId);
      if (!plane) {
        return err(new KernelError("COMMAND_FAILED", "No sketch plane is active.", {}));
      }
      const basis = basisFor(plane);
      if (!basis) {
        return err(
          new KernelError("COMMAND_FAILED", `Sketch plane "${plane.id}" has a degenerate normal.`, {
            planeId: plane.id,
          }),
        );
      }

      const ray = screen as unknown as { origin?: Vec3; direction?: Vec3; x: number; y: number };
      // Without a camera ray the only honest interpretation of a screen point is plane-local
      // coordinates, which is exactly what a 2D sketch view supplies.
      if (!ray.origin || !ray.direction) {
        const point = { u: ray.x, v: ray.y };
        const world = snapToPlaneGrid(
          [
            basis.origin[0] + basis.xAxis[0] * point.u + basis.yAxis[0] * point.v,
            basis.origin[1] + basis.xAxis[1] * point.u + basis.yAxis[1] * point.v,
            basis.origin[2] + basis.xAxis[2] * point.u + basis.yAxis[2] * point.v,
          ],
          basis,
          spacing,
        );
        return ok(world);
      }

      const hit = intersectRayPlane(ray.origin, ray.direction, basis);
      if (!hit) {
        return err(
          new KernelError("COMMAND_FAILED", "The ray does not meet the sketch plane.", {}),
        );
      }
      return ok(snapToPlaneGrid(hit, basis, spacing));
    },

    list: () => stores.planes.all(),

    basisOf(planeId) {
      const plane = stores.planes.get(planeId);
      return plane ? basisFor(plane) : undefined;
    },
  };
}
