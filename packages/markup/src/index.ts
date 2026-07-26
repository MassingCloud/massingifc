/**
 * `@massingifc/markup` — markup, issues, comment threads and review.
 *
 * `contracts` holds the interfaces and capability tokens; `services` and `plugin` implement them.
 * Kept apart so other families can depend on the contracts without the implementation.
 */
export * from "./contracts.js";
export {
  createAnchorService,
  createCommentService,
  createIssueService,
  createMarkupService,
  createMarkupStores,
  createReviewService,
  type MarkupRuntime,
  type MarkupStores,
  type ModelVersionProvider,
} from "./services.js";
export { createMarkupPlugin, markupPlugin, type MarkupPluginOptions } from "./plugin.js";
