/**
 * `@massingifc/interop` — import, export and enterprise connectors.
 *
 * Everything crossing the platform boundary goes through an adapter with a declared format and a
 * declared direction. The reason is governance rather than tidiness: an enterprise deployment
 * needs to enumerate exactly what can leave the system and where it can go, and that is only
 * possible if connectors are registered artifacts instead of ad-hoc fetch calls.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type { Id, IsoTimestamp, Provenance } from "@massingifc/project-schema";

export interface FormatDescriptor {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly mimeType?: string;
}

export interface ImportContext {
  readonly fileName?: string;
  readonly provenance?: Provenance;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

export interface ImportOutcome {
  readonly recordsCreated: number;
  readonly warnings: readonly string[];
  /** Ids created, by schema — lets the caller select or navigate to what just arrived. */
  readonly created: Readonly<Record<string, readonly Id[]>>;
}

export interface ImportAdapter {
  readonly format: FormatDescriptor;
  /** Cheap sniff before committing to a full parse, so a wrong file fails fast and clearly. */
  canHandle(payload: Uint8Array, context?: ImportContext): boolean;
  import(payload: Uint8Array, context?: ImportContext): Promise<Result<ImportOutcome>>;
}

export const ImportAdapterToken = createCapabilityToken<ImportAdapter>("interop.import");

export interface ExportAdapter {
  readonly format: FormatDescriptor;
  export(options: {
    readonly scope?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<Result<Uint8Array>>;
}

export const ExportAdapterToken = createCapabilityToken<ExportAdapter>("interop.export");

export interface InteropService {
  importFormats(): readonly FormatDescriptor[];
  exportFormats(): readonly FormatDescriptor[];
  /** Picks an adapter by sniffing, falling back to the extension. */
  import(payload: Uint8Array, context?: ImportContext): Promise<Result<ImportOutcome>>;
  importAs(formatId: string, payload: Uint8Array, context?: ImportContext): Promise<Result<ImportOutcome>>;
  export(formatId: string, options?: { readonly scope?: Readonly<Record<string, unknown>> }): Promise<Result<Uint8Array>>;
}

export const InteropToken = createCapabilityToken<InteropService>("interop.service");

export type ConnectorAuth = "none" | "api-key" | "oauth2" | "basic" | "certificate";

export interface ConnectorDescriptor {
  readonly id: string;
  readonly name: string;
  readonly vendor?: string;
  readonly auth: ConnectorAuth;
  /** Actions this connector can perform. Enumerated so a deployment can allow-list them. */
  readonly operations: readonly string[];
  readonly readOnly: boolean;
}

export interface ConnectorHealth {
  readonly connected: boolean;
  readonly checkedAt: IsoTimestamp;
  readonly latencyMs?: number;
  readonly message?: string;
}

/**
 * A link to an external system of record.
 *
 * Credentials are never part of the descriptor or of any persisted record — the host resolves them
 * from its own secret store and passes them at connect time, so a project file can be shared
 * without carrying somebody's API key.
 */
export interface EnterpriseConnector {
  readonly descriptor: ConnectorDescriptor;
  connect(credentials: Readonly<Record<string, unknown>>): Promise<Result<void>>;
  disconnect(): Promise<void>;
  health(): Promise<Result<ConnectorHealth>>;
  execute<T = unknown>(operation: string, params?: Readonly<Record<string, unknown>>): Promise<Result<T>>;
}

export const EnterpriseConnectorToken =
  createCapabilityToken<EnterpriseConnector>("interop.connector");

export interface InteropEvents {
  "interop.import.completed": { readonly formatId: string; readonly outcome: ImportOutcome };
  "interop.export.completed": { readonly formatId: string; readonly bytes: number };
  "interop.connector.health": { readonly connectorId: string; readonly health: ConnectorHealth };
}

export const INTEROP_COMMANDS = {
  importFile: "interop.import",
  exportAs: "interop.export",
  connectSystem: "interop.connector.connect",
  runOperation: "interop.connector.execute",
} as const;

export const INTEROP_PERMISSIONS = {
  import: "interop.import",
  export: "interop.export",
  manageConnectors: "interop.connector.manage",
} as const;
