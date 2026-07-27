/**
 * `@massingifc/interop` — import, export and enterprise connectors.
 */
export * from "./contracts.js";
export {
  ConnectorRegistry,
  createInteropService,
  extensionOf,
  selectImportAdapter,
  type ConnectorSession,
  type InteropRuntime,
} from "./services.js";
export {
  ConnectorRegistryToken,
  createInteropPlugin,
  interopPlugin,
  type InteropPluginOptions,
} from "./plugin.js";
