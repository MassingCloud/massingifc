import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  ANALYTICS_COMMANDS,
  AnalyticsToken,
  ForecastToken,
  MetricProviderToken,
  ReportToken,
} from "./contracts.js";
import {
  createAnalyticsService,
  createAnalyticsStores,
  createForecastService,
  createReportService,
} from "./services.js";

export interface AnalyticsPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
}

/**
 * Project analytics.
 *
 * Separate from the kernel's telemetry, which is about the software. This is about the project —
 * quantities, issue burn-down, schedule variance, cost movement — which has different retention,
 * a different audience and very different privacy characteristics.
 */
export function createAnalyticsPlugin(options: AnalyticsPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.analytics",
    version: "0.1.0",
    name: "Analytics",
    description: "Metric collection, reporting and forecasting.",

    activate(context) {
      const stores = createAnalyticsStores(context);
      const runtime = {
        context,
        clock,
        ids,
        providers: () => context.capabilities.getAll(MetricProviderToken).map((p) => p.value),
      };

      const analytics = createAnalyticsService(runtime, stores);
      const reports = createReportService(runtime, stores, analytics);
      const forecasts = createForecastService(runtime, stores);

      context.capabilities.provide(AnalyticsToken, analytics, { version: "0.1.0" });
      context.capabilities.provide(ReportToken, reports, { version: "0.1.0" });
      context.capabilities.provide(ForecastToken, forecasts, { version: "0.1.0" });

      context.commands.register<{ label?: string }, unknown>({
        id: ANALYTICS_COMMANDS.captureSnapshot,
        title: "Capture metrics snapshot",
        handler: async ({ label }) => {
          const captured = await analytics.snapshot(label);
          if (!captured.ok) throw captured.error;
          return captured.value;
        },
      });

      context.commands.register<{ reportId: string; format: "html" | "json" }, Uint8Array>({
        id: ANALYTICS_COMMANDS.renderReport,
        title: "Render report",
        handler: async ({ reportId, format }) => {
          const rendered = await reports.render(reportId, format);
          if (!rendered.ok) throw rendered.error;
          return rendered.value;
        },
      });

      context.ui.register({ id: "analytics.panel", point: "panel", title: "Analytics", placement: "bottom", order: 40 });
      context.logger.info("Analytics ready");
    },
  });
}

export const analyticsPlugin = createAnalyticsPlugin();
