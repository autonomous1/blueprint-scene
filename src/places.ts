import { PlanError } from "./errors.ts";
import type {
  FloorElevatorSource,
  FloorPlatformSource,
  FloorSource,
  FloorStairsSource,
  FloorsSource,
  RoomInstanceSource,
} from "./floors-svg.ts";
import { hallCells } from "./hall-floor.ts";
import type { RoomFile } from "./room-file.ts";
import { addYaw, buildingToWorld, roomToBuilding } from "./rooms-bake.ts";
import type { AnyPlace, ElevatorPlace, Placement, ScenePlace, StairsPlace, Vec3, Yaw } from "./types.ts";
import { unionAabbs } from "./union.ts";
import { placeBox, transformXz } from "./yaw.ts";

type PlaceBuilding = {
  id: string;
  model: string;
  position: Vec3;
  yaw: Yaw;
  scale: number;
};

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Same 0.1% rule as rooms-bake: measure-stencil world size against the footprint. */
function footprintScaleOff(
  building: { scale: number },
  source: FloorsSource,
  measured: { width: number; depth: number } | undefined,
): boolean {
  if (!measured || measured.width < 1e-9 || measured.depth < 1e-9) {
    return Math.abs(building.scale - source.scale) > 1e-3 * source.scale;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of source.footprint) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const worldW = measured.width * building.scale;
  const worldD = measured.depth * building.scale;
  return Math.abs(worldW - (maxX - minX)) > 1e-3 * Math.abs(maxX - minX)
    || Math.abs(worldD - (maxZ - minZ)) > 1e-3 * Math.abs(maxZ - minZ);
}

/**
 * Rooms, halls, platforms, stairs, and elevators from floors files and room prefabs.
 * A building with no floors file adds nothing.
 */
export function derivePlaces(args: {
  buildings: readonly PlaceBuilding[];
  floorsFor: (model: string) => FloorsSource | undefined;
  roomFileFor: (prefab: string) => RoomFile | undefined;
  /** Placement, prop, and door ids already claimed. Room instance ids are not included: a room place reuses that id. */
  taken?: ReadonlySet<string>;
  /** Measure-stencil XZ size. When set, that extent times scale is checked against the footprint. */
  measures?: ReadonlyMap<string, { width: number; depth: number }>;
}): { places: AnyPlace[]; warnings: string[] } {
  const warnings: string[] = [];
  const places: AnyPlace[] = [];
  const ids = new Set(args.taken);
  const claim = (id: string): void => {
    if (ids.has(id)) throw new PlanError(`duplicate placement id "${id}"`);
    ids.add(id);
  };

  for (const building of args.buildings) {
    const source = args.floorsFor(building.model);
    if (!source) continue;
    if (footprintScaleOff(building, source, args.measures?.get(building.model))) {
      console.log(`building "${building.id}" scale ${building.scale} differs from ${building.model}.floors.svg scale ${source.scale}`);
      throw new PlanError(
        `building "${building.id}" scale ${building.scale} differs from ${building.model}.floors.svg scale ${source.scale}`,
      );
    }
    if (source.outlineFallback) {
      const why = source.outlineFallback === "curve" ? "a curve" : "a diagonal edge";
      warnings.push(`building "${building.id}" stencil outline has ${why}; using the bounding box`);
    }
    for (const floor of source.floors) {
      if (floor.n !== source.floors[0]?.n && floor.outlineFallback) {
        const why = floor.outlineFallback === "curve" ? "a curve" : "a diagonal edge";
        warnings.push(`building "${building.id}" floor-${floor.n} stencil outline has ${why}; using the bounding box`);
      }
      const y = building.position[1] + floor.elevation;
      const floorName = String(floor.n);
      const outline = worldPoly(building, floor.outline);
      const roomPolys: Array<Array<[number, number]>> = [];
      for (const inst of floor.rooms) {
        const file = args.roomFileFor(inst.prefab);
        if (!file) {
          throw new PlanError(`room "${building.id}.${inst.id}" prefab "${inst.prefab}" has no .room.json`);
        }
        if (!polygonInside(drawnRoom(inst), floor.outline)) {
          throw new PlanError(`room "${building.id}.${inst.id}" is outside floor-${floor.n} outline`);
        }
        const id = `${building.id}.${inst.id}`;
        claim(id);
        const polygon = roomPolygon(building, inst, file.footprint);
        roomPolys.push(polygon);
        places.push(makePlace(id, "room", building.id, floorName, y, polygon));
      }
      const hallId = `${building.id}.floor-${floor.n}.hall`;
      claim(hallId);
      places.push(makePlace(
        hallId,
        "hall",
        building.id,
        floorName,
        y,
        hallPolygon(outline, roomPolys, warnings, hallId),
      ));
      if (floor.platformDeck !== undefined) {
        const id = `${building.id}.floor-${floor.n}.platform`;
        claim(id);
        places.push(makePlace(id, "platform", building.id, floorName, y + floor.platformDeck, outline));
      }
      for (const platform of floor.platforms) {
        pushPlatform(places, claim, building, floorName, y, platform);
      }
    }
    for (const stair of source.stairs) pushStair(places, warnings, claim, building, source.floors, stair);
    for (const elevator of source.elevators) pushElevator(places, warnings, claim, building, source.floors, elevator);
  }

  places.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { places, warnings };
}

