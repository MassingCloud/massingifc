import type { Vec3 } from "@massingifc/project-schema";

/**
 * Sketch-plane geometry.
 *
 * Pure vector maths, no dependency on a 3D library. Projecting a screen ray onto a work plane is
 * the core of every sketch interaction, and it needs to be testable without a renderer — a
 * projection that is subtly wrong produces geometry that is subtly in the wrong place, which is
 * far harder to notice than a crash.
 */

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (v: Vec3): number => Math.sqrt(dot(v, v));

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Tolerance for treating a vector as degenerate or a ray as parallel to a plane. */
export const EPSILON = 1e-9;

export function normalize(v: Vec3): Vec3 | undefined {
  const l = length(v);
  // A zero-length vector has no direction. Returning `[0,0,0]` would let a caller carry on with a
  // meaningless basis; returning undefined forces the question to be answered.
  return l < EPSILON ? undefined : scale(v, 1 / l);
}

export interface PlaneBasis {
  readonly origin: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
  /** Unit in-plane axis, the sketch's local +U. */
  readonly xAxis: Vec3;
  /** Unit in-plane axis, the sketch's local +V. Always `normal x xAxis`. */
  readonly yAxis: Vec3;
}

/**
 * Builds an orthonormal basis for a plane.
 *
 * A caller-supplied `xAxis` is orthogonalised against the normal rather than trusted: a user
 * picking two points on screen will hand over an axis that is very nearly, but not exactly, in the
 * plane, and using it unmodified skews every subsequent coordinate slightly.
 */
export function planeBasis(origin: Vec3, normal: Vec3, xAxis?: Vec3): PlaneBasis | undefined {
  const n = normalize(normal);
  if (!n) return undefined;

  let x: Vec3 | undefined;
  if (xAxis) {
    // Gram-Schmidt: remove the component along the normal, then renormalise.
    x = normalize(sub(xAxis, scale(n, dot(xAxis, n))));
  }
  if (!x) {
    // No usable hint: pick whichever world axis is least aligned with the normal, so the cross
    // product is well conditioned rather than nearly zero.
    const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    x = normalize(cross(seed, n));
  }
  if (!x) return undefined;

  return { origin, normal: n, xAxis: x, yAxis: cross(n, x) };
}

/** A horizontal work plane at an elevation — the commonest case in building work. */
export function levelPlane(elevation: number): PlaneBasis {
  return {
    origin: [0, 0, elevation],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    yAxis: [0, 1, 0],
  };
}

/**
 * Intersects a ray with a plane.
 *
 * Returns `undefined` when the ray is parallel to the plane, or points away from it. A ray that
 * misses is a normal outcome of a user moving the pointer past the horizon, not an error.
 */
export function intersectRayPlane(
  rayOrigin: Vec3,
  rayDirection: Vec3,
  plane: PlaneBasis,
): Vec3 | undefined {
  const direction = normalize(rayDirection);
  if (!direction) return undefined;

  const denominator = dot(plane.normal, direction);
  if (Math.abs(denominator) < EPSILON) return undefined; // parallel

  const t = dot(plane.normal, sub(plane.origin, rayOrigin)) / denominator;
  if (t < 0) return undefined; // behind the ray
  return add(rayOrigin, scale(direction, t));
}

/** World point to plane-local (u, v). */
export function worldToPlane(point: Vec3, plane: PlaneBasis): readonly [number, number] {
  const d = sub(point, plane.origin);
  return [dot(d, plane.xAxis), dot(d, plane.yAxis)];
}

/** Plane-local (u, v) back to a world point. */
export function planeToWorld(u: number, v: number, plane: PlaneBasis): Vec3 {
  return add(plane.origin, add(scale(plane.xAxis, u), scale(plane.yAxis, v)));
}

/** Signed distance from a point to the plane, positive on the normal side. */
export function distanceToPlane(point: Vec3, plane: PlaneBasis): number {
  return dot(sub(point, plane.origin), plane.normal);
}

/** Rounds to the nearest multiple of `spacing`. A non-positive spacing means no snapping. */
export function snap(value: number, spacing: number): number {
  if (spacing <= 0) return value;
  return Math.round(value / spacing) * spacing;
}

/** Snaps a world point onto the plane grid, returning a point guaranteed to lie on the plane. */
export function snapToPlaneGrid(point: Vec3, plane: PlaneBasis, spacing: number): Vec3 {
  const [u, v] = worldToPlane(point, plane);
  return planeToWorld(snap(u, spacing), snap(v, spacing), plane);
}
