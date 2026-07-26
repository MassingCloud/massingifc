/**
 * `@massingifc/coordination` — clash, validation, routing and change review.
 */
export * from "./contracts.js";
export {
  clashSignature,
  createClashService,
  createCoordinationStores,
  createIssueRoutingService,
  createResponsibilityService,
  createRevisionDiffService,
  createValidationService,
  diffSnapshots,
  type CoordinationRuntime,
  type CoordinationStores,
  type IssueLike,
  type IssueSource,
  type IssueUpdater,
} from "./services.js";
export {
  createCoordinationPlugin,
  coordinationPlugin,
  type CoordinationPluginOptions,
} from "./plugin.js";
