import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import type {
  GeoReference,
  Id,
  IsoTimestamp,
  LinearUnit,
  ModelRecord,
  TwinObjectRecord,
} from "@massingifc/project-schema";
import type {
  ElementProperties,
  PropertyService,
  SpatialTreeNode,
  SpatialTreeService,
} from "@massingifc/viewer-runtime";
import { buildScenePackage } from "./build.js";
import type {
  ScenePackage,
  ScenePackageProvider,
  ScenePropertySet,
  SceneNode,
  SceneRelationship,
} from "./contracts.js";
import { toRealityLayers } from "./reality.js";

/**
 * Builds scene packages from the viewer contracts.
 *
 * Written against `viewer-runtime` rather than the That Open adapter on purpose: the spatial tree
 * and the property service are all this needs, so it works with any viewer implementing them, and
 * `engine-bridge` stays free of `three` and `@thatopen`. Putting it in the adapter would have tied
 * the export path to one renderer for no benefit.
 *
 * What it does not do is produce geometry. Nothing in the viewer contracts hands out mesh buffers,
 * so this emits the semantic half — identity, class, hierarchy, properties, relationships — and
 * `validateScenePackage` reports the absence rather than leaving a consumer to discover it. That
 * half is already enough for selection, filtering and property inspection; geometry arrives when a
 * fragments exporter exists to supply payloads.
 */
export interface ViewerScenePackageOptions {
  readonly properties: PropertyService;
  readonly tree: SpatialTreeService;
  /** Models available to export. Their `geoReference` is carried into the package. */
  readonly models: () => readonly ModelRecord[];
  readonly now: () => IsoTimestamp;
  readonly generator?: string;
  /** Units the models are authored in. Everything leaves in metres regardless. */
  readonly sourceUnits?: LinearUnit;
  /** Reality datasets to carry alongside the model. */
  readonly realityObjects?: () => readonly TwinObjectRecord[];
}

/** IFC classes that denote a storey, used to stamp `levelGlobalId` down the tree. */
const STOREY_CLASSES = new Set(["IFCBUILDINGSTOREY"]);

interface Walked {
  readonly nodes: SceneNode[];
  readonly relationships: SceneRelationship[];
  /**
   * Which model each node came from.
   *
   * A `SceneNode` deliberately carries no model id — a GlobalId is unique across a project, so
   * consumers have no use for one. The export path does: property lookups go back to the viewer,
   * which answers per model, and asking the wrong model returns nothing at all.
   */
  readonly origin: Map<string, Id>;
}

function walk(root: SpatialTreeNode, modelIds: ReadonlySet<Id>): Walked {
  const nodes: SceneNode[] = [];
  const relationships: SceneRelationship[] = [];
  const origin = new Map<string, Id>();
  const seen = new Set<string>();

  const visit = (
    node: SpatialTreeNode,
    parentGlobalId: string | undefined,
    levelGlobalId: string | undefined,
  ): void => {
    const globalId = node.element?.globalId;
    let nextParent = parentGlobalId;
    let nextLevel = levelGlobalId;

    // A tree node without an element is a grouping the viewer invented — a federation root, a
    // discipline folder. It has no GlobalId, so it cannot be a scene node, but its children still
    // belong to whatever real parent sits above it.
    const owner = node.element?.modelId;
    if (globalId !== undefined && owner !== undefined && modelIds.has(owner)) {
      const ifcClass = node.ifcClass?.toUpperCase();
      if (ifcClass !== undefined && STOREY_CLASSES.has(ifcClass)) nextLevel = globalId;

      if (!seen.has(globalId)) {
        seen.add(globalId);
        origin.set(globalId, owner);
        nodes.push({
          globalId,
          ...(node.label === undefined ? {} : { name: node.label }),
          ...(ifcClass === undefined ? {} : { ifcClass }),
          ...(parentGlobalId === undefined ? {} : { parentGlobalId }),
          ...(nextLevel === undefined || nextLevel === globalId ? {} : { levelGlobalId: nextLevel }),
        });
        if (parentGlobalId !== undefined) {
          relationships.push({
            type: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
            fromGlobalId: parentGlobalId,
            toGlobalId: globalId,
          });
        }
      }
      nextParent = globalId;
    }

    for (const child of node.children) visit(child, nextParent, nextLevel);
  };

  visit(root, undefined, undefined);
  return { nodes, relationships, origin };
}

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

