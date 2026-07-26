/**
 * `@massingifc/family-libraries` — pluggable, versioned reusable content.
 *
 * The important decision here is that a repository is an *adapter*, not an integration. Git, a
 * cloud API, an enterprise registry and a project-local folder differ only in how bytes are
 * fetched; hard-coding any one of them — including `MassingCloud/massing-families` — would mean a
 * new content source required a change to the platform rather than a new plugin.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  FamilyInstanceRecord,
  FamilyPackageRecord,
  FamilyParameterDefinition,
  FamilyRepositoryRecord,
  FamilyValidationResult,
  Id,
  Matrix4,
} from "@massingifc/project-schema";

export interface PackageQuery {
  readonly text?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly repositoryId?: Id;
}

/**
 * What every content source must implement.
 *
 * `capabilities` is declared rather than assumed because sources genuinely differ: a git
 * repository can publish, a read-only CDN cannot, and a project-local folder has no version
 * history. A caller that assumed otherwise would fail at the worst moment — mid-publish.
 */
export interface FamilyRepositoryAdapter {
  readonly kind: FamilyRepositoryRecord["kind"];
  readonly capabilities: {
    readonly publish: boolean;
    readonly versions: boolean;
    readonly preview: boolean;
  };
  connect(record: FamilyRepositoryRecord): Promise<Result<void>>;
  discover(query?: PackageQuery): Promise<Result<readonly FamilyPackageRecord[]>>;
  versions(slug: string): Promise<Result<readonly string[]>>;
  fetch(slug: string, version: string): Promise<Result<FamilyPackageRecord>>;
  preview(slug: string, version: string): Promise<Result<{ readonly uri: string }>>;
  publish?(pkg: FamilyPackageRecord, payload: Uint8Array): Promise<Result<FamilyPackageRecord>>;
  disconnect(): Promise<void>;
}

export const FamilyRepositoryAdapterToken =
  createCapabilityToken<FamilyRepositoryAdapter>("family.repository-adapter");

export interface FamilyLibraryRegistryService {
  addRepository(record: FamilyRepositoryRecord): Promise<Result<void>>;
  removeRepository(repositoryId: Id): Promise<Result<void>>;
  repositories(): readonly FamilyRepositoryRecord[];
  /** Refreshes the package index for one repository, or all of them. */
  sync(repositoryId?: Id): Promise<Result<{ readonly discovered: number }>>;
  search(query?: PackageQuery): Promise<Result<readonly FamilyPackageRecord[]>>;
}

export const FamilyLibraryRegistryToken =
  createCapabilityToken<FamilyLibraryRegistryService>("family.registry");

export interface FamilyResolverService {
  resolve(slug: string, versionRange?: string): Promise<Result<FamilyPackageRecord>>;
  /** Caches package content locally so placement works offline and repeat use is cheap. */
  cache(packageId: Id, version: string): Promise<Result<void>>;
  isCached(packageId: Id, version: string): boolean;
  validate(pkg: FamilyPackageRecord): Promise<Result<FamilyValidationResult>>;
}

export const FamilyResolverToken = createCapabilityToken<FamilyResolverService>("family.resolver");

export interface PlacementOptions {
  readonly transform: Matrix4;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly levelId?: Id;
  readonly hostElementId?: number | string;
  readonly modelId?: Id;
}

export interface FamilyPlacementService {
  place(packageId: Id, version: string, options: PlacementOptions): Promise<Result<FamilyInstanceRecord>>;
  move(instanceId: Id, transform: Matrix4): Promise<Result<FamilyInstanceRecord>>;
  remove(instanceId: Id): Promise<Result<void>>;
  instances(packageId?: Id): readonly FamilyInstanceRecord[];
}

export const FamilyPlacementToken = createCapabilityToken<FamilyPlacementService>("family.placement");

export interface FamilyParameterService {
  definitions(packageId: Id, version: string): readonly FamilyParameterDefinition[];
  get(instanceId: Id): Readonly<Record<string, unknown>>;
  set(instanceId: Id, parameters: Readonly<Record<string, unknown>>): Promise<Result<FamilyInstanceRecord>>;
  /** Type, range and required-field checks before a value is committed. */
  validate(packageId: Id, version: string, parameters: Readonly<Record<string, unknown>>): Result<void>;
}

export const FamilyParameterToken = createCapabilityToken<FamilyParameterService>("family.parameters");

export interface FamilyVersionService {
  available(slug: string): Promise<Result<readonly string[]>>;
  /**
   * Moves placed instances to another version.
   *
   * Returns the instances it could not migrate rather than failing wholesale — a parameter removed
   * between versions should strand one instance for review, not block the whole upgrade.
   */
  upgrade(instanceIds: readonly Id[], toVersion: string): Promise<Result<{
    readonly upgraded: readonly Id[];
    readonly failed: readonly { readonly instanceId: Id; readonly reason: string }[];
  }>>;
  publish(pkg: FamilyPackageRecord, payload: Uint8Array, repositoryId: Id): Promise<Result<FamilyPackageRecord>>;
}

export const FamilyVersionToken = createCapabilityToken<FamilyVersionService>("family.versions");

export interface FamilyEvents {
  "family.repository.synced": { readonly repositoryId: Id; readonly discovered: number };
  "family.package.resolved": { readonly pkg: FamilyPackageRecord };
  "family.instance.placed": { readonly instance: FamilyInstanceRecord };
  "family.validation.failed": { readonly result: FamilyValidationResult };
}

export const FAMILY_COMMANDS = {
  addRepository: "family.repository.add",
  syncRepositories: "family.repository.sync",
  searchPackages: "family.package.search",
  placeInstance: "family.instance.place",
  setParameters: "family.instance.set-parameters",
  upgradeInstances: "family.instance.upgrade",
  publishPackage: "family.package.publish",
} as const;

export const FAMILY_PERMISSIONS = {
  place: "family.place",
  manageRepositories: "family.repository.manage",
  publish: "family.publish",
} as const;
