import { createKernel, PersistenceEngine, type DocumentMigrator } from "@massingifc/core-kernel";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { IndexedDbStorageAdapter } from "./indexeddb.js";

/**
 * Run against `fake-indexeddb`, a spec-conformant in-process implementation.
 *
 * That matters more than it sounds: the behaviours worth testing here — transactions aborting,
 * key ranges, structured cloning of binary — are IndexedDB semantics, not browser rendering, and a
 * hand-written mock would only assert that the mock behaves the way I assumed.
 */

let factory: IDBFactory;
let storage: IndexedDbStorageAdapter;

const fresh = (name = "test"): IndexedDbStorageAdapter =>
  // Factory *and* key range are injected: both are browser globals, neither exists in Node.
  new IndexedDbStorageAdapter({ factory, keyRange: IDBKeyRange, databaseName: name });

beforeEach(() => {
  factory = new IDBFactory();
  storage = fresh();
});

describe("round trip", () => {
  it("stores and reads a value", async () => {
    await storage.put("project", { name: "Tower", storeys: 12 });

    expect(await storage.get("project")).toEqual({ name: "Tower", storeys: 12 });
  });

  it("treats a missing key as absent", async () => {
    expect(await storage.get("never-written")).toBeUndefined();
  });

  it("overwrites in place", async () => {
    await storage.put("project", { name: "First" });
    await storage.put("project", { name: "Second" });

    expect(await storage.get("project")).toEqual({ name: "Second" });
  });

  it("deletes, and tolerates deleting what is not there", async () => {
    await storage.put("gone", { x: 1 });
    await storage.delete("gone");

    expect(await storage.get("gone")).toBeUndefined();
    await expect(storage.delete("gone")).resolves.toBeUndefined();
  });

  it("stores binary natively, with no base64 round-trip", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await storage.put("model", { payload: bytes });

    const loaded = (await storage.get("model")) as { payload: Uint8Array };

    // The reason to prefer IndexedDB over localStorage for model payloads: no ~33% inflation and
    // no encode/decode on every save.
    expect(loaded.payload).toBeInstanceOf(Uint8Array);
    expect([...loaded.payload]).toEqual([0, 1, 2, 250, 255]);
  });

  it("rejects a value it cannot store, naming it at the call site", async () => {
    // A function cannot be structured-cloned. Without the eager clone this surfaces later as an
    // aborted transaction, which is far harder to trace back to the value that caused it.
    await expect(storage.put("bad", { run: () => 1 })).rejects.toThrow(/not storable/i);
  });
});

describe("key listing", () => {
  beforeEach(async () => {
    await storage.put("markup:a", {});
    await storage.put("markup:b", {});
    await storage.put("massing:a", {});
    await storage.put("zzz", {});
  });

  it("lists everything, sorted", async () => {
    expect(await storage.keys()).toEqual(["markup:a", "markup:b", "massing:a", "zzz"]);
  });

  it("filters by prefix using a bounded range", async () => {
    expect(await storage.keys("markup")).toEqual(["markup:a", "markup:b"]);
    expect(await storage.keys("mass")).toEqual(["massing:a"]);
  });

  it("returns nothing for a prefix that matches nothing", async () => {
    expect(await storage.keys("nothing")).toEqual([]);
  });

  it("does not let a prefix match a neighbouring key by accident", async () => {
    await storage.put("markupX", {});

    // "markup" must not swallow "markupX" only because it sorts nearby — the bound has to be
    // exclusive of the next prefix, which is what the high sentinel achieves.
    expect(await storage.keys("markup:")).toEqual(["markup:a", "markup:b"]);
  });
});

