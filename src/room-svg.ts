import { existsSync } from "node:fs";
import path from "node:path";
import { PlanError } from "./errors.ts";
import type { XzRect } from "./footprint.ts";
import { loadTextureRef } from "./crate.ts";
import {
  ID_RE,
  apply,
  documentUnits,
  doorFromElement,
  ident,
  mul,
  optionalNumber,
  optionalPositive,
  pageFrame,
  parseTransform,
  propFromElement,
  rectBounds,
  requireId,
  svgPointToWorld,
  uniformScale,
  yawFromSvgMatrix,
  type Mat,
  type PageFrame,
} from "./plan.ts";
import type { SceneDoor, SceneProp, Vec3 } from "./types.ts";
import { attr, localName, parseXml, type XmlNode } from "./xml.ts";

export type WallFace = "front" | "back" | "left" | "right";
export type RoomFace = WallFace | "floor" | "ceiling";
/** `ref` is a data URI or a path resolved against the SVG folder (or an absref). */
export type FaceTexture = { face: RoomFace; source: RoomFace; ref: string };

export type RoomShape = { id: string; minX: number; maxX: number; minZ: number; maxZ: number };

export type RoomWindow = RoomShape & {
  wall: WallFace;
  sill: number;
  height: number;
  width: number;
  glass: boolean;
  paneRef?: string;
};

export type RoomOpening = RoomShape & {
  wall: WallFace;
  sill: number;
  height: number;
  width: number;
};

export type RoomHole = RoomShape & { cut: "floor" | "ceiling" | "both" };

export type RoomLightSource = {
  id: string;
  x: number;
  z: number;
  y: number;
  /**
   * Three.js physical units: candela for point lights and nits for rect lights.
   * Under the arena's ACES tone mapping, about 8–20 cd and 20–40 nits look right.
   */
  intensity: number;
  color: string;
  width?: number;
  height?: number;
  range: number;
};

export type RoomSource = {
  id: string;
  svgPath: string;
  /** Metres along x, z, and y. */
  width: number;
  depth: number;
  height: number;
  /** Room-local, centred on the floor. */
  footprint: XzRect;
  /** `source` is the face that was drawn. A copied opposite points at that face. */
  faces: Record<RoomFace, FaceTexture>;
  /** `building` is the room id. Centres are snapped onto the named wall. */
  doors: Array<SceneDoor & { wall: WallFace }>;
  windows: RoomWindow[];
  openings: RoomOpening[];
  holes: RoomHole[];
  props: SceneProp[];
  lights: RoomLightSource[];
  warnings: string[];
};

const SEMANTIC = new Set(["floor", "walls", "ceiling", "doors", "windows", "openings", "holes", "props", "lights"]);

const SHAPES: Record<string, ReadonlySet<string>> = {
  floor: new Set(["rect", "image"]),
  walls: new Set(["rect", "image"]),
  ceiling: new Set(["rect", "image"]),
  doors: new Set(["rect"]),
  windows: new Set(["rect", "image"]),
  openings: new Set(["rect", "image"]),
  holes: new Set(["rect"]),
  props: new Set(["rect"]),
  lights: new Set(["rect", "circle", "ellipse"]),
};

const FACE_ORDER: readonly RoomFace[] = ["front", "back", "left", "right", "floor", "ceiling"];

const OPPOSITE: Record<RoomFace, RoomFace> = {
  front: "back",
  back: "front",
  left: "right",
  right: "left",
  floor: "ceiling",
  ceiling: "floor",
};

/** Shared edges within this many metres are the same length. Matches crate `EDGE_M`. */
const EDGE_M = 1e-2;

export function layerRole(label: string | undefined): string | undefined {
  const name = (label ?? "").replace(/^\d+_/, "").toLowerCase();
  return SEMANTIC.has(name) ? name : name === "ignore" ? "ignore" : undefined;
}

/** Inner wall line in room-local metres. Doors, windows, and openings snap onto it. */
export function wallLine(wall: WallFace, width: number, depth: number): { axis: "x" | "z"; at: number } {
  switch (wall) {
    case "front":
      return { axis: "z", at: depth / 2 };
    case "back":
      return { axis: "z", at: -depth / 2 };
    case "left":
      return { axis: "x", at: -width / 2 };
    case "right":
      return { axis: "x", at: width / 2 };
  }
}

