import { PlanError } from "./errors.ts";
import type { DoorPlacement, LocalBox, SceneDoor, Triangle, Vec3, Yaw } from "./types.ts";
import { inverseYaw, placeBox, transformXz } from "./yaw.ts";

/** Panel height when the rectangle does not set `data-height`. */
export const DOOR_HEIGHT_M = 2.1;

/** Panel thickness when the rectangle does not set `data-depth`. */
export const DOOR_DEPTH_M = 0.08;

/**
 * Minimum hole through the wall. A 0.5 m pawn needs a passage deeper than
 * the wall's outer skin, so the stamp is at least this deep.
 */
export const DOOR_GAP_DEPTH_M = 2;

/**
 * A wall box is on the door's wall when its outer side is within this of the
 * face the hinge sits on. A box whose outside is deeper (an interior or
 * opposite wall the 2 m stamp reaches) is left whole.
 */
export const DOOR_FACE_TOL_M = 0.5;

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
  /**
   * Clear opening in the door's local frame. The hinge is the origin.
   * +X runs along the wall for a left hinge. −Z is inward. Y is 0 at the
   * placement, up to the door height.
   */
  opening: LocalBox;
};

const BOX_EPS = 1e-6;

/**
 * Put the hinge on the hinge edge of the drawn rectangle, on the nearest
 * exposed wall face. The door GLB's origin is its hinge (the arena mounts
 * that origin at `position`), and the clear opening runs one width from it,
 * so the mesh, the opening, and the drawn rectangle share one span.
 * Local +X is `transformXz(1, 0, yaw)`. A left hinge sits on the
 * rectangle's local −X edge, a right hinge on its +X edge.
 *
 * The width, in order:
 * - `data-width`, centered on the rectangle (the hinge sits half that width
 *   from the center);
 * - `modelWidth`, the door GLB's panel width, measured from the hinge edge of
 *   the drawn rectangle, so a rectangle drawn wider than the model does not
 *   widen the hole;
 * - the drawn rectangle's span along the wall.
 * The door itself is not an obstacle.
 *
 * Check: a 2 m rectangle centered at x 10 on a yaw-0 face, left hinge:
 * position x 9, opening world x 9..11. Right hinge: position x 11, same span.
 * With `modelWidth` 1.05: left hinge x 9, opening 9..10.05; right hinge x 11,
 * opening 9.95..11.
 */
export function situateDoor(door: SceneDoor, boxes: readonly WorldBox[], modelWidth?: number): SituatedDoor {
  const face = nearestFace(door.center[0], door.center[1], door.center[2], boxes);
  if (!face) throw new PlanError(`door "${door.id}" has no wall on "${door.building}"`);
  if (modelWidth !== undefined && !(modelWidth > 0)) {
    throw new PlanError(`door "${door.id}" model "${door.model}" panel width must be positive`);
  }
  const drawn = spanAlong(door, face.axis);
  const width = door.width ?? modelWidth ?? drawn;
  if (!(width > 0)) throw new PlanError(`door "${door.id}" width must be positive`);
  const point = hingeOnFace(door, face, door.width ?? drawn);
  const placement: DoorPlacement = {
    id: door.id,
    model: door.model,
    position: [point.x, point.y, point.z],
    yaw: face.yaw,
    hinge: door.hinge,
    size: [width, door.height ?? DOOR_HEIGHT_M, door.depth ?? DOOR_DEPTH_M],
    open: door.open,
    ...(door.locked ? { locked: true } : {}),
    ...(door.key ? { key: door.key } : {}),
  };
  return { placement, opening: doorClearLocal(placement) };
}

/**
 * Hinge edge of a span centered on the rectangle, with the normal coordinate
 * on `face`. `span` is the drawn span, or `data-width`. Not clamped to one box.
 */
function hingeOnFace(door: SceneDoor, face: WallFace, span: number): { x: number; y: number; z: number } {
  const alongX = transformXz(1, 0, face.yaw);
  const half = door.hinge === "left" ? -span / 2 : span / 2;
  const x = door.center[0] + alongX.x * half;
  const z = door.center[2] + alongX.z * half;
  if (face.axis === "x") return { x: face.coord, y: door.center[1], z };
  return { x, y: door.center[1], z: face.coord };
}

/**
 * Panel width of a door GLB: the X extent of its `door` mesh (the swinging
 * panel `prop --shape door` writes), in model meters. The frame stiles are
 * left out; they overlap the jambs. Undefined when there is no panel mesh.
 */
export function doorPanelWidth(triangles: readonly Triangle[]): number | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const tri of triangles) {
    for (const v of tri) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
    }
  }
  const width = maxX - minX;
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

