/**
 * `@massingifc/coordination` — clash, validation, routing and change review.
 *
 * The design constraint throughout is *re-runnability*. Coordination is a weekly cycle, and any
 * contract that produces fresh identities on every run throws away the triage work done last week.
 * Clashes therefore carry a stable signature, and diffs are computed between named revisions.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  ClashRecord,
  ClashStatus,
  ClashTestRecord,
  ElementRef,
  Id,
  ResponsibilityRecord,
  RevisionDiffRecord,
  ValidationResultRecord,
  ValidationRuleRecord,
} from "@massingifc/project-schema";

export interface ClashRunSummary {
  readonly testId: Id;
  readonly total: number;
  /** Not seen in the previous run. */
  readonly created: number;
  /** Present before and still present — triage state is preserved. */
  readonly persisted: number;
  /** Present before, gone now. Marked resolved rather than deleted. */
  readonly resolved: number;
  readonly runAt: string;
}

export interface ClashService {
  defineTest(test: Omit<ClashTestRecord, "id">): Promise<Result<ClashTestRecord>>;
  run(testId: Id, options?: { readonly signal?: AbortSignal }): Promise<Result<ClashRunSummary>>;
  results(testId: Id, filter?: { readonly status?: ClashStatus }): readonly ClashRecord[];
  setStatus(clashId: Id, status: ClashStatus, note?: string): Promise<Result<ClashRecord>>;
  /** Raises an issue from a clash, carrying the elements and a viewpoint across. */
  promoteToIssue(clashId: Id, assignee?: Id): Promise<Result<Id>>;
  tests(): readonly ClashTestRecord[];
}

export const ClashToken = createCapabilityToken<ClashService>("coordination.clash");

/** A single checkable requirement. Registered by plugins so rule sets are extensible. */
export interface ValidationRule {
  readonly definition: ValidationRuleRecord;
  check(context: {
    readonly modelIds: readonly Id[];
    readonly elements?: readonly ElementRef[];
  }): Promise<Result<readonly Omit<ValidationResultRecord, "id" | "ruleId">[]>>;
}

export const ValidationRuleToken = createCapabilityToken<ValidationRule>("coordination.rule");

export interface ValidationService {
  rules(): readonly ValidationRuleRecord[];
  setEnabled(ruleId: Id, enabled: boolean): void;
  run(options?: { readonly ruleIds?: readonly Id[]; readonly modelIds?: readonly Id[] }): Promise<Result<{
    readonly results: readonly ValidationResultRecord[];
    readonly errors: number;
    readonly warnings: number;
  }>>;
  results(filter?: { readonly severity?: ValidationRuleRecord["severity"] }): readonly ValidationResultRecord[];
}

export const ValidationToken = createCapabilityToken<ValidationService>("coordination.validation");

export interface RoutingRule {
  readonly id: Id;
  readonly name: string;
  /** Element or issue predicate deciding which discipline owns the problem. */
  readonly match: Readonly<Record<string, unknown>>;
  readonly responsibility: string;
  readonly assignee?: Id;
  readonly priority?: number;
}

export interface IssueRoutingService {
  addRule(rule: Omit<RoutingRule, "id">): Promise<Result<RoutingRule>>;
  removeRule(ruleId: Id): Promise<Result<void>>;
  rules(): readonly RoutingRule[];
  /** Applies rules to unassigned issues, reporting what it could not route. */
  route(issueIds?: readonly Id[]): Promise<Result<{
    readonly routed: readonly Id[];
    readonly unmatched: readonly Id[];
  }>>;
}

export const IssueRoutingToken = createCapabilityToken<IssueRoutingService>("coordination.routing");

export interface RevisionDiffService {
  compare(modelId: Id, fromVersion: string, toVersion: string): Promise<Result<RevisionDiffRecord>>;
  /** Compares the loaded revision against its immediate predecessor. */
  compareToPrevious(modelId: Id): Promise<Result<RevisionDiffRecord>>;
  get(diffId: Id): RevisionDiffRecord | undefined;
  /** Colours the scene by change kind — the review affordance that makes a diff usable. */
  visualise(diffId: Id): Promise<Result<void>>;
}

export const RevisionDiffToken = createCapabilityToken<RevisionDiffService>("coordination.diff");

export interface ResponsibilityMatrixService {
  entries(): readonly ResponsibilityRecord[];
  upsert(record: Omit<ResponsibilityRecord, "id"> & { readonly id?: Id }): Promise<Result<ResponsibilityRecord>>;
  remove(recordId: Id): Promise<Result<void>>;
  responsibleFor(scope: string): ResponsibilityRecord | undefined;
}

export const ResponsibilityMatrixToken =
  createCapabilityToken<ResponsibilityMatrixService>("coordination.responsibility");

export interface CoordinationEvents {
  "coordination.clash.completed": { readonly summary: ClashRunSummary };
  "coordination.clash.status": { readonly clash: ClashRecord };
  "coordination.validation.completed": { readonly errors: number; readonly warnings: number };
  "coordination.diff.computed": { readonly diff: RevisionDiffRecord };
}

export const COORDINATION_COMMANDS = {
  defineClashTest: "coordination.clash.define",
  runClashTest: "coordination.clash.run",
  setClashStatus: "coordination.clash.set-status",
  promoteClashToIssue: "coordination.clash.promote",
  runValidation: "coordination.validation.run",
  compareRevisions: "coordination.diff.compare",
  routeIssues: "coordination.routing.run",
} as const;

export const COORDINATION_PERMISSIONS = {
  runTests: "coordination.run",
  triage: "coordination.triage",
  manageRules: "coordination.rules.manage",
} as const;