type Box = { minX: number; maxX: number; minZ: number; maxZ: number };

type Span = Box & { cx: number; cz: number };

type Hit = { el: XmlNode; matrix: Mat; role: string };

type Drawn = {
  id: string;
  face: RoomFace;
  box: Box;
  raw: string;
  absref?: string;
};

/**
 * Read one room prefab. The file name is the room id. 1 mm = 1 m.
 * The origin is the centre of the floor, y = 0 is the floor, front is +Z, and right is +X.
 */
export function readRoomSvg(svgText: string, svgPath: string): RoomSource {
  const id = path.basename(svgPath, ".svg");
  if (!ID_RE.test(id)) throw new PlanError(`invalid room id "${id}"`);
  const svg = parseXml(svgText);
  const frame = pageFrame(svg);
  const units = documentUnits(svg);
  checkIds(svg, id);
  const hits = collect(svg);

  const walls = new Map<WallFace, Drawn>();
  let floor: Drawn | undefined;
  let ceiling: Drawn | undefined;
  for (const hit of hits) {
    if (hit.role !== "floor" && hit.role !== "walls" && hit.role !== "ceiling") continue;
    const drawn = readFace(hit, id, frame, units);
    if (drawn.face === "floor" || drawn.face === "ceiling") {
      const prior = drawn.face === "floor" ? floor : ceiling;
      if (prior) {
        throw new PlanError(`room "${id}" element "${drawn.id}": more than one "${drawn.face}"`);
      }
      if (drawn.face === "floor") floor = drawn;
      else ceiling = drawn;
      continue;
    }
    if (walls.has(drawn.face)) {
      throw new PlanError(`room "${id}" element "${drawn.id}": more than one "${drawn.face}"`);
    }
    walls.set(drawn.face, drawn);
  }

  if (!floor) throw new PlanError(`room "${id}": missing floor`);
  const front = walls.get("front");
  if (!front) throw new PlanError(`room "${id}": missing front`);
  const width = spanX(front.box);
  const height = spanZ(front.box);
  const back = walls.get("back");
  if (back) {
    expectSpan(id, back, spanX(back.box), width, "width", "front width");
    expectSpan(id, back, spanZ(back.box), height, "height", "front height");
  }
  const left = walls.get("left");
  const right = walls.get("right");
  if (!left && !right) throw new PlanError(`room "${id}": missing left and right`);
  if (left) expectSpan(id, left, spanX(left.box), height, "height", "front height");
  if (right) expectSpan(id, right, spanX(right.box), height, "height", "front height");
  if (left && right) expectSpan(id, right, spanZ(right.box), spanZ(left.box), "depth", "left depth");
  const depth = spanZ((left ?? right)!.box);
  expectSpan(id, floor, spanX(floor.box), width, "width", "room width");
  expectSpan(id, floor, spanZ(floor.box), depth, "depth", "room depth");
  if (ceiling) {
    expectSpan(id, ceiling, spanX(ceiling.box), width, "width", "room width");
    expectSpan(id, ceiling, spanZ(ceiling.box), depth, "depth", "room depth");
  }

  const originX = (floor.box.minX + floor.box.maxX) / 2;
  const originZ = (floor.box.minZ + floor.box.maxZ) / 2;
  const footprint: XzRect = {
    minX: -width / 2,
    maxX: width / 2,
    minZ: -depth / 2,
    maxZ: depth / 2,
  };
  const drawnByFace = new Map<RoomFace, Drawn>([
    ["floor", floor],
    ["front", front],
  ]);
  if (back) drawnByFace.set("back", back);
  if (left) drawnByFace.set("left", left);
  if (right) drawnByFace.set("right", right);
  if (ceiling) drawnByFace.set("ceiling", ceiling);

  const refs = new Map<RoomFace, string>();
  const ownerOf = (face: RoomFace): RoomFace => {
    if (drawnByFace.has(face)) return face;
    const opposite = OPPOSITE[face];
    if (drawnByFace.has(opposite)) return opposite;
    throw new PlanError(`room "${id}": missing ${face}`);
  };
  const refOf = (face: RoomFace): string => {
    const owner = ownerOf(face);
    const cached = refs.get(owner);
    if (cached) return cached;
    const drawn = drawnByFace.get(owner)!;
    const ref = loadFace(svgPath, id, owner, drawn);
    refs.set(owner, ref);
    return ref;
  };
  const faces = Object.fromEntries(FACE_ORDER.map((face) => {
    const source = ownerOf(face);
    return [face, { face, source, ref: refOf(face) }];
  })) as Record<RoomFace, FaceTexture>;

  const doors: RoomSource["doors"] = [];
  const windows: RoomWindow[] = [];
  const openings: RoomOpening[] = [];
  const holes: RoomHole[] = [];
  const props: SceneProp[] = [];
  const lights: RoomLightSource[] = [];
  const warnings: string[] = [];
  const place = { id, frame, units, originX, originZ, width, depth, height, footprint, svgPath };

  for (const hit of hits) {
    if (hit.role === "doors") doors.push(readDoor(hit, place));
    else if (hit.role === "windows") windows.push(readWindow(hit, place));
    else if (hit.role === "openings") openings.push(readOpening(hit, place));
    else if (hit.role === "holes") holes.push(readHole(hit, place));
    else if (hit.role === "props") {
      const prop = readProp(hit, place);
      if (prop) props.push(prop);
    } else if (hit.role === "lights") {
      const light = readLight(hit, place, warnings);
      if (!light) continue;
      if (lights.some((item) => item.id === light.id)) {
        throw new PlanError(`room "${id}": duplicate light "${light.id}"`);
      }
      lights.push(light);
    }
  }

  return {
    id,
    svgPath,
    width,
    depth,
    height,
    footprint,
    faces,
    doors,
    windows,
    openings,
    holes,
    props,
    lights,
    warnings,
  };
}

