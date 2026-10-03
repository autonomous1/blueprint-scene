import { PlanError } from "./errors.ts";
import type { LocalBox, Triangle } from "./types.ts";

/** Occupancy cell. Doubled once when a model still has more than `MAX_OBSTACLES` runs. */
export const CELL_M = 0.5;

/** Per instance, after scale. The second pass uses `CELL_M * 2` and then stops. */
export const MAX_OBSTACLES = 32;

/**
 * Drop a run thinner than this or shorter than this. A one-cell wall is
 * 0.5 m thick, so it stays; a 0.2 m mullion does not.
 */
const MIN_THICKNESS_M = 0.4;
const MIN_LENGTH_M = 1;

/** Triangles whose highest vertex is under this are floor debris. */
const FLOOR_Y_M = 0.5;

const EPS = 1e-6;

type Item = {
  triangle: Triangle;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

type Clip = { minX: number; maxX: number; minZ: number; maxZ: number };

type Run = { i0: number; i1: number; k0: number; k1: number };

export type CoarseFootprint = {
  boxes: LocalBox[];
  cellSize: number;
};

/**
 * Project triangles onto XZ and emit one AABB per horizontal or vertical run.
 * Call this after scale and before yaw. A doorway is a run of empty cells;
 * gaps wider than one cell are left open.
 */
export function footprintFromTriangles(triangles: Triangle[], cellSize = CELL_M): LocalBox[] {
  if (!(cellSize > 0)) throw new PlanError("cell size must be positive");
  const items = keptTriangles(triangles);
  if (items.length === 0) return [];
  const geom = new Map<string, Clip>();
  for (const item of items) markCells(item, cellSize, geom);
  if (geom.size === 0) return [];
  const cells: Array<[number, number]> = [];
  for (const key of geom.keys()) cells.push(unpack(key));
  const boxes = [
    ...boxesFromRuns(runsAlongRows(cells), geom),
    ...boxesFromRuns(runsAlongColumns(cells), geom),
  ].map((box) => assignY(box, items));
  return dropContained(dropShort(boxes));
}

/** 0.5 m grid, or 1 m when the first pass still exceeds `MAX_OBSTACLES`. */
export function coarseFootprint(triangles: Triangle[]): CoarseFootprint {
  const boxes = footprintFromTriangles(triangles, CELL_M);
  if (boxes.length <= MAX_OBSTACLES) return { boxes, cellSize: CELL_M };
  return { boxes: footprintFromTriangles(triangles, CELL_M * 2), cellSize: CELL_M * 2 };
}

/**
 * Floor triangles are dropped. A tessellated wall is made of pieces smaller
 * than a cell; those still paint any center they cover. A mullion disappears
 * later, when its run is thinner than 0.4 m or shorter than 1 m.
 */
function keptTriangles(triangles: Triangle[]): Item[] {
  const items: Item[] = [];
  for (const triangle of triangles) {
    const item = itemOf(triangle);
    if (item.maxY < FLOOR_Y_M) continue;
    items.push(item);
  }
  return items;
}

function itemOf(triangle: Triangle): Item {
  const coords = triangle.flat();
  if (!coords.every(Number.isFinite)) throw new PlanError("wall triangle has a non-finite vertex");
  const xs = [triangle[0][0], triangle[1][0], triangle[2][0]];
  const ys = [triangle[0][1], triangle[1][1], triangle[2][1]];
  const zs = [triangle[0][2], triangle[1][2], triangle[2][2]];
  return {
    triangle,
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function markCells(item: Item, cell: number, geom: Map<string, Clip>): void {
  const i0 = Math.floor(item.minX / cell);
  const i1 = Math.floor(item.maxX / cell);
  const k0 = Math.floor(item.minZ / cell);
  const k1 = Math.floor(item.maxZ / cell);
  const [a, b, c] = item.triangle;
  for (let k = k0; k <= k1; k += 1) {
    const cz = (k + 0.5) * cell;
    if (cz < item.minZ || cz > item.maxZ) continue;
    for (let i = i0; i <= i1; i += 1) {
      const cx = (i + 0.5) * cell;
      if (cx < item.minX || cx > item.maxX) continue;
      if (!covers(a[0], a[2], b[0], b[2], c[0], c[2], cx, cz)) continue;
      const key = pack(i, k);
      const clip: Clip = {
        minX: Math.max(item.minX, i * cell),
        maxX: Math.min(item.maxX, (i + 1) * cell),
        minZ: Math.max(item.minZ, k * cell),
        maxZ: Math.min(item.maxZ, (k + 1) * cell),
      };
      const prev = geom.get(key);
      if (!prev) geom.set(key, clip);
      else {
        prev.minX = Math.min(prev.minX, clip.minX);
        prev.maxX = Math.max(prev.maxX, clip.maxX);
        prev.minZ = Math.min(prev.minZ, clip.minZ);
        prev.maxZ = Math.max(prev.maxZ, clip.maxZ);
      }
    }
  }
}

/** Barycentric XZ test. Edges count, so a center on a shared edge is solid. */
function covers(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, x: number, z: number): boolean {
  const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(denom) < 1e-12) return false;
  const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denom;
  const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denom;
  const w0 = 1 - w1 - w2;
  return w0 >= -1e-8 && w1 >= -1e-8 && w2 >= -1e-8;
}

function runsAlongRows(cells: Array<[number, number]>): Run[] {
  const rows = new Map<number, number[]>();
  for (const [i, k] of cells) {
    const row = rows.get(k);
    if (row) row.push(i);
    else rows.set(k, [i]);
  }
  const segments: Run[] = [];
  for (const [k, cols] of rows) {
    cols.sort((a, b) => a - b);
    let start = cols[0]!;
    let prev = start;
    for (let n = 1; n < cols.length; n += 1) {
      const i = cols[n]!;
      if (i === prev + 1) {
        prev = i;
        continue;
      }
      segments.push({ i0: start, i1: prev, k0: k, k1: k });
      start = i;
      prev = i;
    }
    segments.push({ i0: start, i1: prev, k0: k, k1: k });
  }
  segments.sort((a, b) => a.i0 - b.i0 || a.i1 - b.i1 || a.k0 - b.k0);
  const stacked: Run[] = [];
  for (const segment of segments) {
    const last = stacked[stacked.length - 1];
    if (last && last.i0 === segment.i0 && last.i1 === segment.i1 && last.k1 + 1 === segment.k0) {
      last.k1 = segment.k1;
    } else {
      stacked.push({ ...segment });
    }
  }
  return stacked;
}

function runsAlongColumns(cells: Array<[number, number]>): Run[] {
  const swapped = cells.map(([i, k]) => [k, i] as [number, number]);
  return runsAlongRows(swapped).map((run) => ({
    i0: run.k0,
    i1: run.k1,
    k0: run.i0,
    k1: run.i1,
  }));
}

function boxesFromRuns(runs: Run[], geom: Map<string, Clip>): LocalBox[] {
  const boxes: LocalBox[] = [];
  for (const run of runs) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = run.k0; k <= run.k1; k += 1) {
      for (let i = run.i0; i <= run.i1; i += 1) {
        const clip = geom.get(pack(i, k));
        if (!clip) continue;
        if (clip.minX < minX) minX = clip.minX;
        if (clip.maxX > maxX) maxX = clip.maxX;
        if (clip.minZ < minZ) minZ = clip.minZ;
        if (clip.maxZ > maxZ) maxZ = clip.maxZ;
      }
    }
    if (minX === Infinity) continue;
    boxes.push({ minX, maxX, minY: 0, maxY: 0, minZ, maxZ });
  }
  return boxes;
}

