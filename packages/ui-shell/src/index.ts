/**
 * `@massingifc/ui-shell` — host application surface.
 */
export * from "./contracts.js";
export {
  createCommandPaletteService,
  createNotificationService,
  createShellService,
  createStatusBarService,
  type NotificationRecord,
  type ShellPanelContribution,
  type ShellRuntime,
} from "./services.js";
export { createShellPlugin, shellPlugin, type ShellPluginOptions } from "./plugin.js";
