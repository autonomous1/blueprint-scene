import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stampPlacement } from "./asset-type.ts";
import { DOOR_FACE_TOL_M, cutDoorFromBoxes, doorCutLocal, situateDoor, type SituatedDoor } from "./doors.ts";
import { PlanError } from "./errors.ts";
import { readFloorsSvg, type RoomInstanceSource } from "./floors-svg.ts";
import { ID_RE } from "./plan.ts";
import { WALL_T, type RoomDoor, type RoomFile, type RoomLight } from "./room-file.ts";
import { wallLine, type WallFace } from "./room-svg.ts";
import type { AssetType, DoorPlacement, LocalBox, Obstacle, Placement, SceneDoor, SceneProp, Vec3, Yaw } from "./types.ts";
import { inverseYaw, transformXz } from "./yaw.ts";

export const addYaw = (a: Yaw, b: Yaw): Yaw => ((a + b) % 360) as Yaw;

/** Building-local point → world, for building placement b. */
export function buildingToWorld(b: Placement, p: Vec3): Vec3 {
  const w = transformXz(p[0], p[2], b.yaw);
  return [b.position[0] + w.x, b.position[1] + p[1], b.position[2] + w.z];
}

/** Room-local point → building-local, for instance (center, yaw) on a floor at elevation. */
export function roomToBuilding(center: { x: number; z: number }, yaw: Yaw, elevation: number, r: Vec3): Vec3 {
  const q = transformXz(r[0], r[2], yaw);
  return [center.x + q.x, elevation + r[1], center.z + q.z];
}

/** Any box through a point map: its 4 xz corners, then min/max. */
export function mapBox(box: LocalBox, f: (p: Vec3) => Vec3): LocalBox {
  const pts = [box.minX, box.maxX].flatMap((x) => [box.minZ, box.maxZ].map((z) => f([x, box.minY, z])));
  const dy = box.maxY - box.minY;
  return {
    minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
    minY: pts[0]![1], maxY: pts[0]![1] + dy,
    minZ: Math.min(...pts.map((p) => p[2])), maxZ: Math.max(...pts.map((p) => p[2])),
  };
}

export type RoomsLight = {
  id: string;
  type: "point" | "rect";
  position: Vec3;
  yaw?: Yaw;
  color: string;
  intensity: number;
  width?: number;
  height?: number;
  range?: number;
};

export type RoomsLightsFile = {
  formatVersion: 1;
  units: "meters";
  lights: RoomsLight[];
};

export type RoomsPlacementsFile = {
  formatVersion: 1;
  units: "meters";
  placements: Array<Placement | DoorPlacement>;
  obstacles: Obstacle[];
};

/** One room door, in world, ready to merge or to situate. */
export type PendingRoomDoor = {
  id: string;
  width: number;
  height: number;
  along: "x" | "z";
  spanMin: number;
  spanMax: number;
  /** Wall line on the normal axis. */
  face: number;
  normal: { x: number; z: number };
  sceneDoor: SceneDoor;
  host: { min: Vec3; max: Vec3 };
  /** `<prefab>.room.json` this door was read from. */
  file: string;
};

export type BuildingRooms = {
  interiors: LocalBox[];
  pending: PendingRoomDoor[];
};

export type FloorBake = {
  doors: SceneDoor[];
  props: SceneProp[];
  buildings: Map<string, BuildingRooms>;
  placements: Placement[];
  obstacles: Obstacle[];
  lights: RoomsLight[];
  roomCount: number;
};

const GROUND_FLOOR_Y = 0.05;
const SPAN_OVERLAP_M = 0.01;
const SIZE_WARN_M = 0.05;
/** Nudge the doorway centre toward the outside face so situateDoor picks that face. */
const FACE_NUDGE_M = 1e-4;

type LoadInput = {
  floorsDir: string;
  roomsDir?: string;
  buildings: readonly Placement[];
  taken: ReadonlySet<string>;
  /** Asset ids listed in the game file. */
  assets: ReadonlySet<string>;
  assetTypes: ReadonlyMap<string, AssetType>;
  warnings: string[];
  /**
   * Measure-stencil XZ size of each model, in model units: the union of the
   * 0.05 m runs. That is the outline a copied floors path uses, not the raw
   * vertex bounds.
   */
  measures?: ReadonlyMap<string, { width: number; depth: number }>;
};

