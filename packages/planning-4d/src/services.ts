import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  ElementRef,
  Id,
  IsoTimestamp,
  ProgressComparisonRecord,
  ScheduleTaskRecord,
  SimulationSettings,
  TaskDependencyRecord,
  TaskLinkBehaviour,
  TaskModelLinkRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  PlannedActualComparisonService,
  ScheduleFormat,
  ScheduleImportService,
  ScheduleImportSummary,
  TaskModelLinkService,
  TimelinePlaybackService,
  ElementFilterSource,
} from "./contracts.js";

export interface PlanningStores {
  readonly tasks: RecordStore<ScheduleTaskRecord>;
  readonly dependencies: RecordStore<TaskDependencyRecord>;
  readonly links: RecordStore<TaskModelLinkRecord>;
  readonly comparisons: RecordStore<ProgressComparisonRecord>;
}

export interface PlanningRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly elements: () => ElementFilterSource | undefined;
}

export function createPlanningStores(context: PluginContext): PlanningStores {
  return {
    tasks: createRecordStore<ScheduleTaskRecord>(context.state, "tasks"),
    dependencies: createRecordStore<TaskDependencyRecord>(context.state, "dependencies"),
    links: createRecordStore<TaskModelLinkRecord>(context.state, "links"),
    comparisons: createRecordStore<ProgressComparisonRecord>(context.state, "progress"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

const DAY_MS = 86_400_000;

const days = (from: IsoTimestamp, to: IsoTimestamp): number =>
  (new Date(to).getTime() - new Date(from).getTime()) / DAY_MS;

// ---------------------------------------------------------------------------------------------
// Schedule import
// ---------------------------------------------------------------------------------------------

interface RawTask {
  readonly externalId?: string;
  readonly name: string;
  readonly plannedStart: string;
  readonly plannedFinish: string;
  readonly wbsCode?: string;
  readonly percentComplete?: number;
  readonly actualStart?: string;
  readonly actualFinish?: string;
}

interface RawSchedule {
  readonly dataDate?: string;
  readonly tasks: readonly RawTask[];
  readonly dependencies?: readonly {
    readonly predecessor: string;
    readonly successor: string;
    readonly type?: TaskDependencyRecord["type"];
    readonly lag?: number;
  }[];
}

function parseSchedule(payload: Uint8Array | string, format: ScheduleFormat): Result<RawSchedule> {
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);

  if (format === "json") {
    try {
      const parsed = JSON.parse(text) as RawSchedule;
      if (!Array.isArray(parsed.tasks)) {
        return err(new KernelError("COMMAND_FAILED", "Schedule JSON has no tasks array.", {}));
      }
      return ok(parsed);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "Schedule is not valid JSON.", {}, { cause: thrown }),
      );
    }
  }

  if (format === "csv") {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    const header = lines.shift()?.split(",").map((cell) => cell.trim().toLowerCase());
    if (!header) return err(new KernelError("COMMAND_FAILED", "Schedule CSV is empty.", {}));

    const column = (name: string): number => header.indexOf(name);
    const idIndex = column("id");
    const nameIndex = column("name");
    const startIndex = column("start");
    const finishIndex = column("finish");
    if (nameIndex === -1 || startIndex === -1 || finishIndex === -1) {
      return err(
        new KernelError("COMMAND_FAILED", "Schedule CSV needs name, start and finish columns.", {
          header,
        }),
      );
    }

    const tasks: RawTask[] = [];
    for (const line of lines) {
      const cells = line.split(",").map((cell) => cell.trim());
      const name = cells[nameIndex];
      const plannedStart = cells[startIndex];
      const plannedFinish = cells[finishIndex];
      if (!name || !plannedStart || !plannedFinish) continue;
      tasks.push({
        name,
        plannedStart,
        plannedFinish,
        ...(idIndex === -1 || !cells[idIndex] ? {} : { externalId: cells[idIndex] }),
      });
    }
    return ok({ tasks });
  }

  // XER and the XML programme formats are real work and only meaningful against fixtures from the
  // tools that write them. Refusing is honest; a half-parser that silently drops relationships
  // would produce a programme that looks imported and is wrong.
  return err(
    new KernelError("COMMAND_FAILED", `Schedule format "${format}" is not implemented yet.`, {
      format,
    }),
  );
}