type Place = {
  id: string;
  frame: PageFrame;
  units: string | undefined;
  originX: number;
  originZ: number;
  width: number;
  depth: number;
  height: number;
  footprint: XzRect;
  svgPath: string;
};

function readFace(hit: Hit, roomId: string, frame: PageFrame, units: string | undefined): Drawn {
  const id = call(roomId, undefined, () => requireId(hit.el, "face"));
  assertPose(hit.matrix, id, roomId, false);
  const box = worldBox(hit.el, hit.matrix, frame, units, id, roomId);
  const face = faceName(hit, id, roomId);
  if ((face === "floor" || face === "ceiling") && yawFromSvgMatrix(hit.matrix, id) !== 0) {
    throw new PlanError(`room "${roomId}" element "${id}": ${face} image must not be rotated`);
  }
  const tex = textureSource(hit.el);
  if (!tex.raw) throw new PlanError(`room "${roomId}" element "${id}" face "${face}": missing a texture`);
  return { id, face, box, raw: tex.raw, ...(tex.absref ? { absref: tex.absref } : {}) };
}

function faceName(hit: Hit, id: string, roomId: string): RoomFace {
  if (hit.role === "floor" || hit.role === "ceiling") {
    const explicit = explicitName(hit.el);
    if (explicit && explicit.toLowerCase() !== hit.role) {
      throw new PlanError(`room "${roomId}" element "${id}": ${hit.role} is labelled "${explicit}"`);
    }
    return hit.role;
  }
  const named = (explicitName(hit.el) || attr(hit.el, "id") || "").trim().toLowerCase();
  if (named === "front" || named === "back" || named === "left" || named === "right") return named;
  throw new PlanError(`room "${roomId}" element "${id}": face "${named}" is not front, back, left, or right`);
}

