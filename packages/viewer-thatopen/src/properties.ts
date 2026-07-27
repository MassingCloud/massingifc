import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import type { ElementRef, Id } from "@massingifc/project-schema";
import type { ElementProperties, PropertyService } from "@massingifc/viewer-runtime";
import {
  alignItems,
  attributeOf,
  relationOf,
  stringAttribute,
  PROPERTY_SET_CONFIG,
  type FragmentDataModel,
  type FragmentItemData,
  type FragmentModelSource,
} from "./model-data.js";

/**
 * Property access over fragments models.
 *
 * Two things decide whether this is correct, and neither is about property values. First, every
 * result is keyed by GlobalId: local ids enter at the engine boundary and never leave it, because
 * a markup anchor or a clash signature holding a transient id breaks on the next re-export.
 * Second, lookups are batched — one `getItemsData` call per model, not one per element. The
 * fragments model answers from a worker, so a per-element loop turns a property panel on a
 * hundred-element selection into a hundred round trips.
 */
export class ThatOpenProperties implements PropertyService {
  readonly #models: FragmentModelSource;

  constructor(models: FragmentModelSource) {
    this.#models = models;
  }

  async get(element: ElementRef): Promise<Result<ElementProperties>> {
    const many = await this.getMany([element]);
    if (!many.ok) return err(many.error);
    const first = many.value[0];
    return first
      ? ok(first)
      : err(
          new KernelError("COMMAND_FAILED", `Element "${element.globalId}" is not in the model.`, {
            globalId: element.globalId,
          }),
        );
  }

  async getMany(elements: readonly ElementRef[]): Promise<Result<readonly ElementProperties[]>> {
    const byModel = new Map<Id, string[]>();
    for (const element of elements) {
      const bucket = byModel.get(element.modelId);
      if (bucket) bucket.push(element.globalId);
      else byModel.set(element.modelId, [element.globalId]);
    }

    const results: ElementProperties[] = [];
    for (const [modelId, globalIds] of byModel) {
      const model = this.#models(modelId);
      if (!model) return err(notLoaded(modelId));

      try {
        const locals = await model.getLocalIdsByGuids([...globalIds]);
        // Keep the pairing: an unresolvable GlobalId leaves a hole that would otherwise shift every
        // subsequent element onto the wrong properties.
        const resolved = globalIds
          .map((globalId, index) => ({ globalId, localId: locals[index] ?? null }))
          .filter((entry): entry is { globalId: string; localId: number } => entry.localId !== null);
        if (resolved.length === 0) continue;

        const requested = resolved.map((entry) => entry.localId);
        const data = await model.getItemsData(requested, PROPERTY_SET_CONFIG);
        const items = alignItems(requested, data);
        if (!items) {
          // Reporting one element's properties under another element's id is worse than returning
          // nothing, because nothing downstream can tell it happened.
          return err(
            new KernelError(
              "COMMAND_FAILED",
              `Model "${modelId}" returned ${data.length} records for ${requested.length} elements, and they cannot be matched to the elements that were asked for.`,
              { modelId },
            ),
          );
        }

        for (const entry of resolved) {
          const item = items.get(entry.localId);
          if (item === undefined) continue;
          results.push(
            toElementProperties({ modelId, globalId: entry.globalId, localId: entry.localId }, item),
          );
        }
      } catch (thrown) {
        return err(
          new KernelError("COMMAND_FAILED", "Failed to read properties.", { modelId }, { cause: thrown }),
        );
      }
    }

    return ok(results);
  }

  // Takes the contract's own parameter type so the two cannot drift apart.
  async find(query: PropertyQuery): Promise<Result<readonly ElementRef[]>> {
    const modelId = query.modelId;
    if (modelId === undefined) {
      return err(
        new KernelError(
          "COMMAND_FAILED",
          "Property search needs a model; searching every loaded model at once is the host's decision.",
          {},
        ),
      );
    }
    const model = this.#models(modelId);
    if (!model) return err(notLoaded(modelId));

    try {
      const localIds = await candidateIds(model, query.ifcClass);
      if (localIds.length === 0) return ok([]);

      const needsData = query.text !== undefined || query.property !== undefined;
      if (!needsData) return toRefs(model, modelId, localIds);

      // Read in chunks rather than one call over every candidate. An unfiltered text search on a
      // federated model would otherwise pull the entire property database across the worker
      // boundary into a single array before filtering any of it.
      const matched: number[] = [];
      for (let start = 0; start < localIds.length; start += SEARCH_CHUNK) {
        const chunk = localIds.slice(start, start + SEARCH_CHUNK);
        matched.push(...(await filterByData(model, chunk, query)));
        if (matched.length >= (query.limit ?? DEFAULT_SEARCH_LIMIT)) break;
      }

      return toRefs(model, modelId, matched.slice(0, query.limit ?? DEFAULT_SEARCH_LIMIT));
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "Property search failed.", { modelId }, { cause: thrown }),
      );
    }
  }
}

type PropertyQuery = Parameters<PropertyService["find"]>[0];

/** Candidates read per round trip. Bounds peak memory without making the search chatty. */
const SEARCH_CHUNK = 500;

/** Ceiling when the caller names none. A result set larger than this is a filter, not a search. */
const DEFAULT_SEARCH_LIMIT = 1000;

