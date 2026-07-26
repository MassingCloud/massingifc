import {
  err,
  KernelError,
  ok,
  satisfies,
  type PluginContext,
  type Result,
} from "@massingifc/core-kernel";
import type {
  FamilyInstanceRecord,
  FamilyPackageRecord,
  FamilyParameterDefinition,
  FamilyRepositoryRecord,
  FamilyValidationResult,
  Id,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  FamilyLibraryRegistryService,
  FamilyParameterService,
  FamilyPlacementService,
  FamilyRepositoryAdapter,
  FamilyResolverService,
  FamilyVersionService,
  PackageQuery,
} from "./contracts.js";

export interface FamilyStores {
  readonly repositories: RecordStore<FamilyRepositoryRecord>;
  readonly packages: RecordStore<FamilyPackageRecord>;
  readonly instances: RecordStore<FamilyInstanceRecord>;
}

export interface FamilyRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly apiVersion: string;
  readonly adapters: () => readonly FamilyRepositoryAdapter[];
}

export function createFamilyStores(context: PluginContext): FamilyStores {
  return {
    repositories: createRecordStore<FamilyRepositoryRecord>(context.state, "repositories"),
    packages: createRecordStore<FamilyPackageRecord>(context.state, "packages"),
    instances: createRecordStore<FamilyInstanceRecord>(context.state, "instances"),
  };
}

const notFound = (kind: string, id: string): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

/** Highest version satisfying a range, or the highest overall when no range is given. */
function pick(
  candidates: readonly FamilyPackageRecord[],
  range: string | undefined,
): FamilyPackageRecord | undefined {
  const eligible = range
    ? candidates.filter((candidate) => satisfies(candidate.version, range))
    : candidates;
  return [...eligible].sort((a, b) => (a.version < b.version ? 1 : -1))[0];
}

export function createRegistryService(
  runtime: FamilyRuntime,
  stores: FamilyStores,
): FamilyLibraryRegistryService {
  const adapterFor = (record: FamilyRepositoryRecord): FamilyRepositoryAdapter | undefined =>
    runtime.adapters().find((adapter) => adapter.kind === record.kind);

  return {
    async addRepository(record) {
      if (!adapterFor(record)) {
        // Named honestly at add time rather than failing later on first use, when the user has
        // stopped associating the failure with the thing they just configured.
        return err(
          new KernelError("CAPABILITY_NOT_FOUND", `No adapter is installed for "${record.kind}" repositories.`, {
            kind: record.kind,
          }),
        );
      }
      stores.repositories.add(record);
      return ok(undefined);
    },

    async removeRepository(repositoryId) {
      if (!stores.repositories.remove(repositoryId)) {
        return err(notFound("repository", repositoryId));
      }
      // Packages from a removed repository are dropped; leaving them listed would offer content
      // that can no longer be fetched.
      stores.packages.removeWhere((pkg) => pkg.repositoryId === repositoryId);
      return ok(undefined);
    },

    repositories: () => stores.repositories.all(),

    async sync(repositoryId) {
      const targets = repositoryId
        ? [stores.repositories.get(repositoryId)].filter((r): r is FamilyRepositoryRecord => !!r)
        : stores.repositories.all();
      if (repositoryId && targets.length === 0) return err(notFound("repository", repositoryId));

      let discovered = 0;
      for (const repository of targets) {
        const adapter = adapterFor(repository);
        if (!adapter) continue;

        const connected = await adapter.connect(repository);
        if (!connected.ok) return err(connected.error);

        const found = await adapter.discover();
        if (!found.ok) return err(found.error);

        stores.packages.removeWhere((pkg) => pkg.repositoryId === repository.id);
        stores.packages.addMany(
          found.value.map((pkg) => ({ ...pkg, repositoryId: repository.id })),
        );
        discovered += found.value.length;

        stores.repositories.update(repository.id, { lastSyncedAt: runtime.clock.timestamp() });
        runtime.context.events.emit("family.repository.synced", {
          repositoryId: repository.id,
          discovered: found.value.length,
        });
      }
      return ok({ discovered });
    },

    async search(query) {
      const matches = (pkg: FamilyPackageRecord, q: PackageQuery): boolean => {
        if (q.repositoryId !== undefined && pkg.repositoryId !== q.repositoryId) return false;
        if (q.category !== undefined && pkg.category !== q.category) return false;
        if (q.tags !== undefined && !q.tags.every((tag) => (pkg.tags ?? []).includes(tag))) {
          return false;
        }
        if (q.text !== undefined) {
          const haystack = `${pkg.name} ${pkg.slug} ${pkg.description ?? ""}`.toLowerCase();
          if (!haystack.includes(q.text.toLowerCase())) return false;
        }
        return true;
      };
      return ok(query ? stores.packages.query((pkg) => matches(pkg, query)) : stores.packages.all());
    },
  };
}