function readDoor(hit: Hit, place: Place): SceneDoor & { wall: WallFace } {
  const id = call(place.id, undefined, () => requireId(hit.el, "door"));
  assertPose(hit.matrix, id, place.id, false);
  const wall = wallAttr(hit.el, id, place.id);
  const door = call(place.id, id, () => doorFromElement(hit.el, hit.matrix, place.frame, place.units, place.id));
  const snapped = snapToWall(place.id, id, wall, {
    minX: door.minX - place.originX,
    maxX: door.maxX - place.originX,
    minZ: door.minZ - place.originZ,
    maxZ: door.maxZ - place.originZ,
    cx: door.center[0] - place.originX,
    cz: door.center[2] - place.originZ,
  }, place.width, place.depth);
  const center: Vec3 = [snapped.cx, door.center[1], snapped.cz];
  const sill = center[1];
  if (sill >= place.height - 1e-6) {
    throw new PlanError(`room "${place.id}" element "${id}": sill ${trimNum(sill)} is not below room height ${trimNum(place.height)}`);
  }
  if (door.height !== undefined && sill + door.height > place.height + 1e-6) {
    throw new PlanError(`room "${place.id}" element "${id}": sill ${trimNum(sill)} + height ${trimNum(door.height)} is above room height ${trimNum(place.height)}`);
  }
  return {
    ...door,
    wall,
    center,
    minX: snapped.minX,
    maxX: snapped.maxX,
    minZ: snapped.minZ,
    maxZ: snapped.maxZ,
  };
}

function readWindow(hit: Hit, place: Place): RoomWindow {
  const id = call(place.id, undefined, () => requireId(hit.el, "window"));
  assertPose(hit.matrix, id, place.id, false);
  const wall = wallAttr(hit.el, id, place.id);
  const snapped = snapShape(hit, place, id, wall);
  const along = alongSpan(wall, snapped);
  const what = `room "${place.id}" element "${id}"`;
  const sill = readZ(hit.el, id, place.id, 0.9);
  const winHeight = optionalPositive(attr(hit.el, "data-height"), `${what} data-height`) ?? 1.2;
  const winWidth = optionalPositive(attr(hit.el, "data-width"), `${what} data-width`) ?? along;
  const glass = readBool(hit.el, "data-glass", id, place.id, true);
  if (sill < -1e-6 || sill + winHeight > place.height + 1e-6) {
    throw new PlanError(`${what}: window does not fit the ${wall} wall`);
  }
  assertWidthFits(place.id, id, wall, snapped, winWidth, place.width, place.depth);
  const pane = paneRef(hit.el, id, place);
  return {
    id,
    minX: snapped.minX,
    maxX: snapped.maxX,
    minZ: snapped.minZ,
    maxZ: snapped.maxZ,
    wall,
    sill,
    height: winHeight,
    width: winWidth,
    glass,
    ...(pane ? { paneRef: pane } : {}),
  };
}

function readOpening(hit: Hit, place: Place): RoomOpening {
  const id = call(place.id, undefined, () => requireId(hit.el, "opening"));
  assertPose(hit.matrix, id, place.id, false);
  const wall = wallAttr(hit.el, id, place.id);
  const snapped = snapShape(hit, place, id, wall);
  const along = alongSpan(wall, snapped);
  const what = `room "${place.id}" element "${id}"`;
  const sill = readZ(hit.el, id, place.id, 0);
  const openHeight = optionalPositive(attr(hit.el, "data-height"), `${what} data-height`) ?? 2.1;
  const openWidth = optionalPositive(attr(hit.el, "data-width"), `${what} data-width`) ?? along;
  if (sill < -1e-6 || sill + openHeight > place.height + 1e-6) {
    throw new PlanError(`${what}: opening does not fit the ${wall} wall`);
  }
  assertWidthFits(place.id, id, wall, snapped, openWidth, place.width, place.depth);
  return {
    id,
    minX: snapped.minX,
    maxX: snapped.maxX,
    minZ: snapped.minZ,
    maxZ: snapped.maxZ,
    wall,
    sill,
    height: openHeight,
    width: openWidth,
  };
}

function readHole(hit: Hit, place: Place): RoomHole {
  const id = call(place.id, undefined, () => requireId(hit.el, "hole"));
  assertPose(hit.matrix, id, place.id, false);
  const box = shiftBox(worldBox(hit.el, hit.matrix, place.frame, place.units, id, place.id), place);
  inside(place.id, id, box, place.footprint);
  const raw = attr(hit.el, "data-cut")?.trim() || "both";
  if (raw !== "floor" && raw !== "ceiling" && raw !== "both") {
    throw new PlanError(`room "${place.id}" element "${id}": data-cut "${raw}" is not floor, ceiling, or both`);
  }
  return { id, ...box, cut: raw };
}

