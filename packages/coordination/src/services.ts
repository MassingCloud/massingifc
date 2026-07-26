import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  ClashRecord,
  ClashStatus,
  ClashTestRecord,
  ElementRef,
  Id,
  ResponsibilityRecord,
  RevisionDiffEntry,
  RevisionDiffRecord,
  ValidationResultRecord,
  ValidationRuleRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  ClashEngine,
  ClashRunSummary,
  ClashService,
  IssueRoutingService,
  ModelSnapshotSource,
  ResponsibilityMatrixService,
  RevisionDiffService,
  RoutingRule,
  SnapshotElement,
  ValidationRule,
  ValidationService,
} from "./contracts.js";

export interface CoordinationStores {
  readonly tests: RecordStore<ClashTestRecord>;
  readonly clashes: RecordStore<ClashRecord>;
  readonly rules: RecordStore<ValidationRuleRecord>;
  readonly results: RecordStore<ValidationResultRecord>;
  readonly routing: RecordStore<RoutingRule>;
  readonly diffs: RecordStore<RevisionDiffRecord>;
  readonly responsibilities: RecordStore<ResponsibilityRecord>;
}

export interface CoordinationRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly engine: () => ClashEngine | undefined;
  readonly snapshots: () => ModelSnapshotSource | undefined;
  readonly validationRules: () => readonly ValidationRule[];
  readonly elementsOf: (modelId: Id) => readonly ElementRef[];
}

