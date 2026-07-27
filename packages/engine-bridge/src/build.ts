import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import {
  convertLength,
  type GeoReference,
  type IsoTimestamp,
  type LinearUnit,
} from "@massingifc/project-schema";
import {
  SCENE_FORMAT_VERSION,
  type SceneBounds,
  type SceneIndex,
  type SceneMaterial,
  type SceneNode,
  type ScenePackage,
  type ScenePayload,
  type ScenePropertySet,
  type SceneRealityLayer,
  type SceneRelationship,
  type SceneSource,
  type SceneTransform,
} from "./contracts.js";

export interface ScenePackageInput {
  readonly generator: string;
  readonly generatedAt: IsoTimestamp;
  readonly sources?: readonly SceneSource[];
  /**
   * Units the incoming nodes are expressed in. Everything is converted to metres on the way out,
   * so a consumer never has to ask.
   */
  readonly sourceUnits?: LinearUnit;
  readonly geoReference?: GeoReference;
  readonly payloads?: readonly ScenePayload[];
  readonly nodes: readonly SceneNode[];
  readonly materials?: readonly SceneMaterial[];
  readonly properties?: Readonly<Record<string, readonly ScenePropertySet[]>>;
  readonly relationships?: readonly SceneRelationship[];
  readonly realityLayers?: readonly SceneRealityLayer[];
}

/** Scales the translation column of a column-major 4x4. Rotation and scale are unit-free. */
function scaleTransform(transform: SceneTransform, factor: number): SceneTransform {
  if (factor === 1) return transform;
  return transform.map((value, index) => (index >= 12 && index <= 14 ? value * factor : value));
}

function scaleBounds(bounds: SceneBounds, factor: number): SceneBounds {
  if (factor === 1) return bounds;
  return [
    bounds[0] * factor,
    bounds[1] * factor,
    bounds[2] * factor,
    bounds[3] * factor,
    bounds[4] * factor,
    bounds[5] * factor,
  ];
}

/**
 * Restates a georeference in metres.
 *
 * The package promises metres throughout, and `originOffset` is a coordinate — a consumer computes
 * `world = local + originOffset`, so leaving the offset in the source unit while converting the
 * geometry puts the model a factor of a thousand away from where it belongs. The CRS, datum and
 * true-north angle are unit-free and pass through untouched.
 */
function toMetres(geo: GeoReference): GeoReference {
  // Converted by the georeference's own units, not the model's. The two are independent: a model
  // authored in millimetres can carry a georeference already stated in metres, and scaling by the
  // wrong one is exactly the mistake this function exists to prevent.
  const factor = convertLength(1, geo.units, "m");
  if (factor === 1) return geo;

  const offset = geo.originOffset;
  const local = geo.localToGlobal;
  return {
    ...geo,
    units: "m",
    // `accuracy` is documented in metres regardless of `units`, so it is deliberately not scaled.
    ...(offset === undefined
      ? {}
      : { originOffset: [offset[0] * factor, offset[1] * factor, offset[2] * factor] }),
    ...(local === undefined
      ? {}
      : {
          localToGlobal: local.map((value, index) =>
            index >= 12 && index <= 14 ? value * factor : value,
          ),
        }),
  };
}

function buildIndex(nodes: readonly SceneNode[]): SceneIndex {
  const byClass: Record<string, number[]> = {};
  const byLevel: Record<string, number[]> = {};
  const byGlobalId: Record<string, number> = {};

  nodes.forEach((node, position) => {
    byGlobalId[node.globalId] = position;
    if (node.ifcClass !== undefined) (byClass[node.ifcClass] ??= []).push(position);
    if (node.levelGlobalId !== undefined) (byLevel[node.levelGlobalId] ??= []).push(position);
  });

  return { byClass, byLevel, byGlobalId };
}

/**
 * Assembles a scene package.
 *
 * Refuses duplicate GlobalIds rather than tolerating them, because the index is a map and the
 * second entry would silently displace the first — an element that quietly stops being selectable
 * is far harder to notice than an export that failed.
 */
