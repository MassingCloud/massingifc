import type { FieldStatusRecord, Id, IsoTimestamp, Money } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  definePlugin,
  systemClock,
  type Clock,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  BoqLineSourceToken,
  FieldStatusToken,
  InspectionToken,
  InstallProgressToken,
  PROCUREMENT_COMMANDS,
  PROCUREMENT_PERMISSIONS,
  PackageToken,
  VendorScopeToken,
} from "./contracts.js";
import {
  createFieldStatusService,
  createInspectionService,
  createInstallProgressService,
  createPackageService,
  createProcurementStores,
  createVendorScopeService,
} from "./services.js";

export interface ProcurementPluginOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly currency?: string;
}

/**
 * Procurement and field.
 *
 * The point where 5D stops being an estimate. Progress is recorded against elements rather than
 * typed as a percentage against a task, because element-level state is what makes an earned-value
 * claim traceable back to geometry.
 */
export function createProcurementPlugin(options: ProcurementPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createCountingIdFactory();
  const currency = options.currency ?? "GBP";

  return definePlugin({
    id: "massingifc.procurement",
    version: "0.1.0",
    name: "Procurement & field",
    description: "Packages, vendor scope, field status, inspection and install progress.",
    permissions: Object.values(PROCUREMENT_PERMISSIONS),

    activate(context) {
      const stores = createProcurementStores(context);
      const runtime = {
        context,
        clock,
        ids,
        currency,
        boqLines: (lineIds?: readonly Id[]) =>
          context.capabilities.get(BoqLineSourceToken)?.(lineIds) ?? [],
      };

      const packages = createPackageService(runtime, stores);
      const vendors = createVendorScopeService(runtime, stores);
      const field = createFieldStatusService(runtime, stores);
      const inspections = createInspectionService(runtime, stores);
      const progress = createInstallProgressService(runtime, stores);

      context.capabilities.provide(PackageToken, packages, { version: "0.1.0" });
      context.capabilities.provide(VendorScopeToken, vendors, { version: "0.1.0" });
      context.capabilities.provide(FieldStatusToken, field, { version: "0.1.0" });
      context.capabilities.provide(InspectionToken, inspections, { version: "0.1.0" });
      context.capabilities.provide(InstallProgressToken, progress, { version: "0.1.0" });

      context.commands.register<{ boqLineIds: readonly Id[]; name: string; code: string }, unknown>({
        id: PROCUREMENT_COMMANDS.packageFromBoq,
        title: "Create package from BOQ",
        permission: PROCUREMENT_PERMISSIONS.managePackages,
        handler: async ({ boqLineIds, name, code }) => {
          const created = await packages.fromBoqLines(boqLineIds, name, code);
          if (!created.ok) throw created.error;
          return created.value;
        },
      });

      context.commands.register<{ packageId: Id; vendorId: Id; value: Money }, unknown>({
        id: PROCUREMENT_COMMANDS.awardPackage,
        title: "Award package",
        permission: PROCUREMENT_PERMISSIONS.award,
        handler: async ({ packageId, vendorId, value }) => {
          const awarded = await vendors.award(packageId, vendorId, value);
          if (!awarded.ok) throw awarded.error;
          return awarded.value;
        },
      });

      context.commands.register<Omit<FieldStatusRecord, "id">, unknown>({
        id: PROCUREMENT_COMMANDS.recordFieldStatus,
        title: "Record field status",
        permission: PROCUREMENT_PERMISSIONS.recordField,
        handler: async (status) => {
          const recorded = await field.record(status);
          if (!recorded.ok) throw recorded.error;
          return recorded.value;
        },
      });

      context.commands.register<{ packageId: Id; dataDate: IsoTimestamp }, unknown>({
        id: PROCUREMENT_COMMANDS.computeProgress,
        title: "Compute install progress",
        handler: async ({ packageId, dataDate }) => {
          const computed = await progress.compute(packageId, dataDate);
          if (!computed.ok) throw computed.error;
          return computed.value;
        },
      });

      context.ui.register({ id: "procurement.panel", point: "panel", title: "Packages", placement: "right", order: 45 });
      context.ui.register({ id: "field.panel", point: "panel", title: "Field", placement: "bottom", order: 30 });

      context.logger.info("Procurement and field ready", { currency });
    },
  });
}

export const procurementPlugin = createProcurementPlugin();