function toPropertySets(properties: ElementProperties): readonly ScenePropertySet[] {
  const sets: ScenePropertySet[] = [];

  for (const [name, values] of Object.entries(properties.propertySets ?? {})) {
    // Non-scalar property values are dropped rather than stringified. A consumer reading
    // `"[object Object]"` cannot tell it from a real value; an absent key it can.
    const scalars = Object.entries(values).filter(([, value]) => isScalar(value));
    if (scalars.length > 0) {
      sets.push({ name, properties: Object.fromEntries(scalars) as ScenePropertySet["properties"] });
    }
  }

  if (properties.quantities && Object.keys(properties.quantities).length > 0) {
    sets.push({ name: "Quantities", properties: { ...properties.quantities } });
  }

  return sets;
}

export function createViewerScenePackageProvider(
  options: ViewerScenePackageOptions,
): ScenePackageProvider {
  return {
    async build(request = {}) {
      const available = options.models();
      const wanted = request.modelIds;
      const models =
        wanted === undefined ? available : available.filter((model) => wanted.includes(model.id));

      if (models.length === 0) {
        return err(
          new KernelError("COMMAND_FAILED", "No models match the requested scope.", {
            requested: wanted ?? [],
          }),
        );
      }

      const modelIds = new Set(models.map((model) => model.id));
      const nodes: SceneNode[] = [];
      const relationships: SceneRelationship[] = [];
      const origin = new Map<string, Id>();

      for (const model of models) {
        if (request.signal?.aborted === true) {
          return err(new KernelError("COMMAND_FAILED", "Scene export was cancelled.", {}));
        }
        const built = await options.tree.build(model.id);
        if (!built.ok) return err(built.error);
        const walked = walk(built.value, modelIds);
        nodes.push(...walked.nodes);
        relationships.push(...walked.relationships);
        for (const [globalId, owner] of walked.origin) origin.set(globalId, owner);
      }

      let properties: Record<string, readonly ScenePropertySet[]> | undefined;
      if (request.includeProperties === true && nodes.length > 0) {
        const resolved = await options.properties.getMany(
          // Each node is asked of the model it came from. Using one model for all of them loses
          // every property in a federated scope, silently, because the ids do not resolve there.
          nodes.map((node) => ({
            modelId: origin.get(node.globalId) ?? models[0]!.id,
            globalId: node.globalId,
          })),
        );
        if (!resolved.ok) return err(resolved.error);
        properties = {};
        for (const entry of resolved.value) {
          const sets = toPropertySets(entry);
          if (sets.length > 0) properties[entry.element.globalId] = sets;
        }
      }

      // Georeference comes from the models themselves. Taking it from the first that has one is
      // deliberate: if two disagree they are not in the same space, and silently averaging or
      // preferring one would hide a problem that has to be fixed upstream.
      const georeferenced = models.filter((model) => model.geoReference !== undefined);
      const geoReference: GeoReference | undefined = georeferenced[0]?.geoReference;
      const conflicting = georeferenced.some(
        (model) => model.geoReference?.sourceCrs !== geoReference?.sourceCrs,
      );
      if (conflicting) {
        return err(
          new KernelError(
            "COMMAND_FAILED",
            "Models in this scope declare different coordinate reference systems.",
            { crs: [...new Set(georeferenced.map((model) => model.geoReference?.sourceCrs))] },
          ),
        );
      }

      const realityLayers = toRealityLayers(options.realityObjects?.() ?? []);

      return buildScenePackage({
        generator: options.generator ?? "massingifc",
        generatedAt: options.now(),
        sources: models.map((model) => ({
          modelId: model.id,
          modelName: model.name,
          revision: model.version,
        })),
        ...(options.sourceUnits === undefined ? {} : { sourceUnits: options.sourceUnits }),
        ...(geoReference === undefined ? {} : { geoReference }),
        nodes,
        ...(properties === undefined ? {} : { properties }),
        ...(request.includeRelationships === true ? { relationships } : {}),
        ...(realityLayers.length === 0 ? {} : { realityLayers }),
      });
    },
  };
}

export type { ScenePackage };