function readProp(hit: Hit, place: Place): SceneProp | undefined {
  const prop = call(place.id, attr(hit.el, "id")?.trim(), () =>
    propFromElement(hit.el, hit.matrix, place.frame, place.units));
  if (!prop) return undefined;
  const box = shiftBox(worldBox(hit.el, hit.matrix, place.frame, place.units, prop.id, place.id), place);
  inside(place.id, prop.id, box, place.footprint);
  const position: Vec3 = [prop.position[0] - place.originX, prop.position[1], prop.position[2] - place.originZ];
  return { ...prop, position };
}

function readLight(hit: Hit, place: Place, warnings: string[]): RoomLightSource | undefined {
  const label = attr(hit.el, "label")?.trim();
  const name = lightId(label, place.id);
  if (!name) return undefined;
  const elementId = call(place.id, undefined, () => requireId(hit.el, "light"));
  assertPose(hit.matrix, elementId, place.id, false);
  const center = shapeCenter(hit.el, hit.matrix, place.frame, place.units, elementId, place.id);
  const what = `room "${place.id}" element "${elementId}"`;
  const litWidth = optionalPositive(attr(hit.el, "data-width"), `${what} data-width`);
  const litHeight = optionalPositive(attr(hit.el, "data-height"), `${what} data-height`);
  if ((litWidth === undefined) !== (litHeight === undefined)) {
    throw new PlanError(`room "${place.id}": light "${name}" needs both data-width and data-height`);
  }
  const isRect = litWidth !== undefined && litHeight !== undefined;
  const intensity = readIntensity(hit.el, name, place.id, isRect ? 30 : 12, warnings);
  const color = lightColor(attr(hit.el, "data-color"), place.id, name);
  const range = optionalNumber(attr(hit.el, "data-range"), `${what} data-range`) ?? 0;
  const y = readZ(hit.el, elementId, place.id, place.height - 0.2);
  const x = center.x - place.originX;
  const z = center.z - place.originZ;
  assertLightInside(place, name, x, z, y);
  return {
    id: name,
    x,
    z,
    y,
    intensity,
    color,
    range,
    ...(isRect ? { width: litWidth, height: litHeight } : {}),
  };
}

/** Text after `light:`. A label that does not start with `light:` is not a light. */
function lightId(label: string | undefined, roomId: string): string | undefined {
  if (!label?.startsWith("light:")) return undefined;
  const name = label.slice("light:".length).trim();
  if (!ID_RE.test(name)) {
    throw new PlanError(`room "${roomId}": light label "${label}" needs light:<name>`);
  }
  return name;
}

const LIGHT_COLOR_RE = /^#[0-9a-f]{6}$/i;

function lightColor(raw: string | undefined, roomId: string, name: string): string {
  const color = raw?.trim() || "#ffffff";
  if (!LIGHT_COLOR_RE.test(color)) {
    throw new PlanError(`room "${roomId}" light "${name}": data-color "${raw?.trim() ?? ""}" is not #rrggbb`);
  }
  return color.toLowerCase();
}

function assertLightInside(place: Place, name: string, x: number, z: number, y: number): void {
  const box = place.footprint;
  const eps = 1e-6;
  if (x < box.minX - eps || x > box.maxX + eps || z < box.minZ - eps || z > box.maxZ + eps) {
    throw new PlanError(`room "${place.id}" light "${name}": center is outside the footprint`);
  }
  if (!(y > 0) || y > place.height + 1e-6) {
    throw new PlanError(`room "${place.id}" light "${name}": y ${trimNum(y)} is not in (0, ${trimNum(place.height)}]`);
  }
}

function snapShape(hit: Hit, place: Place, id: string, wall: WallFace): Span {
  const box = worldBox(hit.el, hit.matrix, place.frame, place.units, id, place.id);
  return snapToWall(place.id, id, wall, {
    minX: box.minX - place.originX,
    maxX: box.maxX - place.originX,
    minZ: box.minZ - place.originZ,
    maxZ: box.maxZ - place.originZ,
    cx: (box.minX + box.maxX) / 2 - place.originX,
    cz: (box.minZ + box.maxZ) / 2 - place.originZ,
  }, place.width, place.depth);
}

