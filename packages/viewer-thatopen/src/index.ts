/**
 * `@massingifc/viewer-thatopen` — That Open Components adapter.
 *
 * The **only** package here with runtime dependencies, which is precisely why the other fifteen
 * have none. Every capability family binds to `@massingifc/viewer-runtime` contracts; replacing the
 * engine means replacing this package and nothing else.
 */
export {
  animationFrameScheduler,
  coalesce,
  nextPixelRatio,
  type Coalesced,
  type Scheduler,
} from "./coalesce.js";
export { ThatOpenSelection } from "./selection.js";
export {
  ThatOpenModelLoader,
  ThatOpenViewer,
  type ThatOpenViewerOptions,
  type World,
} from "./viewer.js";
