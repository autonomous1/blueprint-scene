/**
 * Walkable region adjacency for one flat floor. The bake writes `regions.json`
 * beside `scene-graph.json`. Doors stay open here: the arena overlays a shut leaf.
 *
 * Blockers are inflated by the pawn radius first, so a free rectangle is
 * space the capsule centre can occupy. A shared edge of any positive length
 * is already the usable aperture (the geometric gap inset by the radius).
 */
import { PlanError } from "./errors.ts";
import type { SceneGraphFile } from "./scene-graph.ts";
import type { Vec3 } from "./types.ts";

export const DEFAULT_RADIUS = 0.5;
export const DEFAULT_HEIGHT = 1.8;
/** A box whose top is at most this far above the stand is a step, not a wall. */
export const STEP_HEIGHT = 0.3;

export type Region = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
};

export type RegionPortal = {
  from: string;
  to: string;
  /** Usable shared-boundary endpoints (already inset by radius). */
  left: Vec3;
  right: Vec3;
  width: number;
};

export type RegionGraph = {
  placeId: string;
  regions: Region[];
  portals: RegionPortal[];
};

export type DoorStand = {
  doorId: string;
  side: "a" | "b";
  regionId: string;
  at: Vec3;
};

export type BakedPlaceRegions = {
  placeId: string;
  regions: Region[];
  portals: RegionPortal[];
  doorStands?: DoorStand[];
};

export type BakedRegionsFile = {
  version: 1;
  radius: number;
  height: number;
  places: BakedPlaceRegions[];
};

export type RegionPlace = {
  id: string;
  y: number;
  polygon: Array<[number, number]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export type RegionBox = {
  id?: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
};

export type RegionOptions = {
  radius: number;
  height: number;
  /** Shaft footprints. A cell that meets one is not walkable. */
  block?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
};

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

type Built = Region & { index: number };

const SNAP = 0.5;
const Y_BAND = STEP_HEIGHT;
const SLIVER = 1e-4;
const QUANT = 1e6;

const WALK: ReadonlySet<string> = new Set(["room", "hall", "platform", "outside"]);

export function buildRegions(place: RegionPlace, boxes: readonly RegionBox[], opts: RegionOptions): RegionGraph {
  const radius = opts.radius > 0 ? opts.radius : 0;
  const height = opts.height > 0 ? opts.height : 0;
  const bounds = place.bounds;
  const empty: RegionGraph = { placeId: place.id, regions: [], portals: [] };
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) return empty;
  if (place.polygon.length < 3) return empty;

  const blocked = blockerRects(boxes, bounds, radius, place.y, height);
  const solid: Array<ReadonlyArray<readonly [number, number]>> = [];
  for (const poly of opts.block ?? []) {
    const rect = axisRect(poly);
    if (!rect) {
      solid.push(poly);
      continue;
    }
    if (rect.maxX <= bounds.minX || rect.minX >= bounds.maxX) continue;
    if (rect.maxZ <= bounds.minZ || rect.minZ >= bounds.maxZ) continue;
    blocked.push(rect);
  }

  const extraX = place.polygon.map((point) => point[0]);
  const extraZ = place.polygon.map((point) => point[1]);
  for (const poly of solid) {
    for (const point of poly) {
      extraX.push(point[0]);
      extraZ.push(point[1]);
    }
  }
  const xs = splitCoords(bounds.minX, bounds.maxX, blocked.map((rect) => [rect.minX, rect.maxX]), extraX);
  const zs = splitCoords(bounds.minZ, bounds.maxZ, blocked.map((rect) => [rect.minZ, rect.maxZ]), extraZ);
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  if (nx <= 0 || nz <= 0) return empty;

  const free = new Uint8Array(nx * nz);
  const rectangular = rectPolygon(place.polygon, bounds);
  for (let j = 0; j < nz; j += 1) {
    const z0 = zs[j]!;
    const z1 = zs[j + 1]!;
    if (z1 - z0 <= SLIVER) continue;
    const cz = (z0 + z1) * 0.5;
    for (let i = 0; i < nx; i += 1) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      if (x1 - x0 <= SLIVER) continue;
      const cx = (x0 + x1) * 0.5;
      if (!rectangular && !pointInPolygon(place.polygon, cx, cz)) continue;
      if (insideAny(solid, cx, cz)) continue;
      free[j * nx + i] = 1;
    }
  }
  for (const rect of blocked) stamp(free, xs, zs, rect);

  const { regions, regionOf } = mergeCells(free, xs, zs, nx, nz, place.y);
  const portals = portalsOf(regions, regionOf, xs, zs, nx, nz);
  return {
    placeId: place.id,
    regions: regions.map(strip),
    portals,
  };
}

