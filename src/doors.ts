import { PlanError } from "./errors.ts";
import type { DoorPlacement, SceneDoor, Vec3, Yaw } from "./types.ts";
import type { XzRect } from "./footprint.ts";
import { inverseYaw, transformXz } from "./yaw.ts";

/** Panel height when the rectangle does not set `data-height`. */
export const DOOR_HEIGHT_M = 2.1;

/** Panel thickness when the rectangle does not set `data-depth`. */
export const DOOR_DEPTH_M = 0.08;

/**
 * Minimum hole through the wall. A 0.5 m pawn needs a passage deeper than
 * the wall's outer skin, so the stamp is at least this deep.
 */
export const DOOR_GAP_DEPTH_M = 2;

type WorldBox = { min: Vec3; max: Vec3 };

type WallFace = {
  axis: "x" | "z";
  /** +1 is the max side. Its outward normal points along the positive axis. */
  sign: 1 | -1;
  coord: number;
  along0: number;
  along1: number;
  /**
   * Yaw whose local +Z matches the outward normal.
   * maxZ → 0, minZ → 180, maxX → 90, minX → 270.
   */
  yaw: Yaw;
  box: WorldBox;
};

export type SituatedDoor = {
  placement: DoorPlacement;
  /** World rectangle cleared in the occupancy grid, before the inverse yaw. */
  opening: XzRect;
};

/**
 * Push the rectangle center onto the nearest wall face and build the hole.
 * The hole is the door width along the wall and 2 m in from that face.
 * It is not the rest of the footprint. The door itself is not an obstacle.
 */
export function situateDoor(door: SceneDoor, boxes: readonly WorldBox[]): SituatedDoor {
  const face = nearestFace(door.center[0], door.center[2], boxes);
  if (!face) throw new PlanError(`door "${door.id}" has no wall on "${door.building}"`);
  const width = door.width ?? spanAlong(door, face.axis);
  if (!(width > 0)) throw new PlanError(`door "${door.id}" width must be positive`);
  const point = projectToFace(door.center[0], door.center[2], face);
  return {
    placement: {
      id: door.id,
      model: door.model,
      position: [point.x, 0, point.z],
      yaw: face.yaw,
      hinge: door.hinge,
      size: [width, door.height ?? DOOR_HEIGHT_M, door.depth ?? DOOR_DEPTH_M],
      open: door.open,
    },
    opening: openingFor(point.x, point.z, face, width),
  };
}

/** World opening into the scaled model grid. Cardinal yaw keeps it axis-aligned. */
export function openingInModel(opening: XzRect, position: Vec3, yaw: Yaw): XzRect {
  const inv = inverseYaw(yaw);
  const corners = [
    [opening.minX, opening.minZ],
    [opening.maxX, opening.minZ],
    [opening.minX, opening.maxZ],
    [opening.maxX, opening.maxZ],
  ].map(([x, z]) => transformXz(x - position[0], z - position[2], inv));
  const xs = corners.map((corner) => corner.x);
  const zs = corners.map((corner) => corner.z);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}

function spanAlong(door: SceneDoor, axis: "x" | "z"): number {
  return axis === "z" ? door.maxX - door.minX : door.maxZ - door.minZ;
}

function facesOf(box: WorldBox): WallFace[] {
  return [
    { axis: "x", sign: -1, coord: box.min[0], along0: box.min[2], along1: box.max[2], yaw: 270, box },
    { axis: "x", sign: 1, coord: box.max[0], along0: box.min[2], along1: box.max[2], yaw: 90, box },
    { axis: "z", sign: -1, coord: box.min[2], along0: box.min[0], along1: box.max[0], yaw: 180, box },
    { axis: "z", sign: 1, coord: box.max[2], along0: box.min[0], along1: box.max[0], yaw: 0, box },
  ];
}

function nearestFace(x: number, z: number, boxes: readonly WorldBox[]): WallFace | undefined {
  let best: WallFace | undefined;
  let bestDistance = Infinity;
  for (const box of boxes) {
    for (const face of facesOf(box)) {
      const distance = distanceToFace(x, z, face);
      if (!best || closer(distance, face, bestDistance, best)) {
        best = face;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Smaller distance wins. A tie prefers the max side, then a Z face (yaw 0). */
function closer(distance: number, face: WallFace, bestDistance: number, best: WallFace): boolean {
  if (distance < bestDistance - 1e-6) return true;
  if (distance > bestDistance + 1e-6) return false;
  if (face.sign !== best.sign) return face.sign > best.sign;
  if (face.axis !== best.axis) return face.axis === "z";
  return false;
}

function distanceToFace(x: number, z: number, face: WallFace): number {
  const along = face.axis === "x" ? z : x;
  const normal = face.axis === "x" ? x : z;
  const clamped = Math.min(face.along1, Math.max(face.along0, along));
  return Math.hypot(normal - face.coord, along - clamped);
}

function projectToFace(x: number, z: number, face: WallFace): { x: number; z: number } {
  const along = face.axis === "x" ? z : x;
  const clamped = Math.min(face.along1, Math.max(face.along0, along));
  if (face.axis === "x") return { x: face.coord, z: clamped };
  return { x: clamped, z: face.coord };
}

/**
 * The door's own rectangle, then the door yaw. Local +X is the width along
 * the wall. Local −Z is inward, and the gap is 2 m along that normal, not
 * the building footprint. The yaw is the face yaw the visual already uses.
 *
 * Check: face point (10, 10.5), yaw 0, width 2. The corners stay
 * x 9..11 and z 8.5..10.5, so a wall along X loses 2 m of X. Yaw 90 sends
 * local +X to world −Z, so that 2 m lies along Z.
 */
function openingFor(x: number, z: number, face: WallFace, width: number): XzRect {
  const corners = [
    [-width / 2, -DOOR_GAP_DEPTH_M],
    [width / 2, -DOOR_GAP_DEPTH_M],
    [-width / 2, 0],
    [width / 2, 0],
  ].map(([localX, localZ]) => {
    const turned = transformXz(localX!, localZ!, face.yaw);
    return { x: x + turned.x, z: z + turned.z };
  });
  const xs = corners.map((corner) => corner.x);
  const zs = corners.map((corner) => corner.z);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  };
}
