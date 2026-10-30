import { writeMeshesGlb, type DoorCorner } from "./glb-write.ts";
import { FLOOR_T } from "./room-file.ts";
import type { Yaw } from "./types.ts";
import type { Aabb2 } from "./union.ts";
import { placeBox } from "./yaw.ts";

/** Drop the visible hall a millimetre under the walk surface so it does not z-fight a room floor. */
export const HALL_FLOOR_SINK_M = 0.001;

/**
 * Pull facade edges in by this much so the floor ends inside the wall thickness.
 * Room edges are not inset.
 */
export const HALL_EDGE_INSET_M = 0.05;

/** 1×1 mid-grey (#808080) PNG. Used when a floor has no `floor-texture`. */
const GREY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC",
  "base64",
);

export function defaultFloorImage(): Uint8Array {
  return GREY_PNG;
}

/**
 * Building-local footprint of one room instance. The box is the `.room.json`
 * footprint placed at the instance centre, the same rectangle a hall place cuts out.
 */
export function roomFootprintAabb(
  inst: { center: { x: number; z: number }; yaw: Yaw },
  footprint: { minX: number; maxX: number; minZ: number; maxZ: number },
): Aabb2 {
  const placed = placeBox({
    minX: footprint.minX,
    maxX: footprint.maxX,
    minY: 0,
    maxY: 0,
    minZ: footprint.minZ,
    maxZ: footprint.maxZ,
  }, [inst.center.x, 0, inst.center.z], inst.yaw);
  return { minX: placed.min[0], maxX: placed.max[0], minZ: placed.min[2], maxZ: placed.max[2] };
}

/**
 * Outline minus room rectangles. The outline is pulled in by `HALL_EDGE_INSET_M`
 * first; room edges stay put. A cell is kept when its centre is inside the
 * outline (even-odd) and inside no room. Rows are merged, then equal-width
 * rows are stacked. Empty when the rooms cover the outline.
 */
export function hallCells(
  outline: readonly (readonly [number, number])[],
  rooms: readonly Aabb2[],
): Aabb2[] {
  const shape = insetOutline(outline);
  const bounds = rectOf(shape);
  const holes = rooms
    .map((room) => clip(bounds, room))
    .filter((rect): rect is Aabb2 => rect !== undefined);
  const xs = uniqueSorted([...shape.map(([x]) => x), ...holes.flatMap((hole) => [hole.minX, hole.maxX])]);
  const zs = uniqueSorted([...shape.map(([, z]) => z), ...holes.flatMap((hole) => [hole.minZ, hole.maxZ])]);
  const cells: Aabb2[] = [];
  for (let k = 0; k < zs.length - 1; k += 1) {
    for (let i = 0; i < xs.length - 1; i += 1) {
      const minX = xs[i]!;
      const maxX = xs[i + 1]!;
      const minZ = zs[k]!;
      const maxZ = zs[k + 1]!;
      if (maxX - minX <= 1e-8 || maxZ - minZ <= 1e-8) continue;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      if (!pointInPolygon(shape, cx, cz)) continue;
      if (holes.some((hole) => cx >= hole.minX && cx <= hole.maxX && cz >= hole.minZ && cz <= hole.maxZ)) continue;
      cells.push({ minX, maxX, minZ, maxZ });
    }
  }
  return mergeRuns(cells);
}

/**
 * Move each outline edge inward by `inset` metres. A rectilinear counter-clockwise
 * ring stays one. An edge that would flip is left unmoved, and the original ring
 * is returned.
 */
export function insetOutline(
  outline: readonly (readonly [number, number])[],
  inset = HALL_EDGE_INSET_M,
): Array<[number, number]> {
  const poly = outline.map(([x, z]): [number, number] => [x, z]);
  if (inset <= 0 || poly.length < 3) return poly;
  const lines: Array<{ horizontal: boolean; value: number }> = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > 1e-8) {
      lines.push({ horizontal: true, value: a[1] + (dx > 0 ? inset : -inset) });
    } else if (Math.abs(dz) > 1e-8) {
      lines.push({ horizontal: false, value: a[0] + (dz > 0 ? -inset : inset) });
    } else {
      return poly;
    }
  }
  const next: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i += 1) {
    const prev = lines[(i - 1 + poly.length) % poly.length]!;
    const curr = lines[i]!;
    if (prev.horizontal === curr.horizontal) return poly;
    next.push(prev.horizontal ? [curr.value, prev.value] : [prev.value, curr.value]);
  }
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = next[i]!;
    const d = next[(i + 1) % poly.length]!;
    const dot = (b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]);
    if (dot <= 0) return poly;
  }
  return ringArea(next) > 1e-8 ? next : poly;
}

