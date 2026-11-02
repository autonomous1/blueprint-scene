import { writeMeshesGlb, type DoorCorner } from "./glb-write.ts";
import type { LocalBox } from "./types.ts";

/** Tallest riser the bake emits. Under the arena's 0.3 m STEP_HEIGHT, and a normal building riser. */
export const MAX_RISER_M = 0.18;

/** Thickness of each step slab under its tread. The space below the flight stays open. */
export const STEP_THICKNESS_M = 0.3;

/**
 * One slab per step, building-local: STEP_THICKNESS_M thick under its tread
 * (clamped so it never goes below `bottom`), leaving the space under the flight open. `up` is
 * the climb direction in local XZ (unit, axis-aligned after the quarter-turn yaw).
 */
export function stairsStepBoxes(
  polygon: readonly (readonly [number, number])[],
  up: readonly [number, number],
  bottom: number,
  top: number,
): LocalBox[] {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const alongX = Math.abs(up[0]) >= Math.abs(up[1]);
  const sign = (alongX ? up[0] : up[1]) >= 0 ? 1 : -1;
  const lo = alongX ? minX : minZ;
  const hi = alongX ? maxX : maxZ;
  const rise = top - bottom;
  const count = Math.max(1, Math.ceil(rise / MAX_RISER_M - 1e-9));
  const depth = (hi - lo) / count;
  const boxes: LocalBox[] = [];
  for (let i = 0; i < count; i++) {
    // Step i covers [a, b] measured from the low end along the climb.
    const a = sign > 0 ? lo + i * depth : hi - (i + 1) * depth;
    const b = sign > 0 ? lo + (i + 1) * depth : hi - i * depth;
    const maxY = i === count - 1 ? top : bottom + (rise * (i + 1)) / count;
    const minY = Math.max(bottom, maxY - STEP_THICKNESS_M);
    boxes.push(alongX
      ? { minX: a, maxX: b, minY, maxY, minZ, maxZ }
      : { minX, maxX, minY, maxY, minZ: a, maxZ: b });
  }
  return boxes;
}

/** Closed boxes with the floor image tiled in building-local metres. */
export function stairsGlb(args: { boxes: readonly LocalBox[]; image: Uint8Array; tileX: number; tileZ: number }): Uint8Array {
  const corners: DoorCorner[] = [];
  const { tileX: tx, tileZ: tz } = args;
  const face = (n: [number, number, number], pts: [number, number, number][], uv: (p: [number, number, number]) => [number, number]) => {
    for (const p of pts) corners.push({ position: p, normal: n, uv: uv(p) });
  };
  for (const b of args.boxes) {
    const { minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 } = b;
    const xz = (p: [number, number, number]): [number, number] => [p[0] / tx, p[2] / tz];
    const xy = (p: [number, number, number]): [number, number] => [p[0] / tx, -p[1] / tz];
    const zy = (p: [number, number, number]): [number, number] => [p[2] / tz, -p[1] / tz];
    // Counter-clockwise seen from outside each face.
    face([0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], xz);
    face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], xz);
    face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], xy);
    face([0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], xy);
    face([1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], zy);
    face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], zy);
  }
  return writeMeshesGlb([{ name: "stairs", primitives: [{ corners, image: args.image, quads: true, repeat: true }] }]);
}
