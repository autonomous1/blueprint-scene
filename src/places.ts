import { PlanError } from "./errors.ts";
import type { FloorPlatformSource, FloorsSource, RoomInstanceSource } from "./floors-svg.ts";
import { hallCells } from "./hall-floor.ts";
import type { RoomFile } from "./room-file.ts";
import { addYaw, buildingToWorld, roomToBuilding } from "./rooms-bake.ts";
import type { Placement, ScenePlace, Vec3, Yaw } from "./types.ts";
import { unionAabbs } from "./union.ts";
import { placeBox } from "./yaw.ts";

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
 * Rooms, halls, and platforms from floors files and room prefabs.
 * A building with no floors file adds nothing. Stairs and elevators are left for later.
 */
export function derivePlaces(args: {
  buildings: readonly PlaceBuilding[];
  floorsFor: (model: string) => FloorsSource | undefined;
  roomFileFor: (prefab: string) => RoomFile | undefined;
  /** Placement, prop, and door ids already claimed. Room instance ids are not included: a room place reuses that id. */
  taken?: ReadonlySet<string>;
  /** Measure-stencil XZ size. When set, that extent times scale is checked against the footprint. */
  measures?: ReadonlyMap<string, { width: number; depth: number }>;
}): { places: ScenePlace[]; warnings: string[] } {
  const warnings: string[] = [];
  const places: ScenePlace[] = [];
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
    const outline = worldPoly(building, source.outline);
    for (const floor of source.floors) {
      const y = building.position[1] + floor.elevation;
      const floorName = String(floor.n);
      const roomPolys: Array<Array<[number, number]>> = [];
      for (const inst of floor.rooms) {
        const file = args.roomFileFor(inst.prefab);
        if (!file) {
          throw new PlanError(`room "${building.id}.${inst.id}" prefab "${inst.prefab}" has no .room.json`);
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
  }

  places.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { places, warnings };
}

function pushPlatform(
  places: ScenePlace[],
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
