/**
 * `@massingifc/family-libraries` — pluggable, versioned reusable content.
 */
export * from "./contracts.js";
export {
  createFamilyStores,
  createMemoryRepositoryAdapter,
  createParameterService,
  createPlacementService,
  createRegistryService,
  createResolverService,
  createVersionService,
  validateParameters,
  type FamilyRuntime,
  type FamilyStores,
} from "./services.js";
export { createFamilyPlugin, familyPlugin, type FamilyPluginOptions } from "./plugin.js";
