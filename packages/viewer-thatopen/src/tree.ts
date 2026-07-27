import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import type { Id } from "@massingifc/project-schema";
import type { SpatialTreeNode, SpatialTreeService } from "@massingifc/viewer-runtime";
import {
  stringAttribute,
  type FragmentDataModel,
  type FragmentModelSource,
  type FragmentTreeItem,
} from "./model-data.js";

/** Attributes only — a tree needs names, not every property set hanging off every element. */
const TREE_CONFIG = { attributesDefault: true, relationsDefault: { attributes: false, relations: false } };

export interface ThatOpenSpatialTreeOptions {
  readonly models: FragmentModelSource;
  /** Which models are loaded. Supplied by the host, which is the only thing that knows. */
  readonly modelIds: () => readonly Id[];
}

/**
 * The spatial hierarchy, published with stable identities.
 *
 * The fragments tree addresses items by local id. Everything above the viewer — the engine export,
 * markup anchors, a saved tree selection — addresses them by GlobalId, so the whole tree is
 * resolved here in **two** batched calls rather than two per node. A storey with six hundred
 * children would otherwise be twelve hundred round trips to the worker for a panel that opens on
 * a click.
 *
 * Nodes whose items have no GlobalId keep their place in the hierarchy but carry no `element`.
 * That is deliberate: they are real structure, and dropping them would reparent their children
 * onto the wrong ancestor, but they cannot be referenced stably so they must not pretend to be.
 */
export class ThatOpenSpatialTree implements SpatialTreeService {
  readonly #models: FragmentModelSource;
  readonly #modelIds: () => readonly Id[];

  constructor(options: ThatOpenSpatialTreeOptions) {
    this.#models = options.models;
    this.#modelIds = options.modelIds;
  }

  async build(modelId: Id): Promise<Result<SpatialTreeNode>> {
    const model = this.#models(modelId);
    if (!model) {
      return err(new KernelError("COMMAND_FAILED", `Model "${modelId}" is not loaded.`, { modelId }));
    }

    try {
      const root = await model.getSpatialStructure();
      const localIds: number[] = [];
      collectIds(root, localIds);

      const [guids, names] = await Promise.all([
        resolveGuids(model, localIds),
        resolveNames(model, localIds),
      ]);

      return ok(toNode(root, modelId, guids, names, `${modelId}:root`));
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "Failed to read the spatial structure.", { modelId }, { cause: thrown }),
      );
    }
  }

  /**
   * One root per model.
   *
   * Federation is not flattened into a single synthetic tree: two models can both contain a
   * "Level 1", and merging them would imply a shared storey that does not exist. Grouping across
   * models is a product decision, so the host makes it.
   */
  async buildFederated(): Promise<Result<readonly SpatialTreeNode[]>> {
    const roots: SpatialTreeNode[] = [];
    for (const modelId of this.#modelIds()) {
      const built = await this.build(modelId);
      if (!built.ok) return err(built.error);
      roots.push(built.value);
    }
    return ok(roots);
  }
}

function collectIds(item: FragmentTreeItem, into: number[]): void {
  if (item.localId !== null) into.push(item.localId);
  for (const child of item.children ?? []) collectIds(child, into);
}

async function resolveGuids(
  model: FragmentDataModel,
  localIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolved = new Map<number, string>();
  if (localIds.length === 0) return resolved;
  const guids = await model.getGuidsByLocalIds([...localIds]);
  localIds.forEach((localId, index) => {
    const guid = guids[index];
    if (guid) resolved.set(localId, guid);
  });
  return resolved;
}

async function resolveNames(
  model: FragmentDataModel,
  localIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolved = new Map<number, string>();
  if (localIds.length === 0) return resolved;
  const data = await model.getItemsData([...localIds], TREE_CONFIG);
  localIds.forEach((localId, index) => {
    const item = data[index];
    const name = item === undefined ? undefined : stringAttribute(item, "Name");
    if (name !== undefined) resolved.set(localId, name);
  });
  return resolved;
}

function toNode(
  item: FragmentTreeItem,
  modelId: Id,
  guids: ReadonlyMap<number, string>,
  names: ReadonlyMap<number, string>,
  fallbackId: string,
): SpatialTreeNode {
  const localId = item.localId;
  const globalId = localId === null ? undefined : guids.get(localId);
  const category = item.category ?? undefined;
  // Falls back to the class only when the element is unnamed. A tree showing
  // "IFCWALLSTANDARDCASE" six hundred times tells the user nothing.
  const label = (localId === null ? undefined : names.get(localId)) ?? category ?? "Item";

  return {
    id: globalId ?? (localId === null ? fallbackId : `${modelId}:${localId}`),
    label,
    ...(category === undefined ? {} : { ifcClass: category }),
    ...(globalId === undefined || localId === null
      ? {}
      : { element: { modelId, globalId, localId } }),
    children: (item.children ?? []).map((child, index) =>
      toNode(child, modelId, guids, names, `${fallbackId}/${index}`),
    ),
  };
}
