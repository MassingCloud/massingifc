import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  Id,
  Matrix4,
  ModelRecord,
  ProjectRecord,
  SessionStateRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  FederationService,
  ModelLoadState,
  ModelLoaderPort,
  SessionStateService,
} from "./contracts.js";

export interface FederationStores {
  readonly project: ReturnType<typeof createProjectSlice>;
  readonly models: RecordStore<ModelRecord>;
  readonly states: RecordStore<ModelLoadStateRecord>;
}

/** `ModelLoadState` with an id, so it can live in a record store keyed by model. */
export interface ModelLoadStateRecord extends ModelLoadState {
  readonly id: Id;
}

function createProjectSlice(context: PluginContext) {
  return context.state.defineSlice<ProjectRecord | undefined>("project", undefined);
}

export interface FederationRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly loader: () => ModelLoaderPort | undefined;
}

export function createFederationStores(context: PluginContext): FederationStores {
  return {
    project: createProjectSlice(context),
    models: createRecordStore<ModelRecord>(context.state, "models"),
    states: createRecordStore<ModelLoadStateRecord>(context.state, "load-states"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

export function createFederationService(
  runtime: FederationRuntime,
  stores: FederationStores,
): FederationService {
  const setState = (modelId: Id, changes: Partial<ModelLoadState>): ModelLoadStateRecord => {
    const existing = stores.states.get(modelId);
    const next: ModelLoadStateRecord = existing
      ? { ...existing, ...changes }
      : { id: modelId, modelId, status: "unloaded", visible: true, ...changes };
    if (existing) stores.states.replace(next);
    else stores.states.add(next);
    runtime.context.events.emit("federation.model.state", { state: next });
    return next;
  };

  const load = async (modelId: Id): Promise<Result<void>> => {
    const record = stores.models.get(modelId);
    if (!record) return err(notFound("model", modelId));

    const loader = runtime.loader();
    if (!loader) {
      return err(new KernelError("CAPABILITY_NOT_FOUND", "No model loader is installed.", {}));
    }
    if (stores.states.get(modelId)?.status === "loaded") return ok(undefined);

    setState(modelId, { status: "loading" });
    const loaded = await loader.load(record);
    if (!loaded.ok) {
      // The failure is recorded on the model rather than thrown away, so a partially-loaded
      // federation can show which discipline is missing instead of just looking incomplete.
      setState(modelId, { status: "failed", error: loaded.error.message });
      return err(loaded.error);
    }

    setState(modelId, {
      status: "loaded",
      loadedAt: runtime.clock.timestamp(),
      visible: record.visible ?? true,
    });
    runtime.context.events.emit("federation.model.loaded", { modelId });
    return ok(undefined);
  };

  const unload = async (modelId: Id): Promise<Result<void>> => {
    if (!stores.models.has(modelId)) return err(notFound("model", modelId));
    const loader = runtime.loader();
    if (loader) {
      const unloaded = await loader.unload(modelId);
      if (!unloaded.ok) return err(unloaded.error);
    }
    setState(modelId, { status: "unloaded" });
    return ok(undefined);
  };

  return {
    async openProject(project) {
      stores.project.set(project);
      stores.models.clear();
      stores.states.clear();
      runtime.context.events.emit("federation.project.opened", { project });
      return ok(undefined);
    },

    async closeProject() {
      const loader = runtime.loader();
      for (const state of stores.states.query((entry) => entry.status === "loaded")) {
        if (loader) await loader.unload(state.modelId);
      }
      stores.project.set(undefined);
      stores.models.clear();
      stores.states.clear();
      runtime.context.events.emit("federation.project.closed", {});
      return ok(undefined);
    },

    currentProject: () => stores.project.get(),

    async addModel(record) {
      if (stores.models.has(record.id)) {
        return err(
          new KernelError("COMMAND_FAILED", `Model "${record.id}" is already in the project.`, {
            modelId: record.id,
          }),
        );
      }
      stores.models.add(record);
      setState(record.id, { status: "unloaded", visible: record.visible ?? true });
      return ok(undefined);
    },

    async removeModel(modelId) {
      if (!stores.models.has(modelId)) return err(notFound("model", modelId));
      await unload(modelId);
      stores.models.remove(modelId);
      stores.states.remove(modelId);
      return ok(undefined);
    },

    models: () => stores.models.all(),
    load,
    unload,

    async loadDefaults() {
      const targets = stores.models.query((record) => record.loadByDefault !== false);
      for (const record of targets) {
        // Each model's outcome is recorded and the rest still load — one unavailable consultant
        // model must not stop a coordination session from opening.
        await load(record.id);
      }
      return ok(stores.states.all());
    },

    state: (modelId) => stores.states.get(modelId),
    states: () => stores.states.all(),

    setVisible(modelId, visible) {
      if (stores.states.has(modelId)) setState(modelId, { visible });
      stores.models.update(modelId, { visible });
    },

    async setTransform(modelId, transform: Matrix4) {
      const record = stores.models.get(modelId);
      if (!record) return err(notFound("model", modelId));

      stores.models.update(modelId, { transform: [...transform] });
      const loader = runtime.loader();
      if (loader && stores.states.get(modelId)?.status === "loaded") {
        const applied = await loader.setTransform(modelId, transform);
        if (!applied.ok) return err(applied.error);
      }
      return ok(undefined);
    },

    async replaceRevision(modelId, record) {
      const existing = stores.models.get(modelId);
      if (!existing) return err(notFound("model", modelId));

      const wasLoaded = stores.states.get(modelId)?.status === "loaded";
      if (wasLoaded) {
        const unloaded = await unload(modelId);
        if (!unloaded.ok) return err(unloaded.error);
      }

      // The id is preserved deliberately. Markup anchors, clash results, 4D links and takeoff
      // rules all reference models by id; issuing a revision as a new model would orphan every
      // one of them.
      stores.models.replace({ ...record, id: modelId });

      if (wasLoaded) {
        const reloaded = await load(modelId);
        if (!reloaded.ok) return err(reloaded.error);
      }

      // Emitted after the new revision is in place, so listeners that re-resolve against the
      // model — markup anchors, 4D rule links — see the new content, not the old.
      runtime.context.events.emit("federation.model.revised", {
        modelId,
        version: record.version,
      });
      return ok(undefined);
    },
  };
}

export function createSessionStateService(
  runtime: FederationRuntime,
  stores: FederationStores,
): SessionStateService {
  return {
    async capture() {
      const project = stores.project.get();
      if (!project) {
        return err(new KernelError("COMMAND_FAILED", "No project is open.", {}));
      }
      const record: SessionStateRecord = {
        id: runtime.ids.next("session"),
        projectId: project.id,
        loadedModelIds: stores.states
          .query((state) => state.status === "loaded")
          .map((state) => state.modelId),
        savedAt: runtime.clock.timestamp(),
        savedBy: runtime.context.permissions.identity.id,
      };
      return ok(record);
    },

    async restore(state) {
      const project = stores.project.get();
      if (!project || project.id !== state.projectId) {
        return err(
          new KernelError("COMMAND_FAILED", "The saved session belongs to a different project.", {
            expected: project?.id,
            found: state.projectId,
          }),
        );
      }

      const federation = createFederationService(runtime, stores);
      for (const modelId of state.loadedModelIds) {
        // Reopening a federated project should not mean reloading twelve models and re-hiding
        // nine of them, which is why load state is persisted rather than reconstructed.
        if (stores.models.has(modelId)) await federation.load(modelId);
      }
      return ok(undefined);
    },
  };
}