function pushPlatform(
  places: AnyPlace[],
  claim: (id: string) => void,
  building: PlaceBuilding,
  floorName: string,
  floorY: number,
  platform: FloorPlatformSource,
): void {
  const id = `${building.id}.${platform.id}`;
  claim(id);
  places.push(makePlace(
    id,
    "platform",
    building.id,
    floorName,
    floorY + platform.deck,
    worldPoly(building, platform.polygon),
  ));
}

function makePlace(
  id: string,
  kind: ScenePlace["kind"],
  building: string,
  floor: string,
  y: number,
  polygon: Array<[number, number]>,
): ScenePlace {
  const rounded = polygon.map(([x, z]): [number, number] => [roundM(x), roundM(z)]);
  return { id, kind, building, floor, y: roundM(y), polygon: rounded, bounds: boundsOf(rounded) };
}

function roomPolygon(
  building: PlaceBuilding,
  inst: RoomInstanceSource,
  footprint: RoomFile["footprint"],
): Array<[number, number]> {
  const origin = buildingToWorld(placementOf(building), roomToBuilding(inst.center, inst.yaw, 0, [0, 0, 0]));
  const yaw = addYaw(building.yaw, inst.yaw);
  const box = placeBox({
    minX: footprint.minX,
    maxX: footprint.maxX,
    minY: 0,
    maxY: 0,
    minZ: footprint.minZ,
    maxZ: footprint.maxZ,
  }, origin, yaw);
  return ccwRect({ minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2] });
}

function worldPoly(building: PlaceBuilding, local: Array<[number, number]>): Array<[number, number]> {
  const placed = placementOf(building);
  return local.map(([x, z]) => {
    const world = buildingToWorld(placed, [x, 0, z]);
    return [world[0], world[2]];
  });
}

function placementOf(building: PlaceBuilding): Placement {
  return {
    id: building.id,
    model: building.model,
    position: building.position,
    yaw: building.yaw,
    scale: building.scale,
  };
}

/**
 * Outline minus room rectangles. Cells come from `hallCells` (the facade edge
 * is inset; room edges are not). An empty or degenerate difference keeps the
 * outline and warns.
 */
function hallPolygon(
  outline: Array<[number, number]>,
  rooms: readonly (readonly (readonly [number, number])[])[],
  warnings: string[],
  id: string,
): Array<[number, number]> {
  const cells = hallCells(outline, rooms.map((polygon) => rectOf(polygon)));
  if (cells.length === 0) {
    warnings.push(`hall "${id}" difference is empty; using the outline`);
    return outline;
  }
  const rings = unionAabbs(cells);
  const polygon = stitch(rings.map((ring) => ring.points.map((point): [number, number] => [point.x, point.z])));
  if (!polygon || Math.abs(signedArea(polygon)) < 1e-8) {
    warnings.push(`hall "${id}" difference is degenerate; using the outline`);
    return outline;
  }
  return polygon;
}

/** One contour. Extra rings are joined by a there-and-back bridge so even-odd coverage is unchanged. */
function stitch(rings: Array<Array<[number, number]>>): Array<[number, number]> | undefined {
  const live = rings.filter((ring) => ring.length >= 3);
  if (live.length === 0) return undefined;
  const ordered = [...live].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  let polygon = ordered[0]!;
  for (const ring of ordered.slice(1)) polygon = bridge(polygon, ring);
  return polygon;
}

function bridge(host: Array<[number, number]>, extra: Array<[number, number]>): Array<[number, number]> {
  let bestI = 0;
  let bestJ = 0;
  let best = Infinity;
  for (let i = 0; i < host.length; i += 1) {
    for (let j = 0; j < extra.length; j += 1) {
      const dx = host[i]![0] - extra[j]![0];
      const dz = host[i]![1] - extra[j]![1];
      const dist = dx * dx + dz * dz;
      if (dist < best) {
        best = dist;
        bestI = i;
        bestJ = j;
      }
    }
  }
  const rotated = [...extra.slice(bestJ), ...extra.slice(0, bestJ)];
  // `rotated` is not closed. Repeat its start so the bridge walks back on itself.
  return [...host.slice(0, bestI + 1), ...rotated, rotated[0]!, host[bestI]!, ...host.slice(bestI + 1)];
}

