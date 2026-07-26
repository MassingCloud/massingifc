import type { Vec3 } from "@massingifc/project-schema";

/**
 * Planar geometry for massing.
 *
 * Pure functions over plain arrays, with no dependency on a 3D library. Massing metrics are the
 * numbers a scheme is judged on — area, GFA, volume — so they need to be computable and testable
 * without a renderer, a WebGL context, or a loaded model.
 *
 * Masses are vertical extrusions of a horizontal profile, so everything here works in the XY plane
 * and treats Z as elevation.
 */

export type Point2 = readonly [x: number, y: number];

/** Tolerance for coordinate comparison, in project units (metres). ~0.01 mm. */
export const EPSILON = 1e-5;

export function toXY(points: readonly Vec3[]): Point2[] {
  return points.map((point) => [point[0], point[1]] as Point2);
}

/**
 * Shoelace area, signed.
 *
 * The sign carries the winding direction, which callers need in order to normalise orientation
 * before extruding — a profile sketched clockwise would otherwise produce inward-facing surfaces.
 */
export function signedArea(points: readonly Point2[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!current || !next) continue;
    total += current[0] * next[1] - next[0] * current[1];
  }
  return total / 2;
}

export function polygonArea(points: readonly Point2[]): number {
  return Math.abs(signedArea(points));
}

export function isClockwise(points: readonly Point2[]): boolean {
  return signedArea(points) < 0;
}

/** Returns the ring wound counter-clockwise, reversing only if needed. */
export function normaliseWinding(points: readonly Point2[]): readonly Point2[] {
  return isClockwise(points) ? [...points].reverse() : points;
}

export function perimeter(points: readonly Point2[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!current || !next) continue;
    total += Math.hypot(next[0] - current[0], next[1] - current[1]);
  }
  return total;
}

/**
 * Area centroid — not the average of the vertices.
 *
 * The vertex average is wrong for any ring with unevenly spaced points, which is most real
 * footprints. It matters because the centroid is what a mass is rotated and scaled about.
 */
