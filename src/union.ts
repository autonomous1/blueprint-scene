import { PlanError } from "./errors.ts";

/** Axis-aligned rectangle on the ground plane. */
export type Aabb2 = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type XzPoint = { x: number; z: number };

/**
 * One closed ring of the union. `area > 0` is an outer contour,
 * counter-clockwise in XZ (x to the right, z up). `area < 0` is a hole.
 */
export type Ring = { points: XzPoint[]; area: number };

const EPS = 1e-6;

/**
 * Union axis-aligned boxes the way Inkscape Path → Union does.
 * Walk with the solid on the left. A square (0,0)–(1,1) is
 * (0,0) → (1,0) → (1,1) → (0,1). A fully enclosed courtyard is a
 * clockwise hole. Boxes that only share a corner stay separate rings.
 */
export function unionAabbs(boxes: readonly Aabb2[]): Ring[] {
  const live = boxes.filter((box) => box.maxX > box.minX + EPS && box.maxZ > box.minZ + EPS);
  if (live.length === 0) return [];
  const xs = uniqueSorted(live.flatMap((box) => [box.minX, box.maxX]));
  const zs = uniqueSorted(live.flatMap((box) => [box.minZ, box.maxZ]));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const solid: boolean[][] = [];
  for (let k = 0; k < nz; k += 1) {
    const row: boolean[] = [];
    const z0 = zs[k]!;
    const z1 = zs[k + 1]!;
    const cz = (z0 + z1) / 2;
    for (let i = 0; i < nx; i += 1) {
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      row.push(live.some((box) => cx >= box.minX && cx <= box.maxX && cz >= box.minZ && cz <= box.maxZ));
    }
    solid.push(row);
  }

  const outgoing = new Map<string, string[]>();
  const addEdge = (ax: number, az: number, bx: number, bz: number): void => {
    const from = key(ax, az);
    const to = key(bx, bz);
    const list = outgoing.get(from);
    if (!list) outgoing.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (let k = 0; k < nz; k += 1) {
    for (let i = 0; i < nx; i += 1) {
      if (!solid[k]![i]) continue;
      // Solid on the left of each directed edge: +x along the bottom, +z up the right side.
      if (k === 0 || !solid[k - 1]![i]) addEdge(i, k, i + 1, k);
      if (i + 1 === nx || !solid[k]![i + 1]) addEdge(i + 1, k, i + 1, k + 1);
      if (k + 1 === nz || !solid[k + 1]![i]) addEdge(i + 1, k + 1, i, k + 1);
      if (i === 0 || !solid[k]![i - 1]) addEdge(i, k + 1, i, k);
    }
  }

  const unused = new Map<string, Set<string>>();
  const starts: Array<[string, string]> = [];
  for (const [from, tos] of outgoing) {
    unused.set(from, new Set(tos));
    for (const to of tos) starts.push([from, to]);
  }

  const rings: Ring[] = [];
  for (const [from, to] of starts) {
    if (!unused.get(from)?.has(to)) continue;
    const points = simplify(trace(from, to, unused, xs, zs));
    if (points.length < 3) continue;
    const area = signedArea(points);
    if (Math.abs(area) < 1e-8) continue;
    rings.push({ points: canonicalize(points), area });
  }
  rings.sort((a, b) => {
    const ax = Math.min(...a.points.map((point) => point.x));
    const bx = Math.min(...b.points.map((point) => point.x));
    if (Math.abs(ax - bx) > 1e-9) return ax - bx;
    const az = Math.min(...a.points.map((point) => point.z));
    const bz = Math.min(...b.points.map((point) => point.z));
    if (Math.abs(az - bz) > 1e-9) return az - bz;
    return Math.abs(b.area) - Math.abs(a.area);
  });
  return rings;
}

function trace(
  startFrom: string,
  startTo: string,
  unused: Map<string, Set<string>>,
  xs: number[],
  zs: number[],
): XzPoint[] {
  const points: XzPoint[] = [pointOf(startFrom, xs, zs)];
  let prev = startFrom;
  let curr = startTo;
  consume(unused, prev, curr);
  const limit = xs.length * zs.length * 4 + 2;
  for (let step = 0; step < limit; step += 1) {
    if (curr === startFrom) return points;
    points.push(pointOf(curr, xs, zs));
    const next = choose(prev, curr, unused);
    consume(unused, curr, next);
    prev = curr;
    curr = next;
  }
  throw new PlanError("wall union did not close");
}

/** Smallest counter-clockwise turn from the incoming edge. Straight is 0, a left corner is π/2. */
function choose(prev: string, curr: string, unused: Map<string, Set<string>>): string {
  const nexts = [...(unused.get(curr) ?? [])];
  if (nexts.length === 0) throw new PlanError("wall union did not close");
  if (nexts.length === 1) return nexts[0]!;
  const incoming = delta(prev, curr);
  let best = nexts[0]!;
  let bestAngle = Infinity;
  for (const next of nexts) {
    const outgoing = delta(curr, next);
    const cross = incoming.dx * outgoing.dz - incoming.dz * outgoing.dx;
    const dot = incoming.dx * outgoing.dx + incoming.dz * outgoing.dz;
    let angle = Math.atan2(cross, dot);
    if (angle < 0) angle += Math.PI * 2;
    if (angle < bestAngle) {
      bestAngle = angle;
      best = next;
    }
  }
  return best;
}

function consume(unused: Map<string, Set<string>>, from: string, to: string): void {
  const set = unused.get(from);
  if (!set?.delete(to)) throw new PlanError("wall union did not close");
}

function simplify(points: XzPoint[]): XzPoint[] {
  if (points.length < 3) return points;
  const kept: XzPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = points[(i + points.length - 1) % points.length]!;
    const curr = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const cross = (curr.x - prev.x) * (next.z - curr.z) - (curr.z - prev.z) * (next.x - curr.x);
    if (Math.abs(cross) > 1e-8) kept.push(curr);
  }
  return kept;
}

function canonicalize(points: XzPoint[]): XzPoint[] {
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const at = points[best]!;
    if (point.x < at.x - 1e-9 || (Math.abs(point.x - at.x) <= 1e-9 && point.z < at.z - 1e-9)) best = i;
  }
  if (best === 0) return points;
  return [...points.slice(best), ...points.slice(0, best)];
}

function signedArea(points: readonly XzPoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += point.x * next.z - next.x * point.z;
  }
  return area / 2;
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    if (out.length === 0 || value - out[out.length - 1]! > EPS) out.push(value);
  }
  return out;
}

function key(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

function parseKey(value: string): [number, number] {
  const comma = value.indexOf(",");
  return [Number(value.slice(0, comma)), Number(value.slice(comma + 1))];
}

function delta(from: string, to: string): { dx: number; dz: number } {
  const [ax, az] = parseKey(from);
  const [bx, bz] = parseKey(to);
  return { dx: bx - ax, dz: bz - az };
}

function pointOf(value: string, xs: number[], zs: number[]): XzPoint {
  const [ix, iz] = parseKey(value);
  return { x: xs[ix]!, z: zs[iz]! };
}
