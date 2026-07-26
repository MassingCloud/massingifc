import type { Id } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  BoqToken,
  CashflowForecastToken,
  ChangeImpactToken,
  ClassificationMappingToken,
  CostAssemblyToken,
  ESTIMATING_COMMANDS,
  ESTIMATING_PERMISSIONS,
  EstimateToken,
  ModelElementSourceToken,
  QuantityTakeoffToken,
  ScheduleBasisToken,
} from "./contracts.js";
import {
  createBoqService,
  createCashflowService,
  createChangeImpactService,
  createClassificationService,
  createCostAssemblyService,
  createEstimateService,
  createEstimatingStores,
  createQuantityTakeoffService,
  type RevisionDiffSource,
} from "./services.js";

export interface EstimatingPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  /** Project currency. Every rate and total must be in it. */
  readonly currency?: string;
  /** Supplies revision diffs for change assessment; normally the coordination plugin. */
  readonly diffs?: RevisionDiffSource;
}

/**
 * The 5D capability.
 *
 * Holds the chain from model to money intact: element -> quantity (with its rule and model
 * revision) -> classified item -> priced assembly -> BOQ line -> estimate -> cashflow, and back
 * again from any number to the elements that produced it.
 */
export function createEstimatingPlugin(options: EstimatingPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const currency = options.currency ?? "GBP";
  const diffs: RevisionDiffSource = options.diffs ?? (() => undefined);

  return definePlugin({
    id: "massingifc.estimating",
    version: "0.1.0",
    name: "5D estimating",
    description: "Quantity takeoff, classification, cost assemblies, BOQ, estimates and cashflow.",
    permissions: Object.values(ESTIMATING_PERMISSIONS),

    activate(context) {
      const stores = createEstimatingStores(context);
      const runtime = {
        context,
        clock,
        ids,
        currency,
        elements: () => context.capabilities.get(ModelElementSourceToken),
        scheduleBasis: () => context.capabilities.get(ScheduleBasisToken),
      };

      const takeoff = createQuantityTakeoffService(runtime, stores);
      const classification = createClassificationService(runtime, stores);
      const assemblies = createCostAssemblyService(runtime, stores);
      const boqs = createBoqService(runtime, stores, assemblies);
      const estimates = createEstimateService(runtime, stores);
      const cashflow = createCashflowService(runtime, stores);
      const changes = createChangeImpactService(runtime, stores, diffs);

      context.capabilities.provide(QuantityTakeoffToken, takeoff, { version: "0.1.0" });
      context.capabilities.provide(ClassificationMappingToken, classification, { version: "0.1.0" });
      context.capabilities.provide(CostAssemblyToken, assemblies, { version: "0.1.0" });
      context.capabilities.provide(BoqToken, boqs, { version: "0.1.0" });
      context.capabilities.provide(EstimateToken, estimates, { version: "0.1.0" });
      context.capabilities.provide(CashflowForecastToken, cashflow, { version: "0.1.0" });
      context.capabilities.provide(ChangeImpactToken, changes, { version: "0.1.0" });

      context.commands.register<{ modelIds?: readonly Id[]; ruleIds?: readonly Id[] }, unknown>({
        id: ESTIMATING_COMMANDS.runTakeoff,
        title: "Run quantity takeoff",
        permission: ESTIMATING_PERMISSIONS.runTakeoff,
        handler: async (params) => {
          const run = await takeoff.run(params);
          if (!run.ok) throw run.error;
          return run.value;
        },
      });

      context.commands.register<{ systemId: Id; quantityIds?: readonly Id[] }, unknown>({
        id: ESTIMATING_COMMANDS.classifyQuantities,
        title: "Classify quantities",
        permission: ESTIMATING_PERMISSIONS.runTakeoff,
        handler: async ({ systemId, quantityIds }) => {
          const classified = await classification.classify(systemId, quantityIds);
          if (!classified.ok) throw classified.error;
          return classified.value;
        },
      });

      context.commands.register<{ boqId: Id; autoPrice?: boolean }, unknown>({
        id: ESTIMATING_COMMANDS.generateBoq,
        title: "Generate BOQ",
        permission: ESTIMATING_PERMISSIONS.runTakeoff,
        handler: async ({ boqId, autoPrice }) => {
          const generated = await boqs.generate(boqId, { autoPrice: autoPrice ?? true });
          if (!generated.ok) throw generated.error;
          return generated.value;
        },
      });

      context.commands.register<{ boqId: Id; format: "csv" | "json" }, Uint8Array>({
        id: ESTIMATING_COMMANDS.exportBoq,
        title: "Export BOQ",
        handler: async ({ boqId, format }) => {
          const exported = await boqs.export(boqId, format);
          if (!exported.ok) throw exported.error;
          return exported.value;
        },
      });

      context.commands.register<{ name: string; boqId: Id; contingencyPercent?: number }, unknown>({
        id: ESTIMATING_COMMANDS.createEstimate,
        title: "Create estimate",
        permission: ESTIMATING_PERMISSIONS.editRates,
        handler: async ({ name, boqId, contingencyPercent }) => {
          const created = await estimates.create(name, boqId, {
            ...(contingencyPercent === undefined ? {} : { contingencyPercent }),
          });
          if (!created.ok) throw created.error;
          return created.value;
        },
      });

      context.commands.register<{ estimateId: Id }, unknown>({
        id: ESTIMATING_COMMANDS.issueEstimate,
        title: "Issue estimate",
        permission: ESTIMATING_PERMISSIONS.issueEstimate,
        handler: async ({ estimateId }) => {
          const issued = await estimates.issue(estimateId);
          if (!issued.ok) throw issued.error;
          return issued.value;
        },
      });

      context.commands.register<{ diffId: Id; estimateId: Id }, unknown>({
        id: ESTIMATING_COMMANDS.assessChange,
        title: "Assess change impact",
        permission: ESTIMATING_PERMISSIONS.approveChange,
        handler: async ({ diffId, estimateId }) => {
          const assessed = await changes.assess(diffId, estimateId);
          if (!assessed.ok) throw assessed.error;
          return assessed.value;
        },
      });

      context.ui.register({ id: "estimating.panel", point: "panel", title: "Estimating", placement: "right", order: 40 });
      context.ui.register({ id: "estimating.boq", point: "panel", title: "Bill of quantities", placement: "bottom", order: 10 });

      context.logger.info("5D estimating ready", { currency });
    },
  });
}

export const estimatingPlugin = createEstimatingPlugin();
