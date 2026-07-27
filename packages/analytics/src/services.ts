import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type { Id, IsoTimestamp } from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import type {
  AnalyticsService,
  Forecast,
  ForecastService,
  MetricDefinition,
  MetricPoint,
  MetricProvider,
  ReportDefinition,
  ReportService,
} from "./contracts.js";

interface SeriesRecord {
  readonly id: Id;
  readonly metricId: string;
  readonly at: IsoTimestamp;
  readonly value: number;
}

interface SnapshotRecord {
  readonly id: Id;
  readonly label?: string;
  readonly at: IsoTimestamp;
  readonly points: readonly MetricPoint[];
}

export interface AnalyticsStores {
  readonly series: RecordStore<SeriesRecord>;
  readonly snapshots: RecordStore<SnapshotRecord>;
  readonly reports: RecordStore<ReportDefinition>;
}

export interface AnalyticsRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly providers: () => readonly MetricProvider[];
}

export function createAnalyticsStores(context: PluginContext): AnalyticsStores {
  return {
    series: createRecordStore<SeriesRecord>(context.state, "series"),
    snapshots: createRecordStore<SnapshotRecord>(context.state, "snapshots"),
    reports: createRecordStore<ReportDefinition>(context.state, "reports"),
  };
}

const notFound = (kind: string, id: string): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

export function createAnalyticsService(
  runtime: AnalyticsRuntime,
  stores: AnalyticsStores,
): AnalyticsService {
  const definitions = (domain?: string): MetricDefinition[] => {
    const all = runtime.providers().flatMap((provider) => provider.definitions);
    const seen = new Map<string, MetricDefinition>();
    for (const definition of all) if (!seen.has(definition.id)) seen.set(definition.id, definition);
    const list = [...seen.values()];
    return domain === undefined ? list : list.filter((d) => d.domain === domain);
  };

  const sample = async (metricIds: readonly string[], at?: IsoTimestamp): Promise<MetricPoint[]> => {
    const when = at ?? runtime.clock.timestamp();
    const points: MetricPoint[] = [];

    for (const provider of runtime.providers()) {
      const owned = provider.definitions
        .map((definition) => definition.id)
        .filter((id) => metricIds.includes(id));
      for (const metricId of owned) {
        const result = await provider.sample(metricId, when);
        // A provider that fails contributes nothing rather than failing the whole sample: a
        // dashboard missing one tile is far more useful than a dashboard that refuses to render.
        if (result.ok) points.push(...result.value);
      }
    }
    return points;
  };

  return {
    definitions,

    async sample(metricIds, at) {
      const points = await sample(metricIds, at);
      // Recorded on every sample so `series` has history without a separate collection pass.
      stores.series.addMany(
        points.map((point) => ({
          id: runtime.ids.next("point"),
          metricId: point.metricId,
          at: point.at,
          value: point.value,
        })),
      );
      return ok(points);
    },

    async series(metricId, from, to) {
      return ok(
        stores.series
          .query((record) => record.metricId === metricId && record.at >= from && record.at <= to)
          .slice()
          .sort((a, b) => (a.at < b.at ? -1 : 1))
          .map((record) => ({ metricId: record.metricId, at: record.at, value: record.value })),
      );
    },

    async snapshot(label) {
      const points = await sample(definitions().map((definition) => definition.id));
      const record: SnapshotRecord = {
        id: runtime.ids.next("snapshot"),
        at: runtime.clock.timestamp(),
        points,
        ...(label === undefined ? {} : { label }),
      };
      stores.snapshots.add(record);
      runtime.context.events.emit("analytics.snapshot.captured", {
        id: record.id,
        count: points.length,
      });
      return ok({ id: record.id, points });
    },
  };
}

