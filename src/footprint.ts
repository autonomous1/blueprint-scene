import { PlanError } from "./errors.ts";
import type { LocalBox, Triangle } from "./types.ts";

/** Occupancy cell on XZ. Doubled once when a model still has more than `MAX_OBSTACLES` runs. */
export const CELL_M = 0.5;

/**
 * Vertical slice of the same grid. A triangle marks a band only where it
 * overlaps that slice inside the cell. A span at y = 3 does not paint y = 0.
 * Bands stack when they share a footprint, so a solid wall is one box.
 */
export const BAND_M = 0.5;

/** Per instance, after scale. The second pass uses `CELL_M * 2` and then stops. */
export const MAX_OBSTACLES = 32;

/**
 * Drop a run thinner than this or shorter than this. A one-cell wall is
 * 0.5 m thick, so it stays; a 0.2 m mullion does not.
 */
const MIN_THICKNESS_M = 0.4;
const MIN_LENGTH_M = 1;

/**
 * Floor debris. A triangle whose highest vertex is under this is dropped, and
 * so is a band whose top is under this. A 1.8 m pawn walks under a span that
 * starts above about 2 m because the bands below that span stay empty.
 */
const FLOOR_Y_M = 0.5;

/**
 * Cells the mesh covers anywhere from the ground up to this height are one
 * band. They merge into runs before a short or thin run is dropped. A span
 * that starts at or above this height keeps its own Y and does not fill below.
 */
const PAWN_TOP_M = 2;

/** Empty distance above this, along a run, stays a gap. A pawn cannot squeeze through 0.5 m. */
const BRIDGE_M = 0.5;

/** Trim. A box under this volume is dropped after the wall runs are merged. */
const FACET_VOLUME_M3 = 0.5;
/**
 * A shell this thin is still a wall when the run is longer than 1 m. The
 * brutalist facades are about a centimetre, and dropping them leaves a pawn
 * a gap. A sheet of exactly 1 m stays absent, so it does not seal a doorway.
 */
const SHELL_M = 0.1;
/**
 * Consecutive bands whose XZ differs by at most this still stack. A pier or a
 * slanted shell shifts the clip by less than this between slices. A bridge
 * does not share that footprint, so the cells under it stay empty.
 */
const STACK_XZ_M = 0.15;

/**
 * Measure grid on the unscaled GLB, in GLB units. Arena meters are the SVG
 * instance scale, applied later. A run of one cell is kept. The bake cutoffs
 * (`MIN_LENGTH_M`, `MIN_THICKNESS_M`) are not applied here.
 */
export const MEASURE_CELL_M = 0.05;

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

type YSpan = { minY: number; maxY: number };

/** A flat face. `enter` is an underside (solid above); `exit` is a lid (solid below). */
type Cap = { y: number; kind: "enter" | "exit" };

type Column = {
  clip: Clip;
  /** Band index → Y of the triangles that overlap that band inside the cell. */
  bands: Map<number, YSpan>;
  /** Horizontal faces in this cell, including a floor that was dropped from the grid. */
  caps: Cap[];
};

type Run = { i0: number; i1: number; k0: number; k1: number };

type BandBox = LocalBox & { band0: number; band1: number };

export type CoarseFootprint = {
  boxes: LocalBox[];
  cellSize: number;
  /** Facade boxes removed after the runs existed. */
  facetsDropped: number;
};

export type FootprintDetail = {
  boxes: LocalBox[];
  facetsDropped: number;
};

/** Axis-aligned opening in the same XZ space as the occupancy grid. */
export type XzRect = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/**
 * Project triangles onto XZ, then bin each solid cell into 0.5 m vertical
 * bands. Call this after scale and before yaw. A doorway is a run of empty
 * cells; gaps wider than one cell are left open. A box's Y is the bands the
 * mesh covers there, not the building's max height. From y = 0 to 2 m the
 * covered cells merge before any run is dropped.
 */
export function footprintFromTriangles(
  triangles: Triangle[],
  cellSize = CELL_M,
  openings: readonly XzRect[] = [],
): LocalBox[] {
  return footprintDetail(triangles, cellSize, openings).boxes;
}

/** Same grid as `footprintFromTriangles`, plus how many facet boxes were dropped. */
export function footprintDetail(
  triangles: Triangle[],
  cellSize = CELL_M,
  openings: readonly XzRect[] = [],
): FootprintDetail {
  return occupancy(triangles, {
    cellSize,
    openings,
    floorY: FLOOR_Y_M,
    minThickness: MIN_THICKNESS_M,
    minLength: MIN_LENGTH_M,
    bandM: BAND_M,
  });
}