/**
 * Hinge-aligned opening in the door GLB's local frame.
 * A left hinge occupies x 0..width. A right hinge occupies x −width..0.
 * Y is the clear height above the placement: the frame bottom sits on that
 * y, so the hole is 0..height, not the GLB's mid-height origin.
 * −Z is inward. The stamp is `DOOR_GAP_DEPTH_M`, deeper than the panel, so a
 * pawn clears the skin. A thicker host keeps the solid behind that depth.
 *
 * Check: left hinge, width 2, height 2.1. The box is x 0..2, y 0..2.1, z −2..0.
 * A right hinge is x −2..0. It is not x −1..1.
 */
export function doorClearLocal(placement: DoorPlacement): LocalBox {
  const [width, height] = placement.size;
  const minX = placement.hinge === "left" ? 0 : -width;
  const maxX = placement.hinge === "left" ? width : 0;
  return {
    minX,
    maxX,
    minY: 0,
    maxY: height,
    minZ: -DOOR_GAP_DEPTH_M,
    maxZ: 0,
  };
}

/**
 * AABB difference. At most six pieces: full-height slabs on either side of
 * the cut along X, then the Y slabs across the cut's X (the original Z),
 * then the Z slabs across the cut's X and Y. The six do not overlap. A
 * piece thinner than 1e-6 is dropped. No overlap with the cut means the
 * original box.
 */
export function subtractBox(box: LocalBox, cut: LocalBox): LocalBox[] {
  const hole = intersectBox(box, cut);
  if (!hole) return [box];
  const parts: LocalBox[] = [];
  if (hole.minX > box.minX + BOX_EPS) parts.push({ ...box, maxX: hole.minX });
  if (hole.maxX < box.maxX - BOX_EPS) parts.push({ ...box, minX: hole.maxX });
  if (hole.minY > box.minY + BOX_EPS) {
    parts.push({ ...box, minX: hole.minX, maxX: hole.maxX, maxY: hole.minY });
  }
  if (hole.maxY < box.maxY - BOX_EPS) {
    parts.push({ ...box, minX: hole.minX, maxX: hole.maxX, minY: hole.maxY });
  }
  if (hole.minZ > box.minZ + BOX_EPS) {
    parts.push({
      ...box,
      minX: hole.minX,
      maxX: hole.maxX,
      minY: hole.minY,
      maxY: hole.maxY,
      maxZ: hole.minZ,
    });
  }
  if (hole.maxZ < box.maxZ - BOX_EPS) {
    parts.push({
      ...box,
      minX: hole.minX,
      maxX: hole.maxX,
      minY: hole.minY,
      maxY: hole.maxY,
      minZ: hole.maxZ,
    });
  }
  return parts.filter(positiveBox);
}

/**
 * Replace one wall AABB with the solid that remains around a door opening.
 * Both boxes are in the same frame: X along the wall, Y up, Z through the
 * thickness. A through-wall door is the two jambs, the lintel, and a sill
 * when the wall extends below the opening. A host thicker than the opening
 * also keeps the plug behind it. Pieces stay inside the wall.
 */

export function subtractDoorOpening(wall: LocalBox, opening: LocalBox): LocalBox[] {
  const hole = intersectBox(wall, opening);
  if (!hole) return [wall];
  const parts: LocalBox[] = [];
  if (hole.minX > wall.minX + BOX_EPS) parts.push({ ...wall, maxX: hole.minX });
  if (hole.maxX < wall.maxX - BOX_EPS) parts.push({ ...wall, minX: hole.maxX });
  if (hole.maxY < wall.maxY - BOX_EPS) {
    parts.push({
      ...wall,
      minX: hole.minX,
      maxX: hole.maxX,
      minY: hole.maxY,
      minZ: hole.minZ,
      maxZ: hole.maxZ,
    });
  }
  if (hole.minY > wall.minY + BOX_EPS) {
    parts.push({
      ...wall,
      minX: hole.minX,
      maxX: hole.maxX,
      maxY: hole.minY,
      minZ: hole.minZ,
      maxZ: hole.maxZ,
    });
  }
  if (hole.minZ > wall.minZ + BOX_EPS) {
    parts.push({ ...wall, minX: hole.minX, maxX: hole.maxX, maxZ: hole.minZ });
  }
  if (hole.maxZ < wall.maxZ - BOX_EPS) {
    parts.push({ ...wall, minX: hole.minX, maxX: hole.maxX, minZ: hole.maxZ });
  }
  return parts.filter(positiveBox);
}