export function createCoordinationStores(context: PluginContext): CoordinationStores {
  return {
    tests: createRecordStore<ClashTestRecord>(context.state, "clash-tests"),
    clashes: createRecordStore<ClashRecord>(context.state, "clashes"),
    rules: createRecordStore<ValidationRuleRecord>(context.state, "validation-rules"),
    results: createRecordStore<ValidationResultRecord>(context.state, "validation-results"),
    routing: createRecordStore<RoutingRule>(context.state, "routing-rules"),
    diffs: createRecordStore<RevisionDiffRecord>(context.state, "revision-diffs"),
    responsibilities: createRecordStore<ResponsibilityRecord>(context.state, "responsibilities"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

/** FNV-1a. Short, deterministic and dependency-free — this is an identity key, not a digest. */
function hash(input: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}

/**
 * Identity for a clash, stable across runs.
 *
 * Element pairs are sorted so that A-vs-B and B-vs-A are the same clash — otherwise swapping the
 * two selections in a test would present every previously-triaged clash as new. This is the single
 * property that decides whether a weekly clash cycle accumulates knowledge or discards it.
 */
export function clashSignature(testId: Id, a: ElementRef, b: ElementRef): string {
  const left = `${a.modelId}/${a.globalId}`;
  const right = `${b.modelId}/${b.globalId}`;
  const [first, second] = left <= right ? [left, right] : [right, left];
  return hash(`${testId}|${first}|${second}`);
}

// ---------------------------------------------------------------------------------------------
// Clash
// ---------------------------------------------------------------------------------------------

/** Triage state a re-run must carry forward rather than discard. */
const PRESERVED_STATUSES: readonly ClashStatus[] = ["reviewed", "approved", "ignored", "active"];

export function createClashService(
  runtime: CoordinationRuntime,
  stores: CoordinationStores,
): ClashService {
  return {
    async defineTest(test) {
      const record: ClashTestRecord = { ...test, id: runtime.ids.next("test") };
      stores.tests.add(record);
      return ok(record);
    },

    async run(testId, options) {
      const test = stores.tests.get(testId);
      if (!test) return err(notFound("clash test", testId));

      const engine = runtime.engine();
      if (!engine) {
        return err(new KernelError("CAPABILITY_NOT_FOUND", "No clash engine is installed.", {}));
      }
      if (options?.signal?.aborted) {
        return err(new KernelError("COMMAND_FAILED", "Clash run was cancelled.", { testId }));
      }

      const a = test.selectionA.flatMap((modelId) => runtime.elementsOf(modelId));
      const b = test.selectionB.flatMap((modelId) => runtime.elementsOf(modelId));
      const raw = engine.intersect(a, b, { kind: test.kind, tolerance: test.tolerance });
      const runAt = runtime.clock.timestamp();

      const previous = new Map(
        stores.clashes
          .query((clash) => clash.testId === testId)
          .map((clash) => [clash.signature, clash]),
      );
      const seen = new Set<string>();
      let created = 0;
      let persisted = 0;

      for (const candidate of raw) {
        const signature = clashSignature(testId, candidate.a, candidate.b);
        seen.add(signature);
        const existing = previous.get(signature);

        if (existing) {
          // Everything a human decided about this clash survives; only the observation updates.
          stores.clashes.update(existing.id, {
            lastSeenAt: runAt,
            ...(PRESERVED_STATUSES.includes(existing.status) ? {} : { status: "active" as const }),
            ...(candidate.point === undefined ? {} : { point: candidate.point }),
            ...(candidate.distance === undefined ? {} : { distance: candidate.distance }),
          });
          persisted++;
          continue;
        }

        stores.clashes.add({
          id: runtime.ids.next("clash"),
          testId,
          kind: test.kind,
          status: "new",
          a: candidate.a,
          b: candidate.b,
          signature,
          firstSeenAt: runAt,
          lastSeenAt: runAt,
          ...(candidate.point === undefined ? {} : { point: candidate.point }),
          ...(candidate.distance === undefined ? {} : { distance: candidate.distance }),
        });
        created++;
      }

      // Clashes that no longer occur become resolved rather than being deleted — the record that
      // a clash existed and was fixed is the useful part of a coordination history.
      let resolved = 0;
      for (const [signature, clash] of previous) {
        if (seen.has(signature)) continue;
        if (clash.status === "resolved") continue;
        stores.clashes.update(clash.id, { status: "resolved", lastSeenAt: runAt });
        resolved++;
      }

      stores.tests.update(testId, { lastRunAt: runAt, clashCount: raw.length });

      const summary: ClashRunSummary = {
        testId,
        total: raw.length,
        created,
        persisted,
        resolved,
        runAt,
      };
      runtime.context.events.emit("coordination.clash.completed", { summary });
      return ok(summary);
    },

    results: (testId, filter) =>
      stores.clashes.query(
        (clash) =>
          clash.testId === testId && (filter?.status === undefined || clash.status === filter.status),
      ),

    async setStatus(clashId, status) {
      const updated = stores.clashes.update(clashId, { status });
      if (!updated) return err(notFound("clash", clashId));
      runtime.context.events.emit("coordination.clash.status", { clash: updated });
      return ok(updated);
    },

    async promoteToIssue(clashId, assignee) {
      const clash = stores.clashes.get(clashId);
      if (!clash) return err(notFound("clash", clashId));
      if (clash.issueId) return ok(clash.issueId);

      // Raised through the command bus so markup owns issue identity and this package does not
      // have to import it.
      const created = await runtime.context.commands.execute<{ id: Id }>("markup.issue.create", {
        title: `Clash: ${clash.a.globalId} vs ${clash.b.globalId}`,
        description: `${clash.kind} clash detected by test ${clash.testId}.`,
        status: "open",
        reporter: runtime.context.permissions.identity.id,
        markupIds: [],
        ...(assignee === undefined ? {} : { assignee }),
      });
      if (!created.ok) return err(created.error);

      stores.clashes.update(clashId, { issueId: created.value.id, status: "active" });
      return ok(created.value.id);
    },

    tests: () => stores.tests.all(),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export function createValidationService(
  runtime: CoordinationRuntime,
  stores: CoordinationStores,
): ValidationService {
  return {
    rules: () => {
      // Registered rules are the source of truth; the store only carries the enabled flag, which
      // is the part a user changes and expects to persist.
      for (const rule of runtime.validationRules()) {
        if (!stores.rules.has(rule.definition.id)) stores.rules.add(rule.definition);
      }
      return stores.rules.all();
    },

    setEnabled(ruleId, enabled) {
      stores.rules.update(ruleId, { enabled });
    },

    async run(options) {
      const registered = runtime.validationRules();
      const results: ValidationResultRecord[] = [];
      const checkedAt = runtime.clock.timestamp();
      const modelIds = options?.modelIds ?? runtime.snapshots()?.modelIds() ?? [];

      for (const rule of registered) {
        const stored = stores.rules.get(rule.definition.id);
        if (stored && !stored.enabled) continue;
        if (options?.ruleIds && !options.ruleIds.includes(rule.definition.id)) continue;

        const outcome = await rule.check({ modelIds });
        if (!outcome.ok) {
          // One broken rule reports itself as an error and the rest still run — a validation pass
          // that aborts on the first bad rule tells you nothing about the model.
          results.push({
            id: runtime.ids.next("result"),
            ruleId: rule.definition.id,
            severity: "error",
            message: `Rule "${rule.definition.name}" failed to run: ${outcome.error.message}`,
            checkedAt,
          });
          continue;
        }

        for (const finding of outcome.value) {
          results.push({ ...finding, id: runtime.ids.next("result"), ruleId: rule.definition.id });
        }
      }

      stores.results.clear();
      stores.results.addMany(results);

      const errors = results.filter((result) => result.severity === "error").length;
      const warnings = results.filter((result) => result.severity === "warning").length;
      runtime.context.events.emit("coordination.validation.completed", { errors, warnings });
      return ok({ results, errors, warnings });
    },

    results: (filter) =>
      filter?.severity === undefined
        ? stores.results.all()
        : stores.results.query((result) => result.severity === filter.severity),
  };
}

// ---------------------------------------------------------------------------------------------
// Issue routing
// ---------------------------------------------------------------------------------------------

export interface IssueLike {
  readonly id: Id;
  readonly responsibility?: string;
  readonly assignee?: Id;
  readonly labels?: readonly string[];
  readonly title: string;
}

export type IssueSource = () => readonly IssueLike[];
export type IssueUpdater = (
  issueId: Id,
  changes: { responsibility?: string; assignee?: Id },
) => Promise<Result<unknown>>;

export function createIssueRoutingService(
  runtime: CoordinationRuntime,
  stores: CoordinationStores,
  issues: IssueSource,
  update: IssueUpdater,
): IssueRoutingService {
  const matches = (rule: RoutingRule, issue: IssueLike): boolean =>
    Object.entries(rule.match).every(([key, expected]) => {
      if (key === "titleContains") return issue.title.includes(String(expected));
      if (key === "label") return (issue.labels ?? []).includes(String(expected));
      return (issue as unknown as Record<string, unknown>)[key] === expected;
    });

  return {
    async addRule(rule) {
      const record: RoutingRule = { ...rule, id: runtime.ids.next("routing") };
      stores.routing.add(record);
      return ok(record);
    },

    async removeRule(ruleId) {
      return stores.routing.remove(ruleId) ? ok(undefined) : err(notFound("routing rule", ruleId));
    },

    rules: () => stores.routing.all(),

    async route(issueIds) {
      const candidates = issues().filter(
        (issue) => issueIds === undefined || issueIds.includes(issue.id),
      );
      // Highest priority first, first match wins — otherwise the outcome depends on the order
      // rules happened to be added, which makes routing unpredictable to the people relying on it.
      const rules = [...stores.routing.all()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

      const routed: Id[] = [];
      const unmatched: Id[] = [];

      for (const issue of candidates) {
        if (issue.responsibility !== undefined) continue; // already routed; do not re-route
        const rule = rules.find((candidate) => matches(candidate, issue));
        if (!rule) {
          unmatched.push(issue.id);
          continue;
        }
        const applied = await update(issue.id, {
          responsibility: rule.responsibility,
          ...(rule.assignee === undefined ? {} : { assignee: rule.assignee }),
        });
        if (applied.ok) routed.push(issue.id);
        else unmatched.push(issue.id);
      }
      return ok({ routed, unmatched });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------------------------

/** Compares two element snapshots. Pure, so the interesting cases are trivially testable. */
export function diffSnapshots(
  before: readonly SnapshotElement[],
  after: readonly SnapshotElement[],
): RevisionDiffEntry[] {
  const byId = (entries: readonly SnapshotElement[]): Map<string, SnapshotElement> =>
    new Map(entries.map((entry) => [entry.element.globalId, entry]));

  const previous = byId(before);
  const current = byId(after);
  const entries: RevisionDiffEntry[] = [];

  for (const [globalId, entry] of current) {
    const old = previous.get(globalId);
    if (!old) {
      entries.push({
        element: entry.element,
        kind: "added",
        ...(entry.quantities === undefined ? {} : { quantityDelta: { ...entry.quantities } }),
      });
      continue;
    }

    const changedProperties = Object.keys({ ...old.properties, ...entry.properties }).filter(
      (key) => old.properties[key] !== entry.properties[key],
    );
    const moved =
      old.placementHash !== undefined &&
      entry.placementHash !== undefined &&
      old.placementHash !== entry.placementHash;

    const quantityDelta: Record<string, number> = {};
    for (const key of new Set([
      ...Object.keys(old.quantities ?? {}),
      ...Object.keys(entry.quantities ?? {}),
    ])) {
      const delta = (entry.quantities?.[key] ?? 0) - (old.quantities?.[key] ?? 0);
      if (delta !== 0) quantityDelta[key] = delta;
    }

    if (changedProperties.length === 0 && !moved && Object.keys(quantityDelta).length === 0) continue;

    entries.push({
      element: entry.element,
      // A move is reported as a move even when properties also changed: "it moved" is the fact a
      // reviewer acts on, and burying it under "modified" loses it.
      kind: moved ? "moved" : "modified",
      ...(changedProperties.length === 0 ? {} : { changedProperties }),
      ...(Object.keys(quantityDelta).length === 0 ? {} : { quantityDelta }),
    });
  }

  for (const [globalId, entry] of previous) {
    if (current.has(globalId)) continue;
    entries.push({
      element: entry.element,
      kind: "removed",
      ...(entry.quantities === undefined
        ? {}
        : {
            quantityDelta: Object.fromEntries(
              Object.entries(entry.quantities).map(([key, value]) => [key, -value]),
            ),
          }),
    });
  }

  return entries;
}

export function createRevisionDiffService(
  runtime: CoordinationRuntime,
  stores: CoordinationStores,
): RevisionDiffService {
  const compare = (modelId: Id, fromVersion: string, toVersion: string): Result<RevisionDiffRecord> => {
    const source = runtime.snapshots();
    if (!source) {
      return err(new KernelError("CAPABILITY_NOT_FOUND", "No model snapshot source is installed.", {}));
    }
    const before = source.snapshot(modelId, fromVersion);
    const after = source.snapshot(modelId, toVersion);
    if (!before) {
      return err(
        new KernelError("COMMAND_FAILED", `No snapshot for "${modelId}" at "${fromVersion}".`, {
          modelId,
          version: fromVersion,
        }),
      );
    }
    if (!after) {
      return err(
        new KernelError("COMMAND_FAILED", `No snapshot for "${modelId}" at "${toVersion}".`, {
          modelId,
          version: toVersion,
        }),
      );
    }

    const record: RevisionDiffRecord = {
      id: runtime.ids.next("diff"),
      modelId,
      fromVersion,
      toVersion,
      entries: diffSnapshots(before, after),
      computedAt: runtime.clock.timestamp(),
    };
    stores.diffs.add(record);
    runtime.context.events.emit("coordination.diff.computed", { diff: record });
    return ok(record);
  };

  return {
    async compare(modelId, fromVersion, toVersion) {
      return compare(modelId, fromVersion, toVersion);
    },

    async compareToPrevious(modelId) {
      const history = stores.diffs.query((diff) => diff.modelId === modelId);
      const latest = history[history.length - 1];
      if (!latest) {
        return err(
          new KernelError("COMMAND_FAILED", `No diff history for "${modelId}" to compare against.`, {
            modelId,
          }),
        );
      }
      return compare(modelId, latest.toVersion, latest.toVersion);
    },

    get: (diffId) => stores.diffs.get(diffId),

    async visualise(diffId) {
      const diff = stores.diffs.get(diffId);
      if (!diff) return err(notFound("revision diff", diffId));
      // Emitted, not rendered — this package does not know what a renderer is.
      runtime.context.events.emit("coordination.diff.visualise", { diff });
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Responsibility
// ---------------------------------------------------------------------------------------------

export function createResponsibilityService(
  runtime: CoordinationRuntime,
  stores: CoordinationStores,
): ResponsibilityMatrixService {
  return {
    entries: () => stores.responsibilities.all(),

    async upsert(record) {
      const id = record.id ?? runtime.ids.next("responsibility");
      const full: ResponsibilityRecord = { ...record, id };
      if (stores.responsibilities.has(id)) stores.responsibilities.replace(full);
      else stores.responsibilities.add(full);
      return ok(full);
    },

    async remove(recordId) {
      return stores.responsibilities.remove(recordId)
        ? ok(undefined)
        : err(notFound("responsibility", recordId));
    },

    responsibleFor: (scope) => stores.responsibilities.find((record) => record.scope === scope),
  };
}
