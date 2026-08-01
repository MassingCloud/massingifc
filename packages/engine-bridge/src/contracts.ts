/**
 * `@massingifc/engine-bridge` — a scene contract a real-time engine can consume.
 *
 * The platform will eventually need a game engine for rendering, and the mistake to avoid is
 * writing an Unreal layer or a Unity layer. Both would encode one vendor's object model into the
 * conversion path, and the conversion path is the part that has to survive. So this package
 * defines a neutral package format instead: a JSON manifest plus opaque binary payloads, which an
 * Unreal C++ plugin, a Unity C# importer, a Bevy crate or a native viewer can each read with
 * nothing but a JSON parser and a file handle. No JavaScript runtime is required on the far side.
 *
 * What makes it a BIM contract rather than a mesh dump is identity and semantics. Every node
 * carries its IFC GlobalId, every property set and relationship is carried through, and the
 * indexes needed for selection and filtering are precomputed here rather than rebuilt by each
 * consumer. An engine importer that drops these becomes another mesh importer; one that keeps them
 * can answer "what is this, which level is it on, what is it connected to" at runtime.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type { GeoReference, Id, IsoTimestamp } from "@massingifc/project-schema";

/**
 * Format version of the package itself.
 *
 * Bumped only for breaking changes to the manifest shape. A consumer that reads a major version it
 * does not know must refuse the package rather than guess — a partially understood scene is worse
 * than a rejected one, because the gaps are invisible.
 */
export const SCENE_FORMAT_VERSION = "1.0" as const;

/** Manifest file name inside the package. */
export const SCENE_MANIFEST_PATH = "scene.json";

/** Directory holding binary payloads inside the package. */
export const SCENE_PAYLOAD_DIRECTORY = "payloads";

/**
 * What a binary payload contains.
 *
 * Left as declared roles rather than an encoding enum because engines care first about what to do
 * with a blob, and only then about how to decode it. `encoding` carries the second question.
 */
export type PayloadRole =
  | "geometry"
  | "instance-transforms"
  | "texture"
  | "material"
  | "point-cloud"
  | "gaussian-splat"
  | "metadata";

export interface ScenePayload {
  readonly id: string;
  readonly role: PayloadRole;
  /** Package-relative path, always forward-slashed. */
  readonly path: string;
  /** Media type or format id, e.g. `"model/gltf-binary"`, `"application/vnd.thatopen.fragments"`. */
  readonly encoding: string;
  readonly byteLength: number;
  /** Content hash, so an incremental sync can skip payloads that did not change. */
  readonly hash?: string;
}

/**
 * Column-major 4x4, metres, translation at indices 12, 13, 14.
 *
 * The convention is named rather than implied because a transposed matrix loads without error and
 * puts the whole model somewhere else, and the far side of this boundary is a different language.
 */
export type SceneTransform = readonly number[];

/** `[minX, minY, minZ, maxX, maxY, maxZ]`, metres, in the scene's local frame. */
export type SceneBounds = readonly [number, number, number, number, number, number];

/**
 * One addressable thing in the scene.
 *
 * `globalId` is the identity. It is the IFC GlobalId, it survives export, re-import, a change of
 * viewer and a change of engine, and it is what an issue, a cost line or a task refers to. Runtime
 * ids assigned by whatever loaded the file are not identity and never cross this boundary as one.
 */
export interface SceneNode {
  readonly globalId: string;
  readonly name?: string;
  /** IFC class, e.g. `"IFCWALLSTANDARDCASE"`. */
  readonly ifcClass?: string;
  /** GlobalId of the spatial parent — storey, space, or assembly. */
  readonly parentGlobalId?: string;
  /** GlobalId of the containing storey, denormalised because level filtering is constant. */
  readonly levelGlobalId?: string;
  readonly transform?: SceneTransform;
  readonly bounds?: SceneBounds;
  /** Payload id holding this node's geometry, and the index of its mesh within that payload. */
  readonly payloadId?: string;
  readonly geometryIndex?: number;
  readonly materialId?: string;
  /**
   * The source viewer's local id at export time.
   *
   * Present only as a debugging aid and explicitly labelled transient: it is valid for the session
   * that produced the package and meaningless afterwards. Consumers must key on `globalId`.
   */
  readonly transientLocalId?: number;
}