export function centroid(points: readonly Point2[]): Point2 {
  const area = signedArea(points);
  if (points.length === 0) return [0, 0];
  if (Math.abs(area) < EPSILON) {
    // Degenerate ring: fall back to the vertex average rather than dividing by ~zero.
    const sum = points.reduce<[number, number]>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!current || !next) continue;
    const cross = current[0] * next[1] - next[0] * current[1];
    cx += (current[0] + next[0]) * cross;
    cy += (current[1] + next[1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: Point2, b: Point2, point: Point2): boolean {
  return (
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON
  );
}

export function segmentsIntersect(a1: Point2, a2: Point2, b1: Point2, b2: Point2): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear overlap still counts as an intersection for validation purposes.
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

/**
 * Whether a ring is simple (non-self-intersecting).
 *
 * O(n²), which is the right trade here: footprints have tens of vertices, not thousands, and a
 * sweep-line implementation would be considerably more code to get right for no felt benefit.
 */
export function isSimplePolygon(points: readonly Point2[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    if (!a1 || !a2) continue;
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges legitimately share a vertex; the closing edge is adjacent to the first.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (!b1 || !b2) continue;
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

export function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const intersects =
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Footprint area with courtyards and light wells subtracted. */
export function netArea(outer: readonly Point2[], holes: readonly (readonly Point2[])[] = []): number {
  return holes.reduce((area, hole) => area - polygonArea(hole), polygonArea(outer));
}

export interface ProfileValidationIssue {
  readonly code:
    | "too-few-points"
    | "zero-area"
    | "self-intersecting"
    | "hole-outside-outer"
    | "hole-self-intersecting";
  readonly message: string;
  readonly holeIndex?: number;
}

/**
 * Checks a sketched outline before it becomes geometry.
 *
 * Catching these at sketch time is the difference between a clear "this outline crosses itself"
 * and a mass that silently computes a nonsensical area — the shoelace formula happily returns a
 * number for a bow-tie, and that number is meaningless.
 */
export function validateProfile(
  outer: readonly Point2[],
  holes: readonly (readonly Point2[])[] = [],
): readonly ProfileValidationIssue[] {
  const issues: ProfileValidationIssue[] = [];

  if (outer.length < 3) {
    issues.push({ code: "too-few-points", message: "A profile needs at least three points." });
    return issues; // everything below assumes a ring
  }
  if (polygonArea(outer) < EPSILON) {
    issues.push({ code: "zero-area", message: "The profile encloses no area." });
  }
  if (!isSimplePolygon(outer)) {
    issues.push({ code: "self-intersecting", message: "The profile outline crosses itself." });
  }

  holes.forEach((hole, holeIndex) => {
    if (hole.length < 3) return;
    if (!isSimplePolygon(hole)) {
      issues.push({
        code: "hole-self-intersecting",
        message: `Opening ${holeIndex + 1} crosses itself.`,
        holeIndex,
      });
    }
    if (!hole.every((point) => pointInPolygon(point, outer))) {
      issues.push({
        code: "hole-outside-outer",
        message: `Opening ${holeIndex + 1} is not fully inside the profile.`,
        holeIndex,
      });
    }
  });

  return issues;
}

export interface StoryGeometry {
  readonly index: number;
  readonly elevation: number;
  readonly height: number;
  readonly area: number;
  readonly perimeter: number;
  readonly excludedFromGfa: boolean;
}

/** Cumulative base elevation of each story. */
export function storyElevations(heights: readonly number[], baseElevation = 0): number[] {
  const elevations: number[] = [];
  let current = baseElevation;
  for (const height of heights) {
    elevations.push(current);
    current += height;
  }
  return elevations;
}

/**
 * Expands per-story heights into a uniform array.
 *
 * Tolerates a heights array that disagrees with the story count — which happens constantly while
 * a user is editing — by padding with the last known height rather than failing. A massing tool
 * that refuses to compute mid-edit is unusable.
 */
export function resolveStoryHeights(
  storyCount: number,
  heights: readonly number[] | undefined,
  fallbackHeight = 3.5,
): number[] {
  const resolved: number[] = [];
  let last = fallbackHeight;
  for (let i = 0; i < storyCount; i++) {
    const height = heights?.[i];
    if (height !== undefined && height > 0) last = height;
    resolved.push(last);
  }
  return resolved;
}

export interface MassMetricsInput {
  readonly outer: readonly Point2[];
  readonly holes?: readonly (readonly Point2[])[];
  readonly storyHeights: readonly number[];
  readonly baseElevation?: number;
  /** Story indices excluded from gross floor area, e.g. plant levels. */
  readonly excludedStories?: readonly number[];
  /** Per-story outline override, keyed by story index — for setbacks and tapers. */
  readonly storyOutlines?: Readonly<Record<number, readonly Point2[]>>;
}

export interface MassMetricsResult {
  readonly footprintArea: number;
  readonly grossFloorArea: number;
  readonly volume: number;
  readonly envelopeArea: number;
  readonly storyCount: number;
  readonly height: number;
  readonly stories: readonly StoryGeometry[];
}

/**
 * The numbers a massing scheme is judged on.
 *
 * Computed per story rather than as `footprint × height` so that setbacks, tapers and excluded
 * plant levels are handled by the same code path as the simple case. Treating the simple case
 * specially is how tools end up reporting a GFA that quietly ignores the setback the user just
 * drew.
 */
export function computeMassMetrics(input: MassMetricsInput): MassMetricsResult {
  const excluded = new Set(input.excludedStories ?? []);
  const elevations = storyElevations(input.storyHeights, input.baseElevation ?? 0);
  const footprintArea = netArea(input.outer, input.holes ?? []);
  const holePerimeter = (input.holes ?? []).reduce((total, hole) => total + perimeter(hole), 0);

  const stories: StoryGeometry[] = input.storyHeights.map((height, index) => {
    const outline = input.storyOutlines?.[index];
    const area = outline ? polygonArea(outline) : footprintArea;
    const ring = outline ? perimeter(outline) : perimeter(input.outer) + holePerimeter;
    return {
      index,
      elevation: elevations[index] ?? 0,
      height,
      area,
      perimeter: ring,
      excludedFromGfa: excluded.has(index),
    };
  });

  const grossFloorArea = stories.reduce(
    (total, story) => (story.excludedFromGfa ? total : total + story.area),
    0,
  );
  const volume = stories.reduce((total, story) => total + story.area * story.height, 0);
  // Facade area plus the roof and the ground slab. The roof is the topmost story's area, which is
  // not the footprint once a setback exists.
  const facadeArea = stories.reduce((total, story) => total + story.perimeter * story.height, 0);
  const roofArea = stories.at(-1)?.area ?? footprintArea;
  const height = input.storyHeights.reduce((total, value) => total + value, 0);

  return {
    footprintArea,
    grossFloorArea,
    volume,
    envelopeArea: facadeArea + roofArea + footprintArea,
    storyCount: stories.length,
    height,
    stories,
  };
}

/** Gross floor area divided by site area. Undefined when there is no site to divide by. */
export function floorAreaRatio(grossFloorArea: number, siteArea: number | undefined): number | undefined {
  if (siteArea === undefined || siteArea < EPSILON) return undefined;
  return grossFloorArea / siteArea;
}