/**
 * Footprint of a raw GLB, in the same units as the vertex positions. Every
 * triangle is projected. The cell is 0.05. A run stays when its long side is
 * at least one cell. This is the measure stencil, not the bake obstacle grid.
 */
export function measureFootprint(triangles: Triangle[]): LocalBox[] {
  return occupancy(triangles, {
    cellSize: MEASURE_CELL_M,
    openings: [],
    floorY: null,
    minThickness: 0,
    minLength: MEASURE_CELL_M,
    bandM: null,
  }).boxes;
}

type OccupancyOptions = {
  cellSize: number;
  openings: readonly XzRect[];
  /** Drop a triangle whose highest vertex is under this. `null` keeps every triangle. */
  floorY: number | null;
  minThickness: number;
  minLength: number;
  /**
   * Vertical band. `null` is the measure stencil: one XZ footprint, Y taken
   * from the triangles that overlap the run.
   */
  bandM: number | null;
};

function occupancy(triangles: Triangle[], options: OccupancyOptions): FootprintDetail {
  const { cellSize, openings } = options;
  if (!(cellSize > 0)) throw new PlanError("cell size must be positive");
  const items = keptTriangles(triangles, options.floorY);
  if (items.length === 0) return { boxes: [], facetsDropped: 0 };
  const columns = new Map<string, Column>();
  for (const item of items) markCells(item, cellSize, columns);
  if (options.bandM != null) addCoveredColumns(items, cellSize, columns);
  for (const opening of openings) eraseOpening(columns, cellSize, opening);
  if (columns.size === 0) return { boxes: [], facetsDropped: 0 };
  if (options.bandM == null) return { boxes: flatFootprint(columns, items, options), facetsDropped: 0 };
  return bandedFootprint(columns, items, triangles, options, options.bandM);
}

/** Measure path. One XZ run, with Y from every triangle whose bounds overlap it. */
function flatFootprint(columns: Map<string, Column>, items: Item[], options: OccupancyOptions): LocalBox[] {
  const geom = new Map<string, Clip>();
  const cells: Array<[number, number]> = [];
  for (const [key, column] of columns) {
    geom.set(key, column.clip);
    cells.push(unpack(key));
  }
  const boxes = [
    ...boxesFromRuns(runsAlongRows(cells), geom),
    ...boxesFromRuns(runsAlongColumns(cells), geom),
  ].map((box) => assignY(box, items));
  return dropContained(dropShort(boxes, options.minThickness, options.minLength));
}

/**
 * Merge the pawn-height cells into runs before dropping any of them. Above
 * that, each 0.5 m band uses the same thick-run and skin-run split, so a
 * sheet or a sliver does not change that band's footprint. Consecutive bands
 * with the same footprint then stack. A higher roof does not raise a lower
 * wall, and the cells under a span stay empty.
 */
function bandedFootprint(
  columns: Map<string, Column>,
  items: Item[],
  triangles: Triangle[],
  options: OccupancyOptions,
  bandM: number,
): FootprintDetail {
  if (!(bandM > 0)) throw new PlanError("band size must be positive");
  for (const item of items) markBands(item, options.cellSize, bandM, columns, options.floorY);
  markCaps(triangles, options.cellSize, columns);
  fillInteriors(columns, bandM, options.floorY);
  const bandIds: number[] = [];
  const seen = new Set<number>();
  for (const column of columns.values()) {
    for (const band of column.bands.keys()) {
      if (seen.has(band)) continue;
      seen.add(band);
      bandIds.push(band);
    }
  }
  bandIds.sort((a, b) => a - b);
  const pawnBands = bandIds.filter((band) => band * bandM < PAWN_TOP_M - EPS);
  const highBands = bandIds.filter((band) => band * bandM >= PAWN_TOP_M - EPS);
  const layered: BandBox[] = [];
  if (pawnBands.length > 0) {
    layered.push(...pawnWalls(columns, pawnBands, options.minThickness, options.minLength));
  }
  for (const band of highBands) {
    layered.push(...pawnWalls(columns, [band], options.minThickness, options.minLength));
  }
  const stacked = stackBands(layered);
  const floorY = options.floorY;
  const aboveFloor = floorY == null ? stacked : stacked.filter((box) => box.maxY >= floorY - EPS);
  const kept = aboveFloor.filter((box) => !isFacet(box, options.minLength));
  return { boxes: kept, facetsDropped: aboveFloor.length - kept.length };
}

/**
 * A facade facet: shorter than a metre on XZ, or under half a cubic metre.
 * A pawn-height surface longer than 1 m is the wall even when the mesh is
 * only about a centimetre thick, so its volume stays under half a cubic metre.
 */
