/**
 * `@massingifc/viewer-runtime` — contracts for the model runtime.
 *
 * Interfaces only, and deliberately free of any `three` or `@thatopen/*` import. The concrete
 * implementation is expected to sit on That Open Components (`IfcImporter`/`IfcLoader` for
 * conversion, `FragmentsManager` for the model lifecycle), but the *contract* must not name it:
 * the kernel and every downstream plugin should survive an engine upgrade, and a viewer type
 * leaking into the 5D package would make that impossible.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type { ElementRef, Id, ModelRecord, SavedViewpoint, Vec3 } from "@massingifc/project-schema";

/** Opaque handle to the host's 3D scene graph node. Narrowed by the implementation. */
export type SceneObject = unknown;

/** Opaque handle to a loaded fragments model. */
export type ModelHandle = unknown;

export interface ViewerBootstrapOptions {
  /** Host surface the renderer attaches to. Typed by the shell, not by this contract. */
  readonly container: unknown;
  readonly antialias?: boolean;
  readonly showGrid?: boolean;
}

/**
 * Owns the world, scene, camera and renderer.
 *
 * `update` exists because fragment-based rendering is camera-driven: the runtime streams and
 * culls against the active camera, so something must tell it the view changed. Exposing it keeps
 * the coalescing policy (per animation frame while moving, full quality at rest) with the
 * implementation rather than forcing every caller to rediscover it.
 */
export interface ViewerRuntime {
  initialize(options: ViewerBootstrapOptions): Promise<Result<void>>;
  /** Request a refresh. `full` trades cost for quality and belongs at camera rest. */
  update(full?: boolean): Promise<void>;
  addToScene(object: SceneObject): void;
  removeFromScene(object: SceneObject): void;
  fitToView(elements?: readonly ElementRef[]): Promise<void>;
  dispose(): void;
}

export const ViewerRuntimeToken = createCapabilityToken<ViewerRuntime>("viewer.runtime");

export interface IfcConversionOptions {
  /** Location of the web-ifc WASM. Local by default — conversion must work offline. */
  readonly wasmPath?: string;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * IFC-to-fragments conversion and fragments loading.
 *
 * Conversion and loading are separate calls because in production they happen in different places
 * and at different times: IFC is converted once, server-side, and the resulting `.frag` payload is
 * what clients actually load. Collapsing them would push a heavy conversion into every session.
 */
export interface ModelLoaderService {
  convertIfc(bytes: Uint8Array, options?: IfcConversionOptions): Promise<Result<Uint8Array>>;
  loadFragments(payload: ArrayBuffer | Uint8Array, modelId: Id): Promise<Result<ModelHandle>>;
  /** Convenience path for small files: convert in-browser, then load. */
  loadIfc(bytes: Uint8Array, modelId: Id, options?: IfcConversionOptions): Promise<Result<ModelHandle>>;
  unload(modelId: Id): Promise<Result<void>>;
  unloadAll(): Promise<void>;
  isLoaded(modelId: Id): boolean;
  loadedModelIds(): readonly Id[];
}

export const ModelLoaderToken = createCapabilityToken<ModelLoaderService>("viewer.loader");

export interface SelectionService {
  get(): readonly ElementRef[];
  set(elements: readonly ElementRef[]): void;
  add(elements: readonly ElementRef[]): void;
  clear(): void;
  /** Named, reusable selection — the basis for clash sets and 4D task links. */
  saveSet(name: string, elements: readonly ElementRef[]): Id;
  restoreSet(setId: Id): readonly ElementRef[];
}

export const SelectionToken = createCapabilityToken<SelectionService>("viewer.selection");

export interface VisibilityService {
  hide(elements: readonly ElementRef[]): void;
  show(elements: readonly ElementRef[]): void;
  isolate(elements: readonly ElementRef[]): void;
  showAll(): void;
  setColor(elements: readonly ElementRef[], color: string, opacity?: number): void;
  /** Drops every override applied by this service, leaving authored appearance intact. */
  resetOverrides(): void;
  hiddenElements(): readonly ElementRef[];
}

export const VisibilityToken = createCapabilityToken<VisibilityService>("viewer.visibility");

export interface ElementProperties {
  readonly element: ElementRef;
  readonly ifcClass?: string;
  readonly name?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly propertySets?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly quantities?: Readonly<Record<string, number>>;
}

export interface PropertyService {
  get(element: ElementRef): Promise<Result<ElementProperties>>;
  getMany(elements: readonly ElementRef[]): Promise<Result<readonly ElementProperties[]>>;
  /** Property-value search across loaded models, used by the tree and search panels. */
  find(query: {
    readonly modelId?: Id;
    readonly ifcClass?: string;
    readonly text?: string;
    readonly property?: { readonly name: string; readonly value?: unknown };
  }): Promise<Result<readonly ElementRef[]>>;
}

export const PropertyToken = createCapabilityToken<PropertyService>("viewer.properties");

export interface SpatialTreeNode {
  readonly id: string;
  readonly label: string;
  readonly ifcClass?: string;
  readonly element?: ElementRef;
  readonly children: readonly SpatialTreeNode[];
}

export interface SpatialTreeService {
  build(modelId: Id): Promise<Result<SpatialTreeNode>>;
  /** Federated tree across every loaded model, grouped by the host's chosen strategy. */
  buildFederated(): Promise<Result<readonly SpatialTreeNode[]>>;
}

export const SpatialTreeToken = createCapabilityToken<SpatialTreeService>("viewer.tree");

export interface ViewpointService {
  capture(name?: string): Promise<Result<SavedViewpoint>>;
  apply(viewpoint: SavedViewpoint, animate?: boolean): Promise<Result<void>>;
  list(): readonly SavedViewpoint[];
  remove(viewpointId: Id): Promise<Result<void>>;
}

export const ViewpointToken = createCapabilityToken<ViewpointService>("viewer.viewpoints");

export interface SectionPlane {
  readonly id: Id;
  readonly normal: Vec3;
  readonly constant: number;
  readonly enabled: boolean;
}

export interface SectioningService {
  create(normal: Vec3, point: Vec3): SectionPlane;
  update(planeId: Id, changes: Partial<Pick<SectionPlane, "constant" | "enabled">>): void;
  remove(planeId: Id): void;
  list(): readonly SectionPlane[];
  clear(): void;
}

export const SectioningToken = createCapabilityToken<SectioningService>("viewer.sectioning");

/** Events the runtime publishes. Consumed by markup, coordination, 4D and 5D plugins alike. */
export interface ViewerEvents {
  "viewer.model.loaded": { readonly modelId: Id; readonly record?: ModelRecord };
  "viewer.model.unloaded": { readonly modelId: Id };
  "viewer.selection.changed": { readonly elements: readonly ElementRef[] };
  "viewer.hover.changed": { readonly element: ElementRef | undefined };
  "viewer.camera.rest": Record<string, never>;
  "viewer.visibility.changed": { readonly hidden: readonly ElementRef[] };
}

export const VIEWER_COMMANDS = {
  loadModel: "viewer.model.load",
  unloadModel: "viewer.model.unload",
  fitToSelection: "viewer.camera.fit-selection",
  isolateSelection: "viewer.visibility.isolate-selection",
  showAll: "viewer.visibility.show-all",
  captureViewpoint: "viewer.viewpoint.capture",
} as const;
