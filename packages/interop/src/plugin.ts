import { createCapabilityToken, definePlugin, systemClock, type Clock, type Plugin } from "@massingifc/plugin-sdk";
import {
  ExportAdapterToken,
  EnterpriseConnectorToken,
  ImportAdapterToken,
  INTEROP_COMMANDS,
  INTEROP_PERMISSIONS,
  InteropToken,
} from "./contracts.js";
import { ConnectorRegistry, createInteropService } from "./services.js";

export const ConnectorRegistryToken = createCapabilityToken<ConnectorRegistry>("interop.connectors");

export interface InteropPluginOptions {
  readonly clock?: Clock;
}

/**
 * The interop capability.
 *
 * Import and export are adapter registries; the value is in the adapters, which arrive as separate
 * plugins. What lives here is the dispatch policy — content-first format detection — and the
 * governance boundary around connectors.
 */
export function createInteropPlugin(options: InteropPluginOptions = {}): Plugin {
  const clock = options.clock ?? systemClock;

  return definePlugin({
    id: "massingifc.interop",
    version: "0.1.0",
    name: "Interop",
    description: "Import/export adapters and enterprise connectors.",
    permissions: Object.values(INTEROP_PERMISSIONS),

    activate(context) {
      const runtime = {
        context,
        importAdapters: () => context.capabilities.getAll(ImportAdapterToken).map((p) => p.value),
        exportAdapters: () => context.capabilities.getAll(ExportAdapterToken).map((p) => p.value),
        connectors: () => context.capabilities.getAll(EnterpriseConnectorToken).map((p) => p.value),
      };

      const interop = createInteropService(runtime);
      const connectors = new ConnectorRegistry(runtime, () => clock.timestamp());

      context.capabilities.provide(InteropToken, interop, { version: "0.1.0" });
      context.capabilities.provide(ConnectorRegistryToken, connectors, { version: "0.1.0" });

      context.commands.register<{ payload: Uint8Array; fileName?: string }, unknown>({
        id: INTEROP_COMMANDS.importFile,
        title: "Import file",
        permission: INTEROP_PERMISSIONS.import,
        handler: async ({ payload, fileName }) => {
          const imported = await interop.import(payload, fileName === undefined ? {} : { fileName });
          if (!imported.ok) throw imported.error;
          return imported.value;
        },
      });

      context.commands.register<{ formatId: string; scope?: Record<string, unknown> }, Uint8Array>({
        id: INTEROP_COMMANDS.exportAs,
        title: "Export",
        permission: INTEROP_PERMISSIONS.export,
        handler: async ({ formatId, scope }) => {
          const exported = await interop.export(formatId, scope === undefined ? {} : { scope });
          if (!exported.ok) throw exported.error;
          return exported.value;
        },
      });

      context.commands.register<{ connectorId: string; operation: string; params?: Record<string, unknown> }, unknown>({
        id: INTEROP_COMMANDS.runOperation,
        title: "Run connector operation",
        permission: INTEROP_PERMISSIONS.manageConnectors,
        handler: async ({ connectorId, operation, params }) => {
          const result = await connectors.execute(connectorId, operation, params);
          if (!result.ok) throw result.error;
          return result.value;
        },
      });

      context.ui.register({ id: "interop.panel", point: "panel", title: "Import / export", placement: "left", order: 60 });
      context.logger.info("Interop ready");
    },
  });
}

export const interopPlugin = createInteropPlugin();