/**
 * Placement scale times the measure-stencil extent must match the floors
 * footprint. Both sides are that stencil, so a copied group at the floors
 * scale passes even when a vertex lip sits outside the path. A model scaled
 * off the footprint still fails. The tolerance is 0.1%. With no measure, the
 * scale numbers themselves are compared at that tolerance.
 */
function assertSameMetres(
  building: Placement,
  source: { scale: number; footprint: Array<[number, number]> },
  measured: { width: number; depth: number } | undefined,
): void {
  const footprint = footprintSpan(source.footprint);
  const haveMeasure = measured !== undefined && measured.width > 1e-9 && measured.depth > 1e-9;
  const worldW = haveMeasure ? measured.width * building.scale : undefined;
  const worldD = haveMeasure ? measured.depth * building.scale : undefined;
  const scaleOff = Math.abs(building.scale - source.scale) > 1e-3 * Math.abs(source.scale);
  const widthOff = worldW === undefined
    ? scaleOff
    : Math.abs(worldW - footprint.width) > 1e-3 * Math.abs(footprint.width);
  const depthOff = worldD === undefined
    ? false
    : Math.abs(worldD - footprint.depth) > 1e-3 * Math.abs(footprint.depth);
  if (!widthOff && !depthOff) return;
  const detail = worldW === undefined
    ? ""
    : ` (mesh ${fmt(worldW)}\u00d7${fmt(worldD!)} m, footprint ${fmt(footprint.width)}\u00d7${fmt(footprint.depth)} m)`;
  const lead = worldW !== undefined && !scaleOff
    ? `building "${building.id}" mesh differs from ${building.model}.floors.svg footprint at scale ${fmt(building.scale)}`
    : `building "${building.id}" scale ${fmt(building.scale)} differs from ${building.model}.floors.svg scale ${fmt(source.scale)}`;
  throw new PlanError(`${lead}${detail}`);
}

function footprintSpan(footprint: readonly (readonly [number, number])[]): { width: number; depth: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of footprint) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { width: maxX - minX, depth: maxZ - minZ };
}

/**
 * External doors, stairs, and room instances for every building that has a floors file.
 * Doors and props are world `SceneDoor` / `SceneProp` values to append before the bake loops.
 */
