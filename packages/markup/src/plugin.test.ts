import type { ElementRef, IssueRecord, MarkupRecord } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnchorToken,
  CommentToken,
  ElementResolverToken,
  IssueToken,
  MarkupToken,
  MARKUP_COMMANDS,
  ReviewToken,
  ViewpointProviderToken,
  type ElementResolver,
} from "./contracts.js";
import { createMarkupPlugin } from "./plugin.js";

let harness: TestHarness;
let modelElements: Map<string, string[]>;

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const resolver = (): ElementResolver => ({
  exists: (modelId, globalId) => (modelElements.get(modelId) ?? []).includes(globalId),
  globalIds: (modelId) => modelElements.get(modelId) ?? [],
});

const element = (globalId: string, modelId = "m1"): ElementRef => ({ modelId, globalId });

beforeEach(async () => {
  modelElements = new Map([["m1", ["GUID-A", "GUID-B"]]]);
  harness = createTestHarness({ identity: { id: "alice", roles: ["reviewer"] } });
  await harness.load(
    createMarkupPlugin({
      clock: createFixedClock(),
      ids: createCountingIdFactory(),
      modelVersions: () => [{ modelId: "m1", version: "C01" }],
    }),
  );
  harness.kernel.capabilities.provide(ElementResolverToken, resolver());
});

const markups = () => unwrapOk(harness.kernel.capabilities.require(MarkupToken));
const anchors = () => unwrapOk(harness.kernel.capabilities.require(AnchorToken));
const issues = () => unwrapOk(harness.kernel.capabilities.require(IssueToken));
const comments = () => unwrapOk(harness.kernel.capabilities.require(CommentToken));
const review = () => unwrapOk(harness.kernel.capabilities.require(ReviewToken));

const makePin = async (overrides: Partial<MarkupRecord> = {}): Promise<MarkupRecord> =>
  unwrapOk(
    await harness.kernel.commands.execute<MarkupRecord>(MARKUP_COMMANDS.createPin, {
      kind: "pin",
      modelId: "m1",
      text: "Check this",
      createdBy: "alice",
      ...overrides,
    }),
  );

describe("activation", () => {
  it("provides every markup capability", () => {
    for (const token of [MarkupToken, AnchorToken, IssueToken, CommentToken, ReviewToken]) {
      expect(harness.kernel.capabilities.has(token)).toBe(true);
    }
  });

  it("releases everything on deactivate", async () => {
    await harness.kernel.plugins.deactivate("massingifc.markup");

    expect(harness.kernel.capabilities.has(MarkupToken)).toBe(false);
    expect(harness.kernel.commands.has(MARKUP_COMMANDS.createPin)).toBe(false);
  });
});