export function createResolverService(
  runtime: FamilyRuntime,
  stores: FamilyStores,
): FamilyResolverService {
  const cached = new Set<string>();

  const validate = (pkg: FamilyPackageRecord): FamilyValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Packages are user-authored content from repositories the platform does not control, so they
    // are treated as untrusted input and can be refused rather than loaded hopefully.
    if (pkg.apiVersion && !satisfies(runtime.apiVersion, pkg.apiVersion)) {
      errors.push(
        `Package requires platform API "${pkg.apiVersion}"; this platform is ${runtime.apiVersion}.`,
      );
    }
    if (!pkg.slug) errors.push("Package has no slug.");
    if (!pkg.version) errors.push("Package has no version.");

    const names = new Set<string>();
    for (const parameter of pkg.parameters) {
      if (names.has(parameter.name)) errors.push(`Duplicate parameter "${parameter.name}".`);
      names.add(parameter.name);
      if (parameter.type === "enum" && (parameter.options ?? []).length === 0) {
        errors.push(`Enum parameter "${parameter.name}" has no options.`);
      }
    }
    if (!pkg.license) warnings.push("Package declares no licence.");

    return {
      packageId: pkg.id,
      version: pkg.version,
      compatible: errors.length === 0,
      errors,
      warnings,
      checkedAt: runtime.clock.timestamp(),
    };
  };

  return {
    async resolve(slug, versionRange) {
      const candidates = stores.packages.query((pkg) => pkg.slug === slug);
      if (candidates.length === 0) return err(notFound("package", slug));

      const chosen = pick(candidates, versionRange);
      if (!chosen) {
        return err(
          new KernelError(
            "CAPABILITY_VERSION_MISMATCH",
            `No version of "${slug}" satisfies "${versionRange}".`,
            { slug, requested: versionRange, available: candidates.map((c) => c.version) },
          ),
        );
      }

      const validation = validate(chosen);
      if (!validation.compatible) {
        runtime.context.events.emit("family.validation.failed", { result: validation });
        return err(
          new KernelError("COMMAND_FAILED", validation.errors.join(" "), { slug, version: chosen.version }),
        );
      }

      runtime.context.events.emit("family.package.resolved", { pkg: chosen });
      return ok(chosen);
    },

    async cache(packageId, version) {
      if (!stores.packages.has(packageId)) return err(notFound("package", packageId));
      cached.add(`${packageId}@${version}`);
      return ok(undefined);
    },

    isCached: (packageId, version) => cached.has(`${packageId}@${version}`),

    async validate(pkg) {
      return ok(validate(pkg));
    },
  };
}

