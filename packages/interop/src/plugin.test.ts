import { createFixedClock, createTestHarness, type TestHarness } from "@massingifc/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EnterpriseConnectorToken,
  ExportAdapterToken,
  ImportAdapterToken,
  InteropToken,
  type EnterpriseConnector,
  type ExportAdapter,
  type ImportAdapter,
} from "./contracts.js";
import { ConnectorRegistryToken, createInteropPlugin } from "./plugin.js";
import { extensionOf, selectImportAdapter } from "./services.js";

const unwrapOk = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const importer = (
  id: string,
  extensions: readonly string[],
  magic: string,
): ImportAdapter => ({
  format: { id, label: id, extensions: [...extensions] },
  canHandle: (payload) => new TextDecoder().decode(payload.slice(0, magic.length)) === magic,
  import: async () => ({
    ok: true,
    value: { recordsCreated: 1, warnings: [], created: { [id]: ["r1"] } },
  }),
});

let harness: TestHarness;

beforeEach(async () => {
  harness = createTestHarness();
  await harness.load(createInteropPlugin({ clock: createFixedClock() }));
});

const interop = () => unwrapOk(harness.kernel.capabilities.require(InteropToken));
const connectors = () => unwrapOk(harness.kernel.capabilities.require(ConnectorRegistryToken));

describe("format detection", () => {
  it("reads the extension from a file name", () => {
    expect(extensionOf("model.IFC")).toBe("ifc");
    expect(extensionOf("noextension")).toBeUndefined();
    expect(extensionOf(undefined)).toBeUndefined();
  });

  it("prefers content over the extension", () => {
    const ifc = importer("ifc", ["ifc"], "ISO-10303");
    const icdd = importer("icdd", ["icdd", "zip"], "PK");

    // An IFC saved as .zip is still an IFC; the extension is a claim, the bytes are the fact.
    const chosen = selectImportAdapter([ifc, icdd], bytes("ISO-10303-21;"), {
      fileName: "mislabelled.zip",
    });
    expect(chosen?.format.id).toBe("ifc");
  });

  it("uses the extension to break a tie between two sniff matches", () => {
    const a: ImportAdapter = { ...importer("a", ["aaa"], ""), canHandle: () => true };
    const b: ImportAdapter = { ...importer("b", ["bbb"], ""), canHandle: () => true };

    expect(selectImportAdapter([a, b], bytes("x"), { fileName: "f.bbb" })?.format.id).toBe("b");
  });

  it("treats an adapter that throws while sniffing as not matching", () => {
    const bad: ImportAdapter = {
      ...importer("bad", ["x"], ""),
      canHandle: () => {
        throw new Error("sniff exploded");
      },
    };
    const good = importer("good", ["y"], "OK");

    expect(selectImportAdapter([bad, good], bytes("OK!"))?.format.id).toBe("good");
  });
});

describe("import and export", () => {
  it("dispatches to the adapter that recognised the payload", async () => {
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "ISO-10303"));

    const outcome = unwrapOk(await interop().import(bytes("ISO-10303-21;")));
    expect(outcome.created["ifc"]).toEqual(["r1"]);
  });

  it("names the formats it does understand when nothing matches", async () => {
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "ISO-10303"));

    const result = await interop().import(bytes("something else"));

    expect(result.ok).toBe(false);
    // "It did not work" is not actionable; "I understand ifc" is.
    if (!result.ok) expect(result.error.details["known"]).toEqual(["ifc"]);
  });

  it("reports when no adapters are registered at all", async () => {
    const result = await interop().import(bytes("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("forces a format with importAs, bypassing detection", async () => {
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "NEVER-MATCHES"));

    expect((await interop().importAs("ifc", bytes("anything"))).ok).toBe(true);
    expect((await interop().importAs("nope", bytes("anything"))).ok).toBe(false);
  });

  it("honours an already-aborted signal", async () => {
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "ISO"));
    const controller = new AbortController();
    controller.abort();

    const result = await interop().import(bytes("ISO-x"), { signal: controller.signal });
    expect(result.ok).toBe(false);
  });

  it("lists formats without duplicates", async () => {
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "A"));
    harness.kernel.capabilities.provide(ImportAdapterToken, importer("ifc", ["ifc"], "B"));

    expect(interop().importFormats()).toHaveLength(1);
  });

  it("exports through a named adapter", async () => {
    const exporter: ExportAdapter = {
      format: { id: "csv", label: "CSV", extensions: ["csv"] },
      export: async () => ({ ok: true, value: bytes("a,b") }),
    };
    harness.kernel.capabilities.provide(ExportAdapterToken, exporter);

    expect(unwrapOk(await interop().export("csv"))).toEqual(bytes("a,b"));
    expect((await interop().export("pdf")).ok).toBe(false);
  });
});