export function loadFloors(input: LoadInput): FloorBake {
  const ids = new Set(input.taken);
  const claim = (id: string): void => {
    if (ids.has(id)) throw new PlanError(`duplicate placement id "${id}"`);
    ids.add(id);
  };
  const doors: SceneDoor[] = [];
  const props: SceneProp[] = [];
  const buildings = new Map<string, BuildingRooms>();
  const placements: Placement[] = [];
  const obstacles: Obstacle[] = [];
  const lights: RoomsLight[] = [];
  const roomsByPrefab = new Map<string, RoomFile>();
  const reported = new Set<string>();
  let roomCount = 0;

  for (const building of input.buildings) {
    const floorsPath = path.join(input.floorsDir, `${building.model}.floors.svg`);
    if (!existsSync(floorsPath)) continue;
    const source = readFloorsSvg(readText(floorsPath));
    if (source.model !== building.model) {
      throw new PlanError(
        `building "${building.id}": ${building.model}.floors.svg model "${source.model}" is not "${building.model}"`,
      );
    }
    assertSameMetres(building, source, input.measures?.get(building.model));
    const hasRooms = source.floors.some((floor) => floor.rooms.length > 0);
    if (hasRooms && !input.roomsDir) {
      throw new PlanError(`building "${building.id}" has room instances in ${building.model}.floors.svg; pass --rooms`);
    }
    for (const door of source.doors) {
      for (const world of expandModelDoor(door, [building])) {
        claim(world.id);
        doors.push(world);
      }
    }
    for (const prop of source.props) {
      const world = worldProp(building, prop, `${building.id}.${prop.id}`);
      claim(world.id);
      props.push(world);
    }
    const record: BuildingRooms = { interiors: [], pending: [] };
    for (const floor of source.floors) {
      for (const inst of floor.rooms) {
        const room = roomsByPrefab.get(inst.prefab) ?? loadRoom(input.roomsDir!, inst.prefab, roomsByPrefab);
        checkFootprint(building, inst, room);
        const toWorld = (p: Vec3): Vec3 => instanceToWorld(building, inst, floor.elevation, p);
        const prefix = `${building.id}.${inst.id}`;
        const yaw = addYaw(building.yaw, inst.yaw);
        placements.push(stampPlacement({
          id: prefix,
          model: inst.prefab,
          position: roundVec(toWorld([0, 0, 0])),
          yaw,
          scale: 1,
        }, input.assetTypes));
        claim(prefix);
        if (!reported.has(inst.prefab)) {
          reported.add(inst.prefab);
          if (!input.assets.has(inst.prefab)) {
            input.warnings.push(
              `{"id":"${inst.prefab}","kind":"model","type":"room","instance":"static","uri":"/assets/models/${inst.prefab}.glb","mediaType":"model/gltf-binary"}`,
            );
          }
        }
        record.interiors.push(mapBox({
          minX: room.footprint.minX,
          maxX: room.footprint.maxX,
          minY: 0,
          maxY: room.height,
          minZ: room.footprint.minZ,
          maxZ: room.footprint.maxZ,
        }, toWorld));
        for (const box of room.obstacles) {
          const world = mapBox(box, toWorld);
          if (box.id.startsWith("floor.") && world.maxY <= GROUND_FLOOR_Y) continue;
          obstacles.push({
            id: `${prefix}.${box.id}`,
            kind: "aabb",
            min: roundVec([world.minX, world.minY, world.minZ]),
            max: roundVec([world.maxX, world.maxY, world.maxZ]),
          });
        }
        for (const prop of room.props) {
          const world = worldProp(
            building,
            {
              ...prop,
              position: roomToBuilding(inst.center, inst.yaw, floor.elevation, prop.position),
              yaw: addYaw(inst.yaw, prop.yaw),
            },
            `${prefix}.${prop.id}`,
          );
          claim(world.id);
          props.push(world);
        }
        for (const light of room.lights) lights.push(worldLight(building, inst, floor.elevation, prefix, light));
        const roomFile = path.join(input.roomsDir!, `${inst.prefab}.room.json`);
        for (const door of room.doors) {
          record.pending.push(pendingDoor(building, inst, floor.elevation, room, prefix, door, toWorld, roomFile));
        }
        roomCount += 1;
      }
    }
    if (record.interiors.length > 0 || record.pending.length > 0) buildings.set(building.id, record);
  }

  return { doors, props, buildings, placements, obstacles, lights, roomCount };
}

export type RoomDoorHosts = {
  buildingId: string;
  /** World room obstacles. Cut every box for this building, including a sibling room. */
  rooms: Obstacle[];
  /** World building obstacles already emitted. Cut this building's `-wall-` boxes. */
  buildings: Obstacle[];
};

/** An unmerged room door that cut this building's wall boxes. `local` is door-local. */
export type RoomWallCut = {
  id: string;
  file: string;
  placement: DoorPlacement;
  local: LocalBox;
};

/**
 * Merge a room door into a situated door of the same opening, or return a leaf.
 * A partial overlap throws. A size mismatch warns and still merges.
 * An unmerged leaf is cut from the room walls and from the emitted building
 * boxes with `cutDoorFromBoxes`, the same opening an exterior door uses.
 * A leaf that hits a building wall is also returned in `wallCuts`, in the
 * door frame, so the visual mesh can punch that same volume.
 */
