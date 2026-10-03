import type { LocalBox, Triangle, Vec3 } from "./types.ts";

/**
 * Triangles thinner than this on XZ do not move the stencil. Plans already
 * drawn around that extent keep the same scale. This is not the obstacle rule.
 */
const STENCIL_SLIVER_M = 0.05;

export type ModelBounds = { min: Vec3; max: Vec3 };

/** Axis-aligned bounds of every triangle vertex, in raw GLB units. */
export function boundsOfTriangles(triangles: Triangle[]): ModelBounds | undefined {
  if (triangles.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const triangle of triangles) {
    for (const [x, y, z] of triangle) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * One rectangle, the XZ extent plans are scaled against. Paper-thin
 * triangles are left out. A mesh with no thicker triangle uses the raw
 * bounds, so the stencil still has a shape.
 */
export function stencilBoxes(triangles: Triangle[]): LocalBox[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const triangle of triangles) {
    const xs = [triangle[0][0], triangle[1][0], triangle[2][0]];
    const ys = [triangle[0][1], triangle[1][1], triangle[2][1]];
    const zs = [triangle[0][2], triangle[1][2], triangle[2][2]];
    const dx = Math.max(...xs) - Math.min(...xs);
    const dz = Math.max(...zs) - Math.min(...zs);
    if (Math.min(dx, dz) < STENCIL_SLIVER_M) continue;
    any = true;
    for (const x of xs) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    for (const y of ys) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (const z of zs) {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (any && maxX > minX && maxZ > minZ) {
    return [{ minX, maxX, minY, maxY, minZ, maxZ }];
  }
  const bounds = boundsOfTriangles(triangles);
  if (!bounds) return [];
  return [{
    minX: bounds.min[0],
    maxX: bounds.max[0],
    minY: bounds.min[1],
    maxY: bounds.max[1],
    minZ: bounds.min[2],
    maxZ: bounds.max[2],
  }];
}

/** Union of the stencil on X (width) and Z (depth), in model meters. */
export function stencilSize(boxes: readonly LocalBox[]): { width: number; depth: number } {
  if (boxes.length === 0) return { width: 0, depth: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const box of boxes) {
    if (box.minX < minX) minX = box.minX;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.minZ < minZ) minZ = box.minZ;
    if (box.maxZ > maxZ) maxZ = box.maxZ;
  }
  return { width: maxX - minX, depth: maxZ - minZ };
}
