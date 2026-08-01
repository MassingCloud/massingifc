import type { Id, ModelRecord } from "@massingifc/project-schema";
import type { PayloadRole, ScenePayload } from "./contracts.js";
import { payloadPath } from "./codec.js";

/**
 * Geometry payloads.
 *
 * The package carries the model's **Fragments binary**, not a re-tessellation of it. That is the
 * whole point: Fragments is already a compact, open, schema-based representation of exactly this
 * geometry, and the engine-side consumers being built against it read it natively. Emitting glTF
 * here would mean inventing a parallel format, decoding geometry the engine can decode better, and
 * losing the per-element addressing Fragments already carries — three costs for no benefit.
 *
 * What the manifest adds on top is the part Fragments does not give an importer for free: stable
 * identity keyed by GlobalId, the class and level indexes precomputed, property sets and
 * relationships, and the georeference. The binary says what the shapes are; the manifest says what
 * they *mean* and how to address them.
 */

/** Media type for a Fragments 2.0 binary. */
export const FRAGMENTS_ENCODING = "application/vnd.thatopen.fragments";

export interface GeometryPayload {
  readonly bytes: Uint8Array;
  /** Defaults to the Fragments media type. Set it when carrying something else. */
  readonly encoding?: string;
  readonly role?: PayloadRole;
  /** File extension used inside the package, without the dot. */
  readonly extension?: string;
}

/**
 * Supplies a model's geometry bytes.
 *
 * A port because where the `.frag` lives is a deployment question — a container entry, object
 * storage, a URL, or already in memory from the session that loaded it. `undefined` means this
 * model has no geometry to carry, which is a normal answer rather than a failure: a scope can
 * legitimately mix converted and unconverted models.
 */
export type GeometrySource = (model: ModelRecord) => Promise<GeometryPayload | undefined>;

/**
 * FNV-1a over the bytes.
 *
 * An identity key, not a digest — it exists so an incremental sync can skip a payload that has not
 * changed, and it is explicitly not a security check. Kept dependency-free because this package
 * runs in a browser, in Node, and in whatever a converter is built on.
 */
export function contentHash(bytes: Uint8Array): string {
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return `fnv1a-${value.toString(36)}`;
}

export function payloadIdFor(modelId: Id): string {
  return `geometry-${modelId}`;
}

/** Builds the manifest entry for one model's geometry. */
export function toScenePayload(modelId: Id, payload: GeometryPayload): ScenePayload {
  const extension = payload.extension ?? "frag";
  return {
    id: payloadIdFor(modelId),
    role: payload.role ?? "geometry",
    path: payloadPath(payloadIdFor(modelId), extension),
    encoding: payload.encoding ?? FRAGMENTS_ENCODING,
    byteLength: payload.bytes.byteLength,
    hash: contentHash(payload.bytes),
  };
}