export function placeRoomDoors(
  pending: readonly PendingRoomDoor[],
  situated: readonly DoorPlacement[],
  assetTypes: ReadonlyMap<string, AssetType>,
  lines: string[],
  hosts: RoomDoorHosts,
): { placements: DoorPlacement[]; wallCuts: RoomWallCut[] } {
  const out: DoorPlacement[] = [];
  const unmerged: SituatedDoor[] = [];
  const files = new Map<string, string>();
  for (const door of pending) {
    let merged = false;
    for (const other of situated) {
      const rel = relate(door, other);
      if (rel === "none") continue;
      if (rel === "partial") {
        throw new PlanError(`door "${other.id}" partially overlaps room door "${door.id}"`);
      }
      merged = true;
      if (Math.abs(door.width - other.size[0]) > SIZE_WARN_M) {
        lines.push(
          `warning: door "${other.id}" width ${fmt(other.size[0])} differs from room door "${door.id}" width ${fmt(door.width)}`,
        );
      }
      if (Math.abs(door.height - other.size[1]) > SIZE_WARN_M) {
        lines.push(
          `warning: door "${other.id}" height ${fmt(other.size[1])} differs from room door "${door.id}" height ${fmt(door.height)}`,
        );
      }
    }
    if (merged) continue;
    const situatedDoor = situateDoor(door.sceneDoor, [door.host]);
    unmerged.push(situatedDoor);
    files.set(situatedDoor.placement.id, door.file);
    out.push(stampPlacement(roundDoor(situatedDoor.placement), assetTypes));
  }
  const wallBoxes = hosts.buildings
    .filter((obstacle) => obstacle.id.startsWith(`${hosts.buildingId}-wall-`))
    .map(obstacleToLocal);
  const wallCuts: RoomWallCut[] = [];
  for (const door of unmerged) {
    const local = doorCutLocal(wallBoxes, door, [0, 0, 0], 0);
    if (!local) continue;
    wallCuts.push({
      id: door.placement.id,
      file: files.get(door.placement.id) ?? door.placement.id,
      placement: door.placement,
      local,
    });
  }
  if (unmerged.length > 0) {
    cutRoomWalls(hosts.rooms, hosts.buildingId, unmerged);
    cutPrefixedWalls(hosts.buildings, `${hosts.buildingId}-wall-`, unmerged);
  }
  return { placements: out, wallCuts };
}

/**
 * Cut each situated opening out of this building's room obstacles.
 * Those boxes are already world AABBs, so the cut uses an identity pose.
 * A door that misses a box leaves it, including its id. A split replaces
 * that id with `<id>.0`, `<id>.1`, … . Pieces thinner than the door epsilon
 * are dropped inside `cutDoorFromBoxes`.
 */
export function cutRoomWalls(
  obstacles: Obstacle[],
  buildingId: string,
  doors: readonly SituatedDoor[],
): void {
  cutPrefixedWalls(obstacles, `${buildingId}.`, doors);
}

function cutPrefixedWalls(
  obstacles: Obstacle[],
  prefix: string,
  doors: readonly SituatedDoor[],
): void {
  if (doors.length === 0) return;
  const next: Obstacle[] = [];
  let changed = false;
  for (const obstacle of obstacles) {
    if (!obstacle.id.startsWith(prefix)) {
      next.push(obstacle);
      continue;
    }
    const parts = cutObstacle(obstacle, doors);
    if (parts.length !== 1 || parts[0] !== obstacle) changed = true;
    next.push(...parts);
  }
  if (!changed) return;
  obstacles.splice(0, obstacles.length, ...next);
}

function cutObstacle(obstacle: Obstacle, doors: readonly SituatedDoor[]): Obstacle[] {
  let current: Array<{ id: string; box: LocalBox; fresh: boolean }> = [{
    id: obstacle.id,
    box: obstacleToLocal(obstacle),
    fresh: false,
  }];
  for (const door of doors) {
    const next: typeof current = [];
    for (const part of current) {
      // requireHit false: this one box often belongs to another wall.
      const cut = cutDoorFromBoxes([part.box], door, [0, 0, 0], 0, false);
      if (cut.length === 1 && cut[0] === part.box) {
        next.push(part);
        continue;
      }
      cut.forEach((box, index) => {
        next.push({
          id: cut.length === 1 ? part.id : `${part.id}.${index}`,
          box,
          fresh: true,
        });
      });
    }
    current = next;
  }
  if (current.length === 1 && !current[0]!.fresh) return [obstacle];
  const out: Obstacle[] = [];
  for (const part of current) {
    const min = roundVec([part.box.minX, part.box.minY, part.box.minZ]);
    const max = roundVec([part.box.maxX, part.box.maxY, part.box.maxZ]);
    if (!(max[0] > min[0] && max[1] > min[1] && max[2] > min[2])) continue;
    out.push({ id: part.id, kind: "aabb", min, max });
  }
  return out;
}