/**
 * Cut `situated.opening` out of every model-space wall box it overlaps.
 * A facade is often several boxes with vertical seams, so the opening can
 * straddle two or more of them. Each one is split around its share of the
 * hole: jambs, lintel, and sill, clipped to that box. Untouched boxes keep
 * their place in the list and are not re-transformed.
 * Only boxes on the door's own wall count: the box must reach the face
 * (outer side within `DOOR_FACE_TOL_M`) and extend inward. A box that only
 * touches the opening along an edge or face is not a hit. A face skin that
 * stands proud of the hinge face is cut through too, so no sliver seals the
 * doorway. No hit at all is a plan error, unless `requireHit` is false
 * (a room wall the opening may miss). Then the boxes are returned unchanged.
 * `outwardCap` limits how far past the opening's outer face the hole runs.
 * Infinity, the default, still reaches the host box's far face.
 */
export function cutDoorFromBoxes(
  modelBoxes: readonly LocalBox[],
  situated: SituatedDoor,
  buildingPosition: Vec3,
  buildingYaw: Yaw,
  requireHit = true,
  outwardCap = Infinity,
): LocalBox[] {
  const { placement, opening } = situated;
  const out: LocalBox[] = [];
  let hits = 0;
  for (const box of modelBoxes) {
    const wallWorld = placeBox(box, buildingPosition, buildingYaw);
    const wallLocal = toLocalBox(wallWorld, placement.position, placement.yaw);
    if (!onDoorWall(wallLocal)) {
      out.push(box);
      continue;
    }
    const through = throughOpening(opening, wallLocal, outwardCap);
    if (!intersectBox(wallLocal, through)) {
      out.push(box);
      continue;
    }
    hits += 1;
    for (const part of subtractDoorOpening(wallLocal, through)) {
      out.push(toLocalBox(placeBox(part, placement.position, placement.yaw), buildingPosition, buildingYaw));
    }
  }
  if (hits === 0) {
    if (!requireHit) return modelBoxes.slice();
    throw new PlanError(`door "${placement.id}" does not hit a wall box`);
  }
  return out;
}

/**
 * Door-local AABB of the solid `cutDoorFromBoxes` removes.
 * Same hit rule: the wall must meet the hinge face, and the stamp extends
 * out through a skin that stands proud of that face. Undefined when no wall
 * is hit. The box is the union of those intersections, so its depth is the
 * wall that was actually cut, not the 2 m inward stamp alone.
 */
export function doorCutLocal(
  modelBoxes: readonly LocalBox[],
  situated: SituatedDoor,
  buildingPosition: Vec3,
  buildingYaw: Yaw,
  outwardCap = Infinity,
): LocalBox | undefined {
  const { placement, opening } = situated;
  let hole: LocalBox | undefined;
  for (const box of modelBoxes) {
    const wallWorld = placeBox(box, buildingPosition, buildingYaw);
    const wallLocal = toLocalBox(wallWorld, placement.position, placement.yaw);
    if (!onDoorWall(wallLocal)) continue;
    const through = throughOpening(opening, wallLocal, outwardCap);
    const hit = intersectBox(wallLocal, through);
    if (!hit) continue;
    hole = hole ? unionBox(hole, hit) : hit;
  }
  return hole;
}

/**
 * Metres the box extends past the opening's outer face, in the door frame.
 * Undefined when the box is not this door's wall. +Z is outward from the
 * hinge face. A thin shell is under a metre. A filled hall is several.
 */
export function doorOutwardDepth(
  box: LocalBox,
  situated: SituatedDoor,
  buildingPosition: Vec3,
  buildingYaw: Yaw,
): number | undefined {
  const { placement, opening } = situated;
  const wallWorld = placeBox(box, buildingPosition, buildingYaw);
  const wallLocal = toLocalBox(wallWorld, placement.position, placement.yaw);
  if (!onDoorWall(wallLocal)) return undefined;
  if (!intersectBox(wallLocal, throughOpening(opening, wallLocal, Infinity))) return undefined;
  return wallLocal.maxZ - opening.maxZ;
}

/** Opening extended to the wall's far face, and no further than `outwardCap` past `opening.maxZ`. */
function throughOpening(opening: LocalBox, wallLocal: LocalBox, outwardCap: number): LocalBox {
  const far = Math.max(opening.maxZ, wallLocal.maxZ);
  return { ...opening, maxZ: Math.min(far, opening.maxZ + outwardCap) };
}

