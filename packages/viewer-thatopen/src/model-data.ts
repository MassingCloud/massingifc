import type * as FRAGS from "@thatopen/fragments";

import type { Id } from "@massingifc/project-schema";

/**
 * The slice of a fragments model that semantic services need.
 *
 * Declared structurally rather than imported as a class so the property and tree services can be
 * exercised without a WebGL context, a worker or a real `.frag` file. A real `FragmentsModel`
 * satisfies it as-is — nothing is adapted at the call site — while a test can hand over a plain
 * object and assert the part that decides correctness: that local ids become GlobalIds and that
 * the hierarchy comes out in the right shape.
 */
export interface FragmentDataModel {
  getSpatialStructure(): Promise<FragmentTreeItem>;
  getItemsData(ids: number[], config?: unknown): Promise<readonly FragmentItemData[]>;
  getGuidsByLocalIds(localIds: number[]): Promise<readonly (string | null)[]>;
  getLocalIdsByGuids(guids: string[]): Promise<readonly (number | null)[]>;
  getItemsOfCategories(categories: RegExp[]): Promise<Record<string, number[]>>;
  getCategories(): Promise<readonly string[]>;
}

export interface FragmentTreeItem {
  readonly category: string | null;
  readonly localId: number | null;
  readonly children?: readonly FragmentTreeItem[];
}

export interface FragmentAttribute {
  readonly value: unknown;
  readonly type?: string;
}

export interface FragmentItemData {
  readonly [name: string]: FragmentAttribute | readonly FragmentItemData[] | undefined;
}

/**
 * The local id an item reports for itself.
 *
 * Fragments stamps `_localId`, `_guid` and `_category` onto every item it returns, which means
 * results can be matched to requests by identity rather than by array position. That matters:
 * positional matching is correct only while the engine returns exactly one entry per id in order,
 * and when it stops doing so nothing fails — one element is simply reported with another's data.
 */
export function localIdOf(item: FragmentItemData): number | undefined {
  const value = attributeOf(item, "_localId");
  return typeof value === "number" ? value : undefined;
}

export function guidOf(item: FragmentItemData): string | undefined {
  return stringAttribute(item, "_guid");
}

/**
 * Matches returned item data back to the ids that were requested.
 *
 * Prefers each item's own `_localId`. Falls back to position only when nothing self-identifies and
 * the counts line up exactly — enough for a hand-written fake — and returns `undefined` rather than
 * guessing when neither holds, so the caller reports a failure instead of silently mispairing.
 */
export function alignItems(
  localIds: readonly number[],
  data: readonly FragmentItemData[],
): ReadonlyMap<number, FragmentItemData> | undefined {
  const byLocalId = new Map<number, FragmentItemData>();
  let selfIdentified = 0;

  for (const item of data) {
    const localId = localIdOf(item);
    if (localId !== undefined) {
      byLocalId.set(localId, item);
      selfIdentified++;
    }
  }

  if (selfIdentified > 0) return byLocalId;
  if (data.length !== localIds.length) return undefined;

  localIds.forEach((localId, index) => {
    const item = data[index];
    if (item !== undefined) byLocalId.set(localId, item);
  });
  return byLocalId;
}

/**
 * Narrows a real fragments model to the port.
 *
 * The cast is free at runtime; the point is the compiler. A hand-written port that tests satisfy
 * but the real API does not is worse than no port, because every test still passes while nothing
 * works — so this fails the build the day `FragmentsModel` changes shape under us.
 */
export function asDataModel(model: FRAGS.FragmentsModel): FragmentDataModel {
  return model;
}

/** Resolves a model by id. Kept a function so services do not each hold a `FragmentsManager`. */
export type FragmentModelSource = (modelId: Id) => FragmentDataModel | undefined;

const isAttribute = (value: unknown): value is FragmentAttribute =>
  typeof value === "object" && value !== null && "value" in value;

const isItemList = (value: unknown): value is readonly FragmentItemData[] => Array.isArray(value);

/** Reads a scalar attribute, ignoring relation arrays. */
export function attributeOf(item: FragmentItemData, name: string): unknown {
  const entry = item[name];
  return isAttribute(entry) ? entry.value : undefined;
}

export function stringAttribute(item: FragmentItemData, name: string): string | undefined {
  const value = attributeOf(item, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function relationOf(item: FragmentItemData, name: string): readonly FragmentItemData[] {
  const entry = item[name];
  return isItemList(entry) ? entry : [];
}

/**
 * Requests attributes plus the property-set relation.
 *
 * `IsDefinedBy` is the IFC route from an element to its property sets and element quantities.
 * `DefinesOccurrence` is switched off deliberately: it walks back from the type to every occurrence
 * that shares it, which on a real model means re-reading most of the file to answer a question
 * about one wall.
 */
export const PROPERTY_SET_CONFIG = {
  attributesDefault: true,
  relations: {
    IsDefinedBy: { attributes: true, relations: true },
    DefinesOccurrence: { attributes: false, relations: false },
  },
} as const;
