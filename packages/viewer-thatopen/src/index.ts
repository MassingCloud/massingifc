/**
 * `@massingifc/viewer-thatopen` — That Open Components adapter.
 *
 * The **only** package here with runtime dependencies, which is precisely why the other seventeen
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
  asDataModel,
  attributeOf,
  relationOf,
  stringAttribute,
  PROPERTY_SET_CONFIG,
  type FragmentAttribute,
  type FragmentDataModel,
  type FragmentItemData,
  type FragmentModelSource,
  type FragmentTreeItem,
} from "./model-data.js";
export { ThatOpenProperties, toElementProperties } from "./properties.js";
export { ThatOpenSpatialTree, type ThatOpenSpatialTreeOptions } from "./tree.js";
export {
  ThatOpenModelLoader,
  ThatOpenViewer,
  type ThatOpenViewerOptions,
  type World,
} from "./viewer.js";
