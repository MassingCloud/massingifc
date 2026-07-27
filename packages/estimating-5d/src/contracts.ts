/**
 * `@massingifc/estimating-5d` — quantities, classification, cost and change.
 *
 * The chain this package exists to keep intact is: model -> quantity -> classified item -> priced
 * assembly -> BOQ line -> estimate -> cashflow, with a reverse path from any number back to the
 * elements that produced it. An estimating tool that cannot answer "which elements is this?" is
 * not auditable, and an unauditable number does not get used to buy anything.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  BoqLineRecord,
  BoqRecord,
  CashflowForecastRecord,
  ChangeImpactRecord,
  ClassificationMappingRecord,
  ClassificationSystemRecord,
  CostAssemblyRecord,
  ElementRef,
  EstimateRecord,
  Id,
  Money,
  QuantityRecord,
  ResourceRecord,
  TakeoffRuleRecord,
} from "@massingifc/project-schema";

/** One element as the takeoff sees it. */
export interface TakeoffElement {
  readonly element: ElementRef;
  readonly ifcClass?: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /** Base quantities carried by the element, e.g. `NetVolume`, `Width`, `Height`. */
  readonly quantities: Readonly<Record<string, number>>;
}

/**
 * Supplies model content to the takeoff.
 *
 * Estimating must not import the viewer: takeoff runs server-side on a converted model far more
 * often than it runs in a browser, and a quantity produced in a nightly job has to be identical to
 * one produced on screen.
 */
export interface ModelElementSource {
  elements(modelId: Id): readonly TakeoffElement[];
  modelIds(): readonly Id[];
  /** Revision measured against — recorded on every quantity so a re-run is comparable. */
  modelVersion(modelId: Id): string | undefined;
}

export const ModelElementSourceToken =
  createCapabilityToken<ModelElementSource>("estimating.element-source");

/**
 * Supplies the schedule a cashflow is spread over.
 *
 * The basis decides its own window, because the programme does — an estimate has only a creation
 * date, and asking it to bound the spread produced a zero-width window that a real provider
 * answers with no periods at all.
 */
export interface ScheduleBasisSource {
  periods(unit: "week" | "month" | "quarter"): readonly {
    readonly start: string;
    readonly end: string;
    /** 0..1 share of total value falling in this period. */
    readonly weight: number;
  }[];
}

export const ScheduleBasisToken =
  createCapabilityToken<ScheduleBasisSource>("estimating.schedule-basis");

export interface TakeoffSummary {
  readonly quantities: number;
  readonly elementsMeasured: number;
  /** Elements no rule matched. The coverage gap that decides whether the takeoff is trustworthy. */
  readonly unmeasured: readonly ElementRef[];
  readonly takenAt: string;
}

export interface QuantityTakeoffService {
  rules(): readonly TakeoffRuleRecord[];
  addRule(rule: Omit<TakeoffRuleRecord, "id">): Promise<Result<TakeoffRuleRecord>>;
  setRuleEnabled(ruleId: Id, enabled: boolean): void;
  run(options?: { readonly modelIds?: readonly Id[]; readonly ruleIds?: readonly Id[] }): Promise<Result<TakeoffSummary>>;
  quantities(filter?: {
    readonly modelId?: Id;
    readonly metric?: string;
    readonly classificationCode?: string;
  }): readonly QuantityRecord[];
  /** Reverse lookup: the elements behind a number. */
  elementsFor(quantityId: Id): readonly ElementRef[];
}

export const QuantityTakeoffToken = createCapabilityToken<QuantityTakeoffService>("estimating.takeoff");

export interface ClassificationMappingService {
  systems(): readonly ClassificationSystemRecord[];
  addSystem(system: Omit<ClassificationSystemRecord, "id">): Promise<Result<ClassificationSystemRecord>>;
  mappings(systemId?: Id): readonly ClassificationMappingRecord[];
  /** Applies mapping rules to takeoff output, reporting what it could not classify. */
  classify(systemId: Id, quantityIds?: readonly Id[]): Promise<Result<{
    readonly classified: number;
    readonly unclassified: readonly Id[];
  }>>;
  setMapping(mapping: Omit<ClassificationMappingRecord, "id"> & { readonly id?: Id }): Promise<Result<ClassificationMappingRecord>>;
}

export const ClassificationMappingToken =
  createCapabilityToken<ClassificationMappingService>("estimating.classification");

