import type { Matrix4, Vec3 } from "@massingifc/project-schema";

/**
 * Rigid alignment of observed geometry to project coordinates.
 *
 * Solves for **rotation about Z, plus translation** rather than a general 3D rotation. That is not
 * a simplification of convenience: survey and scan registration in building work is nearly always
 * a horizontal rotation onto grid plus a level shift, because both the model and the instrument
 * are levelled. Fitting a full 3D rotation to noisy control points would let a scan tilt to
 * absorb measurement error, producing a lower residual and a worse answer.
 *
 * This is the planar Procrustes solution: rotation from the summed cross and dot products of the
 * centred point pairs, translation from the centroids.
 */

export interface PointPair {
  readonly source: Vec3;
  readonly target: Vec3;
}

export interface AlignmentSolution {
  readonly transform: Matrix4;
  /** Root-mean-square residual in project units. */
  readonly rmsError: number;
  readonly rotationRadians: number;
  readonly translation: Vec3;
}

const centroidOf = (points: readonly Vec3[]): Vec3 => {
  if (points.length === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
    z += point[2];
  }
  return [x / points.length, y / points.length, z / points.length];
};

/**
 * Column-major 4x4, matching `THREE.Matrix4.toArray` — the convention a host will hand straight to
 * a scene object.
 */
export function composeZRotation(angle: number, translation: Vec3): Matrix4 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    cos, sin, 0, 0,
    -sin, cos, 0, 0,
    0, 0, 1, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

export function applyTransform(transform: Matrix4, point: Vec3): Vec3 {
  const m = (index: number): number => transform[index] ?? 0;
  return [
    m(0) * point[0] + m(4) * point[1] + m(8) * point[2] + m(12),
    m(1) * point[0] + m(5) * point[1] + m(9) * point[2] + m(13),
    m(2) * point[0] + m(6) * point[1] + m(10) * point[2] + m(14),
  ];
}

export const IDENTITY_MATRIX: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function solveAlignment(pairs: readonly PointPair[]): AlignmentSolution | undefined {
  if (pairs.length === 0) return undefined;

  const sourceCentroid = centroidOf(pairs.map((pair) => pair.source));
  const targetCentroid = centroidOf(pairs.map((pair) => pair.target));

  // With a single pair there is no information about rotation; solving for one would be inventing
  // it, so the answer is a pure translation.
  let rotation = 0;
  if (pairs.length >= 2) {
    let cross = 0;
    let dot = 0;
    for (const pair of pairs) {
      const sx = pair.source[0] - sourceCentroid[0];
      const sy = pair.source[1] - sourceCentroid[1];
      const tx = pair.target[0] - targetCentroid[0];
      const ty = pair.target[1] - targetCentroid[1];
      cross += sx * ty - sy * tx;
      dot += sx * tx + sy * ty;
    }
    if (Math.abs(cross) > 1e-12 || Math.abs(dot) > 1e-12) rotation = Math.atan2(cross, dot);
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rotatedX = cos * sourceCentroid[0] - sin * sourceCentroid[1];
  const rotatedY = sin * sourceCentroid[0] + cos * sourceCentroid[1];
  const translation: Vec3 = [
    targetCentroid[0] - rotatedX,
    targetCentroid[1] - rotatedY,
    targetCentroid[2] - sourceCentroid[2],
  ];

  const transform = composeZRotation(rotation, translation);

  let squared = 0;
  for (const pair of pairs) {
    const mapped = applyTransform(transform, pair.source);
    squared +=
      (mapped[0] - pair.target[0]) ** 2 +
      (mapped[1] - pair.target[1]) ** 2 +
      (mapped[2] - pair.target[2]) ** 2;
  }

  return {
    transform,
    // Reported, never hidden. A registration that silently "fits" is how a scan ends up half a
    // metre out with nobody able to say when it happened.
    rmsError: Math.sqrt(squared / pairs.length),
    rotationRadians: rotation,
    translation,
  };
}
