import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  createKernel,
  MemoryStorageAdapter,
  PersistenceEngine,
  type DocumentMigrator,
  type StorageAdapter,
} from "@massingifc/core-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeKey,
  encodeKey,
  FileSystemStorageAdapter,
  KeyEscapeError,
  resolveKeyPath,
} from "./filesystem.js";

let root: string;
let storage: FileSystemStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "massingifc-"));
  storage = new FileSystemStorageAdapter({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("key encoding", () => {
  /**
   * The property everything else depends on. An earlier mapping lost information in both
   * directions, which silently broke backup listing and pruning.
   */
  describe("round-trips exactly", () => {
    const keys = [
      "project",
      "container:p1:manifest",
      "container:p1:entry:models/tower.frag",
      "p1::backup::2026-07-27T03:47:24.810Z-0",
      "markup:settings",
      "..cache",
      ".hidden",
      "with space",
      "unicode:Tour Eiffel — café",
      "emoji:🏗",
      'awkward<>:"|?*chars',
      "trailing.",
      "nul",
      "CON",
      "com1",
      "%",
      "%25",
      "",
    ];

    for (const key of keys) {
      it(JSON.stringify(key), () => {
        expect(decodeKey(encodeKey(key))).toBe(key);
      });
    }
  });

  it("never emits a path separator, so traversal is structurally impossible", () => {
    for (const key of ["../../etc/passwd", "a/../../b", "..\\..\\windows", "x:y"]) {
      const encoded = encodeKey(key);
      expect(encoded).not.toContain("/");
      expect(encoded).not.toContain("\\");
      expect(encoded).not.toContain(sep);
    }
  });

  it("keeps distinct keys distinct", () => {
    // The old sanitiser mapped every illegal character to "_", so these three collided onto one
    // file and two of the three were silently lost.
    const encoded = new Set(["a<b", "a>b", "a|b", "a_b"].map(encodeKey));
    expect(encoded.size).toBe(4);
  });

  it("escapes Windows reserved device names", () => {
    // "Naming Files, Paths, and Namespaces" reserves these with or without an extension on older
    // Windows, so `nul.json` is not a file that can be created.
    for (const reserved of ["con", "PRN", "aux", "nul", "com1", "LPT9"]) {
      expect(encodeKey(reserved)).not.toBe(reserved);
      expect(decodeKey(encodeKey(reserved))).toBe(reserved);
    }
    // A name that merely contains one is fine.
    expect(encodeKey("console")).toBe("console");
  });

  it("escapes a trailing dot, which Windows would strip", () => {
    expect(encodeKey("report.")).toBe("report%2E");
    // Without this, "report." and "report" would land on the same file.
    expect(encodeKey("report.")).not.toBe(encodeKey("report"));
  });
});

describe("path containment", () => {
  const attacks = [
    "../outside",
    "../../etc/passwd",
    "a/../../b",
    "..\\..\\windows",
    "nested:..:..:escape",
    "/etc/passwd",
  ];

  for (const key of attacks) {
    it(`contains ${JSON.stringify(key)} inside the root`, () => {
      // Encoding removes every separator, so these are ordinary filenames rather than paths.
      const path = resolveKeyPath("/data", key, ".json");
      expect(path.startsWith(resolve("/data") + sep)).toBe(true);
    });
  }

  it("allows a legitimate key beginning with dots", () => {
    // The `relative().startsWith("..")` idiom rejected this: its relative path is the ordinary
    // filename "..cache.json". Comparing against `root + sep` does not confuse the two.
    expect(() => resolveKeyPath("/data", "..cache", ".json")).not.toThrow();
    expect(() => resolveKeyPath("/data", "..config:v1", ".json")).not.toThrow();
  });

  it("refuses a sibling directory that merely shares the prefix", () => {
    // `/data-evil` must not pass a `/data` root check.
    const path = resolveKeyPath("/data", "x", ".json");
    expect(path.startsWith(resolve("/data-evil"))).toBe(false);
  });

  it("still throws KeyEscapeError if a path ever escapes", () => {
    // Defence in depth: unreachable given the encoding, but the guard is kept and must work.
    expect(() => resolveKeyPath("/data", "x", `${sep}..${sep}..${sep}evil.json`)).toThrowError(
      KeyEscapeError,
    );
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

  it("round-trips a key containing a slash", async () => {
    // Previously `keys()` returned "container:p1:entry:models:tower" — a key never written.
    await storage.put("container:p1:entry:models/tower", { a: 1 });
    expect(await storage.keys()).toEqual(["container:p1:entry:models/tower"]);
  });

  it("round-trips binary payloads", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await storage.put("model", { name: "Tower", payload: bytes });

    const loaded = (await storage.get("model")) as { payload: Uint8Array };
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
  it("leaves no temporary files behind, and never lists one as a record", async () => {
    await storage.put("project", { name: "Tower" });
    // Simulates a crash between write and rename.
    await writeFile(join(root, "project.json.abc-123.tmp.json"), "{}", "utf8");

    expect((await readdir(root)).some((entry) => entry.endsWith(".tmp.json"))).toBe(true);
    expect(await storage.keys()).toEqual(["project"]);
  });

  it("serialises concurrent writes to one key instead of failing", async () => {
    // Two problems met here. A pid+millisecond temp suffix collided, so one write renamed a file
    // the other had already consumed; and on Windows a rename onto a destination another rename is
    // touching fails outright with EPERM. Both surfaced as a spurious rejection from a put whose
    // data was perfectly fine.
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => storage.put("hot", { n: index })),
    );

    const value = (await storage.get("hot")) as { n: number };
    expect(value.n).toBeGreaterThanOrEqual(0);
    expect(value.n).toBeLessThan(12);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toHaveLength(0);
  });

  it("lets a later write succeed after an earlier one fails", async () => {
    // A circular reference genuinely fails to serialise. (A function would not: JSON.stringify
    // drops those silently, so it would have written `{}` and proved nothing.)
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    // A rejected write must not poison the queue for the writes behind it.
    await expect(storage.put("poison", circular)).rejects.toThrow();
    await expect(storage.put("poison", { good: true })).resolves.toBeUndefined();
    expect(await storage.get("poison")).toEqual({ good: true });
  });

  it("does not corrupt an existing value when overwritten", async () => {
    await storage.put("project", { name: "First", data: "x".repeat(5000) });
    await storage.put("project", { name: "Second" });

    expect(await storage.get("project")).toEqual({ name: "Second" });
  });

  it("surfaces a genuinely corrupt file rather than silently returning undefined", async () => {
    await storage.put("project", { name: "Tower" });
    await writeFile(join(root, `${encodeKey("project")}.json`), "{ this is not json", "utf8");

    // Absent and corrupt are different facts; conflating them hides data loss behind a first-run
    // looking empty state.
    await expect(storage.get("project")).rejects.toThrow();
  });

  it("writes readable JSON a human can inspect", async () => {
    await storage.put("project", { name: "Tower" });
    const raw = await readFile(join(root, `${encodeKey("project")}.json`), "utf8");
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
    await new PersistenceEngine({ adapter: storage }).save("p1", "project", { name: "Tower" });

    // A fresh adapter over the same directory is what a restart looks like.
    const reloaded = await new PersistenceEngine({
      adapter: new FileSystemStorageAdapter({ root }),
    }).load<{ name: string }>("p1");

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
    expect(loaded.ok && loaded.value?.data).toEqual({ migrated: true });
  });

  /**
   * Backups exercise the `::backup::` marker, which the previous key mapping collapsed to
   * `:backup:`. Every assertion here failed before the encoding was made reversible.
   */
  describe("backups behave identically to the in-memory adapter", () => {
    const exercise = async (adapter: StorageAdapter) => {
      const engine = new PersistenceEngine({ adapter, maxBackups: 2 });
      await engine.save("p1", "project", { v: 1 });
      for (const v of [2, 3, 4, 5]) {
        await engine.save("p1", "project", { v }, { backup: true });
      }
      return {
        backups: (await engine.listBackups("p1")).length,
        keys: await engine.keys(),
      };
    };

    it("lists them, prunes them, and keeps them out of keys()", async () => {
      const memory = await exercise(new MemoryStorageAdapter());
      const disk = await exercise(storage);

      expect(disk).toEqual(memory);
      // Concretely: listBackups returned 0 before, so pruning never ran and backups grew for ever.
      expect(disk.backups).toBe(2);
      // And every backup showed up here as though it were a document.
      expect(disk.keys).toEqual(["p1"]);
    });

    it("rolls back to a listed backup", async () => {
      const engine = new PersistenceEngine({ adapter: storage });
      await engine.save("p1", "project", { name: "v1" });
      await engine.save("p1", "project", { name: "v2" }, { backup: true });

      const [backup] = await engine.listBackups("p1");
      expect(backup).toBeDefined();
      await engine.rollback("p1", backup!.id);

      const loaded = await engine.load<{ name: string }>("p1");
      expect(loaded.ok && loaded.value?.data).toEqual({ name: "v1" });
    });
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

    // Reopened from a brand-new kernel over the same directory: a real restart.
    const reopened = createKernel({ storage: new FileSystemStorageAdapter({ root }) });
    const opened = await reopened.containers.open({
      name: "tower",
      storage: new FileSystemStorageAdapter({ root }),
    });
    if (!opened.ok) throw opened.error;

    const project = await opened.value.readDocument<{ name: string }>("project.json");
    const model = await opened.value.readBlob("models/tower.frag");

    expect(project.ok && project.value?.data).toEqual({ name: "Tower" });
    expect(model.ok && model.value && [...model.value]).toEqual([1, 2, 3]);
  });

  it("behaves the same as the in-memory adapter for the same operations", async () => {
    for (const adapter of [new MemoryStorageAdapter(), storage]) {
      await adapter.put("a:b", { n: 1 });
      await adapter.put("a:c", { n: 2 });
      expect(await adapter.get("a:b")).toEqual({ n: 1 });
      expect((await adapter.keys("a")).sort()).toEqual(["a:b", "a:c"]);
      await adapter.delete("a:b");
      expect(await adapter.get("a:b")).toBeUndefined();
    }
  });
});
