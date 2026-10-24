import { DOOR_HEIGHT_M } from "./doors.ts";
import { PlanError } from "./errors.ts";
import type { XzRect } from "./footprint.ts";
import type { DoorCorner } from "./glb-write.ts";
import { cutFace, roomApertures, subQuad, type St } from "./room-cut.ts";
import { faceCorners } from "./room-glb.ts";
import type { RoomLightSource, RoomSource, WallFace } from "./room-svg.ts";
import type { DoorHinge, LocalBox, Vec3, Yaw } from "./types.ts";

/** Wall boxes sit this far behind the face, outside the room. */
export const WALL_T = 0.2;

/** Floor boxes sit this far below y = 0. */
export const FLOOR_T = 0.1;

export const MAX_ROOM_OBSTACLES = 64;

const SOLID_FACES = ["front", "back", "left", "right", "floor"] as const;

export type RoomDoor = {
  id: string;
  model: string;
  wall: WallFace;
  /** Snapped centre. y is the sill. */
  center: Vec3;
  width: number;
  height: number;
  hinge: DoorHinge;
  open: boolean;
  locked?: boolean;
  key?: string;
};

export type RoomProp = {
  id: string;
  model: string;
  position: Vec3;
  yaw: Yaw;
  scale: number;
  drawnWidth: number;
  drawnDepth: number;
  minY?: number;
  maxY?: number;
};

export type RoomLight = {
  id: string;
  type: "point" | "rect";
  position: Vec3;
  color: string;
  intensity: number;
  width?: number;
  height?: number;
  range?: number;
};

export type RoomFile = {
  formatVersion: 1;
  units: "meters";
  id: string;
  /** Basename of `--out`. */
  glb: string;
  source: "svg" | "blender";
  /** −w/2..w/2, −d/2..d/2. */
  footprint: XzRect;
  height: number;
  obstacles: Array<LocalBox & { id: string }>;
  walkable: XzRect[];
  /** Floor holes only. */
  holes: XzRect[];
  doors: RoomDoor[];
  props: RoomProp[];
  lights: RoomLight[];
};

/** Box behind a face rectangle. c = faceCorners(face, ...), n = c[0].normal (into the room). */
function boxBehind(c: readonly DoorCorner[], r: St, t: number): LocalBox {
  const q = subQuad(c, r);
  const n = c[0]!.normal;
  const pts = [q[0]!.position, q[2]!.position].flatMap((p) => [
    p,
    [p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t] as Vec3,
  ]);
  const lo = (i: 0 | 1 | 2) => Math.min(...pts.map((p) => p[i]));
  const hi = (i: 0 | 1 | 2) => Math.max(...pts.map((p) => p[i]));
  return { minX: lo(0), maxX: hi(0), minY: lo(1), maxY: hi(1), minZ: lo(2), maxZ: hi(2) };
}

function xzOf(c: readonly DoorCorner[], r: St): XzRect {
  const quad = subQuad(c, r);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const corner of quad) {
    const x = corner.position[0];
    const z = corner.position[2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

function roomDoor(door: RoomSource["doors"][number]): RoomDoor {
  const alongX = door.wall === "front" || door.wall === "back";
  const width = door.width ?? (alongX ? door.maxX - door.minX : door.maxZ - door.minZ);
  const height = door.height ?? DOOR_HEIGHT_M;
  return {
    id: door.id,
    model: door.model,
    wall: door.wall,
    center: [door.center[0], door.center[1], door.center[2]],
    width,
    height,
    hinge: door.hinge,
    open: door.open,
    ...(door.locked !== undefined ? { locked: door.locked } : {}),
    ...(door.key !== undefined ? { key: door.key } : {}),
  };
}

/** Collision boxes, walkable floor rects, and doors. Numbers are rounded to 1e-6 m. */
export function roomFile(room: RoomSource, glb: string, source: "svg" | "blender"): RoomFile {
  const hx = room.width / 2;
  const hz = room.depth / 2;
  const y1 = room.height;
  const apertures = roomApertures(room);
  const obstacles: Array<LocalBox & { id: string }> = [];
  for (const face of SOLID_FACES) {
    const corners = faceCorners(face, hx, hz, y1);
    const rects = cutFace(apertures[face]);
    const thickness = face === "floor" ? FLOOR_T : WALL_T;
    for (let n = 0; n < rects.length; n += 1) {
      obstacles.push({ id: `${face}.${n}`, ...boxBehind(corners, rects[n]!, thickness) });
    }
  }
  for (const win of room.windows) {
    if (!win.glass) continue;
    const aperture = apertures[win.wall].find((item) => item.id === win.id);
    if (!aperture) throw new PlanError(`room "${room.id}" window "${win.id}" has no aperture`);
    obstacles.push({
      id: `${win.id}.pane`,
      ...boxBehind(faceCorners(win.wall, hx, hz, y1), aperture, WALL_T),
    });
  }
  if (obstacles.length > MAX_ROOM_OBSTACLES) {
    throw new PlanError(`room "${room.id}": ${obstacles.length} obstacles, the limit is ${MAX_ROOM_OBSTACLES}`);
  }

  const floor = faceCorners("floor", hx, hz, y1);
  const file: RoomFile = {
    formatVersion: 1,
    units: "meters",
    id: room.id,
    glb,
    source,
    footprint: {
      minX: room.footprint.minX,
      maxX: room.footprint.maxX,
      minZ: room.footprint.minZ,
      maxZ: room.footprint.maxZ,
    },
    height: room.height,
    obstacles,
    walkable: cutFace(apertures.floor).map((rect) => xzOf(floor, rect)),
    holes: room.holes
      .filter((hole) => hole.cut === "floor" || hole.cut === "both")
      .map((hole) => ({ minX: hole.minX, maxX: hole.maxX, minZ: hole.minZ, maxZ: hole.maxZ })),
    doors: room.doors.map(roomDoor),
    props: room.props.map(roomProp),
    lights: room.lights.map(roomLight),
  };
  return roundValue(file);
}

function roomProp(prop: RoomSource["props"][number]): RoomProp {
  return {
    id: prop.id,
    model: prop.model,
    position: [prop.position[0], prop.position[1], prop.position[2]],
    yaw: prop.yaw,
    scale: prop.scale,
    drawnWidth: prop.drawnWidth,
    drawnDepth: prop.drawnDepth,
    ...(prop.minY !== undefined ? { minY: prop.minY } : {}),
    ...(prop.maxY !== undefined ? { maxY: prop.maxY } : {}),
  };
}

/** A rect light faces down (−Y), with width along room-local X and height along Z. */
function roomLight(light: RoomLightSource): RoomLight {
  const rect = light.width !== undefined && light.height !== undefined;
  return {
    id: light.id,
    type: rect ? "rect" : "point",
    position: [light.x, light.y, light.z],
    color: light.color,
    intensity: light.intensity,
    ...(rect ? { width: light.width, height: light.height } : {}),
    ...(light.range > 0 ? { range: light.range } : {}),
  };
}

function roundM(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundValue<T>(value: T): T {
  if (typeof value === "number") return roundM(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => roundValue(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = roundValue(item);
    return out as T;
  }
  return value;
}
