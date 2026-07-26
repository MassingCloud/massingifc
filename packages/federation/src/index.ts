/**
 * `@massingifc/federation` — running many models as one project.
 */
export * from "./contracts.js";
export {
  createFederationService,
  createFederationStores,
  createSessionStateService,
  type FederationRuntime,
  type FederationStores,
  type ModelLoadStateRecord,
} from "./services.js";
export { createFederationPlugin, federationPlugin, type FederationPluginOptions } from "./plugin.js";
