import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  ElementRef,
  FieldState,
  FieldStatusRecord,
  Id,
  InspectionRecord,
  InstallProgressRecord,
  IsoTimestamp,
  Money,
  ProcurementPackageRecord,
  VendorRecord,
  VendorScopeRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  BoqLineSource,
  FieldStatusService,
  InspectionService,
  InstallProgressService,
  PackageService,
  VendorScopeService,
} from "./contracts.js";

export interface ProcurementStores {
  readonly packages: RecordStore<ProcurementPackageRecord>;
  readonly vendors: RecordStore<VendorRecord>;
  readonly scopes: RecordStore<VendorScopeRecord>;
  readonly statuses: RecordStore<FieldStatusRecord>;
  readonly inspections: RecordStore<InspectionRecord>;
  readonly progress: RecordStore<InstallProgressRecord>;
}

export interface ProcurementRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly currency: string;
  readonly boqLines: BoqLineSource;
}

export function createProcurementStores(context: PluginContext): ProcurementStores {
  return {
    packages: createRecordStore<ProcurementPackageRecord>(context.state, "packages"),
    vendors: createRecordStore<VendorRecord>(context.state, "vendors"),
    scopes: createRecordStore<VendorScopeRecord>(context.state, "vendor-scopes"),
    statuses: createRecordStore<FieldStatusRecord>(context.state, "field-status"),
    inspections: createRecordStore<InspectionRecord>(context.state, "inspections"),
    progress: createRecordStore<InstallProgressRecord>(context.state, "install-progress"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

const elementKey = (element: ElementRef): string => `${element.modelId}/${element.globalId}`;

/** States that count as work in place for an earned-value claim. */
export const INSTALLED_STATES: readonly FieldState[] = ["installed", "inspected", "accepted"];

export function createPackageService(
  runtime: ProcurementRuntime,
  stores: ProcurementStores,
): PackageService {
  return {
    async create(input) {
      const record: ProcurementPackageRecord = {
        ...input,
        id: runtime.ids.next("package"),
        createdAt: runtime.clock.timestamp(),
      };
      stores.packages.add(record);
      return ok(record);
    },

    async update(packageId, changes) {
      const updated = stores.packages.update(packageId, changes);
      return updated ? ok(updated) : err(notFound("package", packageId));
    },

    async setStatus(packageId, status) {
      const updated = stores.packages.update(packageId, { status });
      if (!updated) return err(notFound("package", packageId));
      runtime.context.events.emit("procurement.package.status", { packageId, status });
      return ok(updated);
    },

    async fromBoqLines(boqLineIds, name, code) {
      const lines = runtime.boqLines(boqLineIds);
      if (lines.length === 0) {
        return err(
          new KernelError("COMMAND_FAILED", "No BOQ lines matched; a package needs scope.", {
            boqLineIds,
          }),
        );
      }

      // The budget comes across with the scope. A package priced separately from the bill it was
      // cut from is how the estimate and the procurement plan quietly stop agreeing.
      let budget = 0;
      const elements: ElementRef[] = [];
      for (const line of lines) {
        if (line.total) {
          if (line.total.currency !== runtime.currency) {
            return err(
              new KernelError("COMMAND_FAILED", `BOQ line "${line.id}" is not in ${runtime.currency}.`, {
                lineId: line.id,
              }),
            );
          }
          budget += line.total.amount;
        }
        elements.push(...(line.elements ?? []));
      }

      const record: ProcurementPackageRecord = {
        id: runtime.ids.next("package"),
        code,
        name,
        status: "draft",
        boqLineIds: [...boqLineIds],
        elements,
        budget: { amount: budget, currency: runtime.currency },
        createdAt: runtime.clock.timestamp(),
      };
      stores.packages.add(record);
      return ok(record);
    },

    list: (filter) =>
      filter === undefined
        ? stores.packages.all()
        : stores.packages.query(
            (record) =>
              (filter.status === undefined || record.status === filter.status) &&
              (filter.vendorId === undefined || record.vendorId === filter.vendorId),
          ),

    async uncoveredScope() {
      const covered = new Set(stores.packages.all().flatMap((record) => record.boqLineIds));
      // The procurement gap before award: priced work nobody has been asked to do.
      return ok(runtime.boqLines().filter((line) => !covered.has(line.id)).map((line) => line.id));
    },
  };
}

export function createVendorScopeService(
  runtime: ProcurementRuntime,
  stores: ProcurementStores,
): VendorScopeService {
  return {
    vendors: () => stores.vendors.all(),

    async upsertVendor(vendor) {
      const id = vendor.id ?? runtime.ids.next("vendor");
      const record: VendorRecord = { ...vendor, id };
      if (stores.vendors.has(id)) stores.vendors.replace(record);
      else stores.vendors.add(record);
      return ok(record);
    },

    scopes: (packageId) => stores.scopes.query((scope) => scope.packageId === packageId),

    async submitScope(scope) {
      if (!stores.packages.has(scope.packageId)) return err(notFound("package", scope.packageId));
      if (!stores.vendors.has(scope.vendorId)) return err(notFound("vendor", scope.vendorId));

      const record: VendorScopeRecord = {
        ...scope,
        id: runtime.ids.next("scope"),
        submittedAt: scope.submittedAt ?? runtime.clock.timestamp(),
      };
      stores.scopes.add(record);
      return ok(record);
    },

    async compare(packageId) {
      if (!stores.packages.has(packageId)) return err(notFound("package", packageId));
      return ok(
        stores.scopes
          .query((scope) => scope.packageId === packageId)
          .map((scope) => ({
            vendorId: scope.vendorId,
            // Exclusion count travels with the price: the cheapest quote is routinely the one that
            // excluded the most, and comparing on value alone hides that.
            exclusionCount: scope.exclusions.length,
            ...(scope.quotedValue === undefined ? {} : { quotedValue: scope.quotedValue }),
          }))
          .sort((a, b) => (a.quotedValue?.amount ?? 0) - (b.quotedValue?.amount ?? 0)),
      );
    },

    async award(packageId, vendorId, value) {
      const record = stores.packages.get(packageId);
      if (!record) return err(notFound("package", packageId));
      if (!stores.vendors.has(vendorId)) return err(notFound("vendor", vendorId));
      if (record.status === "awarded" || record.status === "complete") {
        return err(
          new KernelError("COMMAND_FAILED", `Package "${packageId}" is already ${record.status}.`, {
            packageId,
          }),
        );
      }

      const updated = stores.packages.update(packageId, {
        vendorId,
        awardedValue: value,
        status: "awarded",
      });
      if (!updated) return err(notFound("package", packageId));
      runtime.context.events.emit("procurement.package.awarded", { packageId, vendorId });
      return ok(updated);
    },
  };
}

export function createFieldStatusService(
  runtime: ProcurementRuntime,
  stores: ProcurementStores,
): FieldStatusService {
  const upsert = (status: Omit<FieldStatusRecord, "id">): FieldStatusRecord => {
    const record: FieldStatusRecord = { ...status, id: runtime.ids.next("status") };
    // One current status per element, superseding rather than accumulating: progress is a state,
    // not a log, and summing a log would double-count every element that was updated twice.
    stores.statuses.removeWhere(
      (existing) => elementKey(existing.element) === elementKey(status.element),
    );
    stores.statuses.add(record);
    return record;
  };

  return {
    async record(status) {
      const record = upsert(status);
      runtime.context.events.emit("field.status.recorded", {
        element: record.element,
        state: record.state,
      });
      return ok(record);
    },

    async recordMany(statuses) {
      for (const status of statuses) upsert(status);
      return ok(statuses.length);
    },

    current: (element) =>
      stores.statuses.find((status) => elementKey(status.element) === elementKey(element)),

    query: (filter) =>
      filter === undefined
        ? stores.statuses.all()
        : stores.statuses.query(
            (status) =>
              (filter.packageId === undefined || status.packageId === filter.packageId) &&
              (filter.taskId === undefined || status.taskId === filter.taskId) &&
              (filter.state === undefined || status.state === filter.state) &&
              (filter.since === undefined || status.observedAt >= filter.since),
          ),

    async visualise(options) {
      runtime.context.events.emit("field.status.visualise", {
        statuses: options?.packageId
          ? stores.statuses.query((status) => status.packageId === options.packageId)
          : stores.statuses.all(),
      });
      return ok(undefined);
    },
  };
}

export function createInspectionService(
  runtime: ProcurementRuntime,
  stores: ProcurementStores,
): InspectionService {
  return {
    async create(inspection) {
      const record: InspectionRecord = { ...inspection, id: runtime.ids.next("inspection") };
      stores.inspections.add(record);

      // A passing inspection advances the elements it covered; recording the outcome without it
      // leaves progress reporting contradicting the inspection record.
      if (record.outcome === "pass" || record.outcome === "pass-with-comments") {
        for (const element of record.elements ?? []) {
          const current = stores.statuses.find(
            (status) => elementKey(status.element) === elementKey(element),
          );
          if (current) stores.statuses.update(current.id, { state: "inspected" });
        }
      }

      runtime.context.events.emit("field.inspection.completed", { inspection: record });
      return ok(record);
    },

    async fail(inspectionId, findings) {
      const inspection = stores.inspections.get(inspectionId);
      if (!inspection) return err(notFound("inspection", inspectionId));

      stores.inspections.update(inspectionId, { outcome: "fail" });
      const issueIds: Id[] = [];

      for (const finding of findings) {
        // Raised through the command bus so markup owns issue identity.
        const created = await runtime.context.commands.execute<{ id: Id }>("markup.issue.create", {
          title: `Inspection finding: ${inspection.name}`,
          description: finding.note,
          status: "open",
          reporter: runtime.context.permissions.identity.id,
          markupIds: [],
        });
        if (created.ok) issueIds.push(created.value.id);

        if (finding.element) {
          const current = stores.statuses.find(
            (status) => elementKey(status.element) === elementKey(finding.element!),
          );
          if (current) stores.statuses.update(current.id, { state: "rework" });
        }
      }

      stores.inspections.update(inspectionId, { issueIds });
      return ok(issueIds);
    },

    list: (filter) =>
      filter === undefined
        ? stores.inspections.all()
        : stores.inspections.query(
            (record) =>
              (filter.packageId === undefined || record.packageId === filter.packageId) &&
              (filter.outcome === undefined || record.outcome === filter.outcome),
          ),
  };
}

export function createInstallProgressService(
  runtime: ProcurementRuntime,
  stores: ProcurementStores,
): InstallProgressService {
  const rollup = (
    packageId: Id,
    dataDate: IsoTimestamp,
  ): Result<{ installed: number; total: number; unit: string; percent: number }> => {
    const record = stores.packages.get(packageId);
    if (!record) return err(notFound("package", packageId));

    const lines = runtime.boqLines(record.boqLineIds);
    const total = lines.reduce((sum, line) => sum + line.quantity.value, 0);
    const unit = lines[0]?.quantity.unit ?? "";

    const statuses = stores.statuses.query(
      (status) =>
        status.packageId === packageId &&
        status.observedAt <= dataDate &&
        INSTALLED_STATES.includes(status.state),
    );

    // Element-level quantities where they were recorded; otherwise a pro-rata share. Falling back
    // keeps a package that was measured coarsely reportable instead of silently reading as zero.
    const measured = statuses.reduce((sum, status) => sum + (status.quantityInstalled ?? 0), 0);
    const unmeasured = statuses.filter((status) => status.quantityInstalled === undefined).length;
    const elementCount = Math.max(1, record.elements?.length ?? statuses.length);
    const installed = measured + (unmeasured * total) / elementCount;

    return ok({
      installed: Math.min(installed, total),
      total,
      unit,
      percent: total === 0 ? 0 : Math.min(1, installed / total),
    });
  };

  return {
    async compute(packageId, dataDate) {
      const computed = rollup(packageId, dataDate);
      if (!computed.ok) return err(computed.error);

      const record = stores.packages.get(packageId)!;
      const value = record.awardedValue ?? record.budget;
      const earnedValue: Money | undefined = value
        ? { amount: Math.round(value.amount * computed.value.percent), currency: value.currency }
        : undefined;

      const progress: InstallProgressRecord = {
        id: runtime.ids.next("progress"),
        packageId,
        dataDate,
        quantityInstalled: computed.value.installed,
        quantityTotal: computed.value.total,
        unit: computed.value.unit,
        percentComplete: computed.value.percent,
        ...(earnedValue === undefined ? {} : { earnedValue }),
      };
      stores.progress.removeWhere(
        (existing) => existing.packageId === packageId && existing.dataDate === dataDate,
      );
      stores.progress.add(progress);
      return ok(progress);
    },

    history: (packageId) => stores.progress.query((record) => record.packageId === packageId),

    async earnedValue(packageId, dataDate) {
      const computed = await this.compute(packageId, dataDate);
      if (!computed.ok) return err(computed.error);
      const value = computed.value.earnedValue;
      if (!value) {
        // No award and no budget means there is no basis for a claim; inventing one would put a
        // number on a payment application that nothing supports.
        return err(
          new KernelError("COMMAND_FAILED", `Package "${packageId}" has no awarded or budget value.`, {
            packageId,
          }),
        );
      }
      return ok(value);
    },
  };
}
