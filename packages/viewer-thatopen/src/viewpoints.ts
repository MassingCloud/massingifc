import { err, KernelError, ok, type Result } from "@massingifc/core-kernel";
import type { Id, IsoTimestamp, SavedViewpoint, Vec3 } from "@massingifc/project-schema";
import type { ViewpointService } from "@massingifc/viewer-runtime";
import type { ThatOpenSectioning } from "./sectioning.js";
import type { ThatOpenVisibility } from "./visibility.js";

/**
 * Saved views.
 *
 * A viewpoint is not just a camera. Sharing "look at this" is useless if the recipient sees the
 * whole model when the sender had everything but the ductwork hidden, so the visibility overrides
 * and section planes are captured with it and restored with it. That is also why `SavedViewpoint`
 * carries `hidden`, `isolated` and `sectionPlanes` — this is the service that fills them in.
 */

/**
 * The camera, as a port.
 *
 * Narrow on purpose: position, target and projection are the whole of what a viewpoint needs, and
 * depending on `OrthoPerspectiveCamera` here would make every test require a real world.
 */
export interface CameraPort {
  getPosition(): Vec3;
  getTarget(): Vec3;
  setLookAt(position: Vec3, target: Vec3, animate: boolean): Promise<void>;
  getProjection?(): "perspective" | "orthographic";
  setProjection?(projection: "perspective" | "orthographic"): void;
}

export interface ThatOpenViewpointsOptions {
  readonly camera: CameraPort;
  readonly now: () => IsoTimestamp;
  readonly ids?: () => Id;
  /** Captured and restored alongside the camera when supplied. */
  readonly visibility?: ThatOpenVisibility;
  readonly sectioning?: ThatOpenSectioning;
}

export class ThatOpenViewpoints implements ViewpointService {
  readonly #options: ThatOpenViewpointsOptions;
  readonly #saved = new Map<Id, SavedViewpoint>();
  readonly #nextId: () => Id;
  #counter = 0;

  constructor(options: ThatOpenViewpointsOptions) {
    this.#options = options;
    this.#nextId = options.ids ?? (() => `viewpoint-${++this.#counter}`);
  }

  async capture(name?: string): Promise<Result<SavedViewpoint>> {
    try {
      const hidden = this.#options.visibility?.hiddenElements() ?? [];
      const planes = this.#options.sectioning
        ?.list()
        .filter((plane) => plane.enabled)
        .map((plane) => ({ normal: plane.normal, constant: plane.constant }));
      const projection = this.#options.camera.getProjection?.();

      const viewpoint: SavedViewpoint = {
        id: this.#nextId(),
        ...(name === undefined ? {} : { name }),
        position: this.#options.camera.getPosition(),
        target: this.#options.camera.getTarget(),
        ...(projection === undefined ? {} : { projection }),
        ...(hidden.length === 0 ? {} : { hidden: [...hidden] }),
        ...(planes === undefined || planes.length === 0 ? {} : { sectionPlanes: planes }),
        createdAt: this.#options.now(),
      };

      this.#saved.set(viewpoint.id, viewpoint);
      return ok(viewpoint);
    } catch (thrown) {
      return err(new KernelError("COMMAND_FAILED", "Failed to capture the viewpoint.", {}, { cause: thrown }));
    }
  }

  async apply(viewpoint: SavedViewpoint, animate = false): Promise<Result<void>> {
    try {
      // Scene state is restored before the camera move. Doing it after means the animation plays
      // against the old visibility and the model visibly re-shuffles when it lands.
      const visibility = this.#options.visibility;
      if (visibility) {
        visibility.showAll();
        if (viewpoint.isolated && viewpoint.isolated.length > 0) {
          visibility.isolate(viewpoint.isolated);
        } else if (viewpoint.hidden && viewpoint.hidden.length > 0) {
          visibility.hide(viewpoint.hidden);
        }
        await visibility.settled();
      }

      this.#options.sectioning?.restore(viewpoint.sectionPlanes ?? []);

      if (viewpoint.projection !== undefined) {
        this.#options.camera.setProjection?.(viewpoint.projection);
      }
      await this.#options.camera.setLookAt(viewpoint.position, viewpoint.target, animate);

      // Applying a viewpoint that arrived from elsewhere — a shared issue, an imported BCF — makes
      // it available to `list` without a separate save step.
      if (!this.#saved.has(viewpoint.id)) this.#saved.set(viewpoint.id, viewpoint);
      return ok(undefined);
    } catch (thrown) {
      return err(
        new KernelError("COMMAND_FAILED", `Failed to apply viewpoint "${viewpoint.id}".`, { id: viewpoint.id }, { cause: thrown }),
      );
    }
  }

  list(): readonly SavedViewpoint[] {
    return [...this.#saved.values()];
  }

  async remove(viewpointId: Id): Promise<Result<void>> {
    if (!this.#saved.delete(viewpointId)) {
      return err(
        new KernelError("COMMAND_FAILED", `No viewpoint with id "${viewpointId}".`, { viewpointId }),
      );
    }
    return ok(undefined);
  }
}
