import type { FamilyPackageRecord, Matrix4 } from "@massingifc/project-schema";
import {
  createCountingIdFactory,
  createFixedClock,
  createTestHarness,
  type TestHarness,
} from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FamilyLibraryRegistryToken,
  FamilyParameterToken,
  FamilyPlacementToken,
  FamilyRepositoryAdapterToken,
  FamilyResolverToken,
  FamilyVersionToken,
} from "./contracts.js";
import { createFamilyPlugin } from "./plugin.js";
import { createMemoryRepositoryAdapter, validateParameters } from "./services.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const pkg = (
  version: string,
  overrides: Partial<FamilyPackageRecord> = {},
): FamilyPackageRecord => ({
  id: `tower-${version}`,
  repositoryId: "repo-1",
  name: "Tower typology",
  slug: "massingcloud/tower",
  version,
  license: "MIT",
  parameters: [
    { name: "Height", type: "length", defaultValue: 30, min: 3, max: 300, required: true },
    { name: "Cladding", type: "enum", options: ["glass", "brick"], defaultValue: "glass" },
  ],
  ...overrides,
});

let harness: TestHarness;
let adapter: ReturnType<typeof createMemoryRepositoryAdapter>;

const addRepo = async (overrides: Record<string, unknown> = {}) =>
  unwrapOk(harness.kernel.capabilities.require(FamilyLibraryRegistryToken)).addRepository({
    id: "repo-1",
    name: "MassingCloud families",
    kind: "local",
    uri: "memory://families",
    readOnly: false,
    publishable: true,
    ...overrides,
  } as never);

beforeEach(async () => {
  adapter = createMemoryRepositoryAdapter([pkg("1.0.0"), pkg("1.2.0"), pkg("2.0.0")]);
  harness = createTestHarness({ identity: { id: "designer", roles: ["author"] } });
  await harness.load(
    createFamilyPlugin({
      clock: createFixedClock(),
      ids: createCountingIdFactory(),
      apiVersion: "1.0.0",
    }),
  );
  harness.kernel.capabilities.provide(FamilyRepositoryAdapterToken, adapter);
});

const registry = () => unwrapOk(harness.kernel.capabilities.require(FamilyLibraryRegistryToken));
const resolver = () => unwrapOk(harness.kernel.capabilities.require(FamilyResolverToken));
const placement = () => unwrapOk(harness.kernel.capabilities.require(FamilyPlacementToken));
const parameters = () => unwrapOk(harness.kernel.capabilities.require(FamilyParameterToken));
const versions = () => unwrapOk(harness.kernel.capabilities.require(FamilyVersionToken));

