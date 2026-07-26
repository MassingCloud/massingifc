/**
 * `@massingifc/planning-4d` — schedule linked to model.
 *
 * 4D is the join between two systems that are maintained by different people in different tools.
 * The contract reflects that: schedules are *imported* and round-tripped by external id, links are
 * expressed as rules so they survive a model re-issue, and planned and actual are kept as separate
 * quantities rather than being collapsed into one "progress" number.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
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

export type ScheduleFormat = "p6-xer" | "ms-project-xml" | "primavera-xml" | "csv" | "json";

/**
 * Resolves a selection rule to elements.
 *
 * The port that lets a rule-based link re-resolve after a model re-issue without planning
 * importing the viewer — which matters because 4D links are usually maintained in a planning tool,
 * not in front of a renderer.
 */
export interface ElementFilterSource {
  match(modelId: Id, filter: Readonly<Record<string, unknown>>): readonly ElementRef[];
}

export const ElementFilterSourceToken =
  createCapabilityToken<ElementFilterSource>("planning.element-source");

export interface ScheduleImportSummary {
  readonly tasks: number;
  readonly dependencies: number;
  readonly dataDate?: IsoTimestamp;
  readonly warnings: readonly string[];
}

export interface ScheduleImportService {
  supportedFormats(): readonly ScheduleFormat[];
  import(payload: Uint8Array | string, format: ScheduleFormat): Promise<Result<ScheduleImportSummary>>;
  /**
   * Re-imports an updated programme, matching on external id.
   *
   * Matching by external id rather than replacing wholesale is what preserves model links: a
   * weekly schedule update must not detach every element the planner spent a day linking.
   */
  reimport(payload: Uint8Array | string, format: ScheduleFormat): Promise<Result<ScheduleImportSummary & {
    readonly added: number;
    readonly updated: number;
    readonly removed: number;
  }>>;
  tasks(filter?: { readonly parentId?: Id; readonly critical?: boolean }): readonly ScheduleTaskRecord[];
  dependencies(taskId?: Id): readonly TaskDependencyRecord[];
  export(format: ScheduleFormat): Promise<Result<Uint8Array>>;
}

export const ScheduleImportToken = createCapabilityToken<ScheduleImportService>("planning.schedule");

export interface TaskModelLinkService {
  link(taskId: Id, elements: readonly ElementRef[], behaviour: TaskLinkBehaviour): Promise<Result<TaskModelLinkRecord>>;
  /** Rule-based link, re-resolved whenever the model is re-issued. */
  linkByRule(
    taskId: Id,
    modelId: Id,
    filter: Readonly<Record<string, unknown>>,
    behaviour: TaskLinkBehaviour,
  ): Promise<Result<TaskModelLinkRecord>>;
  unlink(linkId: Id): Promise<Result<void>>;
  links(taskId?: Id): readonly TaskModelLinkRecord[];
  /** Re-evaluates every rule-based link against the current models. */
  reresolve(modelId?: Id): Promise<Result<{ readonly resolved: number; readonly unmatched: readonly Id[] }>>;
  /** Elements with no task — the coverage gap a planner needs to see before issuing a programme. */
  unlinkedElements(modelId: Id): Promise<Result<readonly ElementRef[]>>;
}

export const TaskModelLinkToken = createCapabilityToken<TaskModelLinkService>("planning.links");

export interface TimelinePlaybackService {
  configure(settings: Omit<SimulationSettings, "id">): Promise<Result<SimulationSettings>>;
  seek(at: IsoTimestamp): Promise<Result<void>>;
  play(speed?: number): Promise<Result<void>>;
  pause(): void;
  stop(): void;
  currentDate(): IsoTimestamp | undefined;
  /** Elements visible at a date, by behaviour — what drives the 4D appearance overrides. */
  stateAt(at: IsoTimestamp): Promise<Result<Readonly<Record<TaskLinkBehaviour, readonly ElementRef[]>>>>;
}

export const TimelinePlaybackToken = createCapabilityToken<TimelinePlaybackService>("planning.playback");

export interface PlannedActualComparisonService {
  compare(dataDate: IsoTimestamp, taskIds?: readonly Id[]): Promise<Result<readonly ProgressComparisonRecord[]>>;
  /** Tasks behind programme at a data date, worst variance first. */
  behindSchedule(dataDate: IsoTimestamp, thresholdDays?: number): Promise<Result<readonly ProgressComparisonRecord[]>>;
  /** Colours the model by schedule variance, so slippage is visible rather than tabular. */
  visualise(dataDate: IsoTimestamp): Promise<Result<void>>;
}

export const PlannedActualToken =
  createCapabilityToken<PlannedActualComparisonService>("planning.comparison");

export interface PlanningEvents {
  "planning.schedule.imported": { readonly summary: ScheduleImportSummary };
  "planning.link.created": { readonly link: TaskModelLinkRecord };
  "planning.links.reresolved": { readonly resolved: number; readonly unmatched: number };
  "planning.playback.date": { readonly at: IsoTimestamp };
}

export const PLANNING_COMMANDS = {
  importSchedule: "planning.schedule.import",
  reimportSchedule: "planning.schedule.reimport",
  linkSelection: "planning.link.selection",
  linkByRule: "planning.link.rule",
  reresolveLinks: "planning.link.reresolve",
  play: "planning.playback.play",
  seek: "planning.playback.seek",
  compareProgress: "planning.compare",
} as const;

export const PLANNING_PERMISSIONS = {
  importSchedule: "planning.import",
  editLinks: "planning.link.edit",
} as const;