function isFacet(box: LocalBox, minLength: number): boolean {
  const dx = box.maxX - box.minX;
  const dy = box.maxY - box.minY;
  const dz = box.maxZ - box.minZ;
  const long = Math.max(dx, dz);
  if (long < minLength - 1e-4) return true;
  if (dx * dy * dz >= FACET_VOLUME_M3 - 1e-4) return false;
  const blocksPawn = box.minY < PAWN_TOP_M - 1e-4 && box.maxY > FLOOR_Y_M - 1e-4;
  const facade = long > minLength + 1e-4 || (long >= minLength - 1e-4 && Math.min(dx, dz) >= 0.05 - 1e-4);
  return !(blocksPawn && facade);
}

/** 0.5 m grid, or 1 m when the first pass still exceeds `MAX_OBSTACLES`. */
export function coarseFootprint(triangles: Triangle[]): CoarseFootprint {
  const fine = footprintDetail(triangles, CELL_M);
  if (fine.boxes.length <= MAX_OBSTACLES) {
    return { boxes: fine.boxes, cellSize: CELL_M, facetsDropped: fine.facetsDropped };
  }
  const coarse = footprintDetail(triangles, CELL_M * 2);
  return { boxes: coarse.boxes, cellSize: CELL_M * 2, facetsDropped: coarse.facetsDropped };
}

/**
 * Bake drops floor triangles. Measure passes `floorY` null and keeps every
 * triangle. A tessellated wall is made of pieces smaller than a cell; those
 * still paint any center they cover. On the bake grid, a mullion disappears
 * later, when its run is thinner than 0.4 m or shorter than 1 m.
 */
function keptTriangles(triangles: Triangle[], floorY: number | null): Item[] {
  const items: Item[] = [];
  for (const triangle of triangles) {
    const item = itemOf(triangle);
    if (floorY != null && item.maxY < floorY) continue;
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

function markCells(item: Item, cell: number, columns: Map<string, Column>): void {
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
      const prev = columns.get(key);
      if (!prev) columns.set(key, { clip, bands: new Map(), caps: [] });
      else {
        prev.clip.minX = Math.min(prev.clip.minX, clip.minX);
        prev.clip.maxX = Math.max(prev.clip.maxX, clip.maxX);
        prev.clip.minZ = Math.min(prev.clip.minZ, clip.minZ);
        prev.clip.maxZ = Math.max(prev.clip.maxZ, clip.maxZ);
      }
    }
  }
}

type Point = { x: number; y: number; z: number };

type CellHit = Clip & YSpan;

/**
 * The triangle inside one XZ cell. A face that crosses the cell interior
 * counts. A face that only lies on the shared edge with the next cell counts
 * for the cell its volume sits in, so a wall end does not paint the span.
 * A thin wall misses the cell center; the clipped polygon still counts.
 */
function hitInCell(triangle: Triangle, minX: number, maxX: number, minZ: number, maxZ: number): CellHit | null {
  let poly: Point[] = [
    { x: triangle[0][0], y: triangle[0][1], z: triangle[0][2] },
    { x: triangle[1][0], y: triangle[1][1], z: triangle[1][2] },
    { x: triangle[2][0], y: triangle[2][1], z: triangle[2][2] },
  ];
  poly = clipPoly(poly, (p) => p.x >= minX - EPS, (a, b) => lerpAxis(a, b, "x", minX));
  poly = clipPoly(poly, (p) => p.x <= maxX + EPS, (a, b) => lerpAxis(a, b, "x", maxX));
  poly = clipPoly(poly, (p) => p.z >= minZ - EPS, (a, b) => lerpAxis(a, b, "z", minZ));
  poly = clipPoly(poly, (p) => p.z <= maxZ + EPS, (a, b) => lerpAxis(a, b, "z", maxZ));
  if (poly.length === 0) return null;
  let y0 = Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const point of poly) {
    if (point.y < y0) y0 = point.y;
    if (point.y > y1) y1 = point.y;
    if (point.x < x0) x0 = point.x;
    if (point.x > x1) x1 = point.x;
    if (point.z < z0) z0 = point.z;
    if (point.z > z1) z1 = point.z;
  }
  if (!(y1 > y0 + EPS)) return null;
  if (!triangleOwnsCell(triangle, poly, minX, maxX, minZ, maxZ)) return null;
  return { minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 };
}

/**
 * A center test misses a wall thinner than the cell. Add every cell a
 * triangle actually crosses, with a clip of that polygon, so the pawn-height
 * merge sees the whole facade before anything is dropped.
 */