/**
 * Partition every walkable place. Shafts, cab rooms, stairs, and landings are omitted.
 * Elevator-room obstacles are dropped: those walls ride with the cab.
 * `boxes` are static world AABBs (buildings, props, room shells). An empty list is valid.
 */
export function bakeWalkableRegions(
  graph: SceneGraphFile,
  boxes: readonly RegionBox[],
  radius = DEFAULT_RADIUS,
  height = DEFAULT_HEIGHT,
): BakedRegionsFile {
  const skip = new Set<string>();
  const prefixes: string[] = [];
  const shafts: RegionPlace[] = [];
  for (const place of graph.places) {
    if (place.kind !== "elevator" || !("stops" in place)) continue;
    skip.add(place.id);
    place.stops.forEach((_, index) => skip.add(`${place.id}@${index}`));
    if (place.room) {
      skip.add(place.room);
      prefixes.push(`${place.room}.`);
    }
    shafts.push(place);
  }
  const kept = prefixes.length === 0
    ? boxes
    : boxes.filter((box) => {
      const id = box.id;
      return !id || !prefixes.some((prefix) => id.startsWith(prefix));
    });

  const built = new Map<string, RegionGraph>();
  const places: BakedPlaceRegions[] = [];
  for (const place of graph.places) {
    if (!WALK.has(place.kind) || skip.has(place.id)) continue;
    const block: Array<Array<[number, number]>> = [];
    for (const shaft of shafts) {
      if (!boundsOverlap(shaft.bounds, place.bounds)) continue;
      block.push(shaft.polygon.map((point) => [point[0], point[1]]));
    }
    const regions = buildRegions(place, kept, { radius, height, block });
    built.set(place.id, regions);
    places.push({ placeId: place.id, regions: regions.regions, portals: regions.portals });
  }
  places.sort((a, b) => cmp(a.placeId, b.placeId));
  attachDoorStands(graph, built, places);
  return { version: 1, radius, height, places };
}

/** Placement-file `obstacles`. Missing or non-aabb entries fail the bake. */
export function obstaclesFrom(value: unknown, filePath: string): RegionBox[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanError(`${filePath} has no obstacles`);
  }
  const obstacles = (value as { obstacles?: unknown }).obstacles;
  if (!Array.isArray(obstacles)) throw new PlanError(`${filePath} has no obstacles`);
  const boxes: RegionBox[] = [];
  obstacles.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PlanError(`${filePath} obstacles[${index}] is not an aabb`);
    }
    const rec = item as { id?: unknown; kind?: unknown; min?: unknown; max?: unknown };
    if (rec.kind !== "aabb" || !Array.isArray(rec.min) || !Array.isArray(rec.max) || rec.min.length < 3 || rec.max.length < 3) {
      throw new PlanError(`${filePath} obstacles[${index}] is not an aabb`);
    }
    const min = coords(rec.min, filePath, index, "min");
    const max = coords(rec.max, filePath, index, "max");
    boxes.push({
      ...(typeof rec.id === "string" ? { id: rec.id } : {}),
      minX: min[0],
      maxX: max[0],
      minY: min[1],
      maxY: max[1],
      minZ: min[2],
      maxZ: max[2],
    });
  });
  return boxes;
}

