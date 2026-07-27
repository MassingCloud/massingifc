import type {
  SceneNode,
  ScenePackage,
  ScenePropertySet,
  SceneRelationship,
} from "./contracts.js";

/**
 * Reference semantics for the queries an engine runtime needs.
 *
 * The point of shipping these in TypeScript is not that an Unreal or Unity importer will call
 * them — it will not, it will reimplement them natively. The point is that the meaning of
 * "children of", "on this level", "related to" is defined once, here, with tests behind it, so
 * every native implementation has something to agree with instead of a prose description.
 */
export interface SceneQuery {
  node(globalId: string): SceneNode | undefined;
  byClass(ifcClass: string): readonly SceneNode[];
  byLevel(levelGlobalId: string): readonly SceneNode[];
  children(globalId: string): readonly SceneNode[];
  /** Ancestors nearest-first, stopping at the package boundary. */
  ancestors(globalId: string): readonly SceneNode[];
  properties(globalId: string): readonly ScenePropertySet[];
  /** Reads a single property, searching all sets when no set name is given. */
  property(globalId: string, name: string, setName?: string): string | number | boolean | null | undefined;
  relationships(globalId: string, type?: string): readonly SceneRelationship[];
  classes(): readonly string[];
  levels(): readonly string[];
}

export function createSceneQuery(scene: ScenePackage): SceneQuery {
  // Children and relationships are derived once per query object rather than stored in the
  // manifest: they are exactly recoverable from the parent links and the edge list, and a second
  // copy in the file is a second thing that can disagree with the first.
  const childrenByParent = new Map<string, SceneNode[]>();
  for (const node of scene.nodes) {
    if (node.parentGlobalId === undefined) continue;
    const bucket = childrenByParent.get(node.parentGlobalId);
    if (bucket) bucket.push(node);
    else childrenByParent.set(node.parentGlobalId, [node]);
  }

  const edgesByNode = new Map<string, SceneRelationship[]>();
  for (const relationship of scene.relationships ?? []) {
    for (const globalId of [relationship.fromGlobalId, relationship.toGlobalId]) {
      const bucket = edgesByNode.get(globalId);
      if (bucket) bucket.push(relationship);
      else edgesByNode.set(globalId, [relationship]);
    }
  }

  const nodeAt = (position: number | undefined): SceneNode | undefined =>
    position === undefined ? undefined : scene.nodes[position];

  const resolve = (positions: readonly number[] | undefined): readonly SceneNode[] =>
    (positions ?? []).map((position) => nodeAt(position)).filter((node): node is SceneNode => node !== undefined);

  const node = (globalId: string): SceneNode | undefined => nodeAt(scene.index.byGlobalId[globalId]);

  return {
    node,
    byClass: (ifcClass) => resolve(scene.index.byClass[ifcClass]),
    byLevel: (levelGlobalId) => resolve(scene.index.byLevel[levelGlobalId]),
    children: (globalId) => childrenByParent.get(globalId) ?? [],

    ancestors(globalId) {
      const chain: SceneNode[] = [];
      const visited = new Set<string>([globalId]);
      let current = node(globalId)?.parentGlobalId;
      while (current !== undefined && !visited.has(current)) {
        // Cycles should not occur in a spatial tree, but a malformed export must produce a short
        // list rather than hang the importer that trusted it.
        visited.add(current);
        const parent = node(current);
        if (!parent) break;
        chain.push(parent);
        current = parent.parentGlobalId;
      }
      return chain;
    },

    properties: (globalId) => scene.properties?.[globalId] ?? [],

    property(globalId, name, setName) {
      const sets = scene.properties?.[globalId] ?? [];
      for (const set of sets) {
        if (setName !== undefined && set.name !== setName) continue;
        if (name in set.properties) return set.properties[name];
      }
      return undefined;
    },

    relationships(globalId, type) {
      const edges = edgesByNode.get(globalId) ?? [];
      return type === undefined ? edges : edges.filter((edge) => edge.type === type);
    },

    classes: () => Object.keys(scene.index.byClass).sort(),
    levels: () => Object.keys(scene.index.byLevel).sort(),
  };
}
