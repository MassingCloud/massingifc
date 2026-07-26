/**
 * `@massingifc/massing` — the first authoring vertical.
 *
 * Massing is where conceptual design actually happens: a sketched footprint, a story count, and a
 * fast read on area and volume. The contract is built around that loop rather than around generic
 * solid modelling, because story-awareness is what separates a massing tool from an extruder — a
 * mass whose stories are implicit cannot answer "what is the GFA if I add two floors?", which is
 * the question the tool exists to answer.
 */

import { createCapabilityToken, type Result } from "@massingifc/core-kernel";
import type {
  GridLineRecord,
  Id,
  LevelRecord,
  MassingMetrics,
  MassingObjectRecord,
  MassingStoryRecord,
  OptionSetRecord,
  ProfileRecord,
  SiteBoundaryRecord,
  Vec3,
} from "@massingifc/project-schema";

export interface CreateMassingInput {
  readonly name: string;
  readonly profileId: Id;
  readonly storyCount: number;
  /** Uniform height applied to every story when `storyHeights` is not supplied. */
  readonly storyHeight?: number;
  readonly storyHeights?: readonly number[];
  readonly color?: string;
  readonly opacity?: number;
  readonly optionSetId?: Id;
  readonly familyTemplateId?: Id;
}

export interface ProfileService {
  create(points: readonly Vec3[], options?: { name?: string; baseElevation?: number }): Promise<Result<ProfileRecord>>;
  update(profileId: Id, points: readonly Vec3[]): Promise<Result<ProfileRecord>>;
  addHole(profileId: Id, points: readonly Vec3[]): Promise<Result<ProfileRecord>>;
  /** Rejects self-intersecting or degenerate outlines before they reach geometry generation. */
  validate(points: readonly Vec3[]): Result<void>;
  get(profileId: Id): ProfileRecord | undefined;
  list(): readonly ProfileRecord[];
}

export const ProfileToken = createCapabilityToken<ProfileService>("massing.profiles");

export interface MassingService {
  create(input: CreateMassingInput): Promise<Result<MassingObjectRecord>>;
  update(id: Id, changes: Partial<MassingObjectRecord>): Promise<Result<MassingObjectRecord>>;
  remove(id: Id): Promise<Result<void>>;
  get(id: Id): MassingObjectRecord | undefined;
  list(): readonly MassingObjectRecord[];
  duplicate(id: Id, options?: { name?: string; optionSetId?: Id }): Promise<Result<MassingObjectRecord>>;
}

export const MassingToken = createCapabilityToken<MassingService>("massing.service");

/**
 * Story-level editing.
 *
 * `editStories` takes a predicate because the real workflows are bulk ones — "make every floor
 * above 10 residential", "set levels 2-6 to 3.6 m". Exposing only per-story setters would push
 * that loop into every caller and lose the single-undo-step property.
 */
export interface StoryService {
  stories(massingObjectId: Id): readonly MassingStoryRecord[];
  setStoryCount(massingObjectId: Id, count: number): Promise<Result<MassingObjectRecord>>;
  setStoryHeight(massingObjectId: Id, storyIndex: number, height: number): Promise<Result<MassingStoryRecord>>;
  editStories(
    massingObjectId: Id,
    predicate: (story: MassingStoryRecord) => boolean,
    changes: Partial<Pick<MassingStoryRecord, "height" | "programme" | "profileId" | "excludedFromGfa">>,
  ): Promise<Result<readonly MassingStoryRecord[]>>;
  insertStory(massingObjectId: Id, atIndex: number, height: number): Promise<Result<MassingObjectRecord>>;
  removeStory(massingObjectId: Id, atIndex: number): Promise<Result<MassingObjectRecord>>;
}

export const StoryToken = createCapabilityToken<StoryService>("massing.stories");

export interface AppearanceService {
  setColor(massingObjectId: Id, color: string): Promise<Result<void>>;
  setOpacity(massingObjectId: Id, opacity: number): Promise<Result<void>>;
  /** Applies a consistent palette across an option set, for side-by-side review. */
  applyOptionStyling(optionSetId: Id, palette?: readonly string[]): Promise<Result<void>>;
}

export const AppearanceToken = createCapabilityToken<AppearanceService>("massing.appearance");

export interface MetricsService {
  compute(massingObjectId: Id): Promise<Result<MassingMetrics>>;
  computeAll(optionSetId?: Id): Promise<Result<readonly MassingMetrics[]>>;
  /** Totals for an option, plus planning compliance when a site boundary is set. */
  summarise(optionSetId: Id): Promise<Result<{
    readonly grossFloorArea: number;
    readonly volume: number;
    readonly footprintArea: number;
    readonly floorAreaRatio?: number;
    readonly withinLimits?: boolean;
  }>>;
}

export const MetricsToken = createCapabilityToken<MetricsService>("massing.metrics");

export interface OptionService {
  create(name: string, massingObjectIds?: readonly Id[]): Promise<Result<OptionSetRecord>>;
  setActive(optionSetId: Id): Promise<Result<void>>;
  compare(optionSetIds: readonly Id[]): Promise<Result<readonly MassingMetrics[]>>;
  list(): readonly OptionSetRecord[];
}

export const OptionToken = createCapabilityToken<OptionService>("massing.options");

export interface ContextService {
  levels(): readonly LevelRecord[];
  grids(): readonly GridLineRecord[];
  siteBoundary(): SiteBoundaryRecord | undefined;
  /** Generates levels from a mass's stories so downstream authoring has real levels to host to. */
  deriveLevels(massingObjectId: Id): Promise<Result<readonly LevelRecord[]>>;
}

export const ContextToken = createCapabilityToken<ContextService>("massing.context");

export type PromotionTarget = "building-systems" | "family" | "working-model";

export interface PromotionService {
  /** Turns a conceptual mass into something downstream: a core and facade, or reusable content. */
  promote(massingObjectId: Id, target: PromotionTarget, options?: {
    readonly name?: string;
    readonly repositoryId?: Id;
    readonly generateCore?: boolean;
    readonly generateFacade?: boolean;
  }): Promise<Result<{ readonly targetId: Id; readonly target: PromotionTarget }>>;
}

export const PromotionToken = createCapabilityToken<PromotionService>("massing.promotion");

export interface MassingEvents {
  "massing.created": { readonly record: MassingObjectRecord };
  "massing.updated": { readonly record: MassingObjectRecord };
  "massing.removed": { readonly id: Id };
  "massing.stories.changed": { readonly massingObjectId: Id; readonly storyCount: number };
  "massing.metrics.computed": { readonly metrics: MassingMetrics };
  "massing.option.activated": { readonly optionSetId: Id };
}

export const MASSING_COMMANDS = {
  sketchProfile: "massing.profile.sketch",
  createMass: "massing.create",
  setStoryCount: "massing.stories.set-count",
  editStories: "massing.stories.edit",
  setColor: "massing.appearance.set-color",
  setOpacity: "massing.appearance.set-opacity",
  computeMetrics: "massing.metrics.compute",
  createOption: "massing.option.create",
  compareOptions: "massing.option.compare",
  promote: "massing.promote",
} as const;

export const MASSING_PERMISSIONS = {
  edit: "massing.edit",
  promote: "massing.promote",
} as const;