function snapToWall(roomId: string, id: string, wall: WallFace, span: Span, roomWidth: number, roomDepth: number): Span {
  const spanX = span.maxX - span.minX;
  const spanZ = span.maxZ - span.minZ;
  const alongX = wall === "front" || wall === "back";
  const along = alongX ? spanX : spanZ;
  const across = alongX ? spanZ : spanX;
  if (along + 1e-6 < across) {
    throw new PlanError(`room "${roomId}" element "${id}": long side runs across the ${wall} wall`);
  }
  const line = wallLine(wall, roomWidth, roomDepth);
  const normal = line.axis === "x" ? span.cx : span.cz;
  const dist = Math.abs(normal - line.at);
  const limit = Math.max(across, 0.5);
  if (dist > limit + 1e-4) {
    throw new PlanError(`room "${roomId}" element "${id}": center is ${trimNum(dist)} m from the ${wall} wall`);
  }
  const delta = line.at - normal;
  const snapped: Span = { ...span };
  if (line.axis === "x") {
    snapped.cx = line.at;
    snapped.minX += delta;
    snapped.maxX += delta;
  } else {
    snapped.cz = line.at;
    snapped.minZ += delta;
    snapped.maxZ += delta;
  }
  const wallMin = alongX ? -roomWidth / 2 : -roomDepth / 2;
  const wallMax = -wallMin;
  const min = alongX ? snapped.minX : snapped.minZ;
  const max = alongX ? snapped.maxX : snapped.maxZ;
  if (min < wallMin - 1e-3 || max > wallMax + 1e-3) {
    throw new PlanError(`room "${roomId}" element "${id}": extends outside the ${wall} wall`);
  }
  return snapped;
}

function alongSpan(wall: WallFace, span: Span): number {
  return wall === "front" || wall === "back" ? span.maxX - span.minX : span.maxZ - span.minZ;
}

function assertWidthFits(
  roomId: string,
  id: string,
  wall: WallFace,
  span: Span,
  openingWidth: number,
  roomWidth: number,
  roomDepth: number,
): void {
  const alongX = wall === "front" || wall === "back";
  const center = alongX ? span.cx : span.cz;
  const wallMin = alongX ? -roomWidth / 2 : -roomDepth / 2;
  const wallMax = -wallMin;
  const half = openingWidth / 2;
  if (center - half < wallMin - 1e-3 || center + half > wallMax + 1e-3) {
    throw new PlanError(`room "${roomId}" element "${id}": width ${trimNum(openingWidth)} does not fit the ${wall} wall`);
  }
}

function wallAttr(el: XmlNode, id: string, roomId: string): WallFace {
  const raw = attr(el, "data-wall")?.trim();
  if (!raw) throw new PlanError(`room "${roomId}" element "${id}": missing data-wall`);
  if (raw === "front" || raw === "back" || raw === "left" || raw === "right") return raw;
  throw new PlanError(`room "${roomId}" element "${id}": data-wall "${raw}" is not front, back, left, or right`);
}

function loadFace(svgPath: string, roomId: string, face: RoomFace, drawn: Drawn): string {
  const ref = resolveRef(svgPath, drawn.raw, drawn.absref, `room "${roomId}" face "${face}"`);
  try {
    loadTextureRef(svgPath, ref, face);
  } catch (err) {
    rethrow(roomId, drawn.id, err);
  }
  return ref;
}

function paneRef(el: XmlNode, id: string, place: Place): string | undefined {
  const tex = textureSource(el);
  if (!tex.raw) return undefined;
  const ref = resolveRef(place.svgPath, tex.raw, tex.absref, `room "${place.id}" element "${id}"`);
  try {
    loadTextureRef(place.svgPath, ref, id);
  } catch (err) {
    rethrow(place.id, id, err);
  }
  return ref;
}