function addCoveredColumns(items: Item[], cell: number, columns: Map<string, Column>): void {
  for (const item of items) {
    const i0 = Math.floor((item.minX - EPS) / cell);
    const i1 = Math.floor((item.maxX + EPS) / cell);
    const k0 = Math.floor((item.minZ - EPS) / cell);
    const k1 = Math.floor((item.maxZ + EPS) / cell);
    for (let k = k0; k <= k1; k += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const hit = hitInCell(item.triangle, i * cell, (i + 1) * cell, k * cell, (k + 1) * cell);
        if (!hit) continue;
        const clip: Clip = { minX: hit.minX, maxX: hit.maxX, minZ: hit.minZ, maxZ: hit.maxZ };
        const key = pack(i, k);
        const prev = columns.get(key);
        if (!prev) {
          columns.set(key, { clip, bands: new Map(), caps: [] });
          continue;
        }
        prev.clip.minX = Math.min(prev.clip.minX, clip.minX);
        prev.clip.maxX = Math.max(prev.clip.maxX, clip.maxX);
        prev.clip.minZ = Math.min(prev.clip.minZ, clip.minZ);
        prev.clip.maxZ = Math.max(prev.clip.maxZ, clip.maxZ);
      }
    }
  }
}

function triangleNormal(triangle: Triangle): { x: number; y: number; z: number } {
  const [a, b, c] = triangle;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return {
    x: uy * vz - uz * vy,
    y: uz * vx - ux * vz,
    z: ux * vy - uy * vx,
  };
}

/**
 * A polygon that reaches the cell interior belongs to it, including a quad
 * whose vertices all sit on the two opposite edges. A polygon that only
 * touches one face belongs to the cell the outward normal leaves, which is
 * the side the volume occupies.
 */
function triangleOwnsCell(
  triangle: Triangle,
  poly: Point[],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  let minPX = Infinity;
  let maxPX = -Infinity;
  let minPZ = Infinity;
  let maxPZ = -Infinity;
  let interiorX = false;
  let interiorZ = false;
  for (const p of poly) {
    if (p.x < minPX) minPX = p.x;
    if (p.x > maxPX) maxPX = p.x;
    if (p.z < minPZ) minPZ = p.z;
    if (p.z > maxPZ) maxPZ = p.z;
    if (p.x > minX + EPS && p.x < maxX - EPS) interiorX = true;
    if (p.z > minZ + EPS && p.z < maxZ - EPS) interiorZ = true;
  }
  if (interiorX && interiorZ) return true;
  const spansX = maxPX > minX + EPS && minPX < maxX - EPS;
  const spansZ = maxPZ > minZ + EPS && minPZ < maxZ - EPS;
  // A clipped quad can put every vertex on the two X edges while the face
  // crosses the cell. That face belongs to this cell.
  if ((interiorX && spansZ) || (interiorZ && spansX)) return true;
  const normal = triangleNormal(triangle);
  const onMinX = poly.every((p) => p.x <= minX + EPS);
  const onMaxX = poly.every((p) => p.x >= maxX - EPS);
  const onMinZ = poly.every((p) => p.z <= minZ + EPS);
  const onMaxZ = poly.every((p) => p.z >= maxZ - EPS);
  if (onMinX && !onMaxX && !onMinZ && !onMaxZ) return normal.x < -EPS;
  if (onMaxX && !onMinX && !onMinZ && !onMaxZ) return normal.x > EPS;
  if (onMinZ && !onMaxZ && !onMinX && !onMaxX) return normal.z < -EPS;
  if (onMaxZ && !onMinZ && !onMinX && !onMaxX) return normal.z > EPS;
  return false;
}

function clipPoly(poly: Point[], inside: (point: Point) => boolean, at: (a: Point, b: Point) => Point): Point[] {
  if (poly.length === 0) return [];
  const out: Point[] = [];
  let prev = poly[poly.length - 1]!;
  let prevIn = inside(prev);
  for (const curr of poly) {
    const currIn = inside(curr);
    if (currIn) {
      if (!prevIn) out.push(at(prev, curr));
      out.push(curr);
    } else if (prevIn) out.push(at(prev, curr));
    prev = curr;
    prevIn = currIn;
  }
  return out;
}

function lerpAxis(a: Point, b: Point, axis: "x" | "z", at: number): Point {
  const delta = b[axis] - a[axis];
  const t = delta === 0 ? 0 : (at - a[axis]) / delta;
  return {
    x: axis === "x" ? at : a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: axis === "z" ? at : a.z + (b.z - a.z) * t,
  };
}

/**
 * Paint bands a triangle actually crosses inside cells the XZ grid already
 * kept. A face on the max edge of a cell is included, so the last solid cell
 * of a wall still receives that side. Flat faces add no band: the sides carry
 * the height, and a sheet at y = 3 does not fill the band under it.
 */
