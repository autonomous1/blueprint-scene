import { DOOR_GAP_DEPTH_M } from "./doors.ts";
import { HALL_EDGE_INSET_M } from "./hall-floor.ts";
import type {
  AnyPlace,
  BoundsFile,
  DoorPlacement,
  ElevatorPlace,
  ScenePlace,
  StairsPlace,
  Vec3,
  XzBounds,
} from "./types.ts";

export type PortalKind = "door" | "landing" | "elevator" | "opening";

export type ScenePortal = {
  id: string;
  kind: PortalKind;
  a: string;
  b: string;
  /** Door placement id. Set when `kind` is `"door"`. */
  door?: string;
  /** Copied from the door. Omitted when the leaf is not locked. */
  locked?: boolean;
  /** Pickup placement id that unlocks a locked door. */
  key?: string;
  at: { a: Vec3; b: Vec3 };
  width: number;
  /** Metres-equivalent. An elevator portal adds `waitS`. */
  cost: number;
};

export type OutsidePlace = {
  id: "outside";
  kind: "outside";
  y: 0;
  polygon: Array<[number, number]>;
  bounds: XzBounds;
};

export type SceneGraphFile = {
  formatVersion: 1;
  units: "meters";
  places: Array<AnyPlace | OutsidePlace>;
  /** Sorted by `id`. */
  portals: ScenePortal[];
};

const PROBE_FRONT_M = 0.6;
const PROBE_BACK_M = -(DOOR_GAP_DEPTH_M + PROBE_FRONT_M);
const SILL_LIFT_M = 0.1;
/** A probe matches a place whose walk height is this close to the sill. */
const PLACE_Y_M = 0.5;
/** Sill this close to the building's lowest floor falls back to `outside`. */
const GROUND_Y_M = 0.5;
/** Hall and platform openings stay on one level. */
const OPENING_LEVEL_M = 0.05;
const OPENING_MIN_M = 0.8;
const STAIR_BOTTOM_COST = 0.5;
const STAIR_TOP_RUN = 1.3;
/** Facade inset plus a centimetre, so a probe in the inset strip still hits the hall. */
const CONTAIN_SLACK_M = HALL_EDGE_INSET_M + 0.01;

type Xz = readonly [number, number];

/**
 * Link places through doors, stairs, elevators, and hall/platform openings.
 * `places` is the `derivePlaces` list. `doors` is building doors plus room doors.
 * A probe that matches nothing does not fail the bake; it is a warning and no portal.
 */
export function buildSceneGraph(args: {
  places: readonly AnyPlace[];
  doors: readonly DoorPlacement[];
  bounds: BoundsFile;
}): { graph: SceneGraphFile; warnings: string[] } {
  const warnings: string[] = [];
  const input = [...args.places];
  const outside = outsidePlace(args.bounds);
  const stops = elevatorStops(input);
  const places: Array<AnyPlace | OutsidePlace> = [...input, outside, ...stops];
  const portals: ScenePortal[] = [];

  const doors = [...args.doors].sort((a, b) => cmp(a.id, b.id));
  for (const door of doors) {
    const front = doorProbe(door, PROBE_FRONT_M);
    const back = doorProbe(door, PROBE_BACK_M);
    const frontId = resolveProbe(front, door, input, stops);
    const backId = resolveProbe(back, door, input, stops);
    if (!frontId) warnings.push(`door ${door.id} opens into no place on the front side`);
    if (!backId) warnings.push(`door ${door.id} opens into no place on the back side`);
    if (frontId && backId && frontId === backId) {
      warnings.push(`door ${door.id}: both sides are ${frontId}`);
    }
    if (!frontId || !backId || frontId === backId) continue;
    const ends = orderPair(frontId, backId, front, back);
    portals.push({
      id: door.id,
      kind: "door",
      a: ends.a,
      b: ends.b,
      door: door.id,
      ...(door.locked ? { locked: true } : {}),
      ...(door.key ? { key: door.key } : {}),
      at: ends.at,
      width: roundM(door.size[0]),
      cost: roundM(distance(front, back)),
    });
  }

  for (const place of input) {
    if (isStairs(place)) pushStairPortals(place, portals);
    if (isElevator(place)) pushElevatorPortals(place, portals);
  }
  pushOpenings(input, portals);

  portals.sort((a, b) => cmp(a.id, b.id));
  const linked = new Set(portals.flatMap((portal) => [portal.a, portal.b]));
  const listed = [...places].sort((a, b) => cmp(a.id, b.id));
  for (const place of listed) {
    if (!linked.has(place.id)) warnings.push(`place ${place.id} has no portals`);
  }

  return {
    graph: { formatVersion: 1, units: "meters", places: listed, portals },
    warnings,
  };
}