describe("markup", () => {
  it("creates a pin with a default status", async () => {
    const pin = await makePin();

    expect(pin.kind).toBe("pin");
    expect(pin.status).toBe("open");
    expect(pin.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("queries by model, status and kind", async () => {
    await makePin();
    await makePin({ modelId: "m2" });
    await harness.kernel.commands.execute(MARKUP_COMMANDS.createRedline, {
      kind: "redline",
      modelId: "m1",
      createdBy: "alice",
    });

    expect(markups().query({ modelId: "m1" })).toHaveLength(2);
    expect(markups().query({ kind: "redline" })).toHaveLength(1);
  });

  it("detaches a deleted markup from its issues without deleting them", async () => {
    const pin = await makePin();
    const issue = unwrapOk(
      await issues().create({
        title: "Clash",
        status: "open",
        reporter: "alice",
        markupIds: [pin.id],
      } as Omit<IssueRecord, "id" | "createdAt">),
    );

    await markups().remove(pin.id);

    // The conversation on an issue outlives the pin that started it.
    expect(issues().get(issue.id)?.markupIds).toEqual([]);
    expect(issues().get(issue.id)).toBeDefined();
  });

  it("undoes a pin creation and a deletion", async () => {
    const pin = await makePin();
    await harness.kernel.commands.undo();
    expect(markups().query()).toHaveLength(0);

    await harness.kernel.commands.redo();
    expect(markups().query()).toHaveLength(1);

    await harness.kernel.commands.execute(MARKUP_COMMANDS.removeMarkup, { id: pin.id });
    expect(markups().query()).toHaveLength(0);

    await harness.kernel.commands.undo();
    // Restored with its original id, so anything referencing it still works.
    expect(markups().get(pin.id)).toBeDefined();
  });
});

describe("anchoring", () => {
  it("anchors to an element that exists", async () => {
    const pin = await makePin();
    const anchor = unwrapOk(await anchors().anchor(pin.id, { element: element("GUID-A") }));

    expect(anchor.resolved).toBe(true);
    expect(anchor.globalId).toBe("GUID-A");
  });

  it("marks an anchor unresolved when the element is absent", async () => {
    const pin = await makePin();
    const anchor = unwrapOk(await anchors().anchor(pin.id, { element: element("GUID-MISSING") }));

    expect(anchor.resolved).toBe(false);
  });

  it("replaces a markup's previous anchor rather than accumulating", async () => {
    const pin = await makePin();
    await anchors().anchor(pin.id, { element: element("GUID-A") });
    await anchors().anchor(pin.id, { element: element("GUID-B") });

    expect(anchors().resolve(pin.id)?.globalId).toBe("GUID-B");
  });

  describe("after a model revision", () => {
    it("keeps anchors whose elements survived and orphans the rest", async () => {
      const kept = await makePin();
      const lost = await makePin();
      await anchors().anchor(kept.id, { element: element("GUID-A") });
      await anchors().anchor(lost.id, { element: element("GUID-B") });

      modelElements.set("m1", ["GUID-A"]); // GUID-B deleted in the new revision
      const result = unwrapOk(await anchors().reanchor("m1"));

      expect(result.resolved).toBe(1);
      expect(result.orphaned).toEqual([lost.id]);
    });

    it("reports orphans rather than relocating them", async () => {
      const pin = await makePin();
      await anchors().anchor(pin.id, { element: element("GUID-B") });
      const orphaned = vi.fn();
      harness.kernel.events.on("markup.orphaned", orphaned);

      modelElements.set("m1", ["GUID-A"]);
      await anchors().reanchor("m1");

      // Silently snapping to another element is worse than admitting the target is gone.
      expect(orphaned).toHaveBeenCalledOnce();
      expect(anchors().orphaned()).toHaveLength(1);
      expect(anchors().resolve(pin.id)?.globalId).toBe("GUID-B");
    });

    it("leaves positional anchors alone", async () => {
      const pin = await makePin();
      await anchors().anchor(pin.id, { worldPosition: [1, 2, 3] });

      modelElements.set("m1", []);
      const result = unwrapOk(await anchors().reanchor("m1"));

      expect(result.orphaned).toHaveLength(0);
    });

    it("re-anchors automatically when a revision event fires", async () => {
      const pin = await makePin();
      await anchors().anchor(pin.id, { element: element("GUID-B") });

      modelElements.set("m1", ["GUID-A"]);
      harness.kernel.events.emit("federation.model.revised", { modelId: "m1", version: "C02" });
      await Promise.resolve();

      expect(anchors().orphaned()).toHaveLength(1);
    });

    it("reports honestly when no element resolver is installed", async () => {
      const bare = createTestHarness();
      await bare.load(createMarkupPlugin({ ids: createCountingIdFactory() }));
      const service = unwrapOk(bare.kernel.capabilities.require(AnchorToken));

      const result = await service.reanchor("m1");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
      await bare.dispose();
    });
  });
});

describe("issues", () => {
  const makeIssue = async (): Promise<IssueRecord> =>
    unwrapOk(
      await issues().create({
        title: "Beam clashes with duct",
        status: "open",
        reporter: "alice",
        markupIds: [],
      } as Omit<IssueRecord, "id" | "createdAt">),
    );

  it("follows the permitted transitions", async () => {
    const issue = await makeIssue();

    expect((await issues().transition(issue.id, "in-review")).ok).toBe(true);
    expect((await issues().transition(issue.id, "resolved")).ok).toBe(true);
    expect((await issues().transition(issue.id, "closed")).ok).toBe(true);
  });

  it("rejects a transition that skips reopening", async () => {
    const issue = await makeIssue();
    await issues().transition(issue.id, "resolved");
    await issues().transition(issue.id, "closed");

    // closed -> resolved would lose the fact that it was reopened.
    const result = await issues().transition(issue.id, "resolved");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cannot move");
  });

  it("stamps a close time", async () => {
    const issue = await makeIssue();
    await issues().transition(issue.id, "resolved");
    const closed = unwrapOk(await issues().transition(issue.id, "closed"));

    expect(closed.closedAt).toBeDefined();
  });

  it("records a transition note as a comment", async () => {
    const issue = await makeIssue();
    await issues().transition(issue.id, "in-review", "Passed to structures");

    expect(comments().thread(issue.id, "issue")?.comments[0]?.body).toBe("Passed to structures");
  });

  it("does not let update() route around the transition rules", async () => {
    const issue = await makeIssue();
    await issues().update(issue.id, { status: "closed", title: "Renamed" });

    expect(issues().get(issue.id)?.status).toBe("open");
    expect(issues().get(issue.id)?.title).toBe("Renamed");
  });

  it("treats only actionable issues as overdue", async () => {
    const clock = createFixedClock("2026-06-01T00:00:00.000Z");
    const late = unwrapOk(
      await issues().create({
        title: "Late",
        status: "open",
        reporter: "alice",
        markupIds: [],
        dueDate: "2020-01-01T00:00:00.000Z",
      } as Omit<IssueRecord, "id" | "createdAt">),
    );
    const done = unwrapOk(
      await issues().create({
        title: "Late but closed",
        status: "open",
        reporter: "alice",
        markupIds: [],
        dueDate: "2020-01-01T00:00:00.000Z",
      } as Omit<IssueRecord, "id" | "createdAt">),
    );
    await issues().transition(done.id, "resolved");
    void clock;

    const overdue = issues().query({ overdue: true });
    expect(overdue.map((issue) => issue.id)).toEqual([late.id]);
  });

  it("undoes a status change back to where it was", async () => {
    const issue = await makeIssue();
    await harness.kernel.commands.execute(MARKUP_COMMANDS.transitionIssue, {
      id: issue.id,
      status: "in-review",
    });
    expect(issues().get(issue.id)?.status).toBe("in-review");

    await harness.kernel.commands.undo();
    expect(issues().get(issue.id)?.status).toBe("open");
  });
});

describe("comments", () => {
  it("appends to one thread per subject", async () => {
    await comments().post("subject-1", "issue", "First");
    await comments().post("subject-1", "issue", "Second");

    expect(comments().thread("subject-1", "issue")?.comments).toHaveLength(2);
  });

  it("attributes the comment to the acting identity", async () => {
    const comment = unwrapOk(await comments().post("s", "issue", "Note"));
    expect(comment.authorId).toBe("alice");
  });

  it("rejects an empty comment", async () => {
    expect((await comments().post("s", "issue", "   ")).ok).toBe(false);
  });

  it("stamps an edit rather than changing text silently", async () => {
    const comment = unwrapOk(await comments().post("s", "issue", "Original"));
    const edited = unwrapOk(await comments().edit(comment.id, "Revised"));

    expect(edited.body).toBe("Revised");
    expect(edited.editedAt).toBeDefined();
  });
});

describe("review", () => {
  const installViewpoints = (): void => {
    harness.kernel.capabilities.provide(ViewpointProviderToken, {
      capture: async () => ({ ok: true, value: { id: "vp-1" } }),
      apply: async () => ({ ok: true, value: undefined }),
    });
  };

  it("captures the model versions that were on screen", async () => {
    installViewpoints();
    await makePin();

    const snapshot = unwrapOk(await review().snapshot("Coordination 12"));

    expect(snapshot.modelVersions).toEqual([{ modelId: "m1", version: "C01" }]);
    expect(snapshot.markupIds).toHaveLength(1);
  });

  it("reports honestly when no viewpoint provider is installed", async () => {
    const result = await review().snapshot();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("flags drift when the models have moved on since the snapshot", async () => {
    const drifting = createTestHarness();
    let version = "C01";
    await drifting.load(
      createMarkupPlugin({
        ids: createCountingIdFactory(),
        modelVersions: () => [{ modelId: "m1", version }],
      }),
    );
    drifting.kernel.capabilities.provide(ViewpointProviderToken, {
      capture: async () => ({ ok: true, value: { id: "vp-1" } }),
      apply: async () => ({ ok: true, value: undefined }),
    });
    const service = unwrapOk(drifting.kernel.capabilities.require(ReviewToken));
    const snapshot = unwrapOk(await service.snapshot());

    const drifted = vi.fn();
    drifting.kernel.events.on("review.snapshot.drifted", drifted);
    version = "C02";
    await service.restore(snapshot.id);

    expect(drifted).toHaveBeenCalledOnce();
    await drifting.dispose();
  });

  it("attributes snapshots and issues raised during a session", async () => {
    installViewpoints();
    const session = unwrapOk(await review().startSession("Weekly", ["alice", "bob"]));
    await review().snapshot();
    await issues().create({
      title: "Raised in session",
      status: "open",
      reporter: "alice",
      markupIds: [],
    } as Omit<IssueRecord, "id" | "createdAt">);

    const ended = unwrapOk(await review().endSession(session.id));

    expect(ended.snapshotIds).toHaveLength(1);
    expect(ended.issueIds).toHaveLength(1);
    expect(ended.endedAt).toBeDefined();
  });
});