/** Type, range and required-field checking for a parameter set. */
export function validateParameters(
  definitions: readonly FamilyParameterDefinition[],
  values: Readonly<Record<string, unknown>>,
): readonly string[] {
  const problems: string[] = [];
  const known = new Set(definitions.map((definition) => definition.name));

  for (const name of Object.keys(values)) {
    if (!known.has(name)) problems.push(`Unknown parameter "${name}".`);
  }

  for (const definition of definitions) {
    const value = values[definition.name] ?? definition.defaultValue;
    if (value === undefined) {
      if (definition.required) problems.push(`Parameter "${definition.name}" is required.`);
      continue;
    }

    const numeric = definition.type === "number" || definition.type === "length" || definition.type === "area";
    if (numeric && typeof value !== "number") {
      problems.push(`Parameter "${definition.name}" must be a number.`);
      continue;
    }
    if (definition.type === "boolean" && typeof value !== "boolean") {
      problems.push(`Parameter "${definition.name}" must be a boolean.`);
      continue;
    }
    if (definition.type === "string" && typeof value !== "string") {
      problems.push(`Parameter "${definition.name}" must be a string.`);
      continue;
    }
    if (definition.type === "enum" && !(definition.options ?? []).includes(String(value))) {
      problems.push(`Parameter "${definition.name}" must be one of ${(definition.options ?? []).join(", ")}.`);
      continue;
    }
    if (numeric && typeof value === "number") {
      if (definition.min !== undefined && value < definition.min) {
        problems.push(`Parameter "${definition.name}" is below its minimum of ${definition.min}.`);
      }
      if (definition.max !== undefined && value > definition.max) {
        problems.push(`Parameter "${definition.name}" is above its maximum of ${definition.max}.`);
      }
    }
  }
  return problems;
}

export function createPlacementService(
  runtime: FamilyRuntime,
  stores: FamilyStores,
): FamilyPlacementService {
  return {
    async place(packageId, version, options) {
      const pkg = stores.packages.get(packageId);
      if (!pkg) return err(notFound("package", packageId));

      const problems = validateParameters(pkg.parameters, options.parameters ?? {});
      if (problems.length > 0) {
        return err(new KernelError("COMMAND_FAILED", problems.join(" "), { packageId }));
      }

      // Defaults are materialised at placement. Leaving them implicit means the instance changes
      // meaning if the package's defaults change later, which is not what "placed" should mean.
      const parameters: Record<string, unknown> = {};
      for (const definition of pkg.parameters) {
        const value = options.parameters?.[definition.name] ?? definition.defaultValue;
        if (value !== undefined) parameters[definition.name] = value;
      }

      const record: FamilyInstanceRecord = {
        id: runtime.ids.next("instance"),
        packageId,
        packageSlug: pkg.slug,
        packageVersion: version,
        transform: [...options.transform],
        parameters,
        createdAt: runtime.clock.timestamp(),
        createdBy: runtime.context.permissions.identity.id,
        ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
        ...(options.levelId === undefined ? {} : { levelId: options.levelId }),
        ...(options.hostElementId === undefined ? {} : { hostElementId: options.hostElementId }),
      };
      stores.instances.add(record);
      runtime.context.events.emit("family.instance.placed", { instance: record });
      return ok(record);
    },

    async move(instanceId, transform) {
      const updated = stores.instances.update(instanceId, { transform: [...transform] });
      return updated ? ok(updated) : err(notFound("instance", instanceId));
    },

    async remove(instanceId) {
      return stores.instances.remove(instanceId) ? ok(undefined) : err(notFound("instance", instanceId));
    },

    instances: (packageId) =>
      packageId === undefined
        ? stores.instances.all()
        : stores.instances.query((instance) => instance.packageId === packageId),
  };
}

export function createParameterService(stores: FamilyStores): FamilyParameterService {
  return {
    definitions: (packageId) => stores.packages.get(packageId)?.parameters ?? [],
    get: (instanceId) => stores.instances.get(instanceId)?.parameters ?? {},

    async set(instanceId, parameters) {
      const instance = stores.instances.get(instanceId);
      if (!instance) return err(notFound("instance", instanceId));
      const pkg = stores.packages.get(instance.packageId);
      if (!pkg) return err(notFound("package", instance.packageId));

      const merged = { ...instance.parameters, ...parameters };
      const problems = validateParameters(pkg.parameters, merged);
      if (problems.length > 0) {
        return err(new KernelError("COMMAND_FAILED", problems.join(" "), { instanceId }));
      }
      const updated = stores.instances.update(instanceId, { parameters: merged });
      return updated ? ok(updated) : err(notFound("instance", instanceId));
    },

    validate(packageId, _version, parameters) {
      const pkg = stores.packages.get(packageId);
      if (!pkg) return err(notFound("package", packageId));
      const problems = validateParameters(pkg.parameters, parameters);
      return problems.length === 0
        ? ok(undefined)
        : err(new KernelError("COMMAND_FAILED", problems.join(" "), { packageId }));
    },
  };
}

