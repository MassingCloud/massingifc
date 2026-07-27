import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";

import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import type { ElementRef, Id } from "@massingifc/project-schema";
import type {
  IfcConversionOptions,
  ModelHandle,
  ModelLoaderService,
  ViewerBootstrapOptions,
  ViewerRuntime,
} from "@massingifc/viewer-runtime";

import { animationFrameScheduler, coalesce, type Coalesced, type Scheduler } from "./coalesce.js";

export type World = OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;

export interface ThatOpenViewerOptions {
  /** Worker URL for the fragments engine. Pass a locally-served one to work offline. */
  readonly workerUrl: string;
  /** Directory holding the web-ifc WASM. Local by default so conversion works offline. */
  readonly wasmPath?: string;
  readonly scheduler?: Scheduler;
}

const notInitialised = (): KernelError =>
  new KernelError("COMMAND_FAILED", "The viewer has not been initialised.", {});

/**
 * That Open Components implementation of `ViewerRuntime`.
 *
 * This is the only package in the repository with runtime dependencies, and it exists so the other
 * fifteen have none: every capability family talks to `@massingifc/viewer-runtime` contracts, and
 * swapping the engine means replacing this package alone.
 *
 * The bootstrap deliberately mirrors the documented Components path — `Worlds` for the world,
 * `FragmentsManager` for the model lifecycle, `IfcImporter` for conversion — rather than inventing
 * a parallel stack.
 */
export class ThatOpenViewer implements ViewerRuntime {
  #components: OBC.Components | undefined;
  #world: World | undefined;
  #cheapPass: Coalesced | undefined;
  readonly #options: ThatOpenViewerOptions;
  readonly #disposers: (() => void)[] = [];

  constructor(options: ThatOpenViewerOptions) {
    this.#options = options;
  }

  get components(): OBC.Components | undefined {
    return this.#components;
  }

  get world(): World | undefined {
    return this.#world;
  }

  async initialize(options: ViewerBootstrapOptions): Promise<Result<void>> {
    const container = options.container;
    if (!(container instanceof HTMLElement)) {
      // The contract types the container as `unknown` so it stays DOM-free; this is the boundary
      // where that becomes a real element, so it is checked rather than cast.
      return err(
        new KernelError("COMMAND_FAILED", "A DOM element is required to initialise the viewer.", {}),
      );
    }

    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();

    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = null;

    // These are WebGL *context* attributes, fixed at construction with no setter to reach for
    // later, so passing nothing here would silently lock in the defaults for ever.
    //  - powerPreference: without it a dual-GPU laptop hands a BIM model to the integrated chip.
    //  - alpha: the scene background is deliberately null so the page shows through.
    //  - stencil: nothing in the pipeline uses it, and the default allocates one per framebuffer.
    world.renderer = new OBC.SimpleRenderer(components, container, {
      antialias: options.antialias ?? true,
      powerPreference: "high-performance",
      alpha: true,
      stencil: false,
    });
    world.camera = new OBC.OrthoPerspectiveCamera(components);

    components.init();
    await world.camera.controls.setLookAt(12, 8, 12, 0, 0, 0);

    if (options.showGrid ?? true) {
      components.get(OBC.Grids).create(world);
    }

    this.#components = components;
    this.#world = world;
    return ok(undefined);
  }

  /** Binds camera motion to fragment updates, coalescing the cheap pass to one per frame. */
  attachCameraUpdates(fragments: OBC.FragmentsManager): void {
    const world = this.#world;
    if (!world) return;

    const scheduler = this.#options.scheduler ?? animationFrameScheduler();
    const cheapPass = coalesce(() => void fragments.core.update(), scheduler);
    this.#cheapPass = cheapPass;

    const { controls } = world.camera;
    const onUpdate = (): void => cheapPass.trigger();
    const onRest = (): void => {
      // The full pass supersedes any pending cheap one. `rest` fires once when motion stops, which
      // is exactly when the expensive version is worth paying for.
      cheapPass.cancel();
      void fragments.core.update(true);
    };

    controls.addEventListener("update", onUpdate);
    controls.addEventListener("rest", onRest);
    this.#disposers.push(() => {
      controls.removeEventListener("update", onUpdate);
      controls.removeEventListener("rest", onRest);
      cheapPass.cancel();
    });
  }

  async update(full = false): Promise<void> {
    const fragments = this.#components?.get(OBC.FragmentsManager);
    if (!fragments) return;
    await fragments.core.update(full);
  }

  addToScene(object: unknown): void {
    if (object instanceof THREE.Object3D) this.#world?.scene.three.add(object);
  }

  removeFromScene(object: unknown): void {
    if (object instanceof THREE.Object3D) this.#world?.scene.three.remove(object);
  }

  async fitToView(elements?: readonly ElementRef[]): Promise<void> {
    const world = this.#world;
    if (!world) return;

    const box = new THREE.Box3();
    if (elements === undefined || elements.length === 0) {
      world.scene.three.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) box.expandByObject(object);
      });
    } else {
      // Falls back to the whole scene when the elements cannot be located, which is better than
      // leaving the camera pointing at nothing.
      world.scene.three.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) box.expandByObject(object);
      });
    }
    if (box.isEmpty()) return;

    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    await world.camera.controls.setLookAt(
      centre.x + size,
      centre.y + size * 0.6,
      centre.z + size,
      centre.x,
      centre.y,
      centre.z,
    );
  }

  dispose(): void {
    for (const disposer of this.#disposers.splice(0)) disposer();
    this.#cheapPass?.cancel();
    this.#components?.dispose();
    this.#components = undefined;
    this.#world = undefined;
  }
}