function coords(value: unknown[], filePath: string, index: number, end: "min" | "max"): Vec3 {
  const out: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const n = value[axis];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new PlanError(`${filePath} obstacles[${index}].${end} is not a point`);
    }
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!];
}

function attachDoorStands(
  graph: SceneGraphFile,
  built: ReadonlyMap<string, RegionGraph>,
  places: BakedPlaceRegions[],
): void {
  const extra = new Map<string, DoorStand[]>();
  for (const portal of graph.portals) {
    if (portal.kind !== "door" || !portal.door) continue;
    for (const side of ["a", "b"] as const) {
      const placeId = portal[side];
      const regions = built.get(placeId);
      if (!regions) continue;
      const at = portal.at[side];
      const regionId = standRegion(regions.regions, at);
      if (!regionId) continue;
      const list = extra.get(placeId);
      const stand: DoorStand = { doorId: portal.door, side, regionId, at };
      if (list) list.push(stand);
      else extra.set(placeId, [stand]);
    }
  }
  for (const place of places) {
    const stands = extra.get(place.placeId);
    if (!stands || stands.length === 0) continue;
    stands.sort((a, b) => cmp(a.doorId, b.doorId) || cmp(a.side, b.side));
    place.doorStands = stands;
  }
}

function standRegion(regions: readonly Region[], point: Vec3): string | undefined {
  let inside: Region | undefined;
  for (const region of regions) {
    if (!yNear(region.y, point[1])) continue;
    if (point[0] < region.minX || point[0] > region.maxX || point[2] < region.minZ || point[2] > region.maxZ) continue;
    if (!inside || region.id < inside.id) inside = region;
  }
  if (inside) return inside.id;

  let best: Region | undefined;
  let bestDist = SNAP;
  for (const region of regions) {
    if (!yNear(region.y, point[1])) continue;
    const x = clamp(point[0], region.minX, region.maxX);
    const z = clamp(point[2], region.minZ, region.maxZ);
    const dist = Math.hypot(x - point[0], z - point[2]);
    if (dist > SNAP) continue;
    if (best && (dist > bestDist || (dist === bestDist && region.id >= best.id))) continue;
    best = region;
    bestDist = dist;
  }
  return best?.id;
}

function yNear(floorY: number, pointY: number): boolean {
  return Math.abs(pointY - floorY) <= Y_BAND + 1e-4;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function boundsOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function strip(region: Built): Region {
  return { id: region.id, minX: region.minX, maxX: region.maxX, minZ: region.minZ, maxZ: region.maxZ, y: region.y };
}

function blockerRects(
  boxes: readonly RegionBox[],
  bounds: RegionPlace["bounds"],
  radius: number,
  baseY: number,
  height: number,
): Rect[] {
  const bodyLo = baseY + STEP_HEIGHT;
  const bodyHi = baseY + height;
  const out: Rect[] = [];
  for (const box of boxes) {
    if (!hitsBody(box, bodyLo, bodyHi)) continue;
    const minX = Math.min(box.minX, box.maxX) - radius;
    const maxX = Math.max(box.minX, box.maxX) + radius;
    const minZ = Math.min(box.minZ, box.maxZ) - radius;
    const maxZ = Math.max(box.minZ, box.maxZ) + radius;
    if (maxX <= bounds.minX || minX >= bounds.maxX || maxZ <= bounds.minZ || minZ >= bounds.maxZ) continue;
    out.push({ minX, maxX, minZ, maxZ });
  }
  return out;
}

/** A box with no vertical span blocks every height. A step at most `STEP_HEIGHT` does not. */
function hitsBody(box: RegionBox, bodyLo: number, bodyHi: number): boolean {
  if (box.minY === undefined || box.maxY === undefined) return true;
  if (!Number.isFinite(box.minY) || !Number.isFinite(box.maxY)) return true;
  const lo = Math.min(box.minY, box.maxY);
  const hi = Math.max(box.minY, box.maxY);
  return !(hi <= bodyLo || lo >= bodyHi);
}

function axisRect(poly: ReadonlyArray<readonly [number, number]>): Rect | undefined {
  if (poly.length < 3) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return undefined;
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minZ) minZ = a[1];
    if (a[1] > maxZ) maxZ = a[1];
  }
  if (!(maxX > minX) || !(maxZ > minZ)) return undefined;
  return { minX, maxX, minZ, maxZ };
}