/**
 * World point of the opening's middle, `localZ` metres along door local +Z.
 * Local +X is `(cos θ, −sin θ)` and local +Z is `(sin θ, cos θ)`, θ the yaw.
 * A left hinge's middle is `+width/2`; a right hinge's middle is `−width/2`.
 */
export function doorProbe(door: DoorPlacement, localZ: number): Vec3 {
  const theta = (door.yaw * Math.PI) / 180;
  const lx = door.hinge === "left" ? door.size[0] / 2 : -door.size[0] / 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    door.position[0] + lx * c + localZ * s,
    door.position[1] + SILL_LIFT_M,
    door.position[2] - lx * s + localZ * c,
  ];
}

function outsidePlace(bounds: BoundsFile): OutsidePlace {
  const minX = roundM(bounds.minX);
  const maxX = roundM(bounds.maxX);
  const minZ = roundM(bounds.minZ);
  const maxZ = roundM(bounds.maxZ);
  return {
    id: "outside",
    kind: "outside",
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

/** One cab place per stop. The shaft place stays; these are the floors the cab visits. */
function elevatorStops(places: readonly AnyPlace[]): ScenePlace[] {
  const stops: ScenePlace[] = [];
  for (const place of places) {
    if (!isElevator(place)) continue;
    place.stops.forEach((y, index) => {
      stops.push({
        id: `${place.id}@${index}`,
        kind: "elevator",
        ...(place.building ? { building: place.building } : {}),
        ...(place.floor ? { floor: place.floor } : {}),
        y,
        polygon: place.polygon.map((point): [number, number] => [point[0], point[1]]),
        bounds: { ...place.bounds },
      });
    });
  }
  return stops;
}

function resolveProbe(
  probe: Vec3,
  door: DoorPlacement,
  places: readonly AnyPlace[],
  stops: readonly ScenePlace[],
): string | undefined {
  const candidates = [...places, ...stops];
  const sill = door.position[1];
  const strict = candidates.filter((place) => nearY(place.y, sill) && pointInRing(place.polygon, probe[0], probe[2]));
  const hit = smallest(strict);
  if (hit) return hit.id;
  const wide = candidates.filter((place) =>
    nearY(place.y, sill) && distanceToPolygon(place.polygon, probe[0], probe[2]) <= CONTAIN_SLACK_M,
  );
  const slack = smallest(wide);
  if (slack) return slack.id;
  if (Math.abs(sill - buildingGround(door.id, places)) <= GROUND_Y_M) return "outside";
  return undefined;
}

function buildingGround(doorId: string, places: readonly AnyPlace[]): number {
  let prefix = "";
  for (const place of places) {
    if (!place.building) continue;
    const candidate = `${place.building}.`;
    if (doorId.startsWith(candidate) && candidate.length > prefix.length) prefix = candidate;
  }
  if (!prefix) return 0;
  const buildingId = prefix.slice(0, -1);
  let min = Infinity;
  for (const place of places) {
    if (place.building !== buildingId) continue;
    if (place.kind !== "hall" && place.kind !== "room" && place.kind !== "platform") continue;
    if (place.y < min) min = place.y;
  }
  return Number.isFinite(min) ? min : 0;
}

function pushStairPortals(stair: StairsPlace, portals: ScenePortal[]): void {
  const bottomJoin = stair.joins.from ?? "outside";
  portals.push(landingPortal(
    `${stair.id}:bottom`,
    stair.id,
    bottomJoin,
    stair.landings.bottom,
    stair.width,
    STAIR_BOTTOM_COST,
  ));
  if (!stair.joins.to) return;
  portals.push(landingPortal(
    `${stair.id}:top`,
    stair.id,
    stair.joins.to,
    stair.landings.top,
    stair.width,
    stair.run * STAIR_TOP_RUN,
  ));
}

function pushElevatorPortals(cab: ElevatorPlace, portals: ScenePortal[]): void {
  const width = Math.min(cab.bounds.maxX - cab.bounds.minX, cab.bounds.maxZ - cab.bounds.minZ);
  for (let index = 0; index < cab.stops.length; index += 1) {
    const join = cab.joins[index];
    const landing = cab.landings[index];
    if (!join || !landing) continue;
    portals.push(landingPortal(`${cab.id}@${index}:landing`, `${cab.id}@${index}`, join, landing, width, STAIR_BOTTOM_COST));
  }
  for (let i = 0; i < cab.stops.length; i += 1) {
    for (let j = i + 1; j < cab.stops.length; j += 1) {
      const dy = Math.abs(cab.stops[i]! - cab.stops[j]!);
      const atI = cabPoint(cab, cab.stops[i]!);
      const atJ = cabPoint(cab, cab.stops[j]!);
      const ends = orderPair(`${cab.id}@${i}`, `${cab.id}@${j}`, atI, atJ);
      portals.push({
        id: `${cab.id}:${i}-${j}`,
        kind: "elevator",
        a: ends.a,
        b: ends.b,
        at: ends.at,
        width: roundM(width),
        cost: roundM(cab.waitS + dy / cab.speed),
      });
    }
  }
}

function cabPoint(cab: ElevatorPlace, y: number): Vec3 {
  let x = 0;
  let z = 0;
  for (const point of cab.polygon) {
    x += point[0];
    z += point[1];
  }
  const n = cab.polygon.length || 1;
  return [roundM(x / n), roundM(y), roundM(z / n)];
}

function landingPortal(
  id: string,
  left: string,
  right: string,
  at: Vec3,
  width: number,
  cost: number,
): ScenePortal {
  const point = roundVec(at);
  const ends = orderPair(left, right, point, point);
  return {
    id,
    kind: "landing",
    a: ends.a,
    b: ends.b,
    at: ends.at,
    width: roundM(width),
    cost: roundM(cost),
  };
}

/**
 * Hall and platform only. A room shares its whole boundary with the hall
 * (the hall is the outline minus the rooms), so a room/hall edge is not an opening.
 * Bridge edges, the there-and-back join of a split hall, are dropped.
 */
function pushOpenings(places: readonly AnyPlace[], portals: ScenePortal[]): void {
  const level = places.filter((place) => place.kind === "hall" || place.kind === "platform");
  for (let i = 0; i < level.length; i += 1) {
    for (let j = i + 1; j < level.length; j += 1) {
      const left = level[i]!;
      const right = level[j]!;
      if (!left.building || left.building !== right.building) continue;
      if (Math.abs(left.y - right.y) > OPENING_LEVEL_M + 1e-6) continue;
      const pieces = sharedPieces(realEdges(left.polygon), realEdges(right.polygon));
      pieces.forEach((piece, index) => {
        const [aId, bId] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
        const [aPoly, bPoly] = aId === left.id ? [left.polygon, right.polygon] : [right.polygon, left.polygon];
        const stand = standPoints(piece.mid, piece.dir, aPoly, bPoly, left.y);
        portals.push({
          id: `${aId}~${bId}:${index}`,
          kind: "opening",
          a: aId,
          b: bId,
          at: { a: stand.a, b: stand.b },
          width: roundM(piece.length),
          cost: roundM(distance(stand.a, stand.b)),
        });
      });
    }
  }
}

type Edge = { a: Xz; b: Xz };

function realEdges(polygon: readonly Xz[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;
    edges.push({ a, b });
  }
  return edges.filter((edge, index) => !edges.some((other, otherIndex) =>
    otherIndex !== index && nearPoint(other.a, edge.b) && nearPoint(other.b, edge.a),
  ));
}

type Piece = { mid: [number, number]; length: number; dir: [number, number] };

function sharedPieces(left: readonly Edge[], right: readonly Edge[]): Piece[] {
  const found: Piece[] = [];
  const seen = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      const piece = overlap(a, b);
      if (!piece) continue;
      const key = `${Math.round(piece.mid[0] * 1e3)},${Math.round(piece.mid[1] * 1e3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(piece);
    }
  }
  found.sort((a, b) => a.mid[0] - b.mid[0] || a.mid[1] - b.mid[1] || a.length - b.length);
  return found;
}

function overlap(a: Edge, b: Edge): Piece | undefined {
  const ax = a.b[0] - a.a[0];
  const az = a.b[1] - a.a[1];
  const bx = b.b[0] - b.a[0];
  const bz = b.b[1] - b.a[1];
  const lenA = Math.hypot(ax, az);
  const lenB = Math.hypot(bx, bz);
  if (lenA < 1e-6 || lenB < 1e-6) return undefined;
  const cross = ax * bz - az * bx;
  if (Math.abs(cross) > 1e-4 * lenA * lenB) return undefined;
  const off = Math.abs(ax * (b.a[1] - a.a[1]) - az * (b.a[0] - a.a[0])) / lenA;
  if (off > 1e-3) return undefined;
  const ux = ax / lenA;
  const uz = az / lenA;
  const proj = (point: Xz) => (point[0] - a.a[0]) * ux + (point[1] - a.a[1]) * uz;
  const lo = Math.max(0, Math.min(proj(b.a), proj(b.b)));
  const hi = Math.min(lenA, Math.max(proj(b.a), proj(b.b)));
  const length = hi - lo;
  if (length < OPENING_MIN_M - 1e-6) return undefined;
  const t = (lo + hi) / 2;
  return {
    mid: [a.a[0] + ux * t, a.a[1] + uz * t],
    length,
    dir: [ux, uz],
  };
}

/** Stand 0.4 m off the shared edge, one side in each place. */
function standPoints(
  mid: readonly [number, number],
  dir: readonly [number, number],
  aPoly: readonly Xz[],
  bPoly: readonly Xz[],
  y: number,
): { a: Vec3; b: Vec3 } {
  const px = -dir[1];
  const pz = dir[0];
  const intoA = pointInRing(aPoly, mid[0] + px * 0.25, mid[1] + pz * 0.25) ? 1 : -1;
  const ax = mid[0] + px * intoA * 0.4;
  const az = mid[1] + pz * intoA * 0.4;
  const bx = mid[0] - px * intoA * 0.4;
  const bz = mid[1] - pz * intoA * 0.4;
  if (!pointInRing(bPoly, bx, bz) && pointInRing(bPoly, ax, az)) {
    return { a: roundVec([bx, y, bz]), b: roundVec([ax, y, az]) };
  }
  return { a: roundVec([ax, y, az]), b: roundVec([bx, y, bz]) };
}

function orderPair(
  aId: string,
  bId: string,
  aAt: Vec3,
  bAt: Vec3,
): { a: string; b: string; at: { a: Vec3; b: Vec3 } } {
  const a = roundVec(aAt);
  const b = roundVec(bAt);
  if (aId <= bId) return { a: aId, b: bId, at: { a, b } };
  return { a: bId, b: aId, at: { a: b, b: a } };
}

function smallest(places: readonly { id: string; polygon: readonly Xz[] }[]): { id: string } | undefined {
  if (places.length === 0) return undefined;
  const ranked = [...places].sort((a, b) => areaOf(a.polygon) - areaOf(b.polygon) || cmp(a.id, b.id));
  return ranked[0];
}

function isStairs(place: AnyPlace): place is StairsPlace {
  return place.kind === "stairs" && "run" in place;
}

function isElevator(place: AnyPlace): place is ElevatorPlace {
  return place.kind === "elevator" && "stops" in place;
}

function nearY(placeY: number, sill: number): boolean {
  return Math.abs(placeY - sill) <= PLACE_Y_M;
}

function nearPoint(a: Xz, b: Xz): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-4;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function areaOf(polygon: readonly Xz[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const point = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(area) / 2;
}

function pointInRing(polygon: readonly Xz[], x: number, z: number): boolean {
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

function distanceToPolygon(polygon: readonly Xz[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const dist = distanceToSegment(x, z, a, b);
    if (dist < best) best = dist;
  }
  return best;
}

function distanceToSegment(x: number, z: number, a: Xz, b: Xz): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-20) return Math.hypot(x - a[0], z - a[1]);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

function roundM(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundVec(v: Vec3): Vec3 {
  return [roundM(v[0]), roundM(v[1]), roundM(v[2])];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
