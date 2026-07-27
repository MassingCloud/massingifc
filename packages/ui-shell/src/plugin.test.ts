import { createCountingIdFactory, createTestHarness, type TestHarness } from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandPaletteToken,
  NotificationToken,
  SHELL_COMMANDS,
  ShellToken,
  StatusBarToken,
} from "./contracts.js";
import { createShellPlugin } from "./plugin.js";
import type { ShellPanelContribution } from "./services.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

let harness: TestHarness;
let panels: ShellPanelContribution[];

beforeEach(async () => {
  panels = [
    { id: "massing.panel", title: "Massing", placement: "left" },
    { id: "markup.panel", title: "Markup", placement: "right" },
    { id: "planning.panel", title: "Programme", placement: "bottom" },
  ];
  harness = createTestHarness();
  await harness.load(
    createShellPlugin({ ids: createCountingIdFactory(), panels: () => panels }),
  );
});

const shell = () => unwrapOk(harness.kernel.capabilities.require(ShellToken));
const notifications = () => unwrapOk(harness.kernel.capabilities.require(NotificationToken));
const palette = () => unwrapOk(harness.kernel.capabilities.require(CommandPaletteToken));

describe("layout", () => {
  it("reflects the panels plugins actually contributed", () => {
    expect(shell().panels().map((p) => p.id)).toEqual([
      "massing.panel",
      "markup.panel",
      "planning.panel",
    ]);

    // A panel contributed after the shell started is visible to it immediately.
    panels.push({ id: "late.panel", placement: "left" });
    expect(shell().panels()).toHaveLength(4);
  });

  it("filters by region", () => {
    expect(shell().panels("left").map((p) => p.id)).toEqual(["massing.panel"]);
  });

  it("shows, hides and toggles", () => {
    expect(shell().showPanel("massing.panel").ok).toBe(true);
    expect(shell().panels("left")[0]?.visible).toBe(true);

    shell().togglePanel("massing.panel");
    expect(shell().panels("left")[0]?.visible).toBe(false);
  });

  it("refuses to open a panel nothing contributed", () => {
    const result = shell().showPanel("ghost.panel");
    expect(result.ok).toBe(false);
  });

  it("emits a visibility event", () => {
    const listener = vi.fn();
    harness.kernel.events.on("shell.panel.visibility", listener);

    shell().showPanel("markup.panel");

    expect(listener).toHaveBeenCalledWith({ contributionId: "markup.panel", visible: true });
  });

  it("captures and restores a layout", () => {
    shell().showPanel("massing.panel");
    shell().setRegionSize("right", 320);
    const layout = shell().captureLayout();

    shell().hidePanel("massing.panel");
    expect(shell().panels("left")[0]?.visible).toBe(false);

    expect(shell().restoreLayout(layout).ok).toBe(true);
    expect(shell().panels("left")[0]?.visible).toBe(true);
    expect(shell().panels("right")[0]?.size).toBe(320);
  });

  it("rejects a malformed layout rather than silently resetting", () => {
    shell().showPanel("massing.panel");
    expect(shell().restoreLayout({ nonsense: true }).ok).toBe(false);
    expect(shell().panels("left")[0]?.visible).toBe(true);
  });

  it("resets the layout through its command", async () => {
    shell().showPanel("massing.panel");
    await harness.kernel.commands.execute(SHELL_COMMANDS.resetLayout, {});

    expect(shell().panels("left")[0]?.visible).toBe(false);
  });
});

describe("notifications", () => {
  it("raises and dismisses", () => {
    const id = notifications().notify("Model loaded", { level: "success" });
    expect(id).toBeTruthy();

    notifications().dismiss(id);
  });

  it("reports progress while work runs, not only when it finishes", () => {
    const events: unknown[] = [];
    harness.kernel.events.on("shell.progress", (payload) => events.push(payload));

    const handle = notifications().progress("Converting IFC");
    handle.update(0.25, "Reading");
    handle.update(0.75);
    handle.done("Converted");

    // The work is already a promise; the shell needs to update during it.
    expect(events).toHaveLength(2);
    expect((events[0] as { fraction: number }).fraction).toBe(0.25);
  });

  it("clamps an out-of-range fraction", () => {
    const events: { fraction: number }[] = [];
    harness.kernel.events.on("shell.progress", (payload) => events.push(payload as { fraction: number }));

    const handle = notifications().progress("Work");
    handle.update(5);
    handle.update(-1);

    expect(events.map((e) => e.fraction)).toEqual([1, 0]);
  });

  it("reports a failure as an error notification", () => {
    const levels: string[] = [];
    harness.kernel.events.on("shell.notification", (payload) =>
      levels.push((payload as { level: string }).level),
    );

    notifications().progress("Clash run").fail("Engine unavailable");

    expect(levels).toContain("error");
  });
});

describe("command palette", () => {
  it("derives entries from registered commands", () => {
    const entries = palette().entries();

    // The shell's own commands are registered with titles, so they appear.
    expect(entries.map((e) => e.commandId)).toContain(SHELL_COMMANDS.togglePanel);
    expect(entries.every((e) => e.label.length > 0)).toBe(true);
  });

  it("omits commands with no title", async () => {
    harness.kernel.commands.register({ id: "internal.plumbing", handler: () => undefined });

    // A command with no title was not written for a human to find.
    expect(palette().entries().map((e) => e.commandId)).not.toContain("internal.plumbing");
  });

  it("searches by label and by id", () => {
    const service = palette() as ReturnType<typeof palette> & {
      search(q: string): readonly { commandId: string }[];
    };

    expect(service.search("palette").length).toBeGreaterThan(0);
    expect(service.search("shell.panel").length).toBeGreaterThan(0);
    expect(service.search("zzzz")).toHaveLength(0);
  });

  it("accepts an extra entry and releases it on dispose", () => {
    const registration = palette().register({ commandId: "custom", label: "Custom action" });
    expect(palette().entries().map((e) => e.commandId)).toContain("custom");

    registration.dispose();
    expect(palette().entries().map((e) => e.commandId)).not.toContain("custom");
  });
});

describe("status bar", () => {
  it("orders by priority then id", () => {
    const bar = unwrapOk(harness.kernel.capabilities.require(StatusBarToken));
    bar.set({ id: "b", text: "B", priority: 1 });
    bar.set({ id: "a", text: "A", priority: 10 });
    bar.set({ id: "c", text: "C", priority: 1 });

    expect(bar.items().map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("releases an item when its registration is disposed", () => {
    const bar = unwrapOk(harness.kernel.capabilities.require(StatusBarToken));
    bar.set({ id: "x", text: "X" }).dispose();

    expect(bar.items()).toHaveLength(0);
  });
});
