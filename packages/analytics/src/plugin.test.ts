import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AnalyticsToken,
  ForecastToken,
  MetricProviderToken,
  ReportToken,
  type MetricProvider,
} from "./contracts.js";
import { createAnalyticsPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

let harness: TestHarness;
let clock: ReturnType<typeof createFixedClock>;

const provider = (
  metricId: string,
  domain: string,
  value: () => number,
  failing = false,
): MetricProvider => ({
  definitions: [{ id: metricId, label: metricId, unit: "count", domain }],
  sample: async (id, at) =>
    failing
      ? { ok: false, error: new Error("provider down") as never }
      : { ok: true, value: [{ metricId: id, at: at ?? "2026-01-01T00:00:00.000Z", value: value() }] },
});

beforeEach(async () => {
  clock = createFixedClock();
  harness = createTestHarness();
  await harness.load(createAnalyticsPlugin({ clock, ids: createCountingIdFactory() }));
});

const analytics = () => unwrapOk(harness.kernel.capabilities.require(AnalyticsToken));
const reports = () => unwrapOk(harness.kernel.capabilities.require(ReportToken));
const forecasts = () => unwrapOk(harness.kernel.capabilities.require(ForecastToken));

describe("metrics", () => {
  it("aggregates definitions across providers and filters by domain", () => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("issues.open", "coordination", () => 3));
    harness.kernel.capabilities.provide(MetricProviderToken, provider("cost.total", "estimating", () => 100));

    expect(analytics().definitions()).toHaveLength(2);
    expect(analytics().definitions("estimating")).toHaveLength(1);
  });

  it("samples only the metrics asked for", async () => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("issues.open", "coordination", () => 3));
    harness.kernel.capabilities.provide(MetricProviderToken, provider("cost.total", "estimating", () => 100));

    const points = unwrapOk(await analytics().sample(["cost.total"]));
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(100);
  });

  it("keeps going when one provider fails", async () => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("bad", "x", () => 0, true));
    harness.kernel.capabilities.provide(MetricProviderToken, provider("good", "x", () => 7));

    // A dashboard missing one tile is far more useful than one that refuses to render.
    const points = unwrapOk(await analytics().sample(["bad", "good"]));
    expect(points).toHaveLength(1);
    expect(points[0]?.metricId).toBe("good");
  });

  it("records history as it samples", async () => {
    let value = 1;
    harness.kernel.capabilities.provide(MetricProviderToken, provider("m", "x", () => value));

    await analytics().sample(["m"]);
    clock.advance(86_400_000);
    value = 5;
    await analytics().sample(["m"]);

    const series = unwrapOk(
      await analytics().series("m", "2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"),
    );
    expect(series.map((p) => p.value)).toEqual([1, 5]);
  });

  it("captures a snapshot of every known metric", async () => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("a", "x", () => 1));
    harness.kernel.capabilities.provide(MetricProviderToken, provider("b", "x", () => 2));

    const snapshot = unwrapOk(await analytics().snapshot("Week 1"));
    expect(snapshot.points).toHaveLength(2);
  });
});

describe("reports", () => {
  beforeEach(() => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("issues.open", "coordination", () => 4));
  });

  it("renders JSON with sampled metrics", async () => {
    const report = unwrapOk(
      await reports().upsert({
        name: "Weekly",
        sections: [{ title: "Coordination", metricIds: ["issues.open"], narrative: "Trending down" }],
      }),
    );

    const rendered = JSON.parse(new TextDecoder().decode(unwrapOk(await reports().render(report.id, "json"))));
    expect(rendered.sections[0].metrics[0].value).toBe(4);
    expect(rendered.sections[0].narrative).toBe("Trending down");
  });

  it("escapes untrusted text when rendering HTML", async () => {
    const report = unwrapOk(
      await reports().upsert({
        name: "Weekly",
        sections: [{ title: "<script>alert(1)</script>", metricIds: [] }],
      }),
    );

    const html = new TextDecoder().decode(unwrapOk(await reports().render(report.id, "html")));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses formats that need a document toolkit this package does not carry", async () => {
    const report = unwrapOk(await reports().upsert({ name: "W", sections: [] }));
    expect((await reports().render(report.id, "pdf")).ok).toBe(false);
  });

  it("reports an unknown report id", async () => {
    expect((await reports().render("ghost", "json")).ok).toBe(false);
  });
});

describe("forecasting", () => {
  it("projects a trend and reports a confidence band", async () => {
    let value = 10;
    harness.kernel.capabilities.provide(MetricProviderToken, provider("m", "x", () => value));

    for (const next of [10, 20, 30, 40]) {
      value = next;
      await analytics().sample(["m"]);
      clock.advance(86_400_000);
    }

    const forecast = unwrapOk(
      await forecasts().forecast("m", { to: "2026-01-08T00:00:00.000Z" }),
    );

    expect(forecast.points.length).toBeGreaterThan(0);
    expect(forecast.points[0]!.value).toBeGreaterThan(40);
    // A projection shown without bounds invites false confidence.
    expect(forecast.lower?.[0]!.value).toBeLessThan(forecast.points[0]!.value);
    expect(forecast.upper?.[0]!.value).toBeGreaterThan(forecast.points[0]!.value);
  });

  it("refuses to forecast from a single point", async () => {
    harness.kernel.capabilities.provide(MetricProviderToken, provider("m", "x", () => 1));
    await analytics().sample(["m"]);

    // Projecting from one point presents an assumption as a forecast.
    const result = await forecasts().forecast("m", { to: "2026-06-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Not enough history");
  });

  it("refuses to forecast a metric with no history", async () => {
    expect((await forecasts().forecast("unknown", { to: "2026-06-01T00:00:00.000Z" })).ok).toBe(false);
  });
});