function obstacleToLocal(obstacle: Obstacle): LocalBox {
  return {
    minX: obstacle.min[0],
    maxX: obstacle.max[0],
    minY: obstacle.min[1],
    maxY: obstacle.max[1],
    minZ: obstacle.min[2],
    maxZ: obstacle.max[2],
  };
}

/** Inverse of `buildingToWorld`. Metres in the placement frame, not GLB units. */
export function worldToBuilding(b: Placement, p: Vec3): Vec3 {
  const local = transformXz(p[0] - b.position[0], p[2] - b.position[2], inverseYaw(b.yaw));
  return [local.x, p[1] - b.position[1], local.z];
}

/**
 * World scene door → the building-local frame `expandModelDoor` consumes.
 * The reference placement is the copy the rectangle overlaps.
 */
export function doorToBuildingLocal(door: SceneDoor, building: Placement): SceneDoor {
  const center = worldToBuilding(building, door.center);
  const box = mapBox({
    minX: door.minX,
    maxX: door.maxX,
    minY: door.center[1],
    maxY: door.center[1],
    minZ: door.minZ,
    maxZ: door.maxZ,
  }, (p) => worldToBuilding(building, p));
  return {
    ...door,
    building: building.model,
    bind: "model",
    center,
    minX: box.minX,
    maxX: box.maxX,
    minZ: box.minZ,
    maxZ: box.maxZ,
  };
}

/**
 * One model-local door onto every given placement. Leaf id is
 * `${placement.id}.${door.id}`. Floors `doors-external` and a scene door
 * whose `data-building` is a model both use this, so the copy is one rule.
 * Pass only placements of that model. Static instances share one opening.
 */
export function expandModelDoor(door: SceneDoor, placements: readonly Placement[]): SceneDoor[] {
  const local: SceneDoor = { ...door, bind: "model" };
  return placements.map((placement) => worldDoor(placement, local));
}

type WorldAabb = { min: Vec3; max: Vec3 };

/**
 * Placement of `door.building`'s model that the door rectangle overlaps.
 * No overlap: the nearest. Several overlaps: the greatest XZ area, then the nearer.
 */