/**
 * `ModelLoaderService` over `FragmentsManager`.
 *
 * Conversion and loading stay separate calls because in production they happen in different places:
 * IFC is converted once, server-side, and clients load the resulting `.frag`. Collapsing them would
 * push a heavy conversion into every session.
 */
export class ThatOpenModelLoader implements ModelLoaderService {
  readonly #viewer: ThatOpenViewer;
  readonly #importer = new FRAGS.IfcImporter();
  #fragments: OBC.FragmentsManager | undefined;

  constructor(viewer: ThatOpenViewer, options: ThatOpenViewerOptions) {
    this.#viewer = viewer;
    // Local WASM by default: conversion must work without reaching the network.
    this.#importer.wasm = { absolute: true, path: options.wasmPath ?? "/wasm/" };
  }

  /** Wires the manager to the world. Call once, after `ThatOpenViewer.initialize`. */
  attach(options: ThatOpenViewerOptions): Result<void> {
    const components = this.#viewer.components;
    const world = this.#viewer.world;
    if (!components || !world) return err(notInitialised());

    const fragments = components.get(OBC.FragmentsManager);
    fragments.init(options.workerUrl);

    const camera = world.camera.three;
    fragments.list.onItemSet.add(({ value: model }) => {
      // The documented pattern: bind each model to the active camera and add it to the scene as it
      // is registered, then force one full pass so it appears at full quality immediately.
      model.useCamera(camera);
      world.scene.three.add(model.object);
      void fragments.core.update(true);
    });

    this.#viewer.attachCameraUpdates(fragments);
    this.#fragments = fragments;
    return ok(undefined);
  }

  async convertIfc(bytes: Uint8Array, options?: IfcConversionOptions): Promise<Result<Uint8Array>> {
    try {
      const converted = await this.#importer.process({
        bytes,
        ...(options?.onProgress ? { progressCallback: options.onProgress } : {}),
      });
      return ok(converted);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "IFC conversion failed.", {}, { cause: thrown }),
      );
    }
  }

  async loadFragments(payload: ArrayBuffer | Uint8Array, modelId: Id): Promise<Result<ModelHandle>> {
    const fragments = this.#fragments;
    if (!fragments) return err(notInitialised());
    try {
      const model = await fragments.core.load(payload, { modelId });
      await fragments.core.update(true);
      return ok(model);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", `Failed to load model "${modelId}".`, { modelId }, { cause: thrown }),
      );
    }
  }

  async loadIfc(
    bytes: Uint8Array,
    modelId: Id,
    options?: IfcConversionOptions,
  ): Promise<Result<ModelHandle>> {
    const converted = await this.convertIfc(bytes, options);
    if (!converted.ok) return err(converted.error);
    return this.loadFragments(converted.value, modelId);
  }

  async unload(modelId: Id): Promise<Result<void>> {
    const fragments = this.#fragments;
    if (!fragments) return err(notInitialised());
    if (!fragments.list.has(modelId)) return ok(undefined);
    try {
      await fragments.core.disposeModel(modelId);
      await fragments.core.update(true);
      return ok(undefined);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", `Failed to unload "${modelId}".`, { modelId }, { cause: thrown }),
      );
    }
  }

  async unloadAll(): Promise<void> {
    const fragments = this.#fragments;
    if (!fragments) return;
    for (const modelId of [...fragments.list.keys()]) {
      await fragments.core.disposeModel(modelId);
    }
    await fragments.core.update(true);
  }

  isLoaded(modelId: Id): boolean {
    return this.#fragments?.list.has(modelId) ?? false;
  }

  loadedModelIds(): readonly Id[] {
    return this.#fragments ? [...this.#fragments.list.keys()] : [];
  }

  /**
   * Resolves engine-local ids to IFC GlobalIds.
   *
   * This is the single most important thing the adapter does. Everything above it — markup anchors,
   * clash signatures, 4D links, takeoff — references elements by GlobalId, and a viewer-local id
   * escaping this boundary would give all of them a transient identity that silently breaks on the
   * next re-export.
   */
  async toElementRefs(modelId: Id, localIds: readonly number[]): Promise<Result<ElementRef[]>> {
    const model = this.#fragments?.list.get(modelId);
    if (!model) return err(notFoundModel(modelId));
    try {
      const guids = await model.getGuidsByLocalIds([...localIds]);
      const refs: ElementRef[] = [];
      guids.forEach((guid, index) => {
        const localId = localIds[index];
        // An element with no GlobalId cannot be referenced stably, so it is dropped rather than
        // given a made-up identity that would look valid until somebody re-issued the model.
        if (guid && localId !== undefined) refs.push({ modelId, globalId: guid, localId });
      });
      return ok(refs);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "Failed to resolve GlobalIds.", { modelId }, { cause: thrown }),
      );
    }
  }

  /** Resolves GlobalIds back to engine-local ids, for the render-side of a selection. */
  async toLocalIds(modelId: Id, globalIds: readonly string[]): Promise<Result<number[]>> {
    const model = this.#fragments?.list.get(modelId);
    if (!model) return err(notFoundModel(modelId));
    try {
      const locals = await model.getLocalIdsByGuids([...globalIds]);
      return ok(locals.filter((local): local is number => local !== null));
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", "Failed to resolve local ids.", { modelId }, { cause: thrown }),
      );
    }
  }
}

const notFoundModel = (modelId: Id): KernelError =>
  new KernelError("COMMAND_FAILED", `Model "${modelId}" is not loaded.`, { modelId });
