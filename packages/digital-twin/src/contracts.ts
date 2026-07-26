/**
 * `@massingifc/digital-twin` — observed reality alongside the authored model.
 *
 * Twins stay loosely coupled to BIM semantics on purpose. A scan, a sensor feed and a generated
 * `THREE.Group` are evidence, and converting evidence into semantic IFC on arrival throws away
 * both the uncertainty and the provenance that make it worth having. Promotion into authored
 * geometry is available, but it is a decision someone makes, not a side effect of ingestion.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  ElementRef,
  Id,
  IsoTimestamp,
  Matrix4,
  TwinAlignmentRecord,
  TwinObjectRecord,
  TwinObservationRecord,
  TwinPromotionRecord,
  TwinTimelineRecord,
  Vec3,
} from "@massingifc/project-schema";

/** Opaque runtime object — a `THREE.Group`, a parsed glTF scene, a point-cloud handle. */
export type TwinRuntimeObject = unknown;

/**
 * Produces a runtime object for a twin record.
 *
 * Registered by kind so new sources plug in without the registry learning about them. Generated
 * content (an `img2threejs`-style TypeScript factory returning a `THREE.Group`) and fetched
 * content (a GLB URL) are the same thing to the registry: something that yields a scene object.
 */
export interface TwinObjectFactory {
  readonly kind: TwinObjectRecord["kind"];
  create(record: TwinObjectRecord): Promise<Result<TwinRuntimeObject>>;
  dispose(object: TwinRuntimeObject): void;
}

export const TwinObjectFactoryToken = createCapabilityToken<TwinObjectFactory>("twin.factory");

export interface TwinRegistryService {
  register(record: TwinObjectRecord): Promise<Result<TwinObjectRecord>>;
  unregister(twinObjectId: Id): Promise<Result<void>>;
  /** Instantiates the runtime object and adds it to the scene. */
  materialise(twinObjectId: Id): Promise<Result<TwinRuntimeObject>>;
  setVisible(twinObjectId: Id, visible: boolean): void;
  get(twinObjectId: Id): TwinObjectRecord | undefined;
  list(filter?: { readonly kind?: TwinObjectRecord["kind"]; readonly aligned?: boolean }): readonly TwinObjectRecord[];
  /** Associates a twin object with the BIM elements it is understood to represent. */
  link(twinObjectId: Id, elements: readonly ElementRef[]): Promise<Result<TwinObjectRecord>>;
}

export const TwinRegistryToken = createCapabilityToken<TwinRegistryService>("twin.registry");

/** A control point correspondence, as supplied by a surveyor or picked on screen. */
export interface PointPairInput {
  readonly source: Vec3;
  readonly target: Vec3;
}

export interface TwinAlignmentService {
  setTransform(twinObjectId: Id, transform: Matrix4): Promise<Result<TwinAlignmentRecord>>;
  /** Three-point registration — the workflow a surveyor or field engineer actually uses. */
  alignByPoints(
    twinObjectId: Id,
    pairs: readonly { readonly source: Vec3; readonly target: Vec3 }[],
  ): Promise<Result<TwinAlignmentRecord>>;
  /** Iterative refinement against model geometry. Reports residual error, never silently "fits". */
  refine(twinObjectId: Id, options?: { readonly maxIterations?: number }): Promise<Result<TwinAlignmentRecord>>;
  history(twinObjectId: Id): readonly TwinAlignmentRecord[];
  revert(alignmentId: Id): Promise<Result<TwinAlignmentRecord>>;
}

export const TwinAlignmentToken = createCapabilityToken<TwinAlignmentService>("twin.alignment");

export interface TwinObservationService {
  record(observation: Omit<TwinObservationRecord, "id">): Promise<Result<TwinObservationRecord>>;
  recordMany(observations: readonly Omit<TwinObservationRecord, "id">[]): Promise<Result<number>>;
  latest(twinObjectId: Id, metric: string): TwinObservationRecord | undefined;
  query(filter: {
    readonly twinObjectId?: Id;
    readonly metric?: string;
    readonly from?: IsoTimestamp;
    readonly to?: IsoTimestamp;
    readonly quality?: TwinObservationRecord["quality"];
  }): readonly TwinObservationRecord[];
}

export const TwinObservationToken = createCapabilityToken<TwinObservationService>("twin.observations");

export interface TwinTimelineService {
  build(twinObjectId: Id, metric: string, from: IsoTimestamp, to: IsoTimestamp): Promise<Result<TwinTimelineRecord>>;
  /** Moves the scene to a point in time, for playback of a captured or sensed history. */
  seek(timelineId: Id, at: IsoTimestamp): Promise<Result<void>>;
  play(timelineId: Id, speed?: number): Promise<Result<void>>;
  pause(): void;
}

export const TwinTimelineToken = createCapabilityToken<TwinTimelineService>("twin.timeline");

export interface TwinPromotionService {
  promote(
    twinObjectId: Id,
    target: TwinPromotionRecord["target"],
    options?: { readonly name?: string; readonly repositoryId?: Id; readonly notes?: string },
  ): Promise<Result<TwinPromotionRecord>>;
  /** Provenance lookup: which observation produced this authored content. */
  originOf(targetId: Id): TwinPromotionRecord | undefined;
  history(twinObjectId: Id): readonly TwinPromotionRecord[];
}

export const TwinPromotionToken = createCapabilityToken<TwinPromotionService>("twin.promotion");

export interface TwinEvents {
  "twin.registered": { readonly record: TwinObjectRecord };
  "twin.aligned": { readonly alignment: TwinAlignmentRecord };
  "twin.observation": { readonly observation: TwinObservationRecord };
  "twin.promoted": { readonly promotion: TwinPromotionRecord };
}

export const TWIN_COMMANDS = {
  register: "twin.register",
  materialise: "twin.materialise",
  alignByPoints: "twin.align.points",
  refineAlignment: "twin.align.refine",
  recordObservation: "twin.observation.record",
  promote: "twin.promote",
} as const;

export const TWIN_PERMISSIONS = {
  register: "twin.register",
  align: "twin.align",
  promote: "twin.promote",
} as const;