function markBands(
  item: Item,
  cell: number,
  bandM: number,
  columns: Map<string, Column>,
  floorY: number | null,
): void {
  const i0 = Math.floor((item.minX - EPS) / cell);
  const i1 = Math.floor((item.maxX + EPS) / cell);
  const k0 = Math.floor((item.minZ - EPS) / cell);
  const k1 = Math.floor((item.maxZ + EPS) / cell);
  for (let k = k0; k <= k1; k += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const column = columns.get(pack(i, k));
      if (!column) continue;
      const extent = hitInCell(item.triangle, i * cell, (i + 1) * cell, k * cell, (k + 1) * cell);
      if (!extent || !(extent.maxY > extent.minY + EPS)) continue;
      const first = Math.floor(extent.minY / bandM);
      const last = Math.floor((extent.maxY - EPS) / bandM);
      for (let band = first; band <= last; band += 1) {
        const bandMin = band * bandM;
        const bandMax = bandMin + bandM;
        if (floorY != null && bandMax < floorY) continue;
        const lo = Math.max(extent.minY, bandMin);
        const hi = Math.min(extent.maxY, bandMax);
        if (!(hi > lo + EPS)) continue;
        const prev = column.bands.get(band);
        if (!prev) column.bands.set(band, { minY: lo, maxY: hi });
        else {
          if (lo < prev.minY) prev.minY = lo;
          if (hi > prev.maxY) prev.maxY = hi;
        }
      }
    }
  }
}

/**
 * Flat faces do not paint a band. They record the lid and the underside so an
 * interior cell can inherit a neighbor's band between those two heights. A
 * floor under 0.5 m is included here even though the grid dropped it. A span's
 * underside stays an enter, so the cells below it are not between two caps.
 */
function markCaps(triangles: Triangle[], cell: number, columns: Map<string, Column>): void {
  for (const triangle of triangles) {
    const item = itemOf(triangle);
    if (item.maxY - item.minY > EPS) continue;
    const normal = triangleNormal(triangle);
    if (!(Math.abs(normal.y) > EPS)) continue;
    const kind: Cap["kind"] = normal.y > 0 ? "exit" : "enter";
    const y = item.minY;
    const [a, b, c] = triangle;
    const i0 = Math.floor(item.minX / cell);
    const i1 = Math.floor((item.maxX - EPS) / cell);
    const k0 = Math.floor(item.minZ / cell);
    const k1 = Math.floor((item.maxZ - EPS) / cell);
    for (let k = k0; k <= k1; k += 1) {
      const cz = (k + 0.5) * cell;
      for (let i = i0; i <= i1; i += 1) {
        const cx = (i + 0.5) * cell;
        if (!covers(a[0], a[2], b[0], b[2], c[0], c[2], cx, cz)) continue;
        const column = columns.get(pack(i, k));
        if (!column) continue;
        column.caps.push({ y, kind });
      }
    }
  }
}

/** Closed intervals where this cell is inside the mesh, from underside to lid. */
function solidSpans(caps: Cap[]): YSpan[] {
  if (caps.length === 0) return [];
  const events = [...caps].sort((a, b) => a.y - b.y || (a.kind === "enter" ? -1 : 1));
  const spans: YSpan[] = [];
  let depth = 0;
  let start = 0;
  for (const event of events) {
    if (event.kind === "enter") {
      if (depth === 0) start = event.y;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0 && event.y > start + EPS) spans.push({ minY: start, maxY: event.y });
  }
  return spans;
}

/**
 * An interior cell has a lid and an underside but no vertical triangle. Copy
 * a neighbor's band only when that band sits inside this cell's own solid
 * span. The space under a span is outside that span, so it stays empty.
 */
function fillInteriors(columns: Map<string, Column>, bandM: number, floorY: number | null): void {
  const spansOf = new Map<string, YSpan[]>();
  for (const [key, column] of columns) spansOf.set(key, solidSpans(column.caps));
  const queue: Array<{ key: string; band: number }> = [];
  const seen = new Set<string>();
  for (const [key, column] of columns) {
    for (const band of column.bands.keys()) {
      const id = `${key}#${band}`;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push({ key, band });
    }
  }
  for (let n = 0; n < queue.length; n += 1) {
    const { key, band } = queue[n]!;
    const [i, k] = unpack(key);
    const neighbors = [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]] as const;
    for (const [ni, nk] of neighbors) {
      const nkey = pack(ni, nk);
      const id = `${nkey}#${band}`;
      if (seen.has(id)) continue;
      const neighbor = columns.get(nkey);
      if (!neighbor) continue;
      const bandMin = band * bandM;
      const bandMax = bandMin + bandM;
      if (floorY != null && bandMax < floorY) continue;
      const spans = spansOf.get(nkey);
      if (!spans) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const span of spans) {
        const a = Math.max(span.minY, bandMin);
        const b = Math.min(span.maxY, bandMax);
        if (!(b > a + EPS)) continue;
        if (floorY != null && b < floorY) continue;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      if (lo === Infinity) continue;
      neighbor.bands.set(band, { minY: lo, maxY: hi });
      seen.add(id);
      queue.push({ key: nkey, band });
    }
  }
}