export function createVersionService(
  runtime: FamilyRuntime,
  stores: FamilyStores,
): FamilyVersionService {
  return {
    async available(slug) {
      const versions = stores.packages.query((pkg) => pkg.slug === slug).map((pkg) => pkg.version);
      return ok([...new Set(versions)].sort());
    },

    async upgrade(instanceIds, toVersion) {
      const upgraded: Id[] = [];
      const failed: { instanceId: Id; reason: string }[] = [];

      for (const instanceId of instanceIds) {
        const instance = stores.instances.get(instanceId);
        if (!instance) {
          failed.push({ instanceId, reason: "instance not found" });
          continue;
        }
        // Resolved by slug first: a repository re-sync replaces catalogue entries, so the package
        // id an instance was placed with may no longer exist even though the family does.
        const slug = instance.packageSlug ?? stores.packages.get(instance.packageId)?.slug;
        const target = slug
          ? stores.packages.find((pkg) => pkg.slug === slug && pkg.version === toVersion)
          : undefined;
        if (!target) {
          failed.push({ instanceId, reason: `no version ${toVersion} available` });
          continue;
        }

        const problems = validateParameters(target.parameters, instance.parameters);
        if (problems.length > 0) {
          // Reported per instance rather than aborting: a parameter removed between versions
          // should strand one instance for review, not block the whole upgrade.
          failed.push({ instanceId, reason: problems.join(" ") });
          continue;
        }

        stores.instances.update(instanceId, { packageId: target.id, packageVersion: toVersion });
        upgraded.push(instanceId);
      }
      return ok({ upgraded, failed });
    },

    async publish(pkg, payload, repositoryId) {
      const repository = stores.repositories.get(repositoryId);
      if (!repository) return err(notFound("repository", repositoryId));
      if (repository.readOnly || repository.publishable === false) {
        return err(
          new KernelError("PERMISSION_DENIED", `Repository "${repository.name}" does not accept publishing.`, {
            repositoryId,
          }),
        );
      }
      const adapter = runtime.adapters().find((candidate) => candidate.kind === repository.kind);
      if (!adapter?.publish || !adapter.capabilities.publish) {
        return err(
          new KernelError("CAPABILITY_NOT_FOUND", `The "${repository.kind}" adapter cannot publish.`, {
            kind: repository.kind,
          }),
        );
      }

      const published = await adapter.publish({ ...pkg, repositoryId }, payload);
      if (!published.ok) return err(published.error);
      stores.packages.add(published.value);
      return ok(published.value);
    },
  };
}

/**
 * An in-memory repository adapter.
 *
 * Exists so the registry is usable and testable without a network, and so the adapter contract is
 * exercised by something real rather than only by mocks in tests.
 */
export function createMemoryRepositoryAdapter(
  packages: readonly FamilyPackageRecord[] = [],
): FamilyRepositoryAdapter & { readonly published: FamilyPackageRecord[] } {
  const catalogue = [...packages];
  const published: FamilyPackageRecord[] = [];

  return {
    kind: "local",
    capabilities: { publish: true, versions: true, preview: false },
    published,
    async connect() {
      return ok(undefined);
    },
    async discover(query) {
      const text = query?.text?.toLowerCase();
      return ok(
        text === undefined
          ? catalogue
          : catalogue.filter((pkg) => pkg.name.toLowerCase().includes(text)),
      );
    },
    async versions(slug) {
      return ok(catalogue.filter((pkg) => pkg.slug === slug).map((pkg) => pkg.version));
    },
    async fetch(slug, version) {
      const found = catalogue.find((pkg) => pkg.slug === slug && pkg.version === version);
      return found ? ok(found) : err(notFound("package", `${slug}@${version}`));
    },
    async preview() {
      return err(new KernelError("COMMAND_FAILED", "This repository has no previews.", {}));
    },
    async publish(pkg) {
      catalogue.push(pkg);
      published.push(pkg);
      return ok(pkg);
    },
    async disconnect() {},
  };
}
