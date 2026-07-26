import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  BoqLineRecord,
  BoqRecord,
  CashflowForecastRecord,
  ChangeImpactRecord,
  ClassificationMappingRecord,
  ClassificationSystemRecord,
  CostAssemblyRecord,
  ElementRef,
  EstimateRecord,
  Id,
  Money,
  QuantityRecord,
  ResourceRecord,
  TakeoffRuleRecord,
} from "@massingifc/project-schema";
import {
  createRecordStore,
  type Clock,
  type IdFactory,
  type RecordStore,
} from "@massingifc/plugin-sdk";
import {
  addMoney,
  evaluateExpression,
  matchesFilter,
  money,
  multiplyMoney,
  percentOf,
  sumMoney,
} from "./math.js";
import type {
  BoqService,
  CashflowForecastService,
  ChangeImpactService,
  ClassificationMappingService,
  CostAssemblyService,
  EstimateService,
  ModelElementSource,
  QuantityTakeoffService,
  ScheduleBasisSource,
  TakeoffSummary,
} from "./contracts.js";

export interface EstimatingStores {
  readonly rules: RecordStore<TakeoffRuleRecord>;
  readonly quantities: RecordStore<QuantityRecord>;
  readonly systems: RecordStore<ClassificationSystemRecord>;
  readonly mappings: RecordStore<ClassificationMappingRecord>;
  readonly resources: RecordStore<ResourceRecord>;
  readonly assemblies: RecordStore<CostAssemblyRecord>;
  readonly boqs: RecordStore<BoqRecord>;
  readonly lines: RecordStore<BoqLineRecord>;
  readonly estimates: RecordStore<EstimateRecord>;
  readonly forecasts: RecordStore<CashflowForecastRecord>;
  readonly impacts: RecordStore<ChangeImpactRecord>;
}

export interface EstimatingRuntime {
  readonly context: PluginContext;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly currency: string;
  readonly elements: () => ModelElementSource | undefined;
  readonly scheduleBasis: () => ScheduleBasisSource | undefined;
}

export function createEstimatingStores(context: PluginContext): EstimatingStores {
  return {
    rules: createRecordStore<TakeoffRuleRecord>(context.state, "takeoff-rules"),
    quantities: createRecordStore<QuantityRecord>(context.state, "quantities"),
    systems: createRecordStore<ClassificationSystemRecord>(context.state, "classification-systems"),
    mappings: createRecordStore<ClassificationMappingRecord>(context.state, "classification-mappings"),
    resources: createRecordStore<ResourceRecord>(context.state, "resources"),
    assemblies: createRecordStore<CostAssemblyRecord>(context.state, "assemblies"),
    boqs: createRecordStore<BoqRecord>(context.state, "boqs"),
    lines: createRecordStore<BoqLineRecord>(context.state, "boq-lines"),
    estimates: createRecordStore<EstimateRecord>(context.state, "estimates"),
    forecasts: createRecordStore<CashflowForecastRecord>(context.state, "cashflows"),
    impacts: createRecordStore<ChangeImpactRecord>(context.state, "change-impacts"),
  };
}

const notFound = (kind: string, id: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `No ${kind} with id "${id}".`, { id });

const missing = (what: string): KernelError =>
  new KernelError("CAPABILITY_NOT_FOUND", `No ${what} is installed.`, {});

const elementKey = (element: ElementRef): string => `${element.modelId}/${element.globalId}`;

/** `A` -> `B` -> `C`; falls back to appending when the revision is not a single letter. */
function nextRevision(revision: string): string {
  if (/^[A-Y]$/.test(revision)) return String.fromCharCode(revision.charCodeAt(0) + 1);
  return `${revision}1`;
}

// ---------------------------------------------------------------------------------------------
// Takeoff
// ---------------------------------------------------------------------------------------------