export type HallFloorPiece = {
  /** Building-local hall, outside every room. */
  cells: Aabb2[];
  /** Mesh height. One millimetre under the walk surface. */
  surfaceY: number;
  /** Slab bottom, `FLOOR_T` under the walk surface. */
  slabMinY: number;
  /** Slab top. The walk surface. */
  slabMaxY: number;
};

/** Elevated-floor hall in building-local metres. Undefined when the hall has no area. */
export function hallFloorPiece(
  elevation: number,
  outline: readonly (readonly [number, number])[],
  rooms: readonly Aabb2[],
): HallFloorPiece | undefined {
  const cells = hallCells(outline, rooms);
  if (cells.length === 0) return undefined;
  return {
    cells,
    surfaceY: elevation - HALL_FLOOR_SINK_M,
    slabMinY: elevation - FLOOR_T,
    slabMaxY: elevation,
  };
}

/**
 * One textured mesh in building-local metres. The quad is wound so its
 * geometric normal is +Y (visible from above).
 * Check: edge (+x, 0, 0) × edge (0, 0, −z) = (0, +1, 0).
 * UVs are building-local metres over the tile (`u = x / tileX`, `v = z / tileZ`),
 * so the image repeats with no seam between rectangles.
 */
export function hallFloorGlb(args: {
  cells: readonly Aabb2[];
  y: number;
  image: Uint8Array;
  tileX: number;
  tileZ: number;
}): Uint8Array {
  const corner = (x: number, z: number): DoorCorner => ({
    position: [x, args.y, z],
    normal: [0, 1, 0],
    uv: [x / args.tileX, z / args.tileZ],
  });
  const corners: DoorCorner[] = [];
  for (const cell of args.cells) {
    // (-x, +z) → (+x, +z) → (+x, −z) → (−x, −z), counter-clockwise from above.
    corners.push(
      corner(cell.minX, cell.maxZ),
      corner(cell.maxX, cell.maxZ),
      corner(cell.maxX, cell.minZ),
      corner(cell.minX, cell.minZ),
    );
  }
  return writeMeshesGlb([{
    name: "floor",
    primitives: [{ corners, image: args.image, quads: true, repeat: true }],
  }]);
}

function rectOf(polygon: readonly (readonly [number, number])[]): Aabb2 {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

function clip(outer: Aabb2, hole: Aabb2): Aabb2 | undefined {
  const minX = Math.max(outer.minX, hole.minX);
  const maxX = Math.min(outer.maxX, hole.maxX);
  const minZ = Math.max(outer.minZ, hole.minZ);
  const maxZ = Math.min(outer.maxZ, hole.maxZ);
  if (maxX - minX <= 1e-8 || maxZ - minZ <= 1e-8) return undefined;
  return { minX, maxX, minZ, maxZ };
}

/** Horizontal runs on each row, then stack rows that share minX and maxX. */
function mergeRuns(cells: readonly Aabb2[]): Aabb2[] {
  if (cells.length === 0) return [];
  const sorted = [...cells].sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
  const runs: Aabb2[] = [];
  let run: Aabb2 | undefined;
  for (const cell of sorted) {
    if (
      run
      && Math.abs(run.minZ - cell.minZ) <= 1e-8
      && Math.abs(run.maxZ - cell.maxZ) <= 1e-8
      && Math.abs(run.maxX - cell.minX) <= 1e-8
    ) {
      run = { ...run, maxX: cell.maxX };
    } else {
      if (run) runs.push(run);
      run = { ...cell };
    }
  }
  if (run) runs.push(run);
  runs.sort((a, b) => a.minX - b.minX || a.minZ - b.minZ);
  const stacked: Aabb2[] = [];
  for (const row of runs) {
    const prev = stacked.find((item) =>
      Math.abs(item.minX - row.minX) <= 1e-8
      && Math.abs(item.maxX - row.maxX) <= 1e-8
      && Math.abs(item.maxZ - row.minZ) <= 1e-8
    );
    if (prev) prev.maxZ = row.maxZ;
    else stacked.push({ ...row });
  }
  stacked.sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
  return stacked;
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || value - last > 1e-8) out.push(value);
  }
  return out;
}

/** Even-odd. A centre on a rectilinear edge does not occur: edges lie on the grid. */
function pointInPolygon(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let hits = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]![0];
    const zi = polygon[i]![1];
    const xj = polygon[j]![0];
    const zj = polygon[j]![1];
    const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (crosses) hits = !hits;
  }
  return hits;
}

function ringArea(poly: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const point = poly[i]!;
    const next = poly[(i + 1) % poly.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}