function rectPolygon(polygon: ReadonlyArray<readonly [number, number]>, bounds: RegionPlace["bounds"]): boolean {
  if (polygon.length !== 4) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return false;
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minZ) minZ = a[1];
    if (a[1] > maxZ) maxZ = a[1];
  }
  return Math.abs(minX - bounds.minX) <= 1e-4
    && Math.abs(maxX - bounds.maxX) <= 1e-4
    && Math.abs(minZ - bounds.minZ) <= 1e-4
    && Math.abs(maxZ - bounds.maxZ) <= 1e-4;
}

function splitCoords(min: number, max: number, edges: ReadonlyArray<readonly number[]>, extra: readonly number[]): number[] {
  const values: number[] = [quant(min), quant(max)];
  for (const group of edges) {
    for (const value of group) {
      const q = quant(value);
      if (q > min && q < max) values.push(q);
    }
  }
  for (const value of extra) {
    const q = quant(value);
    if (q > min && q < max) values.push(q);
  }
  values.sort((a, b) => a - b);
  const end = quant(max);
  const out: number[] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push(value);
      continue;
    }
    if (value - last <= SLIVER) {
      if (value === end) out[out.length - 1] = value;
      continue;
    }
    out.push(value);
  }
  return out;
}

function quant(value: number): number {
  return Math.round(value * QUANT) / QUANT;
}

function pointInPolygon(polygon: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]![0];
    const zi = polygon[i]![1];
    const xj = polygon[j]![0];
    const zj = polygon[j]![1];
    const crosses = (zi > z) !== (zj > z);
    if (!crosses) continue;
    const at = ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (x < at) inside = !inside;
  }
  return inside;
}

function insideAny(polys: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, x: number, z: number): boolean {
  for (const poly of polys) {
    if (pointInPolygon(poly, x, z)) return true;
  }
  return false;
}

function stamp(free: Uint8Array, xs: readonly number[], zs: readonly number[], rect: Rect): void {
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  let i0 = 0;
  while (i0 < nx && !(xs[i0 + 1]! > rect.minX)) i0 += 1;
  let i1 = nx - 1;
  while (i1 >= i0 && !(xs[i1]! < rect.maxX)) i1 -= 1;
  let j0 = 0;
  while (j0 < nz && !(zs[j0 + 1]! > rect.minZ)) j0 += 1;
  let j1 = nz - 1;
  while (j1 >= j0 && !(zs[j1]! < rect.maxZ)) j1 -= 1;
  for (let j = j0; j <= j1; j += 1) {
    const row = j * nx;
    for (let i = i0; i <= i1; i += 1) {
      const overlapX = Math.min(xs[i + 1]!, rect.maxX) - Math.max(xs[i]!, rect.minX);
      const overlapZ = Math.min(zs[j + 1]!, rect.maxZ) - Math.max(zs[j]!, rect.minZ);
      if (overlapX > 1e-9 && overlapZ > 1e-9) free[row + i] = 0;
    }
  }
}

function mergeCells(
  free: Uint8Array,
  xs: readonly number[],
  zs: readonly number[],
  nx: number,
  nz: number,
  y: number,
): { regions: Built[]; regionOf: Int32Array } {
  const regionOf = new Int32Array(nx * nz);
  regionOf.fill(-1);
  const regions: Built[] = [];
  let prev = new Map<string, number>();
  for (let j = 0; j < nz; j += 1) {
    const next = new Map<string, number>();
    let i = 0;
    while (i < nx) {
      if (free[j * nx + i] === 0) {
        i += 1;
        continue;
      }
      const i0 = i;
      while (i < nx && free[j * nx + i] === 1) i += 1;
      const key = `${i0},${i}`;
      const extend = prev.get(key);
      if (extend !== undefined) {
        const region = regions[extend]!;
        region.maxZ = zs[j + 1]!;
        for (let k = i0; k < i; k += 1) regionOf[j * nx + k] = extend;
        next.set(key, extend);
        continue;
      }
      const index = regions.length;
      regions.push({
        index,
        id: `r${index}`,
        minX: xs[i0]!,
        maxX: xs[i]!,
        minZ: zs[j]!,
        maxZ: zs[j + 1]!,
        y,
      });
      for (let k = i0; k < i; k += 1) regionOf[j * nx + k] = index;
      next.set(key, index);
    }
    prev = next;
  }
  return { regions, regionOf };
}