function resolveRef(svgPath: string, raw: string, absref: string | undefined, what: string): string {
  if (raw.startsWith("data:")) return raw;
  const rel = path.resolve(path.dirname(svgPath), raw);
  if (existsSync(rel)) return rel;
  if (absref && existsSync(absref)) return absref;
  const tried = absref ? `${rel} or ${absref}` : rel;
  throw new PlanError(`${what}: texture "${raw}" not found at ${tried}`);
}

function textureSource(el: XmlNode): { raw?: string; absref?: string } {
  const data = attr(el, "data-texture")?.trim();
  const image = imageNode(el);
  const href = image ? attr(image, "href")?.trim() : undefined;
  const absref = (image ? attr(image, "absref") : undefined)?.trim() || attr(el, "absref")?.trim();
  const raw = data || href;
  return { ...(raw ? { raw } : {}), ...(absref ? { absref } : {}) };
}

function imageNode(el: XmlNode): XmlNode | undefined {
  if (localName(el.name) === "image") return el;
  return el.children.find((child) => localName(child.name) === "image");
}

function explicitName(el: XmlNode): string | undefined {
  return attr(el, "data-face")?.trim() || attr(el, "label")?.trim() || undefined;
}

function assertPose(matrix: Mat, id: string, roomId: string, allowScale: boolean): void {
  try {
    yawFromSvgMatrix(matrix, id);
    const scale = uniformScale(matrix, id);
    if (!allowScale && Math.abs(scale - 1) > 1e-3) throw new PlanError(`scale ${trimNum(scale)} is not 1`);
  } catch (err) {
    rethrow(roomId, id, err);
  }
}

function worldBox(
  el: XmlNode,
  matrix: Mat,
  frame: PageFrame,
  units: string | undefined,
  id: string,
  roomId: string,
): Box {
  const local = rectBounds(el, frame.meters, units);
  if (!local) throw new PlanError(`room "${roomId}" element "${id}": has no size`);
  const corners = [
    [local.minX, local.minY],
    [local.maxX, local.minY],
    [local.maxX, local.maxY],
    [local.minX, local.maxY],
  ].map(([x, y]) => {
    const [ux, uy] = apply(matrix, x!, y!);
    const [wx, , wz] = svgPointToWorld(ux, uy, 0, frame);
    return [wx, wz] as [number, number];
  });
  const edge = (from: number, to: number): [number, number] => [
    corners[to]![0] - corners[from]![0],
    corners[to]![1] - corners[from]![1],
  ];
  if (!axisAligned(edge(0, 1)) || !axisAligned(edge(0, 3))) {
    throw new PlanError(`room "${roomId}" element "${id}": is not axis-aligned`);
  }
  const xs = corners.map((corner) => corner[0]);
  const zs = corners.map((corner) => corner[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  if (!(maxX > minX) || !(maxZ > minZ)) throw new PlanError(`room "${roomId}" element "${id}": has no size`);
  return { minX, maxX, minZ, maxZ };
}

function shapeCenter(
  el: XmlNode,
  matrix: Mat,
  frame: PageFrame,
  units: string | undefined,
  id: string,
  roomId: string,
): { x: number; z: number } {
  const name = localName(el.name);
  let lx: number;
  let ly: number;
  if (name === "circle" || name === "ellipse") {
    lx = bareLength(attr(el, "cx"), 0, id, roomId);
    ly = bareLength(attr(el, "cy"), 0, id, roomId);
  } else {
    const box = worldBox(el, matrix, frame, units, id, roomId);
    return { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 };
  }
  const [ux, uy] = apply(matrix, lx, ly);
  const [x, , z] = svgPointToWorld(ux, uy, 0, frame);
  return { x, z };
}

function bareLength(raw: string | undefined, fallback: number, id: string, roomId: string): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new PlanError(`room "${roomId}" element "${id}": length "${raw}" is not a finite number`);
  }
  return value;
}

function shiftBox(box: Box, place: Place): Box {
  return {
    minX: box.minX - place.originX,
    maxX: box.maxX - place.originX,
    minZ: box.minZ - place.originZ,
    maxZ: box.maxZ - place.originZ,
  };
}