describe("enterprise connectors", () => {
  const connector = (overrides: Partial<EnterpriseConnector["descriptor"]> = {}): EnterpriseConnector => {
    let seen: Record<string, unknown> | undefined;
    return {
      descriptor: {
        id: "cde",
        name: "Some CDE",
        auth: "api-key",
        operations: ["listDocuments", "uploadDocument"],
        readOnly: false,
        ...overrides,
      },
      connect: async (credentials) => {
        seen = credentials as Record<string, unknown>;
        return { ok: true, value: undefined };
      },
      disconnect: async () => {},
      health: async () => ({
        ok: true,
        value: { connected: true, checkedAt: "2026-01-01T00:00:00.000Z" },
      }),
      execute: async (operation) => ({ ok: true, value: { operation, sawKey: seen?.["apiKey"] } }),
    };
  };

  it("refuses an operation before connecting", async () => {
    harness.kernel.capabilities.provide(EnterpriseConnectorToken, connector());

    const result = await connectors().execute("cde", "listDocuments");
    expect(result.ok).toBe(false);
  });

  it("refuses an operation the connector did not declare", async () => {
    harness.kernel.capabilities.provide(EnterpriseConnectorToken, connector());
    await connectors().connect("cde", { apiKey: "secret" });

    const result = await connectors().execute("cde", "deleteEverything");

    // Declared operations are what make an enterprise deployment auditable.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION_DENIED");
  });

  it("refuses a write through a read-only connector", async () => {
    harness.kernel.capabilities.provide(EnterpriseConnectorToken, connector({ readOnly: true }));
    await connectors().connect("cde", {});

    expect((await connectors().execute("cde", "uploadDocument")).ok).toBe(false);
    expect((await connectors().execute("cde", "listDocuments")).ok).toBe(true);
  });

  it("passes credentials through without storing them", async () => {
    harness.kernel.capabilities.provide(EnterpriseConnectorToken, connector());
    await connectors().connect("cde", { apiKey: "secret" });

    const result = unwrapOk(
      await connectors().execute<{ sawKey: string }>("cde", "listDocuments"),
    );
    expect(result.sawKey).toBe("secret");

    // Nothing about the credential reaches plugin state, so a shared project file cannot leak it.
    const serialised = JSON.stringify(harness.kernel.state.snapshot());
    expect(serialised).not.toContain("secret");
  });

  it("tracks connection state and reports health", async () => {
    harness.kernel.capabilities.provide(EnterpriseConnectorToken, connector());
    expect(connectors().isConnected("cde")).toBe(false);

    await connectors().connect("cde", {});
    expect(connectors().isConnected("cde")).toBe(true);
    expect(unwrapOk(await connectors().health("cde")).connected).toBe(true);

    await connectors().disconnect("cde");
    expect(connectors().isConnected("cde")).toBe(false);
  });

  it("reports an unknown connector", async () => {
    expect((await connectors().connect("ghost", {})).ok).toBe(false);
  });
});