function portalsOf(
  regions: readonly Built[],
  regionOf: Int32Array,
  xs: readonly number[],
  zs: readonly number[],
  nx: number,
  nz: number,
): RegionPortal[] {
  const groups = new Map<string, Array<{ lo: number; hi: number }>>();
  const meta = new Map<string, { a: number; b: number; axis: 0 | 1; at: number }>();
  const add = (left: number, right: number, axis: 0 | 1, at: number, lo: number, hi: number): void => {
    if (left < 0 || right < 0 || left === right) return;
    let a = left;
    let b = right;
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    const key = `${a}|${b}|${axis}|${at}`;
    const list = groups.get(key);
    if (list) list.push({ lo, hi });
    else groups.set(key, [{ lo, hi }]);
    if (!meta.has(key)) meta.set(key, { a, b, axis, at });
  };
  for (let j = 0; j < nz; j += 1) {
    for (let i = 1; i < nx; i += 1) {
      add(regionOf[j * nx + i - 1]!, regionOf[j * nx + i]!, 0, xs[i]!, zs[j]!, zs[j + 1]!);
    }
  }
  for (let j = 1; j < nz; j += 1) {
    const row = j * nx;
    const above = row - nx;
    for (let i = 0; i < nx; i += 1) add(regionOf[above + i]!, regionOf[row + i]!, 1, zs[j]!, xs[i]!, xs[i + 1]!);
  }

  const portals: RegionPortal[] = [];
  for (const [key, pieces] of groups) {
    const info = meta.get(key)!;
    pieces.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
    let lo = pieces[0]!.lo;
    let hi = pieces[0]!.hi;
    const emit = (from: number, to: number): void => {
      const width = to - from;
      if (!(width > SLIVER)) return;
      const regionA = regions[info.a]!;
      const regionB = regions[info.b]!;
      const ends = orientEnds(info.axis, info.at, from, to, regionA, regionB);
      portals.push({ from: regionA.id, to: regionB.id, left: ends.left, right: ends.right, width });
    };
    for (let n = 1; n < pieces.length; n += 1) {
      const piece = pieces[n]!;
      if (piece.lo <= hi + 1e-6) hi = Math.max(hi, piece.hi);
      else {
        emit(lo, hi);
        lo = piece.lo;
        hi = piece.hi;
      }
    }
    emit(lo, hi);
  }
  portals.sort(portalOrder);
  return portals;
}

function portalOrder(a: RegionPortal, b: RegionPortal): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return a.left[0] - b.left[0] || a.left[2] - b.left[2];
}

/** `left` is to the left of travel from `from` to `to` when +Y is up. */
function orientEnds(
  axis: 0 | 1,
  at: number,
  lo: number,
  hi: number,
  from: Built,
  to: Built,
): { left: Vec3; right: Vec3 } {
  const p: Vec3 = axis === 0 ? [at, from.y, lo] : [lo, from.y, at];
  const q: Vec3 = axis === 0 ? [at, from.y, hi] : [hi, from.y, at];
  const dx = (to.minX + to.maxX) * 0.5 - (from.minX + from.maxX) * 0.5;
  const dz = (to.minZ + to.maxZ) * 0.5 - (from.minZ + from.maxZ) * 0.5;
  const cross = dx * (q[2] - p[2]) - dz * (q[0] - p[0]);
  if (cross > 0) return { left: q, right: p };
  return { left: p, right: q };
}