function inside(roomId: string, id: string, box: Box, footprint: XzRect): void {
  const eps = 1e-3;
  if (
    box.minX < footprint.minX - eps
    || box.maxX > footprint.maxX + eps
    || box.minZ < footprint.minZ - eps
    || box.maxZ > footprint.maxZ + eps
  ) {
    throw new PlanError(`room "${roomId}" element "${id}": is outside the room`);
  }
}

function readZ(el: XmlNode, id: string, roomId: string, fallback: number): number {
  const raw = el.attrs["z"];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new PlanError(`room "${roomId}" element "${id}": z "${raw}" is not a number`);
  return value;
}

function readBool(el: XmlNode, name: string, id: string, roomId: string, fallback: boolean): boolean {
  const raw = attr(el, name)?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new PlanError(`room "${roomId}" element "${id}": ${name} "${raw}" is not true or false`);
}

function readIntensity(el: XmlNode, id: string, roomId: string, fallback: number, warnings: string[]): number {
  const what = `room "${roomId}" element "${id}" data-intensity`;
  const value = optionalNumber(attr(el, "data-intensity"), what);
  if (value === undefined) return fallback;
  if (!(value > 0)) throw new PlanError(`${what} must be greater than 0`);
  if (value < 1 || value > 100) {
    warnings.push(`room "${roomId}" light "${id}": intensity ${trimNum(value)} is outside 1–100`);
  }
  return value;
}

function expectSpan(roomId: string, drawn: Drawn, got: number, expected: number, edge: string, against: string): void {
  if (Math.abs(got - expected) <= EDGE_M) return;
  throw new PlanError(
    `room "${roomId}" element "${drawn.id}" face "${drawn.face}": ${edge} ${trimNum(got)} does not match ${against} ${trimNum(expected)}`,
  );
}

function spanX(box: Box): number {
  return box.maxX - box.minX;
}

function spanZ(box: Box): number {
  return box.maxZ - box.minZ;
}

function axisAligned(edge: [number, number]): boolean {
  const [dx, dy] = edge;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return false;
  return Math.min(Math.abs(dx), Math.abs(dy)) <= 1e-3 * length;
}

function collect(svg: XmlNode): Hit[] {
  const hits: Hit[] = [];
  const visit = (el: XmlNode, parent: Mat, stack: string[]): void => {
    const name = localName(el.name);
    if (name === "defs" || name === "metadata" || name === "namedview") return;
    const isLayer = name === "g" && attr(el, "groupmode") === "layer";
    const nextStack = isLayer ? [...stack, attr(el, "label") ?? ""] : stack;
    const matrix = mul(parent, parseTransform(attr(el, "transform")));
    const role = semanticRole(nextStack);
    if (role && SHAPES[role]?.has(name)) {
      hits.push({ el, matrix, role });
      return;
    }
    for (const child of el.children) visit(child, matrix, nextStack);
  };
  visit(svg, ident(), []);
  return hits;
}

function semanticRole(stack: string[]): string | undefined {
  let role: string | undefined;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const next = layerRole(stack[i]);
    if (next === "ignore") return undefined;
    if (next && !role) role = next;
  }
  return role;
}

function checkIds(el: XmlNode, roomId: string, seen = new Set<string>()): void {
  const raw = attr(el, "id");
  const id = raw?.trim();
  if (raw != null && !id) throw new PlanError(`room "${roomId}": invalid id ""`);
  if (id) {
    if (!ID_RE.test(id)) throw new PlanError(`room "${roomId}" element "${id}": invalid id`);
    if (seen.has(id)) throw new PlanError(`room "${roomId}" element "${id}": duplicate id`);
    seen.add(id);
  }
  for (const child of el.children) checkIds(child, roomId, seen);
}

function call<T>(roomId: string, elementId: string | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    rethrow(roomId, elementId, err);
  }
}

function rethrow(roomId: string, elementId: string | undefined, err: unknown): never {
  if (err instanceof PlanError) {
    if (err.message.startsWith("room \"")) throw err;
    const where = elementId ? `room "${roomId}" element "${elementId}"` : `room "${roomId}"`;
    throw new PlanError(`${where}: ${err.message}`);
  }
  throw err;
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}
