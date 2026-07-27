import { err, KernelError, ok, type PluginContext, type Result } from "@massingifc/core-kernel";
import type {
  ConnectorHealth,
  EnterpriseConnector,
  ExportAdapter,
  FormatDescriptor,
  ImportAdapter,
  ImportContext,
  ImportOutcome,
  InteropService,
} from "./contracts.js";

export interface InteropRuntime {
  readonly context: PluginContext;
  readonly importAdapters: () => readonly ImportAdapter[];
  readonly exportAdapters: () => readonly ExportAdapter[];
  readonly connectors: () => readonly EnterpriseConnector[];
}

const noAdapter = (formatId: string): KernelError =>
  new KernelError("CAPABILITY_NOT_FOUND", `No adapter is registered for format "${formatId}".`, {
    formatId,
  });

/** Extension of a file name, lowercased and without the dot. */
export function extensionOf(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const index = fileName.lastIndexOf(".");
  return index === -1 ? undefined : fileName.slice(index + 1).toLowerCase();
}

/**
 * Chooses an import adapter for a payload.
 *
 * Content first, extension second. A file's extension is a claim its author made and is routinely
 * wrong — an IFC saved as `.txt`, a `.zip` that is really an ICDD container — whereas a sniff reads
 * what the bytes actually are. The extension is the tie-breaker, not the decision.
 */
export function selectImportAdapter(
  adapters: readonly ImportAdapter[],
  payload: Uint8Array,
  context?: ImportContext,
): ImportAdapter | undefined {
  const sniffed = adapters.filter((adapter) => {
    try {
      return adapter.canHandle(payload, context);
    } catch {
      // An adapter that throws while sniffing is simply not a match.
      return false;
    }
  });
  if (sniffed.length === 1) return sniffed[0];

  const extension = extensionOf(context?.fileName);
  if (extension) {
    const byExtension = (sniffed.length > 0 ? sniffed : adapters).find((adapter) =>
      adapter.format.extensions.includes(extension),
    );
    if (byExtension) return byExtension;
  }
  return sniffed[0];
}

export function createInteropService(runtime: InteropRuntime): InteropService {
  const dedupe = (formats: readonly FormatDescriptor[]): FormatDescriptor[] => {
    const seen = new Map<string, FormatDescriptor>();
    for (const format of formats) if (!seen.has(format.id)) seen.set(format.id, format);
    return [...seen.values()];
  };

  const runImport = async (
    adapter: ImportAdapter,
    payload: Uint8Array,
    context?: ImportContext,
  ): Promise<Result<ImportOutcome>> => {
    if (context?.signal?.aborted) {
      return err(new KernelError("COMMAND_FAILED", "Import was cancelled.", {}));
    }
    const outcome = await adapter.import(payload, context);
    if (!outcome.ok) return outcome;

    runtime.context.events.emit("interop.import.completed", {
      formatId: adapter.format.id,
      outcome: outcome.value,
    });
    return outcome;
  };

  return {
    importFormats: () => dedupe(runtime.importAdapters().map((adapter) => adapter.format)),
    exportFormats: () => dedupe(runtime.exportAdapters().map((adapter) => adapter.format)),

    async import(payload, context) {
      const adapters = runtime.importAdapters();
      if (adapters.length === 0) {
        return err(new KernelError("CAPABILITY_NOT_FOUND", "No import adapters are registered.", {}));
      }
      const adapter = selectImportAdapter(adapters, payload, context);
      if (!adapter) {
        // Naming the formats we do understand turns "it did not work" into something actionable.
        return err(
          new KernelError("COMMAND_FAILED", "No adapter recognised this file.", {
            fileName: context?.fileName,
            known: adapters.map((candidate) => candidate.format.id),
          }),
        );
      }
      return runImport(adapter, payload, context);
    },

    async importAs(formatId, payload, context) {
      const adapter = runtime.importAdapters().find((candidate) => candidate.format.id === formatId);
      if (!adapter) return err(noAdapter(formatId));
      return runImport(adapter, payload, context);
    },

    async export(formatId, options) {
      const adapter = runtime.exportAdapters().find((candidate) => candidate.format.id === formatId);
      if (!adapter) return err(noAdapter(formatId));

      const exported = await adapter.export({ ...(options?.scope === undefined ? {} : { scope: options.scope }) });
      if (!exported.ok) return exported;

      runtime.context.events.emit("interop.export.completed", {
        formatId,
        bytes: exported.value.byteLength,
      });
      return exported;
    },
  };
}

