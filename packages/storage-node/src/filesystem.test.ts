import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createKernel,
  MemoryStorageAdapter,
  PersistenceEngine,
  type DocumentMigrator,
} from "@massingifc/core-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSystemStorageAdapter, KeyEscapeError, resolveKeyPath } from "./filesystem.js";

let root: string;
let storage: FileSystemStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "massingifc-"));
  storage = new FileSystemStorageAdapter({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("key mapping", () => {
  it("turns colon-separated keys into a readable directory tree", () => {
    const path = resolveKeyPath("/data", "container:p1:manifest", ".json");

    // Colons are legal in our keys and illegal in Windows paths, so they become separators — which
    // also gives a tree somebody can navigate rather than a flat pile of mangled file names.
    expect(path).toBe(resolve("/data", "container", "p1", "manifest.json"));
  });

  describe("refuses to escape the root", () => {
    const attacks = [
      "../outside",
      "../../etc/passwd",
      "a/../../b",
      "..\\..\\windows",
      "nested:..:..:escape",
    ];

    for (const key of attacks) {
      it(`rejects ${JSON.stringify(key)}`, () => {
        // Keys are not always ours — a plugin namespace, a container id, or a document path from
        // an opened project file all arrive here.
        expect(() => resolveKeyPath("/data", key, ".json")).toThrowError(KeyEscapeError);
      });
    }

    it("allows an ordinary nested key", () => {
      expect(() => resolveKeyPath("/data", "markup:settings", ".json")).not.toThrow();
    });
  });

  it("refuses an escaping key at the adapter boundary too", async () => {
    await expect(storage.put("../escape", { x: 1 })).rejects.toThrowError(KeyEscapeError);
  });
});

describe("round trip", () => {
  it("stores and reads a value", async () => {
    await storage.put("project", { name: "Tower", storeys: 12 });

    expect(await storage.get("project")).toEqual({ name: "Tower", storeys: 12 });
  });

  it("treats a missing key as absent, not as an error", async () => {
    expect(await storage.get("never-written")).toBeUndefined();
  });

  it("creates intermediate directories", async () => {
    await storage.put("container:p1:entry:models/tower", { a: 1 });

    expect(await storage.get("container:p1:entry:models/tower")).toEqual({ a: 1 });
  });

  it("round-trips binary payloads", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await storage.put("model", { name: "Tower", payload: bytes });

    const loaded = (await storage.get("model")) as { payload: Uint8Array };

    // Containers hold model payloads, and JSON cannot represent binary; a tagged base64 wrapper
    // keeps a container one readable tree instead of introducing a second on-disk format.
    expect(loaded.payload).toBeInstanceOf(Uint8Array);
    expect([...loaded.payload]).toEqual([0, 1, 2, 250, 255]);
  });

  it("deletes, and tolerates deleting what is not there", async () => {
    await storage.put("gone", { x: 1 });
    await storage.delete("gone");

    expect(await storage.get("gone")).toBeUndefined();
    await expect(storage.delete("gone")).resolves.toBeUndefined();
  });

  it("lists keys, filtered by prefix", async () => {
    await storage.put("markup:a", {});
    await storage.put("markup:b", {});
    await storage.put("massing:a", {});

    expect(await storage.keys()).toEqual(["markup:a", "markup:b", "massing:a"]);
    expect(await storage.keys("markup")).toEqual(["markup:a", "markup:b"]);
  });

  it("lists nothing before anything is written", async () => {
    const empty = new FileSystemStorageAdapter({ root: join(root, "not-created-yet") });
    expect(await empty.keys()).toEqual([]);
    expect(await empty.exists()).toBe(false);
  });
});

describe("durability", () => {
  it("leaves no temporary files behind after a successful write", async () => {
    await storage.put("project", { name: "Tower" });

    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toHaveLength(0);
  });

  it("does not corrupt an existing value when overwritten", async () => {
    await storage.put("project", { name: "First", data: "x".repeat(5000) });
    await storage.put("project", { name: "Second" });

    expect(await storage.get("project")).toEqual({ name: "Second" });
  });

  it("surfaces a genuinely corrupt file rather than silently returning undefined", async () => {
    await storage.put("project", { name: "Tower" });
    await writeFile(join(root, "project.json"), "{ this is not json", "utf8");

    // Absent and corrupt are different facts; conflating them would hide data loss behind a
    // first-run-looking empty state.
    await expect(storage.get("project")).rejects.toThrow();
  });

  it("writes readable JSON a human can inspect", async () => {
    await storage.put("project", { name: "Tower" });

    const raw = await readFile(join(root, "project.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ name: "Tower" });
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
    const first = new PersistenceEngine({ adapter: storage });
    await first.save("p1", "project", { name: "Tower" });

    // A fresh adapter over the same directory is what a restart looks like.
    const second = new PersistenceEngine({
      adapter: new FileSystemStorageAdapter({ root }),
    });
    const loaded = await second.load<{ name: string }>("p1");

    expect(loaded.ok && loaded.value?.data).toEqual({ name: "Tower" });
  });

  it("migrates a document written by an older release", async () => {
    await storage.put("p1", {
      schema: "project",
      version: 1,
      savedAt: "2025-01-01T00:00:00.000Z",
      data: { name: "Old" },
    });

    const engine = new PersistenceEngine({ adapter: storage, migrator });
    const loaded = await engine.load("p1");

    // Until this adapter existed, migration was theoretical — nothing survived a restart to migrate.
    expect(loaded.ok && loaded.value?.version).toBe(2);
    expect(loaded.ok && loaded.value?.data).toEqual({ migrated: true });
  });

  it("backs up and rolls back on disk", async () => {
    const engine = new PersistenceEngine({ adapter: storage });
    await engine.save("p1", "project", { name: "v1" });
    const backup = await engine.backup("p1");
    await engine.save("p1", "project", { name: "v2" });

    expect(backup.ok && backup.value).toBeTruthy();
    if (backup.ok && backup.value) await engine.rollback("p1", backup.value.id);

    const loaded = await engine.load<{ name: string }>("p1");
    expect(loaded.ok && loaded.value?.data).toEqual({ name: "v1" });
  });

  it("carries a whole container through a save and reopen", async () => {
    const kernel = createKernel({ storage });
    const created = await kernel.containers.create("massingifc.project", {
      containerId: "tower",
      name: "Tower",
      storage,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await created.value.writeDocument("project.json", "massingifc.project", { name: "Tower" });
    await created.value.writeBlob("models/tower.frag", new Uint8Array([1, 2, 3]));
    await kernel.containers.save({ name: "tower", storage });
    await kernel.containers.close();

    // Reopened from a brand-new kernel over the same directory: a real restart.
    const reopened = createKernel({ storage: new FileSystemStorageAdapter({ root }) });
    const opened = await reopened.containers.open({
      name: "tower",
      storage: new FileSystemStorageAdapter({ root }),
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const project = await opened.value.readDocument<{ name: string }>("project.json");
    const model = await opened.value.readBlob("models/tower.frag");

    expect(project.ok && project.value?.data).toEqual({ name: "Tower" });
    expect(model.ok && model.value && [...model.value]).toEqual([1, 2, 3]);
  });

  it("behaves the same as the in-memory adapter for the same operations", async () => {
    const memory = new MemoryStorageAdapter();
    for (const adapter of [memory, storage]) {
      await adapter.put("a:b", { n: 1 });
      await adapter.put("a:c", { n: 2 });
      expect(await adapter.get("a:b")).toEqual({ n: 1 });
      expect((await adapter.keys("a")).sort()).toEqual(["a:b", "a:c"]);
      await adapter.delete("a:b");
      expect(await adapter.get("a:b")).toBeUndefined();
    }
  });
});