function rectOf(polygon: readonly (readonly [number, number])[]): Rect {
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

function ccwRect(rect: Rect): Array<[number, number]> {
  return [[rect.minX, rect.minZ], [rect.maxX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ]];
}

function boundsOf(polygon: readonly (readonly [number, number])[]): ScenePlace["bounds"] {
  const rect = rectOf(polygon);
  return { minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.maxZ };
}

function signedArea(polygon: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const point = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}

function roundM(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function pushStair(
  places: AnyPlace[],
  warnings: string[],
  claim: (id: string) => void,
  building: PlaceBuilding,
  floors: readonly FloorSource[],
  stair: FloorStairsSource,
): void {
  if (stair.floor !== undefined) {
    for (const floor of floors) {
      if (floor.elevation < stair.bottom - 1e-4 || floor.elevation > stair.top + 1e-4) continue;
      if (!polygonInside(stair.polygon, floor.outline)) {
        throw new PlanError(`stairs "${building.id}.${stair.id}" is outside floor-${floor.n} outline`);
      }
    }
  }
  const metrics = stairsLandings(stair.polygon, stair.up, stair.bottom, stair.top);
  const bottom = worldAt(building, metrics.bottom[0], metrics.bottom[1], metrics.bottom[2]);
  const top = worldAt(building, metrics.top[0], metrics.top[1], metrics.top[2]);
  const id = `${building.id}.${stair.id}`;
  const from = landingJoin(places, building, floors, stair.bottom, bottom, "bottom", id, warnings);
  const to = landingJoin(places, building, floors, stair.top, top, "top", id, warnings);
  claim(id);
  const base = makePlace(
    id,
    "stairs",
    building.id,
    stair.floor === undefined ? "ground" : String(stair.floor),
    bottom[1],
    worldPoly(building, stair.polygon),
  );
  const place: StairsPlace = {
    ...base,
    kind: "stairs",
    top: top[1],
    width: roundM(metrics.width),
    run: roundM(metrics.run),
    landings: { bottom, top },
    joins: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
  };
  places.push(place);
}

function pushElevator(
  places: AnyPlace[],
  warnings: string[],
  claim: (id: string) => void,
  building: PlaceBuilding,
  floors: readonly FloorSource[],
  elevator: FloorElevatorSource,
): void {
  const low = elevator.stops[0]!;
  const high = elevator.stops[elevator.stops.length - 1]!;
  for (const floor of floors) {
    if (floor.elevation < low - 1e-4 || floor.elevation > high + 1e-4) continue;
    if (!polygonInside(elevator.polygon, floor.outline)) {
      throw new PlanError(`elevator "${building.id}.${elevator.id}" is outside floor-${floor.n} outline`);
    }
  }
  const [lx, lz] = sidePoint(elevator.polygon, elevator.door, 0.6);
  const landings = elevator.stops.map((stop) => worldAt(building, lx, stop, lz));
  const id = `${building.id}.${elevator.id}`;
  const joins = landings.map((landing, index) => {
    const found = elevatorJoin(places, building, floors, elevator.stops[index]!, landing, id, index, warnings);
    return found;
  });
  claim(id);
  const base = makePlace(id, "elevator", building.id, String(elevator.floor), landings[0]![1], worldPoly(building, elevator.polygon));
  const place: ElevatorPlace = {
    ...base,
    kind: "elevator",
    stops: elevator.stops.map((stop) => roundM(building.position[1] + stop)),
    waitS: elevator.waitS,
    speed: elevator.speed,
    landings,
    joins,
  };
  places.push(place);
}

/** Landings sit 0.4 m beyond the low and high edges. `up` is local XZ. */
function stairsLandings(
  corners: Array<[number, number]>,
  up: [number, number],
  bottom: number,
  top: number,
): { width: number; run: number; bottom: Vec3; top: Vec3 } {
  const proj = corners.map(([x, z]) => x * up[0] + z * up[1]);
  const across = corners.map(([x, z]) => x * -up[1] + z * up[0]);
  const lo = Math.min(...proj);
  const hi = Math.max(...proj);
  const mid = (at: number): [number, number] => {
    const pts = corners.filter((_, index) => Math.abs(proj[index]! - at) < 1e-4);
    if (pts.length === 0) throw new PlanError("stairs rect has no edge along data-up");
    return [
      pts.reduce((sum, point) => sum + point[0], 0) / pts.length,
      pts.reduce((sum, point) => sum + point[1], 0) / pts.length,
    ];
  };
  const [bx, bz] = mid(lo);
  const [tx, tz] = mid(hi);
  return {
    run: hi - lo,
    width: Math.max(...across) - Math.min(...across),
    bottom: [bx - up[0] * 0.4, bottom, bz - up[1] * 0.4],
    top: [tx + up[0] * 0.4, top, tz + up[1] * 0.4],
  };
}

/** Centre of the side `dir` faces, then `offset` metres further out. */
function sidePoint(corners: readonly (readonly [number, number])[], dir: readonly [number, number], offset: number): [number, number] {
  const proj = corners.map(([x, z]) => x * dir[0] + z * dir[1]);
  const hi = Math.max(...proj);
  const pts = corners.filter((_, index) => Math.abs(proj[index]! - hi) < 1e-4);
  const x = pts.reduce((sum, point) => sum + point[0], 0) / pts.length;
  const z = pts.reduce((sum, point) => sum + point[1], 0) / pts.length;
  return [x + dir[0] * offset, z + dir[1] * offset];
}

function landingJoin(
  places: readonly AnyPlace[],
  building: PlaceBuilding,
  floors: readonly FloorSource[],
  elevation: number,
  point: Vec3,
  end: "bottom" | "top",
  id: string,
  warnings: string[],
): string | undefined {
  const floor = floors.find((item) => Math.abs(item.elevation - elevation) <= 1e-3);
  if (floor && !pointInOrOn(worldPoly(building, floor.outline), point[0], point[2])) {
    if (end === "bottom" && floor.n === 1) return undefined;
    throw new PlanError(`stairs "${id}" ${end} landing is outside floor-${floor.n} outline`);
  }
  const found = smallestPlace(places, building.id, point);
  if (!found && end === "top") warnings.push(`stairs "${id}" top landing joins no place`);
  return found?.id;
}

function elevatorJoin(
  places: readonly AnyPlace[],
  building: PlaceBuilding,
  floors: readonly FloorSource[],
  elevation: number,
  point: Vec3,
  id: string,
  index: number,
  warnings: string[],
): string | undefined {
  const floor = floors.find((item) => Math.abs(item.elevation - elevation) <= 1e-3);
  if (floor && !pointInOrOn(worldPoly(building, floor.outline), point[0], point[2])) {
    throw new PlanError(`elevator "${id}" landing is outside floor-${floor.n} outline`);
  }
  const found = smallestPlace(places, building.id, point);
  if (!found) warnings.push(`elevator "${id}" stop ${index + 1} joins no place`);
  return found?.id;
}

function smallestPlace(places: readonly AnyPlace[], buildingId: string, point: Vec3): AnyPlace | undefined {
  const hits = places.filter((place) =>
    place.building === buildingId
    && (place.kind === "hall" || place.kind === "room" || place.kind === "platform")
    && Math.abs(place.y - point[1]) <= 1e-3
    && pointInRing(place.polygon, point[0], point[2]),
  );
  hits.sort((a, b) => Math.abs(signedArea(a.polygon)) - Math.abs(signedArea(b.polygon)) || (a.id < b.id ? -1 : 1));
  return hits[0];
}

function worldAt(building: PlaceBuilding, x: number, y: number, z: number): Vec3 {
  const world = buildingToWorld(placementOf(building), [x, y, z]);
  return [roundM(world[0]), roundM(world[1]), roundM(world[2])];
}

/** The authored room rectangle, in building-local metres. */
function drawnRoom(inst: RoomInstanceSource): Array<[number, number]> {
  const hx = inst.drawnWidth / 2;
  const hz = inst.drawnDepth / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => {
    const turned = transformXz(x, z, inst.yaw);
    return [inst.center.x + turned.x, inst.center.z + turned.z];
  });
}

function polygonInside(
  inner: readonly (readonly [number, number])[],
  outer: readonly (readonly [number, number])[],
): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  for (const [x, z] of inner) {
    if (!pointInOrOn(outer, x, z)) return false;
  }
  for (let i = 0; i < inner.length; i += 1) {
    const a = inner[i]!;
    const b = inner[(i + 1) % inner.length]!;
    for (let j = 0; j < outer.length; j += 1) {
      const c = outer[j]!;
      const d = outer[(j + 1) % outer.length]!;
      if (segmentsCross(a, b, c, d)) return false;
    }
  }
  return true;
}

function pointInOrOn(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  if (pointInRing(polygon, x, z)) return true;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (distToSeg(x, z, a, b) <= 1e-4) return true;
  }
  return false;
}

function pointInRing(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
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

function segmentsCross(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function orient(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) <= 1e-8) return 0;
  return value > 0 ? 1 : -1;
}

function distToSeg(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-20) return Math.hypot(x - a[0], z - a[1]);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}
