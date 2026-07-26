/**
 * `@massingifc/analytics` — metrics, reporting and forecasting.
 *
 * Separate from the kernel's telemetry, which is about the *software*. This is about the
 * *project*: quantities, issue burn-down, schedule variance, cost movement. Keeping them apart
 * matters because they have different retention, different audiences and very different privacy
 * characteristics.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type { Id, IsoTimestamp } from "@massingifc/project-schema";

export type MetricUnit = "count" | "currency" | "days" | "percent" | "area" | "volume" | "mass";

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly description?: string;
  /** Which capability family owns this metric, e.g. `"coordination"`, `"estimating"`. */
  readonly domain: string;
}

export interface MetricPoint {
  readonly metricId: string;
  readonly at: IsoTimestamp;
  readonly value: number;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/**
 * Supplies metric values on demand.
 *
 * Pull rather than push: a plugin registering a provider does not have to maintain a time series,
 * and the analytics layer decides when sampling is worth the cost. A markup plugin should not be
 * recomputing issue counts on every pin drop just in case a dashboard is open.
 */
export interface MetricProvider {
  readonly definitions: readonly MetricDefinition[];
  sample(metricId: string, at?: IsoTimestamp): Promise<Result<readonly MetricPoint[]>>;
}

export const MetricProviderToken = createCapabilityToken<MetricProvider>("analytics.provider");

export interface AnalyticsService {
  definitions(domain?: string): readonly MetricDefinition[];
  sample(metricIds: readonly string[], at?: IsoTimestamp): Promise<Result<readonly MetricPoint[]>>;
  /** Stored history for trend views. Sampling cadence is a host policy, not a plugin's business. */
  series(metricId: string, from: IsoTimestamp, to: IsoTimestamp): Promise<Result<readonly MetricPoint[]>>;
  snapshot(label?: string): Promise<Result<{ readonly id: Id; readonly points: readonly MetricPoint[] }>>;
}

export const AnalyticsToken = createCapabilityToken<AnalyticsService>("analytics.service");

export interface ReportSection {
  readonly title: string;
  readonly metricIds?: readonly string[];
  readonly narrative?: string;
  readonly tableData?: readonly Readonly<Record<string, unknown>>[];
}

export interface ReportDefinition {
  readonly id: Id;
  readonly name: string;
  readonly sections: readonly ReportSection[];
  readonly schedule?: "manual" | "daily" | "weekly" | "monthly";
}

export interface ReportService {
  definitions(): readonly ReportDefinition[];
  upsert(definition: Omit<ReportDefinition, "id"> & { readonly id?: Id }): Promise<Result<ReportDefinition>>;
  render(reportId: Id, format: "html" | "pdf" | "xlsx" | "json"): Promise<Result<Uint8Array>>;
}

export const ReportToken = createCapabilityToken<ReportService>("analytics.reports");

export interface Forecast {
  readonly metricId: string;
  readonly method: "linear" | "moving-average" | "s-curve" | "custom";
  readonly points: readonly MetricPoint[];
  /** Bounds on the projection. A forecast presented without them invites false confidence. */
  readonly lower?: readonly MetricPoint[];
  readonly upper?: readonly MetricPoint[];
  readonly generatedAt: IsoTimestamp;
}

export interface ForecastService {
  forecast(metricId: string, horizon: { readonly to: IsoTimestamp; readonly method?: Forecast["method"] }): Promise<Result<Forecast>>;
}

export const ForecastToken = createCapabilityToken<ForecastService>("analytics.forecast");

export interface AnalyticsEvents {
  "analytics.snapshot.captured": { readonly id: Id; readonly count: number };
  "analytics.report.rendered": { readonly reportId: Id; readonly format: string };
}

export const ANALYTICS_COMMANDS = {
  captureSnapshot: "analytics.snapshot",
  renderReport: "analytics.report.render",
  forecastMetric: "analytics.forecast",
} as const;