export function createQuantityTakeoffService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
): QuantityTakeoffService {
  return {
    rules: () => stores.rules.all(),

    async addRule(rule) {
      const record: TakeoffRuleRecord = { ...rule, id: runtime.ids.next("rule") };
      stores.rules.add(record);
      return ok(record);
    },

    setRuleEnabled(ruleId, enabled) {
      stores.rules.update(ruleId, { enabled });
    },

    async run(options) {
      const source = runtime.elements();
      if (!source) return err(missing("model element source"));

      const modelIds = options?.modelIds ?? source.modelIds();
      const rules = stores.rules
        .query((rule) => rule.enabled)
        .filter((rule) => options?.ruleIds === undefined || options.ruleIds.includes(rule.id));

      const takenAt = runtime.clock.timestamp();
      const measured = new Set<string>();
      const produced: QuantityRecord[] = [];
      const unmeasured: ElementRef[] = [];

      for (const modelId of modelIds) {
        const modelVersion = source.modelVersion(modelId);

        for (const candidate of source.elements(modelId)) {
          let matchedAny = false;

          for (const rule of rules) {
            if (!matchesFilter(rule.filter, candidate)) continue;

            const value = rule.expression
              ? evaluateExpression(rule.expression, candidate.quantities)
              : ok(candidate.quantities[rule.metric] ?? Number.NaN);

            // A rule that cannot measure an element it claimed is reported, not silently zeroed —
            // a confident wrong number is the expensive failure here.
            if (!value.ok || !Number.isFinite(value.value)) continue;

            matchedAny = true;
            produced.push({
              id: runtime.ids.next("qty"),
              modelId,
              metric: rule.metric,
              quantity: { value: value.value, unit: rule.unit },
              elements: [candidate.element],
              source: {
                kind: "model-takeoff",
                ruleId: rule.id,
                ruleVersion: rule.version,
                ...(modelVersion === undefined ? {} : { modelVersion }),
              },
              takenAt,
            });
          }

          if (matchedAny) measured.add(elementKey(candidate.element));
          else unmeasured.push(candidate.element);
        }
      }

      // Replaced wholesale for the models measured: keeping stale quantities alongside fresh ones
      // silently doubles a takeoff on the second run.
      const scope = new Set(modelIds);
      stores.quantities.removeWhere(
        (quantity) =>
          scope.has(quantity.modelId) &&
          (options?.ruleIds === undefined ||
            (quantity.source.ruleId !== undefined && options.ruleIds.includes(quantity.source.ruleId))),
      );
      stores.quantities.addMany(produced);

      const summary: TakeoffSummary = {
        quantities: produced.length,
        elementsMeasured: measured.size,
        unmeasured,
        takenAt,
      };
      runtime.context.events.emit("estimating.takeoff.completed", { summary });
      return ok(summary);
    },

    quantities: (filter) =>
      filter === undefined
        ? stores.quantities.all()
        : stores.quantities.query(
            (quantity) =>
              (filter.modelId === undefined || quantity.modelId === filter.modelId) &&
              (filter.metric === undefined || quantity.metric === filter.metric) &&
              (filter.classificationCode === undefined ||
                quantity.classificationCode === filter.classificationCode),
          ),

    elementsFor: (quantityId) => stores.quantities.get(quantityId)?.elements ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export function createClassificationService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
): ClassificationMappingService {
  return {
    systems: () => stores.systems.all(),

    async addSystem(system) {
      const record: ClassificationSystemRecord = { ...system, id: runtime.ids.next("system") };
      stores.systems.add(record);
      return ok(record);
    },

    mappings: (systemId) =>
      systemId === undefined
        ? stores.mappings.all()
        : stores.mappings.query((mapping) => mapping.systemId === systemId),

    async classify(systemId, quantityIds) {
      if (!stores.systems.has(systemId)) return err(notFound("classification system", systemId));

      const source = runtime.elements();
      const mappings = stores.mappings.query((mapping) => mapping.systemId === systemId);
      const targets =
        quantityIds === undefined
          ? stores.quantities.all()
          : stores.quantities.query((quantity) => quantityIds.includes(quantity.id));

      let classified = 0;
      const unclassified: Id[] = [];

      for (const quantity of targets) {
        const direct = mappings.find((mapping) => mapping.quantityIds?.includes(quantity.id));
        if (direct) {
          stores.quantities.update(quantity.id, { classificationCode: direct.code });
          classified++;
          continue;
        }

        // Filter-based mappings are matched against the element the quantity came from, which is
        // why the takeoff keeps element references rather than only totals.
        const first = quantity.elements[0];
        const candidate =
          first && source
            ? source
                .elements(quantity.modelId)
                .find((entry) => entry.element.globalId === first.globalId)
            : undefined;

        const matched = candidate
          ? mappings.find((mapping) => mapping.filter && matchesFilter(mapping.filter, candidate))
          : undefined;

        if (matched) {
          stores.quantities.update(quantity.id, { classificationCode: matched.code });
          classified++;
        } else {
          unclassified.push(quantity.id);
        }
      }
      return ok({ classified, unclassified });
    },

    async setMapping(mapping) {
      const id = mapping.id ?? runtime.ids.next("mapping");
      const record: ClassificationMappingRecord = { ...mapping, id };
      if (stores.mappings.has(id)) stores.mappings.replace(record);
      else stores.mappings.add(record);
      return ok(record);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cost assemblies
// ---------------------------------------------------------------------------------------------

export function createCostAssemblyService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
): CostAssemblyService {
  const unitRate = (assemblyId: Id): Result<Money> => {
    const assembly = stores.assemblies.get(assemblyId);
    if (!assembly) return err(notFound("cost assembly", assemblyId));

    const components: Money[] = [];
    for (const component of assembly.components) {
      const resource = stores.resources.get(component.resourceId);
      if (!resource) return err(notFound("resource", component.resourceId));
      if (resource.rate.currency !== runtime.currency) {
        return err(
          new KernelError("COMMAND_FAILED", `Resource "${resource.name}" is not in ${runtime.currency}.`, {
            resourceId: resource.id,
          }),
        );
      }
      // Waste inflates the consumed quantity, not the rate — the two are different things and the
      // distinction matters when someone asks what the waste allowance actually cost.
      const factor = component.factor * (1 + (component.wastePercent ?? 0) / 100);
      components.push(multiplyMoney(resource.rate, factor));
    }

    const net = sumMoney(components, runtime.currency);
    if (!net.ok) return err(net.error);

    // Overhead then profit, each on the running total. Applying both to the net would understate
    // the rate, which is the classic markup-on-markup error.
    const withOverhead = addMoney(net.value, percentOf(net.value, assembly.overheadPercent ?? 0));
    if (!withOverhead.ok) return err(withOverhead.error);
    const withProfit = addMoney(
      withOverhead.value,
      percentOf(withOverhead.value, assembly.profitPercent ?? 0),
    );
    return withProfit;
  };

  return {
    resources: () => stores.resources.all(),

    async upsertResource(resource) {
      const id = resource.id ?? runtime.ids.next("resource");
      const record: ResourceRecord = { ...resource, id };
      if (stores.resources.has(id)) stores.resources.replace(record);
      else stores.resources.add(record);
      return ok(record);
    },

    assemblies: (filter) =>
      filter === undefined
        ? stores.assemblies.all()
        : stores.assemblies.query(
            (assembly) =>
              (filter.libraryId === undefined || assembly.libraryId === filter.libraryId) &&
              (filter.code === undefined || assembly.code === filter.code),
          ),

    async upsertAssembly(assembly) {
      const id = assembly.id ?? runtime.ids.next("assembly");
      const record: CostAssemblyRecord = { ...assembly, id };
      if (stores.assemblies.has(id)) stores.assemblies.replace(record);
      else stores.assemblies.add(record);
      return ok(record);
    },

    unitRate,

    async importLibrary(payload) {
      const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
      const parsed = ((): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      })();
      if (!parsed || typeof parsed !== "object") {
        return err(new KernelError("COMMAND_FAILED", "Cost library is not valid JSON.", {}));
      }
      const library = parsed as {
        resources?: Omit<ResourceRecord, "id">[];
        assemblies?: Omit<CostAssemblyRecord, "id">[];
      };
      for (const resource of library.resources ?? []) {
        stores.resources.add({ ...resource, id: runtime.ids.next("resource") });
      }
      let assemblies = 0;
      for (const assembly of library.assemblies ?? []) {
        stores.assemblies.add({ ...assembly, id: runtime.ids.next("assembly") });
        assemblies++;
      }
      return ok({ assemblies });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// BOQ
// ---------------------------------------------------------------------------------------------

export function createBoqService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
  assemblies: CostAssemblyService,
): BoqService {
  return {
    async create(name, currency) {
      const record: BoqRecord = {
        id: runtime.ids.next("boq"),
        name,
        currency,
        revision: "A",
        lineIds: [],
        createdAt: runtime.clock.timestamp(),
        createdBy: runtime.context.permissions.identity.id,
      };
      stores.boqs.add(record);
      return ok(record);
    },

    async generate(boqId, options) {
      const boq = stores.boqs.get(boqId);
      if (!boq) return err(notFound("BOQ", boqId));

      const source =
        options?.quantityIds === undefined
          ? stores.quantities.all()
          : stores.quantities.query((quantity) => options.quantityIds!.includes(quantity.id));

      // Aggregated by classification code and unit. Two quantities in different units are two
      // lines however alike their codes look; summing them would be arithmetic on nonsense.
      const grouped = new Map<string, QuantityRecord[]>();
      for (const quantity of source) {
        const code = quantity.classificationCode;
        if (code === undefined) continue;
        const key = `${code}|${quantity.quantity.unit}`;
        const bucket = grouped.get(key);
        if (bucket) bucket.push(quantity);
        else grouped.set(key, [quantity]);
      }

      stores.lines.removeWhere((line) => line.boqId === boqId);
      const created: BoqLineRecord[] = [];
      const unpriced: Id[] = [];
      let itemNumber = 0;

      for (const [key, quantities] of [...grouped.entries()].sort()) {
        const [code = "", unit = ""] = key.split("|");
        const total = quantities.reduce((sum, quantity) => sum + quantity.quantity.value, 0);
        const assembly = assemblies.assemblies({ code })[0];

        const lineId = runtime.ids.next("line");
        let rate: Money | undefined;
        if (options?.autoPrice !== false && assembly) {
          const computed = assemblies.unitRate(assembly.id);
          if (computed.ok) rate = computed.value;
        }
        if (!rate) unpriced.push(lineId);

        const line: BoqLineRecord = {
          id: lineId,
          boqId,
          itemNumber: `${++itemNumber}`.padStart(3, "0"),
          description: assembly?.name ?? code,
          classificationCode: code,
          quantity: { value: total, unit },
          quantityIds: quantities.map((quantity) => quantity.id),
          ...(quantities[0]?.source === undefined ? {} : { quantitySource: quantities[0].source }),
          ...(assembly === undefined ? {} : { assemblyId: assembly.id }),
          ...(rate === undefined
            ? {}
            : {
                rate,
                rateSource: {
                  kind: "assembly" as const,
                  ...(assembly === undefined ? {} : { assemblyId: assembly.id }),
                },
                total: multiplyMoney(rate, total),
              }),
        };
        created.push(line);
      }

      stores.lines.addMany(created);
      stores.boqs.update(boqId, { lineIds: created.map((line) => line.id) });
      runtime.context.events.emit("estimating.boq.generated", { boqId, lines: created.length });
      return ok({ lines: created.length, unpriced });
    },

    lines: (boqId) => stores.lines.query((line) => line.boqId === boqId),

    async upsertLine(line) {
      const id = line.id ?? runtime.ids.next("line");
      const record: BoqLineRecord = { ...line, id };
      if (stores.lines.has(id)) stores.lines.replace(record);
      else stores.lines.add(record);
      return ok(record);
    },

    async removeLine(lineId) {
      return stores.lines.remove(lineId) ? ok(undefined) : err(notFound("BOQ line", lineId));
    },

    async export(boqId, format) {
      const boq = stores.boqs.get(boqId);
      if (!boq) return err(notFound("BOQ", boqId));
      const lines = stores.lines.query((line) => line.boqId === boqId);

      if (format === "json") {
        return ok(new TextEncoder().encode(JSON.stringify({ boq, lines }, null, 2)));
      }
      if (format === "csv") {
        const escape = (value: string): string =>
          /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        const rows = [
          ["Item", "Code", "Description", "Quantity", "Unit", "Rate", "Total"].join(","),
          ...lines.map((line) =>
            [
              line.itemNumber,
              line.classificationCode ?? "",
              escape(line.description),
              String(line.quantity.value),
              line.quantity.unit,
              line.rate === undefined ? "" : String(line.rate.amount),
              line.total === undefined ? "" : String(line.total.amount),
            ].join(","),
          ),
        ];
        return ok(new TextEncoder().encode(rows.join("\n")));
      }
      return err(
        new KernelError("COMMAND_FAILED", `Export format "${format}" is not implemented.`, { format }),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------------------------

export function createEstimateService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
): EstimateService {
  const totals = (boqId: Id, currency: string, contingencyPercent?: number): Result<{
    subtotal: Money;
    total: Money;
  }> => {
    const lines = stores.lines.query((line) => line.boqId === boqId);
    const subtotal = sumMoney(
      lines.map((line) => line.total ?? money(0, currency)),
      currency,
    );
    if (!subtotal.ok) return err(subtotal.error);
    const total = addMoney(subtotal.value, percentOf(subtotal.value, contingencyPercent ?? 0));
    if (!total.ok) return err(total.error);
    return ok({ subtotal: subtotal.value, total: total.value });
  };

  const basis = (boqId: Id): readonly { modelId: Id; version: string }[] => {
    const lines = stores.lines.query((line) => line.boqId === boqId);
    const versions = new Map<Id, string>();
    for (const line of lines) {
      for (const quantityId of line.quantityIds ?? []) {
        const quantity = stores.quantities.get(quantityId);
        const version = quantity?.source.modelVersion;
        if (quantity && version) versions.set(quantity.modelId, version);
      }
    }
    return [...versions].map(([modelId, version]) => ({ modelId, version }));
  };

  return {
    async create(name, boqId, options) {
      const boq = stores.boqs.get(boqId);
      if (!boq) return err(notFound("BOQ", boqId));

      const computed = totals(boqId, boq.currency, options?.contingencyPercent);
      if (!computed.ok) return err(computed.error);

      const record: EstimateRecord = {
        id: runtime.ids.next("estimate"),
        name,
        boqId,
        status: "draft",
        currency: boq.currency,
        subtotal: computed.value.subtotal,
        total: computed.value.total,
        // Recorded at creation: without it, "what did we price?" is unanswerable once the models
        // move on, and every change-order argument starts from scratch.
        basisModelVersions: basis(boqId),
        createdAt: runtime.clock.timestamp(),
        createdBy: runtime.context.permissions.identity.id,
        ...(options?.contingencyPercent === undefined
          ? {}
          : { contingencyPercent: options.contingencyPercent }),
      };
      stores.estimates.add(record);
      return ok(record);
    },

    async recalculate(estimateId) {
      const estimate = stores.estimates.get(estimateId);
      if (!estimate) return err(notFound("estimate", estimateId));
      if (estimate.status !== "draft") {
        // An issued estimate is a document somebody has acted on; silently repricing it destroys
        // the audit trail that makes change control possible.
        return err(
          new KernelError("COMMAND_FAILED", `Estimate "${estimateId}" is ${estimate.status}; revise it instead.`, {
            estimateId,
            status: estimate.status,
          }),
        );
      }

      const computed = totals(estimate.boqId, estimate.currency, estimate.contingencyPercent);
      if (!computed.ok) return err(computed.error);

      const updated = stores.estimates.update(estimateId, {
        subtotal: computed.value.subtotal,
        total: computed.value.total,
        basisModelVersions: basis(estimate.boqId),
      });
      return updated ? ok(updated) : err(notFound("estimate", estimateId));
    },

    async issue(estimateId) {
      const estimate = stores.estimates.get(estimateId);
      if (!estimate) return err(notFound("estimate", estimateId));
      const working = stores.boqs.get(estimate.boqId);
      if (!working) return err(notFound("BOQ", estimate.boqId));

      // Issuing freezes the bill. Without this, re-running the takeoff after issue would rewrite
      // the lines of a document a client has already been sent, and the estimate's own totals
      // would no longer agree with the lines beneath them.
      const frozenId = runtime.ids.next("boq");
      const frozenLines = stores.lines
        .query((line) => line.boqId === estimate.boqId)
        .map((line) => ({ ...line, id: runtime.ids.next("line"), boqId: frozenId }));
      stores.lines.addMany(frozenLines);
      stores.boqs.add({
        ...working,
        id: frozenId,
        name: `${working.name} (issued)`,
        revision: nextRevision(working.revision),
        lineIds: frozenLines.map((line) => line.id),
      });

      const updated = stores.estimates.update(estimateId, {
        status: "issued",
        boqId: frozenId,
        workingBoqId: estimate.workingBoqId ?? estimate.boqId,
      });
      if (!updated) return err(notFound("estimate", estimateId));
      runtime.context.events.emit("estimating.estimate.issued", { estimate: updated });
      return ok(updated);
    },

    async revise(estimateId, notes) {
      const previous = stores.estimates.get(estimateId);
      if (!previous) return err(notFound("estimate", estimateId));

      // Re-prices against the live bill, not the frozen copy the predecessor reports — the whole
      // point of a revision is to pick up what has changed since.
      const workingBoqId = previous.workingBoqId ?? previous.boqId;
      const computed = totals(workingBoqId, previous.currency, previous.contingencyPercent);
      if (!computed.ok) return err(computed.error);

      const record: EstimateRecord = {
        ...previous,
        id: runtime.ids.next("estimate"),
        name: notes ? `${previous.name} (${notes})` : previous.name,
        status: "draft",
        boqId: workingBoqId,
        workingBoqId,
        subtotal: computed.value.subtotal,
        total: computed.value.total,
        basisModelVersions: basis(workingBoqId),
        createdAt: runtime.clock.timestamp(),
        supersedesId: previous.id,
      };
      stores.estimates.add(record);
      stores.estimates.update(previous.id, { status: "superseded" });
      return ok(record);
    },

    get: (estimateId) => stores.estimates.get(estimateId),
    list: () => stores.estimates.all(),

    async compare(a, b) {
      const first = stores.estimates.get(a);
      const second = stores.estimates.get(b);
      if (!first) return err(notFound("estimate", a));
      if (!second) return err(notFound("estimate", b));
      if (first.currency !== second.currency) {
        return err(new KernelError("COMMAND_FAILED", "Estimates are in different currencies.", {}));
      }

      const linesOf = (estimate: EstimateRecord): Map<string, BoqLineRecord> =>
        new Map(
          stores.lines
            .query((line) => line.boqId === estimate.boqId)
            // Keyed by classification code rather than line id: comparing regenerated BOQs by id
            // reports every line as changed, which is true and useless.
            .map((line) => [line.classificationCode ?? line.id, line]),
        );

      const firstLines = linesOf(first);
      const secondLines = linesOf(second);
      const changed: { lineId: Id; delta: Money }[] = [];

      for (const key of new Set([...firstLines.keys(), ...secondLines.keys()])) {
        const before = firstLines.get(key)?.total ?? money(0, first.currency);
        const after = secondLines.get(key)?.total ?? money(0, first.currency);
        if (before.amount === after.amount) continue;
        changed.push({
          lineId: secondLines.get(key)?.id ?? firstLines.get(key)?.id ?? key,
          delta: money(after.amount - before.amount, first.currency),
        });
      }

      return ok({
        deltaTotal: money(second.total.amount - first.total.amount, first.currency),
        changedLines: changed,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------------------------

export function createCashflowService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
): CashflowForecastService {
  return {
    async generate(estimateId, options) {
      const estimate = stores.estimates.get(estimateId);
      if (!estimate) return err(notFound("estimate", estimateId));

      const basis = runtime.scheduleBasis();
      if (!basis) return err(missing("schedule basis"));

      const periods = basis.periods(
        estimate.createdAt,
        estimate.createdAt,
        options?.period ?? "month",
      );
      if (periods.length === 0) {
        return err(new KernelError("COMMAND_FAILED", "The schedule basis produced no periods.", {}));
      }

      let cumulative = 0;
      // The final period absorbs the rounding remainder so the cashflow sums exactly to the
      // estimate; spreading the error across periods leaves a total that does not tie back.
      const spread = periods.map((period, index) => {
        const isLast = index === periods.length - 1;
        const planned = isLast
          ? estimate.total.amount - cumulative
          : Math.round(estimate.total.amount * period.weight);
        cumulative += planned;
        return {
          periodStart: period.start,
          periodEnd: period.end,
          plannedSpend: money(planned, estimate.currency),
          cumulativePlanned: money(cumulative, estimate.currency),
        };
      });

      const record: CashflowForecastRecord = {
        id: runtime.ids.next("cashflow"),
        estimateId,
        currency: estimate.currency,
        periods: spread,
        generatedAt: runtime.clock.timestamp(),
        ...(options?.scheduleBasis === undefined ? {} : { scheduleBasis: options.scheduleBasis }),
      };
      stores.forecasts.add(record);
      return ok(record);
    },

    async recordActual(forecastId, periodStart, actual) {
      const forecast = stores.forecasts.get(forecastId);
      if (!forecast) return err(notFound("cashflow forecast", forecastId));

      let cumulative = 0;
      let found = false;
      const periods = forecast.periods.map((period) => {
        const value = period.periodStart === periodStart ? actual : period.actualSpend;
        if (period.periodStart === periodStart) found = true;
        if (value) cumulative += value.amount;
        return {
          ...period,
          ...(value === undefined ? {} : { actualSpend: value }),
          ...(value === undefined ? {} : { cumulativeActual: money(cumulative, forecast.currency) }),
        };
      });
      if (!found) {
        return err(
          new KernelError("COMMAND_FAILED", `No period starting "${periodStart}".`, { periodStart }),
        );
      }

      const updated = stores.forecasts.update(forecastId, { periods });
      return updated ? ok(updated) : err(notFound("cashflow forecast", forecastId));
    },

    get: (forecastId) => stores.forecasts.get(forecastId),
  };
}

// ---------------------------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------------------------

export interface RevisionDiffSource {
  (diffId: Id): { readonly quantityDeltas: Readonly<Record<string, number>> } | undefined;
}

export function createChangeImpactService(
  runtime: EstimatingRuntime,
  stores: EstimatingStores,
  diffs: RevisionDiffSource,
): ChangeImpactService {
  return {
    async assess(diffId, estimateId) {
      const estimate = stores.estimates.get(estimateId);
      if (!estimate) return err(notFound("estimate", estimateId));
      const diff = diffs(diffId);
      if (!diff) return err(notFound("revision diff", diffId));

      const lines = stores.lines.query((line) => line.boqId === estimate.boqId);
      const deltaQuantities: { metric: string; delta: { value: number; unit: string } }[] = [];
      let deltaCost = money(0, estimate.currency);

      for (const [metric, delta] of Object.entries(diff.quantityDeltas)) {
        // Priced at the rate already agreed for that work, not a fresh one — a change is valued
        // against the contract, and re-rating it silently is how disputes start.
        const line = lines.find((candidate) => candidate.classificationCode === metric);
        const unit = line?.quantity.unit ?? "";
        deltaQuantities.push({ metric, delta: { value: delta, unit } });
        if (line?.rate) {
          const added = addMoney(deltaCost, multiplyMoney(line.rate, delta));
          if (!added.ok) return err(added.error);
          deltaCost = added.value;
        }
      }

      const record: ChangeImpactRecord = {
        id: runtime.ids.next("impact"),
        diffId,
        estimateId,
        deltaQuantities,
        deltaCost,
        status: "estimated",
        identifiedAt: runtime.clock.timestamp(),
      };
      stores.impacts.add(record);
      runtime.context.events.emit("estimating.change.assessed", { impact: record });
      return ok(record);
    },

    async setStatus(impactId, status) {
      const updated = stores.impacts.update(impactId, { status });
      return updated ? ok(updated) : err(notFound("change impact", impactId));
    },

    list: (filter) =>
      filter === undefined
        ? stores.impacts.all()
        : stores.impacts.query(
            (impact) =>
              (filter.estimateId === undefined || impact.estimateId === filter.estimateId) &&
              (filter.status === undefined || impact.status === filter.status),
          ),

    totalApproved(estimateId) {
      const approved = stores.impacts.query(
        (impact) => impact.estimateId === estimateId && impact.status === "approved",
      );
      return sumMoney(
        approved.map((impact) => impact.deltaCost),
        stores.estimates.get(estimateId)?.currency ?? runtime.currency,
      );
    },
  };
}