export interface SceneMaterial {
  readonly id: string;
  readonly name?: string;
  /** Linear sRGB, 0..1. */
  readonly baseColor?: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly opacity?: number;
  readonly doubleSided?: boolean;
  readonly texturePayloadId?: string;
}

/** A property set, carried through unflattened so an engine can show it as the model does. */
export interface ScenePropertySet {
  readonly name: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SceneRelationship {
  /** IFC relationship class or a platform-defined verb, e.g. `"IFCRELCONNECTSELEMENTS"`. */
  readonly type: string;
  readonly fromGlobalId: string;
  readonly toGlobalId: string;
}

/**
 * A reality dataset carried alongside the model.
 *
 * Kept distinct from `nodes` because it is evidence rather than an authored element, and because
 * an engine treats it differently: a splat is a radiance field to render, not a mesh to collide
 * with or measure. `measurable` is the flag that stops a downstream tool offering a dimension tool
 * over something that has no surface.
 */
export interface SceneRealityLayer {
  readonly id: Id;
  readonly name: string;
  readonly kind: string;
  readonly payloadId?: string;
  readonly sourceUri?: string;
  readonly transform?: SceneTransform;
  readonly geoReference?: GeoReference;
  readonly measurable: boolean;
}

/**
 * Lookups precomputed at export.
 *
 * Built here rather than by each consumer because the cost is paid once by the exporter, which has
 * the whole model in memory anyway, instead of on every load in every engine. On a large federated
 * model the difference is a visible loading pause.
 */
export interface SceneIndex {
  /** IFC class to node indices. */
  readonly byClass: Readonly<Record<string, readonly number[]>>;
  /** Level GlobalId to node indices. */
  readonly byLevel: Readonly<Record<string, readonly number[]>>;
  /** GlobalId to node index — the reverse of `nodes[i].globalId`. */
  readonly byGlobalId: Readonly<Record<string, number>>;
}

export interface SceneSource {
  readonly modelId?: Id;
  readonly modelName?: string;
  /** Revision or version identifier, so a package can be traced to what produced it. */
  readonly revision?: string;
}

/**
 * The manifest.
 *
 * Coordinates are metres throughout — every consumer, engine or otherwise, reads one unit and does
 * not guess. `sourceUnits` records what the model was authored in, because that is provenance and
 * losing it makes a later discrepancy impossible to explain.
 */
export interface ScenePackage {
  readonly formatVersion: typeof SCENE_FORMAT_VERSION;
  readonly generator: string;
  readonly generatedAt: IsoTimestamp;
  readonly sources: readonly SceneSource[];
  readonly units: "m";
  readonly sourceUnits?: string;
  /** Where the scene sits on Earth, and the offset its local coordinates were shifted by. */
  readonly geoReference?: GeoReference;
  readonly payloads: readonly ScenePayload[];
  readonly nodes: readonly SceneNode[];
  readonly materials?: readonly SceneMaterial[];
  /** Property sets by node GlobalId. */
  readonly properties?: Readonly<Record<string, readonly ScenePropertySet[]>>;
  readonly relationships?: readonly SceneRelationship[];
  readonly realityLayers?: readonly SceneRealityLayer[];
  readonly index: SceneIndex;
}

/**
 * A manifest together with the bytes its payloads refer to.
 *
 * The two travel together because a manifest naming payloads that nobody can supply is not a
 * package — it is a promise. Keeping them in one value means a caller cannot forget the binaries
 * and discover it only when an engine fails to find the geometry.
 */
export interface ScenePackageBundle {
  readonly scene: ScenePackage;
  /** Bytes by payload id. Empty when the package carries semantics only. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/**
 * Produces a scene package for a consuming engine.
 *
 * A capability rather than a function so a deployment can substitute one — an installation that
 * already emits Fragments binaries wires a provider that references them as payloads instead of
 * re-tessellating, and nothing upstream changes.
 */
export interface ScenePackageProvider {
  build(options?: {
    readonly modelIds?: readonly Id[];
    readonly includeProperties?: boolean;
    readonly includeRelationships?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<Result<ScenePackageBundle>>;
}

export const ScenePackageProviderToken =
  createCapabilityToken<ScenePackageProvider>("engine.scene-package");

export const ENGINE_BRIDGE_FORMAT = {
  id: "massingifc-scene",
  label: "MassingIFC scene package",
  extensions: [".mifcscene", ".zip"],
  mimeType: "application/zip",
} as const;