describe("repositories", () => {
  it("refuses a repository kind with no adapter, at add time", async () => {
    const result = await addRepo({ kind: "cloud-api" });

    // Named when the user configures it, not later when they have stopped associating the two.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("discovers packages on sync", async () => {
    await addRepo();
    const synced = unwrapOk(await registry().sync());

    expect(synced.discovered).toBe(3);
    expect(unwrapOk(await registry().search())).toHaveLength(3);
    expect(registry().repositories()[0]?.lastSyncedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("replaces rather than accumulates on a second sync", async () => {
    await addRepo();
    await registry().sync();
    await registry().sync();

    expect(unwrapOk(await registry().search())).toHaveLength(3);
  });

  it("drops packages when a repository is removed", async () => {
    await addRepo();
    await registry().sync();
    await registry().removeRepository("repo-1");

    // Listing content that can no longer be fetched would be worse than showing nothing.
    expect(unwrapOk(await registry().search())).toHaveLength(0);
  });

  it("searches by text and tags", async () => {
    await addRepo();
    await registry().sync();

    expect(unwrapOk(await registry().search({ text: "tower" }))).toHaveLength(3);
    expect(unwrapOk(await registry().search({ text: "nothing" }))).toHaveLength(0);
  });
});

describe("resolution", () => {
  beforeEach(async () => {
    await addRepo();
    await registry().sync();
  });

  it("picks the highest version when no range is given", async () => {
    expect(unwrapOk(await resolver().resolve("massingcloud/tower")).version).toBe("2.0.0");
  });

  it("honours a caret range", async () => {
    expect(unwrapOk(await resolver().resolve("massingcloud/tower", "^1.0.0")).version).toBe("1.2.0");
  });

  it("distinguishes an unsatisfiable range from a missing package", async () => {
    const missing = await resolver().resolve("nope/nothing");
    const mismatch = await resolver().resolve("massingcloud/tower", "^9.0.0");

    expect(missing.ok).toBe(false);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("CAPABILITY_VERSION_MISMATCH");
  });

  it("refuses a package built for a newer platform", async () => {
    const incompatible = createMemoryRepositoryAdapter([
      pkg("3.0.0", { slug: "future/pkg", apiVersion: "^9.0.0" }),
    ]);
    harness.kernel.capabilities.provide(FamilyRepositoryAdapterToken, incompatible, { priority: 10 });
    await registry().sync();

    // Packages are untrusted user content, so they can be refused rather than loaded hopefully.
    expect((await resolver().resolve("future/pkg")).ok).toBe(false);
  });

  it("reports a malformed package with a reason", async () => {
    const broken = pkg("1.0.0", {
      slug: "broken/pkg",
      parameters: [
        { name: "A", type: "enum", options: [] },
        { name: "A", type: "string" },
      ],
    });
    const validation = unwrapOk(await resolver().validate(broken));

    expect(validation.compatible).toBe(false);
    expect(validation.errors).toHaveLength(2);
  });

  it("warns about a package with no licence without rejecting it", async () => {
    const unlicensed = pkg("1.0.0", { slug: "u/p", license: undefined });
    const validation = unwrapOk(await resolver().validate(unlicensed));

    expect(validation.compatible).toBe(true);
    expect(validation.warnings[0]).toContain("licence");
  });

  it("tracks what has been cached", async () => {
    const resolved = unwrapOk(await resolver().resolve("massingcloud/tower"));
    expect(resolver().isCached(resolved.id, resolved.version)).toBe(false);

    await resolver().cache(resolved.id, resolved.version);
    expect(resolver().isCached(resolved.id, resolved.version)).toBe(true);
  });
});

describe("parameters", () => {
  const definitions = pkg("1.0.0").parameters;

  it("accepts values within range", () => {
    expect(validateParameters(definitions, { Height: 50, Cladding: "brick" })).toEqual([]);
  });

  it("rejects the wrong type, out of range, and unknown names", () => {
    expect(validateParameters(definitions, { Height: "tall" })[0]).toContain("must be a number");
    expect(validateParameters(definitions, { Height: 1000 })[0]).toContain("above its maximum");
    expect(validateParameters(definitions, { Height: 1 })[0]).toContain("below its minimum");
    expect(validateParameters(definitions, { Nope: 1 })[0]).toContain("Unknown parameter");
  });

  it("rejects a value outside an enum", () => {
    expect(validateParameters(definitions, { Cladding: "timber" })[0]).toContain("must be one of");
  });

  it("counts a default as satisfying a required parameter", () => {
    expect(validateParameters(definitions, {})).toEqual([]);
  });
});

describe("placement", () => {
  beforeEach(async () => {
    await addRepo();
    await registry().sync();
  });

  it("materialises defaults at placement time", async () => {
    const target = unwrapOk(await resolver().resolve("massingcloud/tower"));
    const instance = unwrapOk(await placement().place(target.id, target.version, { transform: IDENTITY }));

    // Left implicit, the instance would change meaning if the package's defaults changed later.
    expect(instance.parameters).toEqual({ Height: 30, Cladding: "glass" });
  });

  it("refuses a placement with invalid parameters", async () => {
    const target = unwrapOk(await resolver().resolve("massingcloud/tower"));
    const result = await placement().place(target.id, target.version, {
      transform: IDENTITY,
      parameters: { Height: 5000 },
    });

    expect(result.ok).toBe(false);
  });

  it("validates on parameter edit too", async () => {
    const target = unwrapOk(await resolver().resolve("massingcloud/tower"));
    const instance = unwrapOk(await placement().place(target.id, target.version, { transform: IDENTITY }));

    expect((await parameters().set(instance.id, { Height: 9999 })).ok).toBe(false);
    expect((await parameters().set(instance.id, { Height: 60 })).ok).toBe(true);
    expect(parameters().get(instance.id)["Height"]).toBe(60);
  });

  it("undoes a placement", async () => {
    const target = unwrapOk(await resolver().resolve("massingcloud/tower"));
    await harness.kernel.commands.execute("family.instance.place", {
      packageId: target.id,
      version: target.version,
      transform: IDENTITY,
    });
    expect(placement().instances()).toHaveLength(1);

    await harness.kernel.commands.undo();
    expect(placement().instances()).toHaveLength(0);
  });
});

describe("versioning", () => {
  beforeEach(async () => {
    await addRepo();
    await registry().sync();
  });

  it("lists available versions", async () => {
    expect(unwrapOk(await versions().available("massingcloud/tower"))).toEqual([
      "1.0.0",
      "1.2.0",
      "2.0.0",
    ]);
  });

  it("upgrades instances that still validate and strands the rest", async () => {
    const older = unwrapOk(await resolver().resolve("massingcloud/tower", "^1.0.0"));
    const good = unwrapOk(await placement().place(older.id, older.version, { transform: IDENTITY }));
    const strict = unwrapOk(await placement().place(older.id, older.version, {
      transform: IDENTITY,
      parameters: { Height: 250 },
    }));

    // 2.0.0 keeps the same parameters but tightens the maximum height, so one instance can move
    // and one cannot.
    const tightened = createMemoryRepositoryAdapter([
      pkg("2.0.0", {
        id: "tower-strict",
        parameters: [
          { name: "Height", type: "length", defaultValue: 30, min: 3, max: 100 },
          { name: "Cladding", type: "enum", options: ["glass", "brick"], defaultValue: "glass" },
        ],
      }),
    ]);
    harness.kernel.capabilities.provide(FamilyRepositoryAdapterToken, tightened, { priority: 10 });
    await registry().sync();

    const result = unwrapOk(await versions().upgrade([good.id, strict.id], "2.0.0"));

    expect(result.upgraded).toEqual([good.id]);
    expect(result.failed[0]?.instanceId).toBe(strict.id);
    expect(result.failed[0]?.reason).toContain("above its maximum");
  });

  it("publishes to a writable repository", async () => {
    const published = unwrapOk(
      await versions().publish(pkg("3.0.0", { id: "tower-3" }), new Uint8Array([1]), "repo-1"),
    );

    expect(published.version).toBe("3.0.0");
    expect(adapter.published).toHaveLength(1);
  });

  it("refuses to publish to a read-only repository", async () => {
    await registry().removeRepository("repo-1");
    await addRepo({ readOnly: true, publishable: false });

    const result = await versions().publish(pkg("3.0.0"), new Uint8Array([1]), "repo-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
  });
});
