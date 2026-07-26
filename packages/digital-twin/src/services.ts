import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  Id,
  IsoTimestamp,
  TwinAlignmentRecord,
  TwinObjectRecord,
  TwinObservationRecord,
  TwinPromotionRecord,
  TwinTimelineRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import { IDENTITY_MATRIX, solveAlignment } from "./alignment.js";
import type {
  TwinAlignmentService,
  TwinObjectFactory,
  TwinObservationService,
  TwinPromotionService,
  TwinRegistryService,
  TwinRuntimeObject,
  TwinTimelineService,
} from "./contracts.js";

export interface TwinStores {
  readonly objects: RecordStore<TwinObjectRecord>;
  readonly alignments: RecordStore<TwinAlignmentRecord>;
  readonly observations: RecordStore<TwinObservationRecord>;
  readonly timelines: RecordStore<TwinTimelineRecord>;
  readonly promotions: RecordStore<TwinPromotionRecord>;
}

export interface TwinRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly factories: () => readonly TwinObjectFactory[];
}

export function createTwinStores(context: PluginContext): TwinStores {
  return {
    objects: createRecordStore<TwinObjectRecord>(context.state, "objects"),
    alignments: createRecordStore<TwinAlignmentRecord>(context.state, "alignments"),
    observations: createRecordStore<TwinObservationRecord>(context.state, "observations"),
    timelines: createRecordStore<TwinTimelineRecord>(context.state, "timelines"),
    promotions: createRecordStore<TwinPromotionRecord>(context.state, "promotions"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

export function createTwinRegistryService(
  runtime: TwinRuntime,
  stores: TwinStores,
): TwinRegistryService {
  const materialised = new Map<Id, TwinRuntimeObject>();

  return {
    async register(record) {
      const stored: TwinObjectRecord = {
        ...record,
        transform: record.transform.length > 0 ? [...record.transform] : [...IDENTITY_MATRIX],
      };
      stores.objects.add(stored);
      runtime.context.events.emit("twin.registered", { record: stored });
      return ok(stored);
    },

    async unregister(twinObjectId) {
      const record = stores.objects.get(twinObjectId);
      if (!record) return err(notFound("twin object", twinObjectId));

      const live = materialised.get(twinObjectId);
      if (live) {
        // Disposal goes back to the factory that built it: only that factory knows whether the
        // object owns GPU resources that leak if merely dropped.
        const factory = runtime.factories().find((candidate) => candidate.kind === record.kind);
        try {
          factory?.dispose(live);
        } catch {
          // A factory that throws on teardown must not block deregistration.
        }
        materialised.delete(twinObjectId);
      }

      stores.objects.remove(twinObjectId);
      stores.observations.removeWhere((observation) => observation.twinObjectId === twinObjectId);
      stores.alignments.removeWhere((alignment) => alignment.twinObjectId === twinObjectId);
      return ok(undefined);
    },

    async materialise(twinObjectId) {
      const record = stores.objects.get(twinObjectId);
      if (!record) return err(notFound("twin object", twinObjectId));

      const existing = materialised.get(twinObjectId);
      if (existing !== undefined) return ok(existing);

      const factory = runtime.factories().find((candidate) => candidate.kind === record.kind);
      if (!factory) {
        return err(
          new KernelError("CAPABILITY_NOT_FOUND", `No factory is installed for "${record.kind}" twin objects.`, {
            kind: record.kind,
          }),
        );
      }

      const created = await factory.create(record);
      if (!created.ok) return err(created.error);
      materialised.set(twinObjectId, created.value);
      return ok(created.value);
    },

    setVisible(twinObjectId, visible) {
      stores.objects.update(twinObjectId, { visible });
    },

    get: (twinObjectId) => stores.objects.get(twinObjectId),

    list: (filter) =>
      filter === undefined
        ? stores.objects.all()
        : stores.objects.query(
            (record) =>
              (filter.kind === undefined || record.kind === filter.kind) &&
              (filter.aligned === undefined || record.aligned === filter.aligned),
          ),

    async link(twinObjectId, elements) {
      const updated = stores.objects.update(twinObjectId, { linkedElements: [...elements] });
      return updated ? ok(updated) : err(notFound("twin object", twinObjectId));
    },
  };
}

export function createTwinAlignmentService(
  runtime: TwinRuntime,
  stores: TwinStores,
): TwinAlignmentService {
  const record = (
    twinObjectId: Id,
    method: TwinAlignmentRecord["method"],
    transform: TwinAlignmentRecord["transform"],
    rmsError: number | undefined,
    controlPoints?: TwinAlignmentRecord["controlPoints"],
  ): TwinAlignmentRecord => ({
    id: runtime.ids.next("alignment"),
    twinObjectId,
    method,
    transform,
    appliedAt: runtime.clock.timestamp(),
    appliedBy: runtime.context.permissions.identity.id,
    ...(rmsError === undefined ? {} : { rmsError }),
    ...(controlPoints === undefined ? {} : { controlPoints }),
  });

  const apply = (entry: TwinAlignmentRecord): Result<TwinAlignmentRecord> => {
    const updated = stores.objects.update(entry.twinObjectId, {
      transform: entry.transform,
      aligned: true,
      // Confidence falls away as residual grows. A 5 cm registration is not the same fact as a
      // 50 cm one, and treating them alike is how a bad alignment gets trusted.
      ...(entry.rmsError === undefined
        ? {}
        : { alignmentConfidence: Math.max(0, Math.min(1, 1 / (1 + entry.rmsError))) }),
    });
    if (!updated) return err(notFound("twin object", entry.twinObjectId));
    stores.alignments.add(entry);
    runtime.context.events.emit("twin.aligned", { alignment: entry });
    return ok(entry);
  };

  return {
    async setTransform(twinObjectId, transform) {
      if (!stores.objects.has(twinObjectId)) return err(notFound("twin object", twinObjectId));
      return apply(record(twinObjectId, "manual", [...transform], undefined));
    },

    async alignByPoints(twinObjectId, pairs) {
      if (!stores.objects.has(twinObjectId)) return err(notFound("twin object", twinObjectId));
      const solution = solveAlignment(pairs);
      if (!solution) {
        return err(
          new KernelError("COMMAND_FAILED", "Alignment needs at least one control point pair.", {
            twinObjectId,
          }),
        );
      }
      return apply(
        record(
          twinObjectId,
          pairs.length >= 3 ? "three-point" : "manual",
          solution.transform,
          solution.rmsError,
          [...pairs],
        ),
      );
    },

    async refine(twinObjectId) {
      const previous = stores.alignments
        .query((entry) => entry.twinObjectId === twinObjectId)
        .at(-1);
      if (!previous?.controlPoints) {
        // Refinement without control points would be a fit to nothing; better to say so.
        return err(
          new KernelError("COMMAND_FAILED", "Nothing to refine against — no control points recorded.", {
            twinObjectId,
          }),
        );
      }
      const solution = solveAlignment(previous.controlPoints);
      if (!solution) return err(notFound("alignment", twinObjectId));
      return apply(
        record(twinObjectId, "icp", solution.transform, solution.rmsError, previous.controlPoints),
      );
    },

    history: (twinObjectId) =>
      stores.alignments.query((entry) => entry.twinObjectId === twinObjectId),

    async revert(alignmentId) {
      const entry = stores.alignments.get(alignmentId);
      if (!entry) return err(notFound("alignment", alignmentId));
      return apply(
        record(entry.twinObjectId, entry.method, entry.transform, entry.rmsError, entry.controlPoints),
      );
    },
  };
}

export function createTwinObservationService(
  runtime: TwinRuntime,
  stores: TwinStores,
): TwinObservationService {
  const add = (observation: Omit<TwinObservationRecord, "id">): TwinObservationRecord => {
    const record: TwinObservationRecord = { ...observation, id: runtime.ids.next("observation") };
    stores.observations.add(record);
    return record;
  };

  return {
    async record(observation) {
      if (!stores.objects.has(observation.twinObjectId)) {
        return err(notFound("twin object", observation.twinObjectId));
      }
      const created = add(observation);
      runtime.context.events.emit("twin.observation", { observation: created });
      return ok(created);
    },

    async recordMany(observations) {
      let count = 0;
      for (const observation of observations) {
        if (!stores.objects.has(observation.twinObjectId)) continue;
        add(observation);
        count++;
      }
      return ok(count);
    },

    latest(twinObjectId, metric) {
      // Sorted by observation time rather than insertion order: sensor batches arrive late and
      // out of order, and "latest" must mean latest reading, not last written.
      return stores.observations
        .query(
          (observation) => observation.twinObjectId === twinObjectId && observation.metric === metric,
        )
        .slice()
        .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1))
        .at(-1);
    },

    query: (filter) =>
      stores.observations.query(
        (observation) =>
          (filter.twinObjectId === undefined || observation.twinObjectId === filter.twinObjectId) &&
          (filter.metric === undefined || observation.metric === filter.metric) &&
          (filter.quality === undefined || observation.quality === filter.quality) &&
          (filter.from === undefined || observation.observedAt >= filter.from) &&
          (filter.to === undefined || observation.observedAt <= filter.to),
      ),
  };
}

export function createTwinTimelineService(
  runtime: TwinRuntime,
  stores: TwinStores,
  observations: TwinObservationService,
): TwinTimelineService {
  let position: IsoTimestamp | undefined;

  return {
    async build(twinObjectId, metric, from, to) {
      if (!stores.objects.has(twinObjectId)) return err(notFound("twin object", twinObjectId));

      const matching = observations
        .query({ twinObjectId, metric, from, to })
        .slice()
        .sort((a, b) => (a.observedAt < b.observedAt ? -1 : 1));

      const record: TwinTimelineRecord = {
        id: runtime.ids.next("timeline"),
        twinObjectId,
        metric,
        from,
        to,
        observationIds: matching.map((observation) => observation.id),
      };
      stores.timelines.add(record);
      return ok(record);
    },

    async seek(timelineId, at) {
      const timeline = stores.timelines.get(timelineId);
      if (!timeline) return err(notFound("timeline", timelineId));
      if (at < timeline.from || at > timeline.to) {
        return err(
          new KernelError("COMMAND_FAILED", `"${at}" is outside the timeline window.`, { at }),
        );
      }
      position = at;
      runtime.context.events.emit("twin.timeline.position", { timelineId, at });
      return ok(undefined);
    },

    async play(timelineId) {
      if (!stores.timelines.has(timelineId)) return err(notFound("timeline", timelineId));
      // As with 4D playback, frame advancement belongs to the host's animation loop.
      return ok(undefined);
    },

    pause() {
      position = position ?? undefined;
    },
  };
}

export function createTwinPromotionService(
  runtime: TwinRuntime,
  stores: TwinStores,
): TwinPromotionService {
  return {
    async promote(twinObjectId, target, options) {
      const twin = stores.objects.get(twinObjectId);
      if (!twin) return err(notFound("twin object", twinObjectId));
      if (!twin.aligned) {
        // Promoting unaligned evidence puts geometry in the wrong place and attributes it to the
        // model, which is worse than not promoting it at all.
        return err(
          new KernelError("COMMAND_FAILED", `Twin object "${twinObjectId}" is not aligned.`, {
            twinObjectId,
          }),
        );
      }

      const record: TwinPromotionRecord = {
        id: runtime.ids.next("promotion"),
        twinObjectId,
        target,
        targetId: options?.name ?? runtime.ids.next(target),
        promotedAt: runtime.clock.timestamp(),
        promotedBy: runtime.context.permissions.identity.id,
        ...(options?.notes === undefined ? {} : { notes: options.notes }),
      };
      stores.promotions.add(record);
      runtime.context.events.emit("twin.promoted", { promotion: record });
      return ok(record);
    },

    // The question people actually ask six months later: what evidence produced this?
    originOf: (targetId) => stores.promotions.find((record) => record.targetId === targetId),

    history: (twinObjectId) =>
      stores.promotions.query((record) => record.twinObjectId === twinObjectId),
  };
}
