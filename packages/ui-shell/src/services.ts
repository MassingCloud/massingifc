import {
  err,
  ok,
  toDisposable,
  type Disposable,
  type PluginContext,
  type Result,
  KernelError,
} from "@massingifc/core-kernel";
import type { Id } from "@massingifc/project-schema";
import type { IdFactory } from "@massingifc/plugin-sdk";
import type {
  CommandPaletteEntry,
  CommandPaletteService,
  LayoutRegion,
  NotificationOptions,
  NotificationService,
  PanelState,
  ShellService,
  StatusBarService,
  StatusItem,
} from "./contracts.js";

/** A panel contribution as the shell sees it. */
export interface ShellPanelContribution {
  readonly id: string;
  readonly title?: string;
  readonly placement?: string;
  readonly order?: number;
}

export interface ShellRuntime {
  readonly context: PluginContext;
  readonly ids: IdFactory;
  /**
   * Panel contributions currently registered.
   *
   * Supplied by the host from the kernel's UI registry rather than read behind the plugin's back.
   * A shell that keeps its own list of panels drifts from what plugins actually contributed, and
   * the drift shows up as a panel that cannot be opened because the shell has never heard of it.
   */
  readonly panels: () => readonly ShellPanelContribution[];
  /** Panels visible when there is no stored layout. */
  readonly defaultVisible?: boolean;
}

/**
 * A headless reference shell.
 *
 * Real rendering belongs to the host application, but the *bookkeeping* — which panels exist,
 * which are open, what the layout was last time, what the palette offers — is identical whether the
 * surface is a web app, a desktop window or a test. Implementing it once here means a host writes
 * only the drawing, and the same plugin behaves the same in all three.
 */
export function createShellService(runtime: ShellRuntime): ShellService {
  const visible = new Map<string, boolean>();
  const sizes = new Map<string, number>();
  const defaultVisible = runtime.defaultVisible ?? false;

  const shellPanels = (): PanelState[] =>
    runtime.panels().map((panel) => ({
      id: panel.id,
      region: (panel.placement as LayoutRegion) ?? "left",
      visible: visible.get(panel.id) ?? defaultVisible,
      ...(sizes.has(panel.id) ? { size: sizes.get(panel.id)! } : {}),
    }));

  const panelOf = (contributionId: string): PanelState | undefined =>
    shellPanels().find((panel) => panel.id === contributionId);

  const setVisible = (contributionId: string, next: boolean): Result<void> => {
    if (!runtime.panels().some((panel) => panel.id === contributionId)) {
      return err(
        new KernelError("COMMAND_FAILED", `No panel contribution "${contributionId}".`, {
          contributionId,
        }),
      );
    }
    visible.set(contributionId, next);
    runtime.context.events.emit("shell.panel.visibility", { contributionId, visible: next });
    return ok(undefined);
  };

  return {
    showPanel: (contributionId) => setVisible(contributionId, true),
    hidePanel: (contributionId) => setVisible(contributionId, false),

    togglePanel(contributionId) {
      const current = panelOf(contributionId)?.visible ?? defaultVisible;
      return setVisible(contributionId, !current);
    },

    panels(region) {
      const all = shellPanels();
      return region === undefined ? all : all.filter((panel) => panel.region === region);
    },

    setRegionSize(region, size) {
      for (const panel of shellPanels()) {
        if (panel.region === region) sizes.set(panel.id, size);
      }
    },

    captureLayout() {
      return {
        visible: Object.fromEntries(visible),
        sizes: Object.fromEntries(sizes),
      };
    },

    restoreLayout(layout) {
      const storedVisible = layout["visible"];
      const storedSizes = layout["sizes"];
      if (typeof storedVisible !== "object" || storedVisible === null) {
        return err(new KernelError("COMMAND_FAILED", "Layout has no visibility map.", {}));
      }
      visible.clear();
      sizes.clear();
      for (const [id, value] of Object.entries(storedVisible as Record<string, unknown>)) {
        if (typeof value === "boolean") visible.set(id, value);
      }
      if (typeof storedSizes === "object" && storedSizes !== null) {
        for (const [id, value] of Object.entries(storedSizes as Record<string, unknown>)) {
          if (typeof value === "number") sizes.set(id, value);
        }
      }
      runtime.context.events.emit("shell.layout.restored", {});
      return ok(undefined);
    },
  };
}