export function createScheduleImportService(
  runtime: PlanningRuntime,
  stores: PlanningStores,
): ScheduleImportService {
  const ingest = (raw: RawSchedule): { added: number; updated: number; warnings: string[] } => {
    const warnings: string[] = [];
    let added = 0;
    let updated = 0;

    for (const task of raw.tasks) {
      // Matched on the planner's own id, which is what makes a weekly re-import preserve the
      // model links somebody spent a day making.
      const existing = task.externalId
        ? stores.tasks.find((candidate) => candidate.externalId === task.externalId)
        : undefined;

      const record: ScheduleTaskRecord = {
        id: existing?.id ?? runtime.ids.next("task"),
        name: task.name,
        plannedStart: task.plannedStart,
        plannedFinish: task.plannedFinish,
        ...(task.externalId === undefined ? {} : { externalId: task.externalId }),
        ...(task.wbsCode === undefined ? {} : { wbsCode: task.wbsCode }),
        ...(task.percentComplete === undefined ? {} : { percentComplete: task.percentComplete }),
        ...(task.actualStart === undefined ? {} : { actualStart: task.actualStart }),
        ...(task.actualFinish === undefined ? {} : { actualFinish: task.actualFinish }),
      };

      if (new Date(record.plannedFinish) < new Date(record.plannedStart)) {
        warnings.push(`Task "${record.name}" finishes before it starts.`);
      }

      if (existing) {
        stores.tasks.replace(record);
        updated++;
      } else {
        stores.tasks.add(record);
        added++;
      }
    }

    for (const dependency of raw.dependencies ?? []) {
      const predecessor = stores.tasks.find((task) => task.externalId === dependency.predecessor);
      const successor = stores.tasks.find((task) => task.externalId === dependency.successor);
      if (!predecessor || !successor) {
        warnings.push(
          `Dependency ${dependency.predecessor} -> ${dependency.successor} names a task that is not in the import.`,
        );
        continue;
      }
      stores.dependencies.add({
        id: runtime.ids.next("dep"),
        predecessorId: predecessor.id,
        successorId: successor.id,
        type: dependency.type ?? "FS",
        ...(dependency.lag === undefined ? {} : { lag: dependency.lag }),
      });
    }

    return { added, updated, warnings };
  };

  return {
    supportedFormats: () => ["json", "csv"],

    async import(payload, format) {
      const parsed = parseSchedule(payload, format);
      if (!parsed.ok) return err(parsed.error);

      stores.tasks.clear();
      stores.dependencies.clear();
      const result = ingest(parsed.value);

      const summary: ScheduleImportSummary = {
        tasks: result.added,
        dependencies: stores.dependencies.count(),
        warnings: result.warnings,
        ...(parsed.value.dataDate === undefined ? {} : { dataDate: parsed.value.dataDate }),
      };
      runtime.context.events.emit("planning.schedule.imported", { summary });
      return ok(summary);
    },

    async reimport(payload, format) {
      const parsed = parseSchedule(payload, format);
      if (!parsed.ok) return err(parsed.error);

      const before = new Set(stores.tasks.all().map((task) => task.id));
      stores.dependencies.clear();
      const result = ingest(parsed.value);

      // Tasks absent from the new programme are removed, taking their links with them; leaving
      // orphaned links behind would quietly inflate the next progress calculation.
      const seen = new Set(
        parsed.value.tasks
          .map((task) =>
            task.externalId
              ? stores.tasks.find((candidate) => candidate.externalId === task.externalId)?.id
              : undefined,
          )
          .filter((id): id is Id => id !== undefined),
      );
      const removedIds = [...before].filter((id) => !seen.has(id));
      for (const id of removedIds) {
        stores.tasks.remove(id);
        stores.links.removeWhere((link) => link.taskId === id);
      }

      const summary = {
        tasks: result.added + result.updated,
        dependencies: stores.dependencies.count(),
        warnings: result.warnings,
        added: result.added,
        updated: result.updated,
        removed: removedIds.length,
        ...(parsed.value.dataDate === undefined ? {} : { dataDate: parsed.value.dataDate }),
      };
      runtime.context.events.emit("planning.schedule.imported", { summary });
      return ok(summary);
    },

    tasks: (filter) =>
      filter === undefined
        ? stores.tasks.all()
        : stores.tasks.query(
            (task) =>
              (filter.parentId === undefined || task.parentId === filter.parentId) &&
              (filter.critical === undefined || task.critical === filter.critical),
          ),

    dependencies: (taskId) =>
      taskId === undefined
        ? stores.dependencies.all()
        : stores.dependencies.query(
            (dependency) =>
              dependency.predecessorId === taskId || dependency.successorId === taskId,
          ),

    async export(format) {
      if (format !== "json") {
        return err(
          new KernelError("COMMAND_FAILED", `Export to "${format}" is not implemented.`, { format }),
        );
      }
      const payload = {
        tasks: stores.tasks.all(),
        dependencies: stores.dependencies.all(),
      };
      return ok(new TextEncoder().encode(JSON.stringify(payload, null, 2)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Task-model links
// ---------------------------------------------------------------------------------------------

export function createTaskModelLinkService(
  runtime: PlanningRuntime,
  stores: PlanningStores,
): TaskModelLinkService {
  const make = (
    taskId: Id,
    elements: readonly ElementRef[],
    behaviour: TaskLinkBehaviour,
    extras: Partial<TaskModelLinkRecord> = {},
  ): TaskModelLinkRecord => ({
    id: runtime.ids.next("link"),
    taskId,
    behaviour,
    elements: [...elements],
    // A 4D link almost always names what a task produces. Stated rather than inferred, because
    // IfcRelAssignsToProcess (what a task consumes) is easy to transpose and still validates.
    ifcRelationship: "IfcRelAssignsToProduct",
    resolvedAt: runtime.clock.timestamp(),
    ...extras,
  });

  return {
    async link(taskId, elements, behaviour) {
      if (!stores.tasks.has(taskId)) return err(notFound("task", taskId));
      const record = make(taskId, elements, behaviour, { linkSource: "manual" });
      stores.links.add(record);
      runtime.context.events.emit("planning.link.created", { link: record });
      return ok(record);
    },

    async linkByRule(taskId, modelId, filter, behaviour) {
      if (!stores.tasks.has(taskId)) return err(notFound("task", taskId));
      const source = runtime.elements();
      const elements = source?.match(modelId, filter) ?? [];

      const record = make(taskId, elements, behaviour, {
        linkSource: "rule",
        selectionRule: { modelId, filter },
      });
      stores.links.add(record);
      runtime.context.events.emit("planning.link.created", { link: record });
      return ok(record);
    },

    async unlink(linkId) {
      return stores.links.remove(linkId) ? ok(undefined) : err(notFound("link", linkId));
    },

    links: (taskId) =>
      taskId === undefined ? stores.links.all() : stores.links.query((link) => link.taskId === taskId),

    async reresolve(modelId) {
      const source = runtime.elements();
      if (!source) {
        return err(new KernelError("CAPABILITY_NOT_FOUND", "No element source is installed.", {}));
      }

      let resolved = 0;
      const unmatched: Id[] = [];
      for (const link of stores.links.all()) {
        const rule = link.selectionRule;
        if (!rule) continue;
        if (modelId !== undefined && rule.modelId !== modelId) continue;

        const elements = source.match(rule.modelId, rule.filter);
        stores.links.update(link.id, { elements, resolvedAt: runtime.clock.timestamp() });
        if (elements.length > 0) resolved++;
        else unmatched.push(link.id);
      }

      runtime.context.events.emit("planning.links.reresolved", {
        resolved,
        unmatched: unmatched.length,
      });
      return ok({ resolved, unmatched });
    },

    async unlinkedElements(modelId) {
      const source = runtime.elements();
      if (!source) {
        return err(new KernelError("CAPABILITY_NOT_FOUND", "No element source is installed.", {}));
      }
      const linked = new Set(
        stores.links
          .all()
          .flatMap((link) => link.elements)
          .filter((element) => element.modelId === modelId)
          .map((element) => element.globalId),
      );
      // The coverage gap a planner has to see before issuing a programme.
      return ok(source.match(modelId, {}).filter((element) => !linked.has(element.globalId)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

export function createTimelinePlaybackService(
  runtime: PlanningRuntime,
  stores: PlanningStores,
): TimelinePlaybackService {
  let settings: SimulationSettings | undefined;
  let current: IsoTimestamp | undefined;
  let playing = false;

  const stateAt = (at: IsoTimestamp): Record<TaskLinkBehaviour, ElementRef[]> => {
    const state: Record<TaskLinkBehaviour, ElementRef[]> = {
      construct: [],
      demolish: [],
      temporary: [],
      existing: [],
    };
    const moment = new Date(at).getTime();

    for (const link of stores.links.all()) {
      const task = stores.tasks.get(link.taskId);
      if (!task) continue;
      const start = new Date(task.actualStart ?? task.plannedStart).getTime();
      const finish = new Date(task.actualFinish ?? task.plannedFinish).getTime();

      if (link.behaviour === "existing") {
        state.existing.push(...link.elements);
        continue;
      }
      if (moment < start) continue;
      if (link.behaviour === "temporary" && moment > finish) continue;
      // Demolition and construction both "complete" at finish; what differs is whether the
      // elements should then be present, which is the caller's business to render.
      state[link.behaviour].push(...link.elements);
    }
    return state;
  };

  return {
    async configure(input) {
      settings = { ...input, id: runtime.ids.next("sim") };
      current = input.from;
      return ok(settings);
    },

    async seek(at) {
      if (!settings) {
        return err(new KernelError("COMMAND_FAILED", "Playback has not been configured.", {}));
      }
      if (at < settings.from || at > settings.to) {
        return err(
          new KernelError("COMMAND_FAILED", `"${at}" is outside the simulation window.`, {
            at,
            from: settings.from,
            to: settings.to,
          }),
        );
      }
      current = at;
      runtime.context.events.emit("planning.playback.date", { at });
      return ok(undefined);
    },

    async play() {
      if (!settings) {
        return err(new KernelError("COMMAND_FAILED", "Playback has not been configured.", {}));
      }
      // Advancing frames is the host's job — it owns the animation loop. This flags intent and
      // lets the host drive `seek`, which keeps the service free of timers it cannot cancel.
      playing = true;
      return ok(undefined);
    },

    pause() {
      playing = false;
    },

    stop() {
      playing = false;
      current = settings?.from;
    },

    currentDate: () => (playing || current !== undefined ? current : undefined),

    async stateAt(at) {
      return ok(stateAt(at));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Planned vs actual
// ---------------------------------------------------------------------------------------------

export function createComparisonService(
  runtime: PlanningRuntime,
  stores: PlanningStores,
): PlannedActualComparisonService {
  const compare = (dataDate: IsoTimestamp, taskIds?: readonly Id[]): ProgressComparisonRecord[] => {
    const tasks = taskIds
      ? stores.tasks.query((task) => taskIds.includes(task.id))
      : stores.tasks.all();
    const moment = new Date(dataDate).getTime();

    return tasks.map((task) => {
      const start = new Date(task.plannedStart).getTime();
      const finish = new Date(task.plannedFinish).getTime();
      const span = finish - start;
      // Linear planned progress. Crude, and the honest default: any S-curve here would be an
      // assumption about a task nobody made, dressed up as data.
      const plannedPercent =
        span <= 0
          ? moment >= finish
            ? 1
            : 0
          : Math.max(0, Math.min(1, (moment - start) / span));
      const actualPercent = task.actualFinish ? 1 : (task.percentComplete ?? 0);

      const scheduleVarianceDays =
        span <= 0 ? 0 : ((actualPercent - plannedPercent) * span) / DAY_MS;

      return {
        id: runtime.ids.next("progress"),
        taskId: task.id,
        dataDate,
        plannedPercent,
        actualPercent,
        scheduleVarianceDays,
      };
    });
  };

  return {
    async compare(dataDate, taskIds) {
      const results = compare(dataDate, taskIds);
      stores.comparisons.removeWhere((record) => record.dataDate === dataDate);
      stores.comparisons.addMany(results);
      return ok(results);
    },

    async behindSchedule(dataDate, thresholdDays = 0) {
      return ok(
        compare(dataDate)
          .filter((record) => (record.scheduleVarianceDays ?? 0) < -thresholdDays)
          .sort((a, b) => (a.scheduleVarianceDays ?? 0) - (b.scheduleVarianceDays ?? 0)),
      );
    },

    async visualise(dataDate) {
      // Emitted rather than rendered: this package must not know what a renderer is.
      runtime.context.events.emit("planning.variance.visualise", {
        dataDate,
        records: compare(dataDate),
      });
      return ok(undefined);
    },
  };
}

export { days };
