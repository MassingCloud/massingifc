/**
 * `@massingifc/procurement-field` — from priced scope to installed work.
 *
 * This is where 5D stops being an estimate. Progress is recorded against *elements*, not as a
 * percentage typed against a task, because element-level state is what makes earned value
 * defensible and what lets a payment application be traced back to geometry.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  ElementRef,
  FieldState,
  FieldStatusRecord,
  Id,
  InspectionRecord,
  InstallProgressRecord,
  IsoTimestamp,
  Money,
  PackageStatus,
  ProcurementPackageRecord,
  VendorRecord,
  VendorScopeRecord,
} from "@massingifc/project-schema";

export interface PackageService {
  create(pkg: Omit<ProcurementPackageRecord, "id" | "createdAt">): Promise<Result<ProcurementPackageRecord>>;
  update(packageId: Id, changes: Partial<ProcurementPackageRecord>): Promise<Result<ProcurementPackageRecord>>;
  setStatus(packageId: Id, status: PackageStatus): Promise<Result<ProcurementPackageRecord>>;
  /** Builds a package from BOQ lines, carrying the elements and tasks across. */
  fromBoqLines(boqLineIds: readonly Id[], name: string, code: string): Promise<Result<ProcurementPackageRecord>>;
  list(filter?: { readonly status?: PackageStatus; readonly vendorId?: Id }): readonly ProcurementPackageRecord[];
  /** Scope not covered by any package — the procurement gap before award. */
  uncoveredScope(): Promise<Result<readonly Id[]>>;
}

export const PackageToken = createCapabilityToken<PackageService>("procurement.packages");

export interface VendorScopeService {
  vendors(): readonly VendorRecord[];
  upsertVendor(vendor: Omit<VendorRecord, "id"> & { readonly id?: Id }): Promise<Result<VendorRecord>>;
  scopes(packageId: Id): readonly VendorScopeRecord[];
  submitScope(scope: Omit<VendorScopeRecord, "id">): Promise<Result<VendorScopeRecord>>;
  /** Side-by-side comparison of quoted scope, including what each vendor excluded. */
  compare(packageId: Id): Promise<Result<readonly {
    readonly vendorId: Id;
    readonly quotedValue?: Money;
    readonly exclusionCount: number;
  }[]>>;
  award(packageId: Id, vendorId: Id, value: Money): Promise<Result<ProcurementPackageRecord>>;
}

export const VendorScopeToken = createCapabilityToken<VendorScopeService>("procurement.vendor-scope");

export interface FieldStatusService {
  record(status: Omit<FieldStatusRecord, "id">): Promise<Result<FieldStatusRecord>>;
  recordMany(statuses: readonly Omit<FieldStatusRecord, "id">[]): Promise<Result<number>>;
  current(element: ElementRef): FieldStatusRecord | undefined;
  query(filter?: {
    readonly packageId?: Id;
    readonly taskId?: Id;
    readonly state?: FieldState;
    readonly since?: IsoTimestamp;
  }): readonly FieldStatusRecord[];
  /** Colours the model by installed state — the site walk view. */
  visualise(options?: { readonly packageId?: Id }): Promise<Result<void>>;
}

export const FieldStatusToken = createCapabilityToken<FieldStatusService>("field.status");

export interface InspectionService {
  create(inspection: Omit<InspectionRecord, "id">): Promise<Result<InspectionRecord>>;
  /** A failed inspection raises issues rather than only recording an outcome. */
  fail(inspectionId: Id, findings: readonly { readonly element?: ElementRef; readonly note: string }[]): Promise<Result<readonly Id[]>>;
  list(filter?: { readonly packageId?: Id; readonly outcome?: InspectionRecord["outcome"] }): readonly InspectionRecord[];
}

export const InspectionToken = createCapabilityToken<InspectionService>("field.inspection");

export interface InstallProgressService {
  /** Rolls element-level field status into a package claim at a data date. */
  compute(packageId: Id, dataDate: IsoTimestamp): Promise<Result<InstallProgressRecord>>;
  history(packageId: Id): readonly InstallProgressRecord[];
  /** Earned value against the awarded amount, for a payment application. */
  earnedValue(packageId: Id, dataDate: IsoTimestamp): Promise<Result<Money>>;
}

export const InstallProgressToken = createCapabilityToken<InstallProgressService>("field.progress");

export interface ProcurementEvents {
  "procurement.package.status": { readonly packageId: Id; readonly status: PackageStatus };
  "procurement.package.awarded": { readonly packageId: Id; readonly vendorId: Id };
  "field.status.recorded": { readonly element: ElementRef; readonly state: FieldState };
  "field.inspection.completed": { readonly inspection: InspectionRecord };
}

export const PROCUREMENT_COMMANDS = {
  createPackage: "procurement.package.create",
  packageFromBoq: "procurement.package.from-boq",
  awardPackage: "procurement.package.award",
  recordFieldStatus: "field.status.record",
  createInspection: "field.inspection.create",
  computeProgress: "field.progress.compute",
} as const;

export const PROCUREMENT_PERMISSIONS = {
  managePackages: "procurement.package.manage",
  award: "procurement.award",
  recordField: "field.record",
  inspect: "field.inspect",
} as const;