export function buildScenePackage(input: ScenePackageInput): Result<ScenePackage> {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const node of input.nodes) {
    if (node.globalId.length === 0) {
      return err(
        new KernelError("COMMAND_FAILED", "A scene node has an empty GlobalId; identity is required.", {
          name: node.name,
        }),
      );
    }
    if (seen.has(node.globalId)) duplicates.push(node.globalId);
    seen.add(node.globalId);
  }
  if (duplicates.length > 0) {
    return err(
      new KernelError("COMMAND_FAILED", `Scene contains ${duplicates.length} duplicate GlobalId(s).`, {
        globalIds: duplicates.slice(0, 10),
      }),
    );
  }

  const units = input.sourceUnits ?? "m";
  const factor = convertLength(1, units, "m");

  const nodes: readonly SceneNode[] = input.nodes.map((node) => ({
    ...node,
    ...(node.transform === undefined ? {} : { transform: scaleTransform(node.transform, factor) }),
    ...(node.bounds === undefined ? {} : { bounds: scaleBounds(node.bounds, factor) }),
  }));

  return ok({
    formatVersion: SCENE_FORMAT_VERSION,
    generator: input.generator,
    generatedAt: input.generatedAt,
    sources: input.sources ?? [],
    units: "m",
    ...(input.sourceUnits === undefined ? {} : { sourceUnits: input.sourceUnits }),
    ...(input.geoReference === undefined ? {} : { geoReference: toMetres(input.geoReference) }),
    payloads: input.payloads ?? [],
    nodes,
    ...(input.materials === undefined ? {} : { materials: input.materials }),
    ...(input.properties === undefined ? {} : { properties: input.properties }),
    ...(input.relationships === undefined ? {} : { relationships: input.relationships }),
    ...(input.realityLayers === undefined ? {} : { realityLayers: input.realityLayers }),
    index: buildIndex(nodes),
  });
}

export type SceneIssueCode =
  | "unknown-payload-reference"
  | "unknown-parent"
  | "unknown-level"
  | "dangling-relationship"
  | "properties-without-node"
  | "unknown-material"
  | "stale-index"
  | "no-geometry";

export interface SceneIssue {
  readonly severity: "error" | "warning";
  readonly code: SceneIssueCode;
  readonly message: string;
  readonly subject?: string;
}

export interface SceneValidationReport {
  readonly valid: boolean;
  readonly issues: readonly SceneIssue[];
}

/**
 * Checks a package's internal references before it leaves the process.
 *
 * Worth doing here because every failure this catches would otherwise surface inside an engine
 * importer as a missing mesh or a null lookup, several tools away from the cause.
 */
export function validateScenePackage(scene: ScenePackage): SceneValidationReport {
  const issues: SceneIssue[] = [];
  const payloadIds = new Set(scene.payloads.map((payload) => payload.id));
  const materialIds = new Set((scene.materials ?? []).map((material) => material.id));
  const globalIds = new Set(scene.nodes.map((node) => node.globalId));

  for (const node of scene.nodes) {
    if (node.payloadId !== undefined && !payloadIds.has(node.payloadId)) {
      issues.push({
        severity: "error",
        code: "unknown-payload-reference",
        message: `Node "${node.globalId}" references payload "${node.payloadId}", which is not in the package.`,
        subject: node.globalId,
      });
    }
    if (node.materialId !== undefined && !materialIds.has(node.materialId)) {
      issues.push({
        severity: "warning",
        code: "unknown-material",
        message: `Node "${node.globalId}" references material "${node.materialId}", which is not declared.`,
        subject: node.globalId,
      });
    }
    if (node.parentGlobalId !== undefined && !globalIds.has(node.parentGlobalId)) {
      issues.push({
        severity: "warning",
        code: "unknown-parent",
        // A warning, not an error: a partial export of one storey legitimately leaves the parent
        // outside the package, and refusing that would make scoped exports impossible.
        message: `Node "${node.globalId}" has parent "${node.parentGlobalId}", which is outside this package.`,
        subject: node.globalId,
      });
    }
    if (node.levelGlobalId !== undefined && !globalIds.has(node.levelGlobalId)) {
      issues.push({
        severity: "warning",
        code: "unknown-level",
        message: `Node "${node.globalId}" is on level "${node.levelGlobalId}", which is outside this package.`,
        subject: node.globalId,
      });
    }
  }

  for (const relationship of scene.relationships ?? []) {
    if (!globalIds.has(relationship.fromGlobalId) || !globalIds.has(relationship.toGlobalId)) {
      issues.push({
        severity: "warning",
        code: "dangling-relationship",
        message: `Relationship "${relationship.type}" links ${relationship.fromGlobalId} to ${relationship.toGlobalId}, at least one of which is outside this package.`,
      });
    }
  }

  for (const globalId of Object.keys(scene.properties ?? {})) {
    if (!globalIds.has(globalId)) {
      issues.push({
        severity: "warning",
        code: "properties-without-node",
        message: `Property sets are attached to "${globalId}", which has no node.`,
        subject: globalId,
      });
    }
  }

  for (const [globalId, position] of Object.entries(scene.index.byGlobalId)) {
    if (scene.nodes[position]?.globalId !== globalId) {
      issues.push({
        severity: "error",
        code: "stale-index",
        // An index that disagrees with the nodes is worse than no index: consumers trust it, so
        // selection silently picks the wrong element.
        message: `Index entry for "${globalId}" points at position ${position}, which holds a different node.`,
        subject: globalId,
      });
    }
  }

  if (scene.nodes.length > 0 && scene.nodes.every((node) => node.payloadId === undefined)) {
    issues.push({
      severity: "warning",
      code: "no-geometry",
      message: "No node references geometry; this package carries semantics only.",
    });
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}