export function createReportService(
  runtime: AnalyticsRuntime,
  stores: AnalyticsStores,
  analytics: AnalyticsService,
): ReportService {
  return {
    definitions: () => stores.reports.all(),

    async upsert(definition) {
      const id = definition.id ?? runtime.ids.next("report");
      const record: ReportDefinition = { ...definition, id };
      if (stores.reports.has(id)) stores.reports.replace(record);
      else stores.reports.add(record);
      return ok(record);
    },

    async render(reportId, format) {
      const report = stores.reports.get(reportId);
      if (!report) return err(notFound("report", reportId));

      const sections = [];
      for (const section of report.sections) {
        const points = section.metricIds
          ? await analytics.sample(section.metricIds)
          : { ok: true as const, value: [] as MetricPoint[] };
        sections.push({
          title: section.title,
          ...(section.narrative === undefined ? {} : { narrative: section.narrative }),
          ...(section.tableData === undefined ? {} : { tableData: section.tableData }),
          metrics: points.ok ? points.value : [],
        });
      }

      const payload = { report: report.name, generatedAt: runtime.clock.timestamp(), sections };
      runtime.context.events.emit("analytics.report.rendered", { reportId, format });

      if (format === "json") {
        return ok(new TextEncoder().encode(JSON.stringify(payload, null, 2)));
      }
      if (format === "html") {
        const escape = (value: string): string =>
          value.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
        const body = sections
          .map(
            (section) =>
              `<section><h2>${escape(section.title)}</h2>` +
              (section.narrative ? `<p>${escape(section.narrative)}</p>` : "") +
              `<ul>${section.metrics
                .map((m) => `<li>${escape(m.metricId)}: ${m.value}</li>`)
                .join("")}</ul></section>`,
          )
          .join("");
        return ok(
          new TextEncoder().encode(
            `<article><h1>${escape(report.name)}</h1>${body}</article>`,
          ),
        );
      }
      // PDF and XLSX need a document toolkit this package deliberately does not carry.
      return err(
        new KernelError("COMMAND_FAILED", `Report format "${format}" needs a host renderer.`, {
          format,
        }),
      );
    },
  };
}

/** Least-squares fit over the series, extrapolated to the horizon. */
function linearForecast(points: readonly SeriesRecord[], to: number, step: number): MetricPoint[] {
  if (points.length < 2) return [];
  const times = points.map((point) => new Date(point.at).getTime());
  const meanT = times.reduce((a, b) => a + b, 0) / times.length;
  const meanV = points.reduce((a, b) => a + b.value, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  points.forEach((point, index) => {
    const dt = (times[index] ?? 0) - meanT;
    numerator += dt * (point.value - meanV);
    denominator += dt * dt;
  });
  const slope = denominator === 0 ? 0 : numerator / denominator;

  const projected: MetricPoint[] = [];
  const last = times[times.length - 1] ?? meanT;
  for (let t = last + step; t <= to; t += step) {
    projected.push({
      metricId: points[0]!.metricId,
      at: new Date(t).toISOString(),
      value: meanV + slope * (t - meanT),
    });
  }
  return projected;
}

export function createForecastService(
  runtime: AnalyticsRuntime,
  stores: AnalyticsStores,
): ForecastService {
  return {
    async forecast(metricId, horizon) {
      const history = stores.series
        .query((record) => record.metricId === metricId)
        .slice()
        .sort((a, b) => (a.at < b.at ? -1 : 1));

      if (history.length < 2) {
        // Two points is the minimum that can express a trend. Projecting from one would be
        // presenting an assumption as a forecast.
        return err(
          new KernelError("COMMAND_FAILED", `Not enough history to forecast "${metricId}".`, {
            metricId,
            points: history.length,
          }),
        );
      }

      const to = new Date(horizon.to).getTime();
      const first = new Date(history[0]!.at).getTime();
      const last = new Date(history[history.length - 1]!.at).getTime();
      const step = Math.max(1, (last - first) / Math.max(1, history.length - 1));

      const points = linearForecast(history, to, step);
      // Residual spread drives the band. A forecast shown without one invites false confidence.
      const values = history.map((record) => record.value);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const deviation = Math.sqrt(
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
      );

      const forecast: Forecast = {
        metricId,
        method: horizon.method ?? "linear",
        points,
        lower: points.map((point) => ({ ...point, value: point.value - deviation })),
        upper: points.map((point) => ({ ...point, value: point.value + deviation })),
        generatedAt: runtime.clock.timestamp(),
      };
      return ok(forecast);
    },
  };
}
