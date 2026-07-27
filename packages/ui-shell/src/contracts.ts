/**
 * `@massingifc/ui-shell` — the host application surface.
 *
 * Contracts only, and free of DOM types. The same plugin must be able to contribute to a web
 * shell, a desktop shell and a test harness; the moment a shell contract names `HTMLElement`, a
 * plugin compiled against it can never run anywhere else.
 */

import { createCapabilityToken, type Disposable, type Result } from "@massingifc/core-kernel";
import type { Id } from "@massingifc/project-schema";

export type LayoutRegion = "left" | "right" | "bottom" | "top" | "center" | "modal" | "floating";

export interface PanelState {
  readonly id: string;
  readonly region: LayoutRegion;
  readonly visible: boolean;
  readonly size?: number;
  readonly active?: boolean;
}

export interface ShellService {
  /** Shows a registered panel contribution, opening its region if collapsed. */
  showPanel(contributionId: string, region?: LayoutRegion): Result<void>;
  hidePanel(contributionId: string): Result<void>;
  togglePanel(contributionId: string): Result<void>;
  panels(region?: LayoutRegion): readonly PanelState[];
  setRegionSize(region: LayoutRegion, size: number): void;
  /** Saves and restores the arrangement, so a workspace survives a reload. */
  captureLayout(): Readonly<Record<string, unknown>>;
  restoreLayout(layout: Readonly<Record<string, unknown>>): Result<void>;
}

export const ShellToken = createCapabilityToken<ShellService>("shell.service");

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationOptions {
  readonly level?: NotificationLevel;
  readonly detail?: string;
  /** Auto-dismiss delay. Omit for a notification the user must dismiss. */
  readonly timeoutMs?: number;
  readonly actions?: readonly { readonly label: string; readonly commandId: string }[];
}

export interface NotificationService {
  notify(message: string, options?: NotificationOptions): Id;
  dismiss(notificationId: Id): void;
  /**
   * Reports long-running work.
   *
   * Returned as a handle rather than a promise wrapper because the work being reported on is
   * usually already a promise — model conversion, a clash run — and the shell needs to update the
   * indicator while it runs, not merely learn that it finished.
   */
  progress(label: string): {
    readonly update: (fraction: number, detail?: string) => void;
    readonly done: (message?: string) => void;
    readonly fail: (message: string) => void;
  };
}

export const NotificationToken = createCapabilityToken<NotificationService>("shell.notifications");

export interface CommandPaletteEntry {
  readonly commandId: string;
  readonly label: string;
  readonly category?: string;
  readonly keybinding?: string;
  readonly enabled?: boolean;
}

export interface CommandPaletteService {
  entries(): readonly CommandPaletteEntry[];
  open(initialQuery?: string): void;
  close(): void;
  /** Adds an entry beyond those derived automatically from registered commands. */
  register(entry: CommandPaletteEntry): Disposable;
}

export const CommandPaletteToken = createCapabilityToken<CommandPaletteService>("shell.palette");

export interface DialogService {
  confirm(message: string, options?: { readonly title?: string; readonly danger?: boolean }): Promise<boolean>;
  prompt(message: string, options?: { readonly title?: string; readonly defaultValue?: string }): Promise<string | undefined>;
  /** Opens a modal rendered by a registered `modal` contribution. */
  openModal(contributionId: string, params?: Readonly<Record<string, unknown>>): Promise<Result<unknown>>;
}

export const DialogToken = createCapabilityToken<DialogService>("shell.dialogs");

export interface StatusItem {
  readonly id: string;
  readonly text: string;
  readonly tooltip?: string;
  readonly commandId?: string;
  readonly priority?: number;
}

export interface StatusBarService {
  set(item: StatusItem): Disposable;
  remove(itemId: string): void;
  items(): readonly StatusItem[];
}

export const StatusBarToken = createCapabilityToken<StatusBarService>("shell.status-bar");

export interface ShellEvents {
  "shell.panel.visibility": { readonly contributionId: string; readonly visible: boolean };
  "shell.layout.restored": Record<string, never>;
  "shell.notification": { readonly id: Id; readonly level: NotificationLevel; readonly message: string };
}

export const SHELL_COMMANDS = {
  togglePanel: "shell.panel.toggle",
  openPalette: "shell.palette.open",
  resetLayout: "shell.layout.reset",
} as const;