export function referencePlacement(
  door: SceneDoor,
  placements: readonly Placement[],
  worldBoxes: (placement: Placement) => readonly WorldAabb[],
): Placement {
  if (placements.length === 0) throw new PlanError(`door "${door.id}" has no placement`);
  let best = placements[0]!;
  let bestArea = -1;
  let bestDist = Infinity;
  for (const placement of placements) {
    const boxes = worldBoxes(placement);
    let area = 0;
    let dist = Infinity;
    if (boxes.length === 0) {
      dist = Math.hypot(door.center[0] - placement.position[0], door.center[2] - placement.position[2]);
    }
    for (const box of boxes) {
      area += xzOverlap(door.minX, door.maxX, door.minZ, door.maxZ, box.min[0], box.max[0], box.min[2], box.max[2]);
      dist = Math.min(dist, xzDistance(door.center[0], door.center[2], box.min[0], box.max[0], box.min[2], box.max[2]));
    }
    if (area > bestArea + 1e-9 || (Math.abs(area - bestArea) <= 1e-9 && dist < bestDist)) {
      best = placement;
      bestArea = area;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Scene doors from `readScene` become one world door per target placement.
 * Model-scoped doors expand. Placement-scoped doors stay one leaf.
 * `taken` is placement and prop ids. An expanded leaf that collides throws.
 */
export function resolveExteriorDoors(
  doors: readonly SceneDoor[],
  placements: readonly Placement[],
  worldBoxes: (placement: Placement) => readonly WorldAabb[],
  taken: ReadonlySet<string>,
): SceneDoor[] {
  const used = new Set(taken);
  const out: SceneDoor[] = [];
  for (const door of doors) {
    if (door.bind === "placement") {
      if (used.has(door.id)) throw new PlanError(`duplicate placement id "${door.id}"`);
      used.add(door.id);
      out.push(door);
      continue;
    }
    if (door.bind !== "model") throw new PlanError(`door "${door.id}" has no bind`);
    const ofModel = placements.filter((placement) => placement.model === door.building);
    if (ofModel.length === 0) {
      throw new PlanError(`door "${door.id}" data-building "${door.building}" does not match a placement`);
    }
    const local = doorToBuildingLocal(door, referencePlacement(door, ofModel, worldBoxes));
    for (const world of expandModelDoor(local, ofModel)) {
      if (used.has(world.id)) throw new PlanError(`duplicate placement id "${world.id}"`);
      used.add(world.id);
      out.push(world);
    }
  }
  return out;
}

function xzOverlap(
  minX: number, maxX: number, minZ: number, maxZ: number,
  boxMinX: number, boxMaxX: number, boxMinZ: number, boxMaxZ: number,
): number {
  const x = Math.min(maxX, boxMaxX) - Math.max(minX, boxMinX);
  const z = Math.min(maxZ, boxMaxZ) - Math.max(minZ, boxMinZ);
  if (x <= 0 || z <= 0) return 0;
  return x * z;
}

function xzDistance(
  x: number, z: number,
  minX: number, maxX: number, minZ: number, maxZ: number,
): number {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  return Math.hypot(dx, dz);
}

function worldDoor(building: Placement, door: SceneDoor): SceneDoor {
  const center = buildingToWorld(building, door.center);
  const box = mapBox({
    minX: door.minX,
    maxX: door.maxX,
    minY: door.center[1],
    maxY: door.center[1],
    minZ: door.minZ,
    maxZ: door.maxZ,
  }, (p) => buildingToWorld(building, p));
  return {
    ...door,
    id: `${building.id}.${door.id}`,
    building: building.id,
    center,
    minX: box.minX,
    maxX: box.maxX,
    minZ: box.minZ,
    maxZ: box.maxZ,
  };
}

function worldProp(building: Placement, prop: SceneProp, id: string): SceneProp {
  return {
    ...prop,
    id,
    position: buildingToWorld(building, prop.position),
    yaw: addYaw(building.yaw, prop.yaw),
  };
}

function instanceToWorld(building: Placement, inst: RoomInstanceSource, elevation: number, p: Vec3): Vec3 {
  return buildingToWorld(building, roomToBuilding(inst.center, inst.yaw, elevation, p));
}

function loadRoom(roomsDir: string, prefab: string, cache: Map<string, RoomFile>): RoomFile {
  if (!ID_RE.test(prefab)) throw new PlanError(`invalid model id "${prefab}"`);
  const filePath = path.join(roomsDir, `${prefab}.room.json`);
  const room = JSON.parse(readText(filePath)) as RoomFile;
  cache.set(prefab, room);
  return room;
}

function checkFootprint(building: Placement, inst: RoomInstanceSource, room: RoomFile): void {
  const fw = room.footprint.maxX - room.footprint.minX;
  const fd = room.footprint.maxZ - room.footprint.minZ;
  const widthOff = Math.abs(inst.drawnWidth - fw) > 0.01 * Math.abs(fw);
  const depthOff = Math.abs(inst.drawnDepth - fd) > 0.01 * Math.abs(fd);
  if (!widthOff && !depthOff) return;
  throw new PlanError(
    `room "${building.id}.${inst.id}" drawn ${fmt(inst.drawnWidth)}\u00d7${fmt(inst.drawnDepth)} `
    + `differs from ${inst.prefab}.room.json footprint ${fmt(fw)}\u00d7${fmt(fd)}`,
  );
}

function worldLight(
  building: Placement,
  inst: RoomInstanceSource,
  elevation: number,
  prefix: string,
  light: RoomLight,
): RoomsLight {
  return {
    id: `${prefix}.${light.id}`,
    type: light.type,
    position: roundVec(instanceToWorld(building, inst, elevation, light.position)),
    ...(light.type === "rect" ? { yaw: addYaw(building.yaw, inst.yaw) } : {}),
    color: light.color,
    intensity: roundM(light.intensity),
    ...(light.width !== undefined ? { width: roundM(light.width) } : {}),
    ...(light.height !== undefined ? { height: roundM(light.height) } : {}),
    ...(light.range !== undefined ? { range: roundM(light.range) } : {}),
  };
}

function pendingDoor(
  building: Placement,
  inst: RoomInstanceSource,
  elevation: number,
  room: RoomFile,
  prefix: string,
  door: RoomDoor,
  toWorld: (p: Vec3) => Vec3,
  file: string,
): PendingRoomDoor {
  const fpW = room.footprint.maxX - room.footprint.minX;
  const fpD = room.footprint.maxZ - room.footprint.minZ;
  const line = wallLine(door.wall, fpW, fpD);
  const normal = composeNormal(building.yaw, inst.yaw, door.wall);
  const half = door.width / 2;
  const alongRoom = line.axis === "z"
    ? { x: 1, z: 0 }
    : { x: 0, z: 1 };
  const at = line.axis === "z"
    ? [door.center[0], door.center[1], line.at] as Vec3
    : [line.at, door.center[1], door.center[2]] as Vec3;
  const aw = toWorld([at[0] - alongRoom.x * half, at[1], at[2] - alongRoom.z * half]);
  const bw = toWorld([at[0] + alongRoom.x * half, at[1], at[2] + alongRoom.z * half]);
  const facePoint = toWorld(at);
  const normalAxis: "x" | "z" = Math.abs(normal.x) >= Math.abs(normal.z) ? "x" : "z";
  const along: "x" | "z" = normalAxis === "x" ? "z" : "x";
  const s0 = along === "x" ? aw[0] : aw[2];
  const s1 = along === "x" ? bw[0] : bw[2];
  const opened = doorwayBox(door, fpW, fpD);
  const worldBox = mapBox(opened.box, toWorld);
  const center = toWorld(opened.center);
  const hostLocal = hostBox(door.wall, fpW, fpD, room.height);
  const hostWorld = mapBox({ ...hostLocal, minY: 0, maxY: room.height }, (p) => {
    const lifted: Vec3 = [p[0], p[1], p[2]];
    return instanceToWorld(building, inst, elevation, lifted);
  });
  return {
    id: `${prefix}.${door.id}`,
    width: door.width,
    height: door.height,
    along,
    spanMin: Math.min(s0, s1),
    spanMax: Math.max(s0, s1),
    face: normalAxis === "x" ? facePoint[0] : facePoint[2],
    normal,
    sceneDoor: {
      id: `${prefix}.${door.id}`,
      model: door.model,
      building: building.id,
      center,
      minX: worldBox.minX,
      maxX: worldBox.maxX,
      minZ: worldBox.minZ,
      maxZ: worldBox.maxZ,
      hinge: door.hinge,
      width: door.width,
      height: door.height,
      open: door.open,
      ...(door.locked ? { locked: true } : {}),
      ...(door.key ? { key: door.key } : {}),
    },
    host: {
      min: [hostWorld.minX, hostWorld.minY, hostWorld.minZ],
      max: [hostWorld.maxX, hostWorld.maxY, hostWorld.maxZ],
    },
    file,
  };
}

function doorwayBox(door: RoomDoor, width: number, depth: number): { box: LocalBox; center: Vec3 } {
  const line = wallLine(door.wall, width, depth);
  const n = wallNormal(door.wall);
  const half = door.width / 2;
  if (line.axis === "z") {
    const z0 = line.at;
    const z1 = line.at + n.z * WALL_T;
    return {
      box: {
        minX: door.center[0] - half,
        maxX: door.center[0] + half,
        minY: door.center[1],
        maxY: door.center[1],
        minZ: Math.min(z0, z1),
        maxZ: Math.max(z0, z1),
      },
      center: [door.center[0], door.center[1], (z0 + z1) / 2 + n.z * FACE_NUDGE_M],
    };
  }
  const x0 = line.at;
  const x1 = line.at + n.x * WALL_T;
  return {
    box: {
      minX: Math.min(x0, x1),
      maxX: Math.max(x0, x1),
      minY: door.center[1],
      maxY: door.center[1],
      minZ: door.center[2] - half,
      maxZ: door.center[2] + half,
    },
    center: [(x0 + x1) / 2 + n.x * FACE_NUDGE_M, door.center[1], door.center[2]],
  };
}

function hostBox(wall: WallFace, width: number, depth: number, height: number): LocalBox {
  const line = wallLine(wall, width, depth);
  const n = wallNormal(wall);
  const hx = width / 2;
  const hz = depth / 2;
  if (line.axis === "z") {
    const z0 = line.at;
    const z1 = line.at + n.z * WALL_T;
    return {
      minX: -hx,
      maxX: hx,
      minY: 0,
      maxY: height,
      minZ: Math.min(z0, z1),
      maxZ: Math.max(z0, z1),
    };
  }
  const x0 = line.at;
  const x1 = line.at + n.x * WALL_T;
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minY: 0,
    maxY: height,
    minZ: -hz,
    maxZ: hz,
  };
}

function wallNormal(wall: WallFace): { x: number; z: number } {
  switch (wall) {
    case "front":
      return { x: 0, z: 1 };
    case "back":
      return { x: 0, z: -1 };
    case "left":
      return { x: -1, z: 0 };
    case "right":
      return { x: 1, z: 0 };
  }
}

function composeNormal(buildingYaw: Yaw, instYaw: Yaw, wall: WallFace): { x: number; z: number } {
  const local = wallNormal(wall);
  const turned = transformXz(local.x, local.z, instYaw);
  return transformXz(turned.x, turned.z, buildingYaw);
}

function relate(door: PendingRoomDoor, other: DoorPlacement): "none" | "partial" | "merge" {
  const span = situatedSpan(other);
  if (Math.abs(door.normal.x * span.normal.z - door.normal.z * span.normal.x) > 1e-6) return "none";
  if (door.along !== span.along) return "none";
  if (Math.abs(door.face - span.face) > DOOR_FACE_TOL_M) return "none";
  const overlap = Math.min(door.spanMax, span.max) - Math.max(door.spanMin, span.min);
  if (!(overlap > SPAN_OVERLAP_M)) return "none";
  const doorCenter = (door.spanMin + door.spanMax) / 2;
  const otherCenter = (span.min + span.max) / 2;
  const inside = doorCenter > span.min && doorCenter < span.max
    && otherCenter > door.spanMin && otherCenter < door.spanMax;
  return inside ? "merge" : "partial";
}

/** Situated opening: hinge at `position`, width along local +X, face on local +Z. */
function situatedSpan(door: DoorPlacement): {
  along: "x" | "z";
  face: number;
  min: number;
  max: number;
  normal: { x: number; z: number };
} {
  const normal = transformXz(0, 1, door.yaw);
  const along = transformXz(1, 0, door.yaw);
  const width = door.size[0];
  const t0 = door.hinge === "left" ? 0 : -width;
  const t1 = door.hinge === "left" ? width : 0;
  const p0x = door.position[0] + along.x * t0;
  const p0z = door.position[2] + along.z * t0;
  const p1x = door.position[0] + along.x * t1;
  const p1z = door.position[2] + along.z * t1;
  const normalAxis: "x" | "z" = Math.abs(normal.x) >= Math.abs(normal.z) ? "x" : "z";
  const alongAxis: "x" | "z" = normalAxis === "x" ? "z" : "x";
  const a = alongAxis === "x" ? p0x : p0z;
  const b = alongAxis === "x" ? p1x : p1z;
  return {
    along: alongAxis,
    face: normalAxis === "x" ? door.position[0] : door.position[2],
    min: Math.min(a, b),
    max: Math.max(a, b),
    normal,
  };
}

function roundDoor(door: DoorPlacement): DoorPlacement {
  return { ...door, position: roundVec(door.position), size: roundVec(door.size) };
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new PlanError(`cannot read ${filePath}`);
  }
}

function roundM(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundVec(v: Vec3): Vec3 {
  return [roundM(v[0]), roundM(v[1]), roundM(v[2])];
}

function fmt(n: number): string {
  return String(roundM(n));
}