/**
 * Cells in these bands merge before anything is dropped. A cell at least
 * 0.1 m thick joins the wall run, so a 0.25 m facade stays one box with the
 * thicker parts of that wall. Thinner cells are skins: parallel skins within
 * 0.5 m join into one wall. A skin longer than 1 m stays, which is the
 * centimetre-thick facade. A skin of exactly 1 m goes, so it does not bridge
 * a doorway. The same split on a band above 2 m keeps a 2 cm sliver from
 * fattening the wall, so that band still stacks onto the pawn-height run.
 */
function pawnWalls(
  columns: Map<string, Column>,
  pawnBands: number[],
  minThickness: number,
  minLength: number,
): BandBox[] {
  const thick: Array<[number, number]> = [];
  const skin: Array<[number, number]> = [];
  for (const [key, column] of columns) {
    if (!pawnBands.some((band) => column.bands.has(band))) continue;
    const [i, k] = unpack(key);
    const dx = column.clip.maxX - column.clip.minX;
    const dz = column.clip.maxZ - column.clip.minZ;
    if (Math.min(dx, dz) >= SHELL_M - 1e-4) thick.push([i, k]);
    else skin.push([i, k]);
  }
  const thickBoxes = dropContainedBands([
    ...boxesForBands(cutRuns(runsAlongRows(thick), columns), columns, pawnBands),
    ...boxesForBands(cutRuns(runsAlongColumns(thick), columns), columns, pawnBands),
  ]);
  const skinBoxes = weldSkins([
    ...boxesForBands(cutRuns(runsAlongRows(skin), columns), columns, pawnBands),
    ...boxesForBands(cutRuns(runsAlongColumns(skin), columns), columns, pawnBands),
  ]);
  return dropContainedBands(dropFlushSkins(keepWalls([...thickBoxes, ...skinBoxes], minThickness, minLength)));
}

/**
 * A 2 cm lip sitting on the face of a thicker run is the same wall. A facade
 * with no thicker run behind it stays, and so does a second skin 0.48 m away.
 */
function dropFlushSkins(boxes: BandBox[]): BandBox[] {
  return boxes.filter((box) => {
    const dx = box.maxX - box.minX;
    const dz = box.maxZ - box.minZ;
    if (Math.min(dx, dz) >= SHELL_M - 1e-4) return true;
    return !boxes.some((other) => other !== box && flushWithThicker(box, other));
  });
}

function flushWithThicker(skin: BandBox, other: BandBox): boolean {
  const skinDx = skin.maxX - skin.minX;
  const skinDz = skin.maxZ - skin.minZ;
  const overlapX = Math.min(skin.maxX, other.maxX) - Math.max(skin.minX, other.minX);
  const overlapZ = Math.min(skin.maxZ, other.maxZ) - Math.max(skin.minZ, other.minZ);
  // The lip runs along the wall. Touching only at an end is a neighbouring bay, not a lip.
  if (skinDx >= skinDz) {
    return overlapX >= 0.8 * skinDx - 1e-4
      && gap1d(skin.minZ, skin.maxZ, other.minZ, other.maxZ) <= 1e-4
      && other.maxZ - other.minZ > skinDz + 1e-4;
  }
  return overlapZ >= 0.8 * skinDz - 1e-4
    && gap1d(skin.minX, skin.maxX, other.minX, other.maxX) <= 1e-4
    && other.maxX - other.minX > skinDx + 1e-4;
}

/** Split a rectangle where either axis has a clip hole, so a doorway does not stay inside one box. */
function cutRuns(runs: Run[], columns: Map<string, Column>): Run[] {
  return splitHoles(splitHoles(runs, columns, "i"), columns, "k");
}

/** Join parallel thin faces whose gap is at most `BRIDGE_M` and whose lengths match. */
function weldSkins(boxes: BandBox[]): BandBox[] {
  const open = boxes.map((box) => ({ ...box }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < open.length; a += 1) {
      let joined = false;
      for (let b = a + 1; b < open.length; b += 1) {
        const next = joinSkins(open[a]!, open[b]!);
        if (!next) continue;
        open.splice(b, 1);
        open.splice(a, 1, next);
        merged = true;
        joined = true;
        break;
      }
      if (joined) break;
    }
  }
  return open;
}