describe("connection handling", () => {
  it("opens lazily and reuses one connection", async () => {
    const adapter = fresh("lazy");
    // Nothing is opened until the first operation.
    await Promise.all([adapter.put("a", 1), adapter.put("b", 2), adapter.get("a")]);

    expect(await adapter.keys()).toEqual(["a", "b"]);
  });

  it("survives being closed and used again", async () => {
    await storage.put("a", 1);
    storage.close();

    expect(await storage.get("a")).toBe(1);
  });

  it("keeps separate databases separate", async () => {
    const projectA = fresh("project-a");
    const projectB = fresh("project-b");

    await projectA.put("shared-key", { from: "a" });
    await projectB.put("shared-key", { from: "b" });

    // One database per project is what stops an unrelated project's quota failure taking yours
    // down with it.
    expect(await projectA.get("shared-key")).toEqual({ from: "a" });
    expect(await projectB.get("shared-key")).toEqual({ from: "b" });
  });

  it("destroys a database completely", async () => {
    await storage.put("a", 1);
    await storage.destroy();

    expect(await fresh().keys()).toEqual([]);
  });

  it("honours a close that lands while an open is still in flight", async () => {
    // IDBDatabase.close() returns immediately and completes once transactions do, so a connection
    // request already in flight resolves *after* the caller asked to close. Storing that late
    // arrival would leave the adapter holding a connection the caller believes is shut, and a
    // following destroy() would hit onblocked and silently do nothing.
    const adapter = fresh("racy");
    const inFlight = adapter.put("a", 1);
    adapter.close();

    await expect(inFlight).rejects.toThrow(/closed while it was being opened/);

    // And the adapter is genuinely usable again afterwards, not wedged.
    await adapter.put("b", 2);
    expect(await adapter.get("b")).toBe(2);
  });

  it("still filters correctly when no key-range constructor is supplied", async () => {
    const rangeless = new IndexedDbStorageAdapter({ factory, databaseName: "rangeless" });
    await rangeless.put("markup:a", {});
    await rangeless.put("massing:a", {});

    // Degrades to filtering rather than returning every key in the store.
    expect(await rangeless.keys("markup")).toEqual(["markup:a"]);
  });

  it("refuses to construct with no IndexedDB available", () => {
    expect(
      () => new IndexedDbStorageAdapter({ factory: undefined as unknown as IDBFactory }),
    ).toThrow();
  });
});

describe("as the kernel's storage", () => {
  const migrator: DocumentMigrator = {
    latestVersion: (schema) => (schema === "project" ? 2 : undefined),
    migrate: (document) =>
      document.version === 1
        ? { ok: true, value: { ...document, version: 2, data: { migrated: true } } }
        : { ok: true, value: document },
  };

  it("persists a versioned document across adapter instances", async () => {
    await new PersistenceEngine({ adapter: storage }).save("p1", "project", { name: "Tower" });

    // A new adapter over the same database is what a page reload looks like.
    const reloaded = await new PersistenceEngine({ adapter: fresh() }).load<{ name: string }>("p1");

    expect(reloaded.ok && reloaded.value?.data).toEqual({ name: "Tower" });
  });

  it("migrates a document written by an older release", async () => {
    await storage.put("p1", {
      schema: "project",
      version: 1,
      savedAt: "2025-01-01T00:00:00.000Z",
      data: { name: "Old" },
    });

    const loaded = await new PersistenceEngine({ adapter: storage, migrator }).load("p1");

    expect(loaded.ok && loaded.value?.version).toBe(2);
  });

  it("carries a whole container through a save and reopen", async () => {
    const kernel = createKernel({ storage });
    const created = await kernel.containers.create("massingifc.project", {
      containerId: "tower",
      name: "Tower",
      storage,
    });
    if (!created.ok) throw created.error;

    await created.value.writeDocument("project.json", "massingifc.project", { name: "Tower" });
    await created.value.writeBlob("models/tower.frag", new Uint8Array([1, 2, 3]));
    await kernel.containers.save({ name: "tower", storage });
    await kernel.containers.close();

    const reopened = createKernel({ storage: fresh() });
    const opened = await reopened.containers.open({ name: "tower", storage: fresh() });
    if (!opened.ok) throw opened.error;

    const project = await opened.value.readDocument<{ name: string }>("project.json");
    const model = await opened.value.readBlob("models/tower.frag");

    expect(project.ok && project.value?.data).toEqual({ name: "Tower" });
    expect(model.ok && model.value && [...model.value]).toEqual([1, 2, 3]);
  });
});