export interface ConnectorSession {
  readonly connectorId: string;
  readonly connected: boolean;
  readonly connectedAt?: string;
}

/**
 * Manages connections to external systems of record.
 *
 * Credentials are taken at connect time and never stored on a record, in state, or in a container.
 * A project file gets shared; an API key inside one is a breach waiting to be committed to a
 * repository. The host resolves secrets from wherever it keeps them and passes them through.
 */
export class ConnectorRegistry {
  readonly #runtime: InteropRuntime;
  readonly #sessions = new Map<string, ConnectorSession>();
  readonly #now: () => string;

  constructor(runtime: InteropRuntime, now: () => string) {
    this.#runtime = runtime;
    this.#now = now;
  }

  descriptors(): readonly EnterpriseConnector["descriptor"][] {
    return this.#runtime.connectors().map((connector) => connector.descriptor);
  }

  #find(connectorId: string): EnterpriseConnector | undefined {
    return this.#runtime.connectors().find((c) => c.descriptor.id === connectorId);
  }

  async connect(
    connectorId: string,
    credentials: Readonly<Record<string, unknown>>,
  ): Promise<Result<void>> {
    const connector = this.#find(connectorId);
    if (!connector) return err(noAdapter(connectorId));

    const connected = await connector.connect(credentials);
    if (!connected.ok) return connected;

    this.#sessions.set(connectorId, { connectorId, connected: true, connectedAt: this.#now() });
    return ok(undefined);
  }

  async disconnect(connectorId: string): Promise<Result<void>> {
    const connector = this.#find(connectorId);
    if (!connector) return err(noAdapter(connectorId));
    await connector.disconnect();
    this.#sessions.set(connectorId, { connectorId, connected: false });
    return ok(undefined);
  }

  isConnected(connectorId: string): boolean {
    return this.#sessions.get(connectorId)?.connected === true;
  }

  async health(connectorId: string): Promise<Result<ConnectorHealth>> {
    const connector = this.#find(connectorId);
    if (!connector) return err(noAdapter(connectorId));

    const health = await connector.health();
    if (health.ok) {
      this.#runtime.context.events.emit("interop.connector.health", {
        connectorId,
        health: health.value,
      });
    }
    return health;
  }

  /**
   * Runs an operation, refusing anything the connector did not declare.
   *
   * Declared operations are what make an enterprise deployment auditable: a deployment can
   * enumerate exactly what this system can do to a system of record, and an undeclared call is a
   * bug or an escalation rather than a feature.
   */
  async execute<T = unknown>(
    connectorId: string,
    operation: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<Result<T>> {
    const connector = this.#find(connectorId);
    if (!connector) return err(noAdapter(connectorId));

    if (!this.isConnected(connectorId)) {
      return err(
        new KernelError("COMMAND_FAILED", `Connector "${connectorId}" is not connected.`, {
          connectorId,
        }),
      );
    }
    if (!connector.descriptor.operations.includes(operation)) {
      return err(
        new KernelError("PERMISSION_DENIED", `Connector "${connectorId}" does not declare "${operation}".`, {
          connectorId,
          operation,
          declared: connector.descriptor.operations,
        }),
      );
    }
    if (connector.descriptor.readOnly && !operation.startsWith("get") && !operation.startsWith("list")) {
      return err(
        new KernelError("PERMISSION_DENIED", `Connector "${connectorId}" is read-only.`, {
          connectorId,
          operation,
        }),
      );
    }

    return connector.execute<T>(operation, params);
  }
}
