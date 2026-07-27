import { isMeasurable, type TwinObjectRecord } from "@massingifc/project-schema";
import type { SceneRealityLayer } from "./contracts.js";

/**
 * Maps a twin record into a scene reality layer.
 *
 * Exists so nobody hand-writes this mapping, because the field they would get wrong is
 * `measurable`. That flag is what stops an engine offering a dimension tool over a radiance field,
 * and the rule behind it lives on the schema — reading it here means the export, the promotion
 * gate and any measurement tool cannot drift apart.
 */
export function toRealityLayer(
  record: TwinObjectRecord,
  options: { readonly payloadId?: string } = {},
): SceneRealityLayer {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    measurable: isMeasurable(record),
    ...(options.payloadId === undefined ? {} : { payloadId: options.payloadId }),
    ...(record.sourceUri === undefined ? {} : { sourceUri: record.sourceUri }),
    ...(record.transform.length === 0 ? {} : { transform: record.transform }),
    ...(record.geoReference === undefined ? {} : { geoReference: record.geoReference }),
  };
}

/**
 * Maps many, keeping only what an engine can actually show.
 *
 * A record with neither a payload nor a source URI has nothing to render, and a layer the consumer
 * cannot resolve is worse than an absent one — it appears in the scene tree and never loads.
 */
export function toRealityLayers(
  records: readonly TwinObjectRecord[],
  payloadIds: ReadonlyMap<string, string> = new Map(),
): readonly SceneRealityLayer[] {
  return records
    .map((record) => {
      const payloadId = payloadIds.get(record.id);
      return toRealityLayer(record, { ...(payloadId === undefined ? {} : { payloadId }) });
    })
    .filter((layer) => layer.payloadId !== undefined || layer.sourceUri !== undefined);
}