function assignY(box: LocalBox, items: Item[]): LocalBox {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    if (item.maxX < box.minX - EPS || item.minX > box.maxX + EPS) continue;
    if (item.maxZ < box.minZ - EPS || item.minZ > box.maxZ + EPS) continue;
    if (item.minY < minY) minY = item.minY;
    if (item.maxY > maxY) maxY = item.maxY;
  }
  if (minY === Infinity) return box;
  return { ...box, minY, maxY };
}

function dropShort(boxes: LocalBox[]): LocalBox[] {
  return boxes.filter((box) => {
    const dx = box.maxX - box.minX;
    const dz = box.maxZ - box.minZ;
    return Math.min(dx, dz) >= MIN_THICKNESS_M - 1e-4 && Math.max(dx, dz) >= MIN_LENGTH_M - 1e-4;
  });
}

function dropContained(boxes: LocalBox[]): LocalBox[] {
  const unique: LocalBox[] = [];
  for (const box of boxes) {
    if (!unique.some((other) => sameXz(other, box))) unique.push(box);
  }
  const kept = unique.filter((box, index) => !unique.some((other, otherIndex) =>
    otherIndex !== index && containsXz(other, box) && area(other) > area(box) + EPS,
  ));
  kept.sort((a, b) => a.minX - b.minX || a.minZ - b.minZ || a.maxX - b.maxX || a.maxZ - b.maxZ || a.minY - b.minY);
  return kept;
}

function area(box: LocalBox): number {
  return (box.maxX - box.minX) * (box.maxZ - box.minZ);
}

function sameXz(a: LocalBox, b: LocalBox): boolean {
  return Math.abs(a.minX - b.minX) <= EPS
    && Math.abs(a.maxX - b.maxX) <= EPS
    && Math.abs(a.minZ - b.minZ) <= EPS
    && Math.abs(a.maxZ - b.maxZ) <= EPS;
}

function containsXz(outer: LocalBox, inner: LocalBox): boolean {
  return inner.minX >= outer.minX - EPS
    && inner.maxX <= outer.maxX + EPS
    && inner.minZ >= outer.minZ - EPS
    && inner.maxZ <= outer.maxZ + EPS;
}

function pack(i: number, k: number): string {
  return `${i}:${k}`;
}

function unpack(key: string): [number, number] {
  const split = key.indexOf(":");
  return [Number(key.slice(0, split)), Number(key.slice(split + 1))];
}
