import type { ModelRecord, ProjectRecord } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FederationToken,
  ModelLoaderPortToken,
  SessionStateToken,
  type ModelLoaderPort,
} from "./contracts.js";
import { createFederationPlugin } from "./plugin.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const PROJECT: ProjectRecord = {
  id: "p1",
  name: "Tower",
  units: { length: "m", area: "m2", volume: "m3", currency: "GBP" },
  modelIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "pm",
};

const model = (id: string, overrides: Partial<ModelRecord> = {}): ModelRecord => ({
  id,
  name: `Model ${id}`,
  role: "reference",
  format: "fragments",
  version: "C01",
  ...overrides,
});

let harness: TestHarness;
let loaded: Set<string>;
let failing: Set<string>;

const loader = (): ModelLoaderPort => ({
  load: async (record) =>
    failing.has(record.id)
      ? { ok: false, error: new Error(`cannot load ${record.id}`) as never }
      : (loaded.add(record.id), { ok: true, value: undefined }),
  unload: async (modelId) => (loaded.delete(modelId), { ok: true, value: undefined }),
  setTransform: async () => ({ ok: true, value: undefined }),
});

beforeEach(async () => {
  loaded = new Set();
  failing = new Set();
  harness = createTestHarness({ identity: { id: "pm", roles: ["manager"] } });
  await harness.load(
    createFederationPlugin({ clock: createFixedClock(), ids: createCountingIdFactory() }),
  );
  harness.kernel.capabilities.provide(ModelLoaderPortToken, loader());
});

const federation = () => unwrapOk(harness.kernel.capabilities.require(FederationToken));

const openWith = async (...models: ModelRecord[]): Promise<void> => {
  await federation().openProject(PROJECT);
  for (const record of models) await federation().addModel(record);
};

describe("project lifecycle", () => {
  it("opens and closes a project", async () => {
    await openWith(model("arch"));
    expect(federation().currentProject()?.name).toBe("Tower");

    await federation().closeProject();
    expect(federation().currentProject()).toBeUndefined();
    expect(federation().models()).toHaveLength(0);
  });

  it("unloads loaded models when the project closes", async () => {
    await openWith(model("arch"));
    await federation().load("arch");
    expect(loaded.has("arch")).toBe(true);

    await federation().closeProject();
    expect(loaded.has("arch")).toBe(false);
  });

  it("refuses to add the same model twice", async () => {
    await openWith(model("arch"));
    expect((await federation().addModel(model("arch"))).ok).toBe(false);
  });
});

