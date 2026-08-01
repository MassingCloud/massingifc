import { ok, type Result } from "@massingifc/core-kernel";
import { createTestHarness, type TestHarness } from "@massingifc/plugin-sdk";
import { ExportAdapterToken, type ExportAdapter } from "@massingifc/interop";
import { beforeEach, describe, expect, it } from "vitest";
import { buildScenePackage, type ScenePackage, type ScenePackageProvider } from "./index.js";
import { ScenePackageProviderToken } from "./contracts.js";
import { createEngineBridgePlugin } from "./plugin.js";

const decoder = new TextDecoder();

const bundle = (scene: ScenePackage) => ({ scene, payloads: new Map<string, Uint8Array>() });

const scene = (): ScenePackage => {
  const result = buildScenePackage({
    generator: "test",
    generatedAt: "2026-07-27T12:00:00.000Z",
    nodes: [{ globalId: "1Wall00000000000000W01", ifcClass: "IFCWALLSTANDARDCASE" }],
  });
  if (!result.ok) throw result.error;
  return result.value;
};

const providerOf = (build: ScenePackageProvider["build"]): ScenePackageProvider => ({ build });

let harness: TestHarness;

beforeEach(async () => {
  harness = createTestHarness({ identity: { id: "exporter", roles: ["bim"] } });
  await harness.load(createEngineBridgePlugin());
});

const adapter = (): ExportAdapter => {
  const found = harness.kernel.capabilities.get(ExportAdapterToken);
  if (!found) throw new Error("no export adapter registered");
  return found;
};

describe("engine bridge plugin", () => {
  it("registers an export adapter", () => {
    expect(adapter().format.id).toBe("massingifc-scene");
  });

  it("says so plainly when no scene provider is installed", async () => {
    const exported = await adapter().export({});
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("exports the manifest once a provider is installed", async () => {
    harness.kernel.capabilities.provide(
      ScenePackageProviderToken,
      providerOf(async () => ok(bundle(scene()))),
      { version: "0.1.0" },
    );

    const exported = await adapter().export({});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const manifest = JSON.parse(decoder.decode(exported.value)) as ScenePackage;
    expect(manifest.formatVersion).toBe("1.0");
    expect(manifest.units).toBe("m");
    expect(manifest.index.byGlobalId["1Wall00000000000000W01"]).toBe(0);
  });

  it("passes the caller's scope through to the provider", async () => {
    let seen: unknown;
    harness.kernel.capabilities.provide(
      ScenePackageProviderToken,
      providerOf(async (options) => {
        seen = options;
        return ok(bundle(scene()));
      }),
      { version: "0.1.0" },
    );

    await adapter().export({ scope: { modelIds: ["model-a"], includeProperties: true } });
    expect(seen).toMatchObject({ modelIds: ["model-a"], includeProperties: true });
  });

  it("refuses to export a package whose index is stale", async () => {
    const broken = scene();
    harness.kernel.capabilities.provide(
      ScenePackageProviderToken,
      providerOf(async () =>
        ok(bundle({ ...broken, index: { ...broken.index, byGlobalId: { "0Ghost00000000000000G1": 0 } } })),
      ),
      { version: "0.1.0" },
    );

    const exported = await adapter().export({});
    // Better to fail here, with a message naming the id, than inside a C++ importer that finds a
    // null where it expected a node.
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.error.message).toMatch(/not exportable/);
  });
});
