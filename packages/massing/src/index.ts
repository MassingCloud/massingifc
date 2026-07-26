/**
 * `@massingifc/massing` — the first authoring vertical.
 *
 * `contracts` holds the interfaces and capability tokens; `geometry` is the dependency-free maths;
 * `services` and `plugin` are the implementation. Split so the contracts can be imported by other
 * capability families without dragging the implementation — or a module cycle — along with them.
 */

export * from "./contracts.js";
export * from "./geometry.js";
export {
  createAppearanceService,
  createContextService,
  createMassingService,
  createMassingStores,
  createMetricsService,
  createOptionService,
  createProfileService,
  createPromotionService,
  createStoryService,
  DEFAULT_STORY_HEIGHT,
  OPTION_PALETTE,
  type MassingRuntime,
  type MassingStores,
} from "./services.js";
export { createMassingPlugin, massingPlugin, type MassingPluginOptions } from "./plugin.js";