function joinSkins(a: BandBox, b: BandBox): BandBox | null {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  const lenAX = a.maxX - a.minX;
  const lenBX = b.maxX - b.minX;
  const lenAZ = a.maxZ - a.minZ;
  const lenBZ = b.maxZ - b.minZ;
  const alongX = overlapX > BRIDGE_M
    && overlapX >= 0.8 * lenAX - 1e-4
    && overlapX >= 0.8 * lenBX - 1e-4
    && gap1d(a.minZ, a.maxZ, b.minZ, b.maxZ) <= BRIDGE_M + 1e-4;
  const alongZ = overlapZ > BRIDGE_M
    && overlapZ >= 0.8 * lenAZ - 1e-4
    && overlapZ >= 0.8 * lenBZ - 1e-4
    && gap1d(a.minX, a.maxX, b.minX, b.maxX) <= BRIDGE_M + 1e-4;
  if (!alongX && !alongZ) return null;
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ),
    band0: Math.min(a.band0, b.band0),
    band1: Math.max(a.band1, b.band1),
  };
}

function gap1d(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 < b0) return b0 - a1;
  if (b1 < a0) return a0 - b1;
  return 0;
}

/** Cut a run where neighboring clips leave a hole wider than `BRIDGE_M`. A solid rectangle stays one run. */
function splitHoles(runs: Run[], columns: Map<string, Column>, along: "i" | "k"): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const a0 = along === "i" ? run.i0 : run.k0;
    const a1 = along === "i" ? run.i1 : run.k1;
    let start = a0;
    const push = (from: number, to: number) => {
      if (from > to) return;
      if (along === "i") out.push({ i0: from, i1: to, k0: run.k0, k1: run.k1 });
      else out.push({ i0: run.i0, i1: run.i1, k0: from, k1: to });
    };
    for (let n = a0 + 1; n <= a1; n += 1) {
      let hole = false;
      if (along === "i") {
        for (let k = run.k0; k <= run.k1 && !hole; k += 1) {
          const left = columns.get(pack(n - 1, k));
          const right = columns.get(pack(n, k));
          if (!left || !right) hole = true;
          else hole = gap1d(left.clip.minX, left.clip.maxX, right.clip.minX, right.clip.maxX) > BRIDGE_M + 1e-4;
        }
      } else {
        for (let i = run.i0; i <= run.i1 && !hole; i += 1) {
          const left = columns.get(pack(i, n - 1));
          const right = columns.get(pack(i, n));
          if (!left || !right) hole = true;
          else hole = gap1d(left.clip.minZ, left.clip.maxZ, right.clip.minZ, right.clip.maxZ) > BRIDGE_M + 1e-4;
        }
      }
      if (hole) {
        push(start, n - 1);
        start = n;
      }
    }
    push(start, a1);
  }
  return out;
}

/**
 * One merged run. `bands` is either the pawn-height slices together, or a
 * single elevated slice. Y is the mesh in those slices, and the band indexes
 * are the slices that actually contributed, so a later slice can stack.
 */
function boxesForBands(runs: Run[], columns: Map<string, Column>, bands: number[]): BandBox[] {
  const wanted = new Set(bands);
  const boxes: BandBox[] = [];
  for (const run of runs) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let band0 = Infinity;
    let band1 = -Infinity;
    for (let k = run.k0; k <= run.k1; k += 1) {
      for (let i = run.i0; i <= run.i1; i += 1) {
        const column = columns.get(pack(i, k));
        if (!column) continue;
        let hit = false;
        for (const [band, span] of column.bands) {
          if (!wanted.has(band)) continue;
          hit = true;
          if (span.minY < minY) minY = span.minY;
          if (span.maxY > maxY) maxY = span.maxY;
          if (band < band0) band0 = band;
          if (band > band1) band1 = band;
        }
        if (!hit) continue;
        const clip = column.clip;
        if (clip.minX < minX) minX = clip.minX;
        if (clip.maxX > maxX) maxX = clip.maxX;
        if (clip.minZ < minZ) minZ = clip.minZ;
        if (clip.maxZ > maxZ) maxZ = clip.maxZ;
      }
    }
    if (minX === Infinity) continue;
    boxes.push({ minX, maxX, minY, maxY, minZ, maxZ, band0, band1 });
  }
  return boxes;
}

/**
 * Consecutive bands with the same footprint become one volume. A gap of one
 * band stays open, so the space under a span is not filled down to the floor.
 * The top is the mesh in the highest band, not the building max and not the
 * next band's ceiling.
 */