function unionBox(a: LocalBox, b: LocalBox): LocalBox {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/**
 * Door frame: the face is z = 0 and −Z is inward. The box's outer side is
 * within `DOOR_FACE_TOL_M` of the face, and the box reaches the face plane
 * (a skin standing proud of it counts, a column in front of it does not).
 */
function onDoorWall(wall: LocalBox): boolean {
  return wall.maxZ > -DOOR_FACE_TOL_M && wall.minZ < BOX_EPS;
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

/**
 * Nearest exposed face. A face whose foot point is inside a neighbouring box
 * (the seam between two boxes of one wall, or a skin behind a proud one) is
 * not the outside of the wall and is skipped. If every face is covered, the
 * nearest face of any box is used, as before.
 */
function nearestFace(x: number, y: number, z: number, boxes: readonly WorldBox[]): WallFace | undefined {
  let best: WallFace | undefined;
  let bestDistance = Infinity;
  let fallback: WallFace | undefined;
  let fallbackDistance = Infinity;
  for (const box of boxes) {
    for (const face of facesOf(box)) {
      const distance = distanceToFace(x, z, face);
      if (!fallback || closer(distance, face, fallbackDistance, fallback)) {
        fallback = face;
        fallbackDistance = distance;
      }
      if (covered(face, x, y, z, boxes)) continue;
      if (!reachesHeight(face.box, y)) continue;
      if (!best || closer(distance, face, bestDistance, best)) {
        best = face;
        bestDistance = distance;
      }
    }
  }
  return best ?? fallback;
}

/** Probe a little outside the face, at mid door height. */
const FACE_PROBE_M = 1e-3;
const FACE_PROBE_Y_M = 1;

function covered(face: WallFace, x: number, y: number, z: number, boxes: readonly WorldBox[]): boolean {
  const foot = projectToFace(x, y, z, face);
  const px = face.axis === "x" ? face.coord + face.sign * FACE_PROBE_M : foot.x;
  const pz = face.axis === "z" ? face.coord + face.sign * FACE_PROBE_M : foot.z;
  const py = y + FACE_PROBE_Y_M;
  return boxes.some((box) => box !== face.box
    && px > box.min[0] + BOX_EPS && px < box.max[0] - BOX_EPS
    && py > box.min[1] + BOX_EPS && py < box.max[1] - BOX_EPS
    && pz > box.min[2] + BOX_EPS && pz < box.max[2] - BOX_EPS);
}

/**
 * The face's box stands at the door's height: it spans the probe height above
 * the sill (`y + FACE_PROBE_Y_M`). A step or plinth below an elevated door, or
 * a cornice above a ground door, is not its wall. Used for the preferred face;
 * the nearest face of any box stays the fallback.
 */
function reachesHeight(box: WorldBox, y: number): boolean {
  const py = y + FACE_PROBE_Y_M;
  return py > box.min[1] + BOX_EPS && py < box.max[1] - BOX_EPS;
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

function projectToFace(x: number, y: number, z: number, face: WallFace): { x: number; y: number; z: number } {
  const along = face.axis === "x" ? z : x;
  const clamped = Math.min(face.along1, Math.max(face.along0, along));
  if (face.axis === "x") return { x: face.coord,  y:y, z: clamped };
  return { x: clamped, y: y, z: face.coord };
}

function positiveBox(box: LocalBox): boolean {
  return box.maxX > box.minX + BOX_EPS
    && box.maxY > box.minY + BOX_EPS
    && box.maxZ > box.minZ + BOX_EPS;
}

function intersectBox(wall: LocalBox, opening: LocalBox): LocalBox | undefined {
  const box: LocalBox = {
    minX: Math.max(wall.minX, opening.minX),
    maxX: Math.min(wall.maxX, opening.maxX),
    minY: Math.max(wall.minY, opening.minY),
    maxY: Math.min(wall.maxY, opening.maxY),
    minZ: Math.max(wall.minZ, opening.minZ),
    maxZ: Math.min(wall.maxZ, opening.maxZ),
  };
  return positiveBox(box) ? box : undefined;
}

/** World AABB into the frame whose origin and yaw are `origin` / `yaw`. Cardinal yaw stays an AABB. */
function toLocalBox(world: WorldBox, origin: Vec3, yaw: Yaw): LocalBox {
  const inv = inverseYaw(yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [world.min[0], world.max[0]]) {
    for (const z of [world.min[2], world.max[2]]) {
      const local = transformXz(x - origin[0], z - origin[2], inv);
      if (local.x < minX) minX = local.x;
      if (local.x > maxX) maxX = local.x;
      if (local.z < minZ) minZ = local.z;
      if (local.z > maxZ) maxZ = local.z;
    }
  }
  return {
    minX,
    maxX,
    minY: world.min[1] - origin[1],
    maxY: world.max[1] - origin[1],
    minZ,
    maxZ,
  };
}
