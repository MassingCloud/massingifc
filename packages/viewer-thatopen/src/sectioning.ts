import type { Id, Vec3 } from "@massingifc/project-schema";
import type { SectionPlane, SectioningService } from "@massingifc/viewer-runtime";

/**
 * Section planes.
 *
 * A plane is stored as normal plus signed distance from the origin, which is what both `THREE.Plane`
 * and the fragments clipper want, and what `SavedViewpoint` persists — so a section survives a
 * viewpoint round trip without a lossy conversion in the middle.
 */

/**
 * Where enabled planes are pushed.
 *
 * A port rather than a `THREE.WebGLRenderer` so the bookkeeping — which planes exist, which are on,
 * what happens on update — is testable without a graphics context. The host wires the renderer's
 * `clippingPlanes` to it in one line.
 */
export interface ClippingSink {
  setPlanes(planes: readonly { readonly normal: Vec3; readonly constant: number }[]): void;
}

export interface ThatOpenSectioningOptions {
  readonly sink: ClippingSink;
  readonly ids?: () => Id;
}

/** Signed distance from the origin along the normal, for a plane through `point`. */
export function planeConstant(normal: Vec3, point: Vec3): number {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length === 0) return 0;
  const unit = [normal[0] / length, normal[1] / length, normal[2] / length] as const;
  // Negated to match the `ax + by + cz + d = 0` form three.js uses, where `d` is the constant.
  return -(unit[0] * point[0] + unit[1] * point[1] + unit[2] * point[2]);
}

export function normalise(normal: Vec3): Vec3 {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  // A zero normal has no direction to clip along; +Z keeps the plane well-formed rather than
  // producing NaNs that turn the whole scene invisible.
  if (length === 0) return [0, 0, 1];
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

export class ThatOpenSectioning implements SectioningService {
  readonly #sink: ClippingSink;
  readonly #planes = new Map<Id, SectionPlane>();
  readonly #nextId: () => Id;
  #counter = 0;

  constructor(options: ThatOpenSectioningOptions) {
    this.#sink = options.sink;
    this.#nextId = options.ids ?? (() => `section-${++this.#counter}`);
  }

  create(normal: Vec3, point: Vec3): SectionPlane {
    const plane: SectionPlane = {
      id: this.#nextId(),
      normal: normalise(normal),
      constant: planeConstant(normal, point),
      enabled: true,
    };
    this.#planes.set(plane.id, plane);
    this.#push();
    return plane;
  }

  update(planeId: Id, changes: Partial<Pick<SectionPlane, "constant" | "enabled">>): void {
    const existing = this.#planes.get(planeId);
    if (!existing) return;
    this.#planes.set(planeId, {
      ...existing,
      ...(changes.constant === undefined ? {} : { constant: changes.constant }),
      ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
    });
    this.#push();
  }

  remove(planeId: Id): void {
    if (this.#planes.delete(planeId)) this.#push();
  }

  list(): readonly SectionPlane[] {
    return [...this.#planes.values()];
  }

  clear(): void {
    if (this.#planes.size === 0) return;
    this.#planes.clear();
    this.#push();
  }

  /** Restores a set of planes captured with a viewpoint, replacing whatever is active. */
  restore(planes: readonly { readonly normal: Vec3; readonly constant: number }[]): void {
    this.#planes.clear();
    for (const plane of planes) {
      const id = this.#nextId();
      this.#planes.set(id, {
        id,
        normal: normalise(plane.normal),
        constant: plane.constant,
        enabled: true,
      });
    }
    this.#push();
  }

  #push(): void {
    // Only enabled planes reach the renderer. A disabled plane stays in the list so a UI can offer
    // it back, but leaving it in the clipping set would keep cutting the model.
    this.#sink.setPlanes(
      [...this.#planes.values()]
        .filter((plane) => plane.enabled)
        .map((plane) => ({ normal: plane.normal, constant: plane.constant })),
    );
  }
}
