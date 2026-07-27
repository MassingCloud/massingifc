/**
 * `@massingifc/analytics` — project metrics, reports and forecasts.
 */
export * from "./contracts.js";
export {
  createAnalyticsService,
  createAnalyticsStores,
  createForecastService,
  createReportService,
  type AnalyticsRuntime,
  type AnalyticsStores,
} from "./services.js";
export { createAnalyticsPlugin, analyticsPlugin, type AnalyticsPluginOptions } from "./plugin.js";