const notLoaded = (modelId: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `Model "${modelId}" is not loaded.`, { modelId });

/** Escapes a class name so a search for `IfcWall` cannot be read as a pattern. */
const exactCategory = (ifcClass: string): RegExp =>
  new RegExp(`^${ifcClass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

async function candidateIds(
  model: FragmentDataModel,
  ifcClass: string | undefined,
): Promise<readonly number[]> {
  if (ifcClass === undefined) {
    const categories = await model.getCategories();
    const all = await model.getItemsOfCategories(categories.map(exactCategory));
    return Object.values(all).flat();
  }
  const byCategory = await model.getItemsOfCategories([exactCategory(ifcClass)]);
  return Object.values(byCategory).flat();
}

async function filterByData(
  model: FragmentDataModel,
  localIds: readonly number[],
  query: {
    readonly text?: string;
    readonly property?: { readonly name: string; readonly value?: unknown };
  },
): Promise<readonly number[]> {
  const data = await model.getItemsData([...localIds], PROPERTY_SET_CONFIG);
  const items = alignItems(localIds, data);
  if (!items) {
    // A search that cannot trust which record belongs to which element returns nothing rather
    // than a plausible-looking list of the wrong elements.
    return [];
  }
  const needle = query.text?.toLowerCase();

  return localIds.filter((localId) => {
    const item = items.get(localId);
    if (!item) return false;

    if (needle !== undefined) {
      const name = stringAttribute(item, "Name")?.toLowerCase() ?? "";
      const description = stringAttribute(item, "Description")?.toLowerCase() ?? "";
      if (!name.includes(needle) && !description.includes(needle)) return false;
    }

    if (query.property !== undefined) {
      const found = findProperty(item, query.property.name);
      if (found === undefined) return false;
      // An unspecified value means "has this property at all", which is a genuinely different
      // question from "has it set to undefined".
      if (query.property.value !== undefined && found !== query.property.value) return false;
    }

    return true;
  });
}

function findProperty(item: FragmentItemData, name: string): unknown {
  for (const set of relationOf(item, "IsDefinedBy")) {
    for (const property of [...relationOf(set, "HasProperties"), ...relationOf(set, "Quantities")]) {
      if (stringAttribute(property, "Name") === name) return valueOf(property);
    }
  }
  return undefined;
}

async function toRefs(
  model: FragmentDataModel,
  modelId: Id,
  localIds: readonly number[],
): Promise<Result<readonly ElementRef[]>> {
  const guids = await model.getGuidsByLocalIds([...localIds]);
  const refs: ElementRef[] = [];
  guids.forEach((guid, index) => {
    const localId = localIds[index];
    // An element with no GlobalId cannot be referenced stably, so it is dropped rather than given
    // a made-up identity that looks valid until somebody re-issues the model.
    if (guid && localId !== undefined) refs.push({ modelId, globalId: guid, localId });
  });
  return ok(refs);
}

/** IFC wraps property values; a quantity carries its number under a type-specific key. */
const QUANTITY_KEYS = [
  "NominalValue",
  "AreaValue",
  "VolumeValue",
  "LengthValue",
  "CountValue",
  "WeightValue",
  "TimeValue",
] as const;

function valueOf(property: FragmentItemData): unknown {
  for (const key of QUANTITY_KEYS) {
    const value = attributeOf(property, key);
    if (value !== undefined) return value;
  }
  return attributeOf(property, "Value");
}

export function toElementProperties(
  element: ElementRef,
  item: FragmentItemData,
): ElementProperties {
  const attributes: Record<string, unknown> = {};
  for (const key of Object.keys(item)) {
    const value = attributeOf(item, key);
    if (value !== undefined) attributes[key] = value;
  }

  const propertySets: Record<string, Record<string, unknown>> = {};
  const quantities: Record<string, number> = {};

  for (const set of relationOf(item, "IsDefinedBy")) {
    const setName = stringAttribute(set, "Name") ?? "Unnamed";
    const values: Record<string, unknown> = propertySets[setName] ?? {};

    for (const property of relationOf(set, "HasProperties")) {
      const name = stringAttribute(property, "Name");
      if (name !== undefined) values[name] = valueOf(property);
    }

    // Quantities are hoisted into their own map as well as staying in their set: takeoff wants
    // them as numbers by name, and a property panel wants to show them where IFC put them.
    for (const quantity of relationOf(set, "Quantities")) {
      const name = stringAttribute(quantity, "Name");
      if (name === undefined) continue;
      const value = valueOf(quantity);
      values[name] = value;
      if (typeof value === "number" && Number.isFinite(value)) quantities[name] = value;
    }

    if (Object.keys(values).length > 0) propertySets[setName] = values;
  }

  const ifcClass = stringAttribute(item, "_category") ?? stringAttribute(item, "category");
  const name = stringAttribute(item, "Name");

  return {
    element,
    ...(ifcClass === undefined ? {} : { ifcClass }),
    ...(name === undefined ? {} : { name }),
    attributes,
    ...(Object.keys(propertySets).length === 0 ? {} : { propertySets }),
    ...(Object.keys(quantities).length === 0 ? {} : { quantities }),
  };
}
