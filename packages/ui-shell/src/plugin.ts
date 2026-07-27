import {
  createCountingIdFactory,
  definePlugin,
  type IdFactory,
  type Plugin,
} from "@massingifc/plugin-sdk";
import {
  CommandPaletteToken,
  NotificationToken,
  SHELL_COMMANDS,
  ShellToken,
  StatusBarToken,
} from "./contracts.js";
import {
  createCommandPaletteService,
  createNotificationService,
  createShellService,
  createStatusBarService,
  type ShellPanelContribution,
} from "./services.js";

export interface ShellPluginOptions {
  readonly ids?: IdFactory;
  /**
   * Panel contributions, supplied by the host from `kernel.ui.byPoint("panel")`.
   *
   * Passed in rather than read behind the plugin's back: the shell must reflect what plugins
   * actually contributed, not a second list that drifts from it.
   */
  readonly panels?: () => readonly ShellPanelContribution[];
  readonly defaultVisible?: boolean;
}

/**
 * A headless reference shell.
 *
 * Rendering belongs to the host, but the bookkeeping — which panels exist, which are open, what the
 * layout was, what the palette offers — is identical in a web app, a desktop window and a test.
 * Implementing it once means a host writes only the drawing.
 */
export function createShellPlugin(options: ShellPluginOptions = {}): Plugin {
  const ids = options.ids ?? createCountingIdFactory();

  return definePlugin({
    id: "massingifc.shell",
    version: "0.1.0",
    name: "Shell",
    description: "Layout, notifications, command palette and status bar.",

    activate(context) {
      const runtime = {
        context,
        ids,
        panels: options.panels ?? (() => []),
        ...(options.defaultVisible === undefined ? {} : { defaultVisible: options.defaultVisible }),
      };

      const shell = createShellService(runtime);
      const notifications = createNotificationService(runtime);
      const palette = createCommandPaletteService(runtime, () => context.commands.list());
      const statusBar = createStatusBarService();

      context.capabilities.provide(ShellToken, shell, { version: "0.1.0" });
      context.capabilities.provide(NotificationToken, notifications, { version: "0.1.0" });
      context.capabilities.provide(CommandPaletteToken, palette, { version: "0.1.0" });
      context.capabilities.provide(StatusBarToken, statusBar, { version: "0.1.0" });

      context.commands.register<{ contributionId: string }, void>({
        id: SHELL_COMMANDS.togglePanel,
        title: "Toggle panel",
        handler: ({ contributionId }) => {
          const toggled = shell.togglePanel(contributionId);
          if (!toggled.ok) throw toggled.error;
        },
      });

      context.commands.register<{ query?: string }, void>({
        id: SHELL_COMMANDS.openPalette,
        title: "Open command palette",
        handler: ({ query }) => palette.open(query),
      });

      context.commands.register<Record<string, never>, void>({
        id: SHELL_COMMANDS.resetLayout,
        title: "Reset layout",
        handler: () => {
          shell.restoreLayout({ visible: {}, sizes: {} });
        },
      });

      context.logger.info("Shell ready");
    },
  });
}

export const shellPlugin = createShellPlugin();