export interface NotificationRecord {
  readonly id: Id;
  readonly message: string;
  readonly level: NonNullable<NotificationOptions["level"]>;
  readonly detail?: string;
}

export function createNotificationService(
  runtime: ShellRuntime,
): NotificationService & { active(): readonly NotificationRecord[] } {
  const active = new Map<Id, NotificationRecord>();

  return {
    notify(message, options) {
      const id = runtime.ids.next("notification");
      const record: NotificationRecord = {
        id,
        message,
        level: options?.level ?? "info",
        ...(options?.detail === undefined ? {} : { detail: options.detail }),
      };
      active.set(id, record);
      runtime.context.events.emit("shell.notification", {
        id,
        level: record.level,
        message,
      });
      return id;
    },

    dismiss(notificationId) {
      active.delete(notificationId);
    },

    /**
     * Progress is a handle, not a promise wrapper.
     *
     * The work being reported on is usually already a promise — a model conversion, a clash run —
     * and the shell needs to update while it runs, not merely learn that it finished.
     */
    progress(label) {
      const id = runtime.ids.next("progress");
      active.set(id, { id, message: label, level: "info" });

      const finish = (level: NonNullable<NotificationOptions["level"]>, message?: string): void => {
        active.delete(id);
        runtime.context.events.emit("shell.notification", {
          id,
          level,
          message: message ?? label,
        });
      };

      return {
        update: (fraction, detail) => {
          const clamped = Math.max(0, Math.min(1, fraction));
          active.set(id, {
            id,
            message: label,
            level: "info",
            ...(detail === undefined ? {} : { detail }),
          });
          runtime.context.events.emit("shell.progress", { id, fraction: clamped, detail });
        },
        done: (message) => finish("success", message),
        fail: (message) => finish("error", message),
      };
    },

    active: () => [...active.values()],
  };
}

export function createCommandPaletteService(
  runtime: ShellRuntime,
  commandInfo: () => readonly { readonly id: string; readonly title: string | undefined }[],
): CommandPaletteService & { search(query: string): readonly CommandPaletteEntry[] } {
  const extra: CommandPaletteEntry[] = [];
  let open = false;

  const derived = (): CommandPaletteEntry[] =>
    commandInfo()
      // A command with no title has not been written for a human to find, so it stays out of the
      // palette rather than showing up as a bare dotted id.
      .filter((command) => command.title !== undefined)
      .map((command) => ({
        commandId: command.id,
        label: command.title!,
        category: command.id.split(".")[0] ?? "",
      }));

  return {
    entries() {
      const seen = new Map<string, CommandPaletteEntry>();
      for (const entry of [...derived(), ...extra]) seen.set(entry.commandId, entry);
      return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
    },

    search(query) {
      const needle = query.trim().toLowerCase();
      if (needle === "") return this.entries();
      return this.entries().filter(
        (entry) =>
          entry.label.toLowerCase().includes(needle) ||
          entry.commandId.toLowerCase().includes(needle),
      );
    },

    open(initialQuery) {
      open = true;
      runtime.context.events.emit("shell.palette.opened", { query: initialQuery ?? "" });
    },

    close() {
      open = false;
      void open;
    },

    register(entry): Disposable {
      extra.push(entry);
      return toDisposable(() => {
        const index = extra.indexOf(entry);
        if (index >= 0) extra.splice(index, 1);
      });
    },
  };
}

export function createStatusBarService(): StatusBarService {
  const items = new Map<string, StatusItem>();

  return {
    set(item) {
      items.set(item.id, item);
      return toDisposable(() => void items.delete(item.id));
    },
    remove(itemId) {
      items.delete(itemId);
    },
    items: () =>
      [...items.values()].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
      ),
  };
}