describe("loading", () => {
  it("tracks per-model load state", async () => {
    await openWith(model("arch"));
    await federation().load("arch");

    expect(federation().state("arch")?.status).toBe("loaded");
    expect(federation().state("arch")?.loadedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("records a failure against the model rather than discarding it", async () => {
    await openWith(model("arch"), model("mep"));
    failing.add("mep");

    await federation().loadDefaults();

    // A partially loaded federation must be able to say which discipline is missing.
    expect(federation().state("arch")?.status).toBe("loaded");
    expect(federation().state("mep")?.status).toBe("failed");
    expect(federation().state("mep")?.error).toContain("cannot load mep");
  });

  it("loads the rest when one model fails", async () => {
    await openWith(model("a"), model("b"), model("c"));
    failing.add("b");

    await federation().loadDefaults();

    expect(loaded).toEqual(new Set(["a", "c"]));
  });

  it("skips models flagged not to load by default", async () => {
    await openWith(model("arch"), model("survey", { loadByDefault: false }));
    await federation().loadDefaults();

    expect(loaded).toEqual(new Set(["arch"]));
  });

  it("is idempotent", async () => {
    await openWith(model("arch"));
    await federation().load("arch");
    await federation().load("arch");

    expect(federation().state("arch")?.status).toBe("loaded");
  });

  it("reports honestly when no loader is installed", async () => {
    const bare = createTestHarness();
    await bare.load(createFederationPlugin({ ids: createCountingIdFactory() }));
    const service = unwrapOk(bare.kernel.capabilities.require(FederationToken));
    await service.openProject(PROJECT);
    await service.addModel(model("arch"));

    const result = await service.load("arch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    await bare.dispose();
  });
});

describe("revisions", () => {
  it("keeps the model id so downstream references survive", async () => {
    await openWith(model("arch"));
    await federation().load("arch");

    await federation().replaceRevision("arch", model("arch", { version: "C02" }));

    // Issuing a revision as a new model would orphan every markup anchor, clash result and 4D
    // link that references it.
    expect(federation().models()).toHaveLength(1);
    expect(federation().models()[0]?.id).toBe("arch");
    expect(federation().models()[0]?.version).toBe("C02");
  });

  it("reloads a model that was loaded, and leaves an unloaded one unloaded", async () => {
    await openWith(model("arch"), model("mep"));
    await federation().load("arch");

    await federation().replaceRevision("arch", model("arch", { version: "C02" }));
    await federation().replaceRevision("mep", model("mep", { version: "C02" }));

    expect(loaded.has("arch")).toBe(true);
    expect(loaded.has("mep")).toBe(false);
  });

  it("announces the revision after the new content is in place", async () => {
    await openWith(model("arch"));
    await federation().load("arch");

    let versionWhenNotified: string | undefined;
    harness.kernel.events.on("federation.model.revised", () => {
      versionWhenNotified = federation().models()[0]?.version;
    });

    await federation().replaceRevision("arch", model("arch", { version: "C02" }));

    // Listeners re-resolve against the model, so they must see the new revision, not the old.
    expect(versionWhenNotified).toBe("C02");
  });

  it("notifies markup and planning listeners", async () => {
    const listener = vi.fn();
    harness.kernel.events.on("federation.model.revised", listener);
    await openWith(model("arch"));

    await federation().replaceRevision("arch", model("arch", { version: "C02" }));

    expect(listener).toHaveBeenCalledWith({ modelId: "arch", version: "C02" });
  });

  it("refuses to revise a model that is not in the project", async () => {
    await federation().openProject(PROJECT);
    expect((await federation().replaceRevision("ghost", model("ghost"))).ok).toBe(false);
  });
});

describe("visibility and placement", () => {
  it("tracks visibility separately from load state", async () => {
    await openWith(model("arch"));
    await federation().load("arch");

    federation().setVisible("arch", false);

    expect(federation().state("arch")?.visible).toBe(false);
    expect(federation().state("arch")?.status).toBe("loaded");
  });

  it("re-datums a model without re-importing it", async () => {
    await openWith(model("arch"));
    await federation().load("arch");
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];

    expect((await federation().setTransform("arch", transform)).ok).toBe(true);
    expect(federation().models()[0]?.transform?.[12]).toBe(100);
  });
});

describe("session state", () => {
  it("captures and restores which models were loaded", async () => {
    await openWith(model("arch"), model("mep"), model("survey"));
    await federation().load("arch");
    await federation().load("mep");

    const session = unwrapOk(harness.kernel.capabilities.require(SessionStateToken));
    const captured = unwrapOk(await session.capture());
    expect(captured.loadedModelIds.sort()).toEqual(["arch", "mep"]);

    await federation().unload("arch");
    await federation().unload("mep");
    await session.restore(captured);

    // Reopening should not mean reloading twelve models and re-hiding nine of them.
    expect(loaded).toEqual(new Set(["arch", "mep"]));
  });

  it("refuses a session belonging to another project", async () => {
    await openWith(model("arch"));
    const session = unwrapOk(harness.kernel.capabilities.require(SessionStateToken));
    const captured = unwrapOk(await session.capture());

    await federation().openProject({ ...PROJECT, id: "other" });
    expect((await session.restore(captured)).ok).toBe(false);
  });

  it("refuses to capture with no project open", async () => {
    const session = unwrapOk(harness.kernel.capabilities.require(SessionStateToken));
    expect((await session.capture()).ok).toBe(false);
  });
});