export interface CostAssemblyService {
  resources(): readonly ResourceRecord[];
  upsertResource(resource: Omit<ResourceRecord, "id"> & { readonly id?: Id }): Promise<Result<ResourceRecord>>;
  assemblies(filter?: { readonly libraryId?: Id; readonly code?: string }): readonly CostAssemblyRecord[];
  upsertAssembly(assembly: Omit<CostAssemblyRecord, "id"> & { readonly id?: Id }): Promise<Result<CostAssemblyRecord>>;
  /** Composite unit rate, including waste, overhead and profit. */
  unitRate(assemblyId: Id): Result<Money>;
  /** Bulk rate import from an external cost library. */
  importLibrary(payload: Uint8Array | string, format: string): Promise<Result<{ readonly assemblies: number }>>;
}

export const CostAssemblyToken = createCapabilityToken<CostAssemblyService>("estimating.assemblies");

export interface BoqService {
  create(name: string, currency: string): Promise<Result<BoqRecord>>;
  /** Builds lines from classified quantities — the model-driven path, not manual entry. */
  generate(boqId: Id, options?: {
    readonly systemId?: Id;
    readonly quantityIds?: readonly Id[];
    readonly autoPrice?: boolean;
  }): Promise<Result<{ readonly lines: number; readonly unpriced: readonly Id[] }>>;
  lines(boqId: Id): readonly BoqLineRecord[];
  upsertLine(line: Omit<BoqLineRecord, "id"> & { readonly id?: Id }): Promise<Result<BoqLineRecord>>;
  removeLine(lineId: Id): Promise<Result<void>>;
  export(boqId: Id, format: "xlsx" | "csv" | "json"): Promise<Result<Uint8Array>>;
}

export const BoqToken = createCapabilityToken<BoqService>("estimating.boq");

export interface EstimateService {
  create(name: string, boqId: Id, options?: { readonly contingencyPercent?: number }): Promise<Result<EstimateRecord>>;
  /** Recomputes totals from current BOQ lines and rates. */
  recalculate(estimateId: Id): Promise<Result<EstimateRecord>>;
  issue(estimateId: Id): Promise<Result<EstimateRecord>>;
  /** Issues a new estimate superseding an existing one, preserving the audit chain. */
  revise(estimateId: Id, notes?: string): Promise<Result<EstimateRecord>>;
  get(estimateId: Id): EstimateRecord | undefined;
  list(): readonly EstimateRecord[];
  compare(a: Id, b: Id): Promise<Result<{
    readonly deltaTotal: Money;
    readonly changedLines: readonly { readonly lineId: Id; readonly delta: Money }[];
  }>>;
}

export const EstimateToken = createCapabilityToken<EstimateService>("estimating.estimate");

export interface CashflowForecastService {
  /** Spreads an estimate over time using the linked programme. */
  generate(estimateId: Id, options?: {
    readonly scheduleBasis?: Id;
    readonly period?: "week" | "month" | "quarter";
  }): Promise<Result<CashflowForecastRecord>>;
  recordActual(forecastId: Id, periodStart: string, actual: Money): Promise<Result<CashflowForecastRecord>>;
  get(forecastId: Id): CashflowForecastRecord | undefined;
}

export const CashflowForecastToken =
  createCapabilityToken<CashflowForecastService>("estimating.cashflow");

export interface ChangeImpactService {
  /** Prices a model revision diff: delta quantities, delta cost, and programme impact. */
  assess(diffId: Id, estimateId: Id): Promise<Result<ChangeImpactRecord>>;
  setStatus(impactId: Id, status: ChangeImpactRecord["status"]): Promise<Result<ChangeImpactRecord>>;
  list(filter?: { readonly estimateId?: Id; readonly status?: ChangeImpactRecord["status"] }): readonly ChangeImpactRecord[];
  /** Cumulative approved change against an estimate — the number a client actually asks for. */
  totalApproved(estimateId: Id): Result<Money>;
}

export const ChangeImpactToken = createCapabilityToken<ChangeImpactService>("estimating.change-impact");

export interface EstimatingEvents {
  "estimating.takeoff.completed": { readonly summary: TakeoffSummary };
  "estimating.boq.generated": { readonly boqId: Id; readonly lines: number };
  "estimating.estimate.issued": { readonly estimate: EstimateRecord };
  "estimating.change.assessed": { readonly impact: ChangeImpactRecord };
}

export const ESTIMATING_COMMANDS = {
  runTakeoff: "estimating.takeoff.run",
  addTakeoffRule: "estimating.takeoff.add-rule",
  classifyQuantities: "estimating.classification.run",
  generateBoq: "estimating.boq.generate",
  exportBoq: "estimating.boq.export",
  createEstimate: "estimating.estimate.create",
  issueEstimate: "estimating.estimate.issue",
  generateCashflow: "estimating.cashflow.generate",
  assessChange: "estimating.change.assess",
} as const;

export const ESTIMATING_PERMISSIONS = {
  runTakeoff: "estimating.takeoff",
  editRates: "estimating.rates.edit",
  issueEstimate: "estimating.estimate.issue",
  approveChange: "estimating.change.approve",
} as const;