function stackBands(boxes: BandBox[]): LocalBox[] {
  const sorted = [...boxes].sort((a, b) => a.minX - b.minX || a.minZ - b.minZ || a.maxX - b.maxX || a.maxZ - b.maxZ || a.band0 - b.band0);
  const stacked: BandBox[] = [];
  for (const box of sorted) {
    let joined = false;
    for (let n = stacked.length - 1; n >= 0; n -= 1) {
      const last = stacked[n]!;
      if (last.band1 + 1 !== box.band0 || !nearXz(last, box)) continue;
      last.band1 = box.band1;
      if (box.maxY > last.maxY) last.maxY = box.maxY;
      if (box.minY < last.minY) last.minY = box.minY;
      joined = true;
      break;
    }
    if (!joined) stacked.push({ ...box });
  }
  const out = stacked.map((box) => ({
    minX: box.minX,
    maxX: box.maxX,
    minY: box.minY,
    maxY: box.maxY,
    minZ: box.minZ,
    maxZ: box.maxZ,
  }));
  out.sort((a, b) => a.minX - b.minX || a.minZ - b.minZ || a.maxX - b.maxX || a.maxZ - b.maxZ || a.minY - b.minY);
  return out;
}

function dropContainedBands(boxes: BandBox[]): BandBox[] {
  const unique: BandBox[] = [];
  for (const box of boxes) {
    if (!unique.some((other) => sameXz(other, box))) unique.push(box);
  }
  const kept = unique.filter((box, index) => !unique.some((other, otherIndex) =>
    otherIndex !== index && containsXz(other, box) && area(other) > area(box) + EPS,
  ));
  kept.sort((a, b) => a.minX - b.minX || a.minZ - b.minZ || a.maxX - b.maxX || a.maxZ - b.maxZ || a.minY - b.minY);
  return kept;
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

/**
 * Drop every solid cell the opening overlaps, including a cell the rectangle
 * only partly covers. A center-only test can leave a jamb inside the door.
 */
function eraseOpening(columns: Map<string, Column>, cell: number, opening: XzRect): void {
  if (!(opening.maxX > opening.minX) || !(opening.maxZ > opening.minZ)) return;
  const doomed: string[] = [];
  for (const key of columns.keys()) {
    const [i, k] = unpack(key);
    const x0 = i * cell;
    const z0 = k * cell;
    if (x0 + cell > opening.minX && x0 < opening.maxX && z0 + cell > opening.minZ && z0 < opening.maxZ) {
      doomed.push(key);
    }
  }
  for (const key of doomed) columns.delete(key);
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

function dropShort<T extends LocalBox>(boxes: T[], minThickness: number, minLength: number): T[] {
  return boxes.filter((box) => {
    const dx = box.maxX - box.minX;
    const dz = box.maxZ - box.minZ;
    return Math.min(dx, dz) >= minThickness - 1e-4 && Math.max(dx, dz) >= minLength - 1e-4;
  });
}

/**
 * A short run is a mullion and goes. A run 0.4 m thick stays. A shell between
 * 0.1 m and 0.4 m stays when it is at least 1 m long and half a cubic metre.
 * A still thinner surface stays when it is longer than 1 m: that is the
 * centimetre-thick facade. A sheet of exactly 1 m goes, so it cannot seal a
 * doorway.
 */
function keepWalls<T extends LocalBox>(boxes: T[], minThickness: number, minLength: number): T[] {
  return boxes.filter((box) => {
    const dx = box.maxX - box.minX;
    const dy = box.maxY - box.minY;
    const dz = box.maxZ - box.minZ;
    const long = Math.max(dx, dz);
    const thin = Math.min(dx, dz);
    if (long < minLength - 1e-4) return false;
    if (thin >= minThickness - 1e-4) return true;
    // Longer than 1 m is the facade. Exactly 1 m stays when the run is at
    // least 5 cm thick: the 1 m cell leaves that between piers. A 2 cm sheet
    // of exactly 1 m is the doorway and stays out.
    if (thin < SHELL_M - 1e-4) {
      return long > minLength + 1e-4 || (long >= minLength - 1e-4 && thin >= 0.05 - 1e-4);
    }
    return dx * dy * dz >= FACET_VOLUME_M3 - 1e-4;
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

/** Close enough to be the same wall seen in the next band, not a second wall. */
function nearXz(a: LocalBox, b: LocalBox): boolean {
  return Math.abs(a.minX - b.minX) <= STACK_XZ_M
    && Math.abs(a.maxX - b.maxX) <= STACK_XZ_M
    && Math.abs(a.minZ - b.minZ) <= STACK_XZ_M
    && Math.abs(a.maxZ - b.maxZ) <= STACK_XZ_M;
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
