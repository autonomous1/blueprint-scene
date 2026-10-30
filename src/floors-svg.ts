import { loadTextureRef } from "./crate.ts";
import { PlanError } from "./errors.ts";
import {
  apply,
  documentUnits,
  doorFromElement,
  ident,
  measureTagged,
  mul,
  optionalNumber,
  pageFrame,
  parseTransform,
  pathPoints,
  propFromElement,
  rectBounds,
  requireId,
  stencilPose,
  svgPointToWorld,
  taggedModel,
  uniformScale,
  yawFromSvgMatrix,
  type Mat,
  type PageFrame,
} from "./plan.ts";
import type { SceneDoor, SceneProp, Vec3, Yaw } from "./types.ts";
import { attr, localName, parseXml, type XmlNode } from "./xml.ts";
import { inverseYaw, transformXz } from "./yaw.ts";

export type RoomInstanceSource = {
  id: string;
  prefab: string;
  center: { x: number; z: number };
  yaw: Yaw;
  drawnWidth: number;
  drawnDepth: number;
};

/** Tileable albedo for one floor's hall. Tile sizes are metres. */
export type FloorTexture = {
  image: Uint8Array;
  /** Metres per tile along building-local +X. */
  tileX: number;
  /** Metres per tile along building-local +Z. */
  tileZ: number;
};

/** Used when an image has no `data-tile-m` and no pattern tile. */
export const DEFAULT_TILE_M = 2;

/** A `platform:<id>` rect or path, in building-local metres. */
export type FloorPlatformSource = {
  id: string;
  /** Counter-clockwise XZ. A path uses the AABB of its vertices. */
  polygon: Array<[number, number]>;
  /** Added to the floor elevation. From `data-height`, or 0. */
  deck: number;
};

/**
 * A `stairs:<id>` rect, in building-local metres. `bottom` and `top` are
 * metres above the building ground. `up` is a unit vector in local XZ.
 * `floor` is omitted for a `stairs-external` run.
 */
export type FloorStairsSource = {
  id: string;
  floor?: number;
  polygon: Array<[number, number]>;
  up: [number, number];
  bottom: number;
  top: number;
};

/** An `elevator:<id>` cab, in building-local metres. Stops are above the building ground. */
export type FloorElevatorSource = {
  id: string;
  floor: number;
  polygon: Array<[number, number]>;
  /** Unit vector in local XZ, the side the landing sits outside. */
  door: [number, number];
  /** Ascending. Defaults filled in: every floor from this one up. */
  stops: number[];
  waitS: number;
  speed: number;
};

export type FloorSource = {
  n: number;
  name: string;
  elevation: number;
  height?: number;
  /** This floor's AABB, building-local, counter-clockwise. */
  footprint: Array<[number, number]>;
  /**
   * This floor's stencil outline, building-local, counter-clockwise, with
   * consecutive duplicates removed. A rectilinear path keeps its vertices.
   * A diagonal edge or a curve falls back to `footprint`.
   */
  outline: Array<[number, number]>;
  /** Set when this floor's `outline` fell back to its footprint AABB. */
  outlineFallback?: "diagonal" | "curve";
  rooms: RoomInstanceSource[];
  platforms: FloorPlatformSource[];
  /** Set when the floor layer has `data-kind="platform"`. */
  platformDeck?: number;
  /** Authored `floor-texture`, or the `floor-<n>-texture` layer. Absent when neither is drawn. */
  texture?: FloorTexture;
};

export type FloorsSource = {
  model: string;
  /** Stencil model units → metres (30 for the arena buildings). */
  scale: number;
  /** Stencil yaw on the page. Local data has it removed. */
  yaw: Yaw;
  /** Page-world origin of the stencil, y = 0. */
  origin: Vec3;
  /** Floor-1's footprint AABB. The scale check and building placement use this. */
  footprint: Array<[number, number]>;
  /**
   * Floor-1's stencil outline, counter-clockwise, with consecutive
   * duplicates removed. A rectilinear path keeps its vertices. A diagonal
   * edge or a curve falls back to `footprint`.
   */
  outline: Array<[number, number]>;
  /** Set when floor-1's `outline` fell back to the footprint AABB. */
  outlineFallback?: "diagonal" | "curve";
  floors: FloorSource[];
  /** Building-local. `center[1]` is the sill. */
  doors: SceneDoor[];
  /** `stairs-external` props, building-local. A `stairs:<id>` rect is not a prop. */
  props: SceneProp[];
  /** `stairs:<id>` rects from floor layers and from `stairs-external`. */
  stairs: FloorStairsSource[];
  /** `elevator:<id>` rects from floor layers. */
  elevators: FloorElevatorSource[];
};

type Scope =
  | { kind: "floor"; floor: FloorAcc }
  | { kind: "texture"; n: number }
  | { kind: "doors" }
  | { kind: "stairs" };

type Hit = { el: XmlNode; matrix: Mat };

type FloorAcc = {
  n: number;
  name: string;
  layer: XmlNode;
  stencils: Hit[];
  rooms: Hit[];
  platforms: Hit[];
  stairs: Hit[];
  elevators: Hit[];
  textures: Hit[];
  asPlatform: boolean;
};

type Pose = {
  model: string;
  scale: number;
  yaw: Yaw;
  origin: Vec3;
  elevation: number;
};

/**
 * Page-world point to building-local metres. `yaw` is the stencil yaw on the page.
 * Model Z maps to SVG −y, so this is the inverse of the placement R7 will apply.
 */
function toLocal(x: number, z: number, origin: Vec3, yaw: Yaw): { x: number; z: number } {
  return transformXz(x - origin[0], z - origin[2], inverseYaw(yaw));
}

/**
 * Read one building's floors file. Positions are building-local metres.
 * Hidden layers are read. `ignore` and everything under it is skipped.
 */
export function readFloorsSvg(svgText: string, svgPath?: string): FloorsSource {
  const svg = parseXml(svgText);
  const frame = pageFrame(svg);
  const units = documentUnits(svg);
  const patterns = indexPatterns(svg);
  const imageCache = new Map<string, Uint8Array>();
  const floors: FloorAcc[] = [];
  const doorHits: Hit[] = [];
  const propHits: Hit[] = [];
  const externalStairHits: Hit[] = [];
  const textureHits = new Map<number, Hit[]>();
  const ids = new Set<string>();
  const floorNs = new Set<number>();

  const claim = (id: string): void => {
    if (ids.has(id)) throw new PlanError(`duplicate id "${id}"`);
    ids.add(id);
  };

  const visit = (el: XmlNode, parent: Mat, scope: Scope | undefined): void => {
    const name = localName(el.name);
    if (name === "defs" || name === "metadata" || name === "namedview") return;
    const isLayer = name === "g" && attr(el, "groupmode") === "layer";
    const label = isLayer ? attr(el, "label") ?? "" : "";
    if (isLayer && scope === undefined) {
      const kind = classifyLayer(label);
      if (kind.kind === "ignore") return;
      if (kind.kind === "floor") {
        if (floorNs.has(kind.n)) throw new PlanError(`duplicate floor-${kind.n}`);
        floorNs.add(kind.n);
        const floor: FloorAcc = {
          n: kind.n,
          name: label,
          layer: el,
          stencils: [],
          rooms: [],
          platforms: [],
          stairs: [],
          elevators: [],
          textures: [],
          asPlatform: attr(el, "data-kind")?.trim() === "platform",
        };
        floors.push(floor);
        scope = { kind: "floor", floor };
      } else if (kind.kind === "doors") {
        scope = { kind: "doors" };
      } else if (kind.kind === "stairs") {
        scope = { kind: "stairs" };
      } else if (kind.kind === "floor-texture") {
        scope = { kind: "texture", n: kind.n };
      }
    } else if (isLayer && label === "ignore") {
      return;
    }

    const matrix = mul(parent, parseTransform(attr(el, "transform")));
    if (scope?.kind === "floor") {
      const platform = platformIdOf(el);
      const stairsId = labelledId(el, "stairs");
      const elevatorId = labelledId(el, "elevator");
      if (attr(el, "label")?.trim() === "floor-texture") {
        scope.floor.textures.push({ el, matrix });
      } else if (platform && (name === "rect" || name === "path")) {
        claim(platform);
        scope.floor.platforms.push({ el, matrix });
      } else if (stairsId && name === "rect") {
        claim(stairsId);
        scope.floor.stairs.push({ el, matrix });
      } else if (elevatorId && name === "rect") {
        claim(elevatorId);
        scope.floor.elevators.push({ el, matrix });
      } else if ((name === "g" || name === "path") && stencilPose(el, matrix, frame) && taggedModel(el)) {
        scope.floor.stencils.push({ el, matrix });
      } else if (name === "rect") {
        const tagged = taggedModel(el);
        if (tagged) {
          claim(tagged.id);
          scope.floor.rooms.push({ el, matrix });
        }
      }
    } else if (scope?.kind === "texture") {
      if (attr(el, "label")?.trim() === "floor-texture") {
        const hits = textureHits.get(scope.n) ?? [];
        hits.push({ el, matrix });
        textureHits.set(scope.n, hits);
      }
    } else if (scope?.kind === "doors" && name === "rect") {
      claim(requireId(el, "door"));
      doorHits.push({ el, matrix });
    } else if (scope?.kind === "stairs" && name === "rect") {
      const stairsId = labelledId(el, "stairs");
      const elevatorId = labelledId(el, "elevator");
      if (elevatorId) throw new PlanError(`elevator "${elevatorId}" must be on a floor-<n> layer`);
      if (stairsId) {
        claim(stairsId);
        externalStairHits.push({ el, matrix });
      } else {
        const tagged = taggedModel(el);
        if (tagged) claim(tagged.id);
        propHits.push({ el, matrix });
      }
    }
    for (const child of el.children) visit(child, matrix, scope);
  };
  visit(svg, ident(), undefined);

  if (floors.length === 0) throw new PlanError("floors file has no floor-<n> layer");
  floors.sort((a, b) => a.n - b.n);
  const poses = floors.map((floor) => floorPose(floor, frame));
  const first = poses[0]!;
  for (let i = 1; i < poses.length; i += 1) {
    const pose = poses[i]!;
    const floor = floors[i]!;
    if (!sameFootprint(first, pose)) {
      throw new PlanError(`floor-${floor.n} stencil transform does not match floor-${floors[0]!.n}`);
    }
  }
  for (let i = 1; i < poses.length; i += 1) {
    if (!(poses[i]!.elevation > poses[i - 1]!.elevation)) {
      throw new PlanError(`floor-${floors[i]!.n} elevation must be above floor-${floors[i - 1]!.n}`);
    }
  }

  const { model, scale, yaw, origin } = first;
  // Each floor's path is converted with floor-1's pose, so a setback lines up
  // by where it sits on the page. The transform itself must still match.
  const shapes = floors.map((floor) => stencilShape(floor.stencils[0]!, frame, origin, yaw));
  for (let i = 1; i < shapes.length; i += 1) {
    const area = outsideArea(shapes[i]!.outline, shapes[i - 1]!.outline);
    if (area > 1e-4) {
      console.warn(`floor-${floors[i]!.n} outline overhangs floor-${floors[i - 1]!.n} by ${formatArea(area)} m²`);
    }
  }
  const shape = shapes[0]!;
  const footprint = shape.footprint;
  const outline = shape.outline;
  const floorSources: FloorSource[] = floors.map((floor, index) => {
    const elevation = poses[index]!.elevation;
    const rooms: RoomInstanceSource[] = [];
    for (const hit of floor.rooms) {
      const tagged = taggedModel(hit.el);
      if (!tagged) continue;
      const measured = measureTagged(hit.el, hit.matrix, frame, units, tagged.id);
      const drawnScale = uniformScale(hit.matrix, tagged.id);
      if (Math.abs(drawnScale - 1) > 1e-3) throw new PlanError(`room "${tagged.id}" must not be scaled`);
      const center = toLocal(measured.position[0], measured.position[2], origin, yaw);
      rooms.push({
        id: tagged.id,
        prefab: tagged.model,
        center,
        yaw: localYaw(measured.yaw, yaw),
        drawnWidth: measured.drawnWidth,
        drawnDepth: measured.drawnDepth,
      });
    }
    const platforms = floor.platforms.map((hit) => readPlatform(hit, frame, units, origin, yaw));
    const floorShape = shapes[index]!;
    const source: FloorSource = {
      n: floor.n,
      name: floor.name,
      elevation,
      footprint: floorShape.footprint,
      outline: floorShape.outline,
      rooms,
      platforms,
      ...(floorShape.fallback ? { outlineFallback: floorShape.fallback } : {}),
    };
    const texture = readFloorTexture(
      [...floor.textures, ...(textureHits.get(floor.n) ?? [])],
      patterns,
      frame,
      svgPath ?? "",
      imageCache,
      floor.n,
    );
    if (texture) source.texture = texture;
    if (floor.asPlatform) {
      source.platformDeck = optionalNumber(attr(floor.layer, "data-height"), `floor-${floor.n} data-height`) ?? 0;
    }
    if (index < floors.length - 1) source.height = poses[index + 1]!.elevation - elevation;
    else {
      const height = optionalNumber(attr(floor.layer, "data-height"), `floor-${floor.n} data-height`);
      if (height !== undefined) source.height = height;
    }
    return source;
  });

  const doors = doorHits.map((hit) => {
    const id = requireId(hit.el, "door");
    const building = attr(hit.el, "data-building")?.trim();
    if (building && building !== model) {
      throw new PlanError(`door "${id}" data-building must be "${model}" or absent`);
    }
    const door = doorFromElement(hit.el, hit.matrix, frame, units, model);
    const center = toLocal(door.center[0], door.center[2], origin, yaw);
    const box = toLocalBox(door.minX, door.maxX, door.minZ, door.maxZ, origin, yaw);
    return { ...door, center: [center.x, door.center[1], center.z] as Vec3, ...box };
  });

  const elevations = poses.map((pose) => pose.elevation);
  const stairs: FloorStairsSource[] = [];
  const elevators: FloorElevatorSource[] = [];
  for (let index = 0; index < floors.length; index += 1) {
    const elevation = elevations[index]!;
    const next = index + 1 < elevations.length ? elevations[index + 1] : undefined;
    const floor = floors[index]!;
    for (const hit of floor.stairs) stairs.push(readStair(hit, floor.n, elevation, next, frame, units, origin, yaw));
    for (const hit of floor.elevators) {
      elevators.push(readElevator(hit, floor.n, elevation, elevations, frame, units, origin, yaw));
    }
  }
  for (const hit of externalStairHits) stairs.push(readStair(hit, undefined, 0, undefined, frame, units, origin, yaw));

  const props: SceneProp[] = [];
  for (const hit of propHits) {
    const prop = propFromElement(hit.el, hit.matrix, frame, units);
    if (!prop) continue;
    const position = toLocal(prop.position[0], prop.position[2], origin, yaw);
    props.push({
      ...prop,
      position: [position.x, prop.position[1], position.z],
      yaw: localYaw(prop.yaw, yaw),
    });
  }

  return {
    model,
    scale,
    yaw,
    origin,
    footprint,
    outline,
    ...(shape.fallback ? { outlineFallback: shape.fallback } : {}),
    floors: floorSources,
    doors,
    props,
    stairs,
    elevators,
  };
}

function platformIdOf(el: XmlNode): string | undefined {
  const label = attr(el, "label");
  if (!label) return undefined;
  const match = label.trim().match(/^platform:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
  return match?.[1];
}

/** `stairs:<id>` or `elevator:<id>`. A matching prefix with a bad id is an error. */
function labelledId(el: XmlNode, kind: "stairs" | "elevator"): string | undefined {
  const label = attr(el, "label")?.trim();
  if (!label) return undefined;
  const match = label.match(new RegExp(`^${kind}:\\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\\s*$`));
  if (label.startsWith(`${kind}:`) && !match) throw new PlanError(`invalid ${kind} id "${label}"`);
  return match?.[1];
}

function stencilShape(
  hit: Hit,
  frame: PageFrame,
  origin: Vec3,
  yaw: Yaw,
): { footprint: Array<[number, number]>; outline: Array<[number, number]>; fallback?: "diagonal" | "curve" } {
  const id = attr(hit.el, "id")?.trim() || "footprint";
  const path = pathOf(hit.el, id);
  const points = localPoints(hit.el, hit.matrix, frame, origin, yaw, id);
  const footprint = aabbPolygon(points, id);
  if (pathHasCurve(attr(path, "d"))) return { footprint, outline: footprint, fallback: "curve" };
  const ring = rectilinearRing(points);
  if (!ring) return { footprint, outline: footprint, fallback: "diagonal" };
  return { footprint, outline: ring };
}

/** C, S, Q and A contribute control points. v1 does not flatten them. */
function pathHasCurve(raw: string | undefined): boolean {
  return /[CcSsQqAa]/.test(raw ?? "");
}

function pathOf(el: XmlNode, id: string): XmlNode {
  const path = localName(el.name) === "path" ? el : el.children.find((child) => localName(child.name) === "path");
  if (!path) throw new PlanError(`footprint "${id}" has no path`);
  return path;
}

function readPlatform(hit: Hit, frame: PageFrame, units: string | undefined, origin: Vec3, yaw: Yaw): FloorPlatformSource {
  const id = platformIdOf(hit.el) ?? requireId(hit.el, "platform");
  const deck = optionalNumber(attr(hit.el, "data-height"), `platform "${id}" data-height`) ?? 0;
  const polygon = localName(hit.el.name) === "rect"
    ? rectPolygon(hit, frame, units, origin, yaw, id)
    : aabbPolygon(localPoints(hit.el, hit.matrix, frame, origin, yaw, id), id);
  return { id, polygon, deck };
}

function rectPolygon(
  hit: Hit,
  frame: PageFrame,
  units: string | undefined,
  origin: Vec3,
  yaw: Yaw,
  id: string,
): Array<[number, number]> {
  const measured = measureTagged(hit.el, hit.matrix, frame, units, id);
  const center = toLocal(measured.position[0], measured.position[2], origin, yaw);
  const turned = localYaw(measured.yaw, yaw);
  const hx = measured.drawnWidth / 2;
  const hz = measured.drawnDepth / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => {
    const q = transformXz(x, z, turned);
    return [center.x + q.x, center.z + q.z];
  });
}

/** Path vertices in building-local metres. Control points of a curve count toward the AABB. */
function localPoints(
  el: XmlNode,
  matrix: Mat,
  frame: PageFrame,
  origin: Vec3,
  yaw: Yaw,
  id: string,
): Array<{ x: number; z: number }> {
  const path = pathOf(el, id);
  const pathMatrix = path === el ? matrix : mul(matrix, parseTransform(attr(path, "transform")));
  return pathPoints(attr(path, "d"), id, "footprint").map(([px, py]) => {
    const [sx, sy] = apply(pathMatrix, px, py);
    const world = svgPointToWorld(sx, sy, 0, frame);
    return toLocal(world[0], world[2], origin, yaw);
  });
}

function aabbPolygon(points: Array<{ x: number; z: number }>, id: string): Array<[number, number]> {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  if (!(maxX > minX) || !(maxZ > minZ)) throw new PlanError(`"${id}" has no area`);
  return [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
}

const OUTLINE_TOL_M = 1e-4;

/**
 * Counter-clockwise rectilinear ring, or undefined when an edge is diagonal.
 * Consecutive duplicates and colinear points are dropped. Nearly axis-aligned
 * edges (float noise from the yaw quarter turn) are snapped onto the axis.
 */
function rectilinearRing(points: Array<{ x: number; z: number }>): Array<[number, number]> | undefined {
  const raw: Array<[number, number]> = [];
  for (const point of points) {
    const last = raw[raw.length - 1];
    if (last && Math.hypot(last[0] - point.x, last[1] - point.z) <= 1e-6) continue;
    raw.push([point.x, point.z]);
  }
  if (raw.length >= 2) {
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) raw.pop();
  }
  if (raw.length < 3 || Math.abs(ringArea(raw)) <= 1e-8) return undefined;
  if (ringArea(raw) < 0) raw.reverse();
  const turned = dropColinear(raw);
  if (!turned.every((_, index) => axisEdge(turned, index))) return undefined;
  const snapped = snapAxes(turned);
  const ring = dropColinear(snapped);
  if (ring.length < 3 || !ring.every((_, index) => axisEdge(ring, index))) return undefined;
  return ring;
}

function axisEdge(poly: readonly (readonly [number, number])[], index: number): boolean {
  const a = poly[index]!;
  const b = poly[(index + 1) % poly.length]!;
  const dx = Math.abs(b[0] - a[0]);
  const dz = Math.abs(b[1] - a[1]);
  if (dx <= 1e-6 && dz <= 1e-6) return false;
  return dx <= OUTLINE_TOL_M || dz <= OUTLINE_TOL_M;
}

function dropColinear(poly: Array<[number, number]>): Array<[number, number]> {
  if (poly.length < 3) return poly;
  const kept: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i += 1) {
    const prev = poly[(i - 1 + poly.length) % poly.length]!;
    const curr = poly[i]!;
    const next = poly[(i + 1) % poly.length]!;
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (Math.abs(cross) <= 1e-6) continue;
    kept.push([curr[0], curr[1]]);
  }
  return kept.length >= 3 ? kept : poly;
}

/** Each vertex becomes the crossing of its two axis-aligned edges. */
function snapAxes(poly: readonly (readonly [number, number])[]): Array<[number, number]> {
  const n = poly.length;
  const horizontal: boolean[] = [];
  const coord: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    if (Math.abs(dz) <= Math.abs(dx)) {
      horizontal.push(true);
      coord.push((a[1] + b[1]) / 2);
    } else {
      horizontal.push(false);
      coord.push((a[0] + b[0]) / 2);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const prev = (i - 1 + n) % n;
    if (horizontal[prev] === horizontal[i]) return poly.map(([x, z]) => [x, z]);
    const x = horizontal[prev] ? coord[i]! : coord[prev]!;
    const z = horizontal[prev] ? coord[prev]! : coord[i]!;
    out.push([x, z]);
  }
  return out;
}

function ringArea(poly: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const point = poly[i]!;
    const next = poly[(i + 1) % poly.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}

const PAGE_DIR: Record<string, [number, number]> = {
  "+x": [1, 0],
  "-x": [-1, 0],
  "+y": [0, 1],
  "-y": [0, -1],
};

function readStair(
  hit: Hit,
  floor: number | undefined,
  elevation: number,
  next: number | undefined,
  frame: PageFrame,
  units: string | undefined,
  origin: Vec3,
  yaw: Yaw,
): FloorStairsSource {
  const id = labelledId(hit.el, "stairs") ?? requireId(hit.el, "stairs");
  const polygon = rectPolygon(hit, frame, units, origin, yaw, id);
  const up = stairUp(hit, frame, units, origin, yaw, id);
  const bottom = optionalNumber(attr(hit.el, "data-bottom"), `stairs "${id}" data-bottom`) ?? elevation;
  const authoredTop = optionalNumber(attr(hit.el, "data-top"), `stairs "${id}" data-top`);
  const top = authoredTop ?? next;
  if (top === undefined) throw new PlanError(`stairs "${id}" needs data-top`);
  if (!(top > bottom)) throw new PlanError(`stairs "${id}" top must be above the bottom`);
  const run = spanAlong(polygon, up);
  if ((top - bottom) / run > 1) throw new PlanError(`stairs "${id}" slope ${(top - bottom)} / ${run} is steeper than 1`);
  return { id, ...(floor === undefined ? {} : { floor }), polygon, up, bottom, top };
}

function readElevator(
  hit: Hit,
  floor: number,
  elevation: number,
  elevations: readonly number[],
  frame: PageFrame,
  units: string | undefined,
  origin: Vec3,
  yaw: Yaw,
): FloorElevatorSource {
  const id = labelledId(hit.el, "elevator") ?? requireId(hit.el, "elevator");
  const polygon = rectPolygon(hit, frame, units, origin, yaw, id);
  const door = pageVector(hit, frame, units, origin, yaw, doorDir(hit, id), `elevator "${id}"`);
  const stops = parseStops(attr(hit.el, "data-stops"), id)
    ?? elevations.filter((value) => value >= elevation - 1e-6);
  if (stops.length < 2) throw new PlanError(`elevator "${id}" needs at least two stops`);
  const waitS = positiveOr(attr(hit.el, "data-wait-s"), 8, `elevator "${id}" data-wait-s`);
  const speed = positiveOr(attr(hit.el, "data-speed"), 1, `elevator "${id}" data-speed`);
  return { id, floor, polygon, door, stops, waitS, speed };
}

function doorDir(hit: Hit, id: string): [number, number] {
  const raw = attr(hit.el, "data-door-side")?.trim();
  if (!raw) return PAGE_DIR["+y"]!;
  const dir = PAGE_DIR[raw];
  if (!dir) throw new PlanError(`elevator "${id}" data-door-side "${raw}" is not +x, -x, +y, or -y`);
  return dir;
}

/** Element-local page direction, mapped through the rect matrix into building-local XZ. */
function stairUp(
  hit: Hit,
  frame: PageFrame,
  units: string | undefined,
  origin: Vec3,
  yaw: Yaw,
  id: string,
): [number, number] {
  const raw = attr(hit.el, "data-up")?.trim();
  if (raw) {
    const dir = PAGE_DIR[raw];
    if (!dir) throw new PlanError(`stairs "${id}" data-up "${raw}" is not +x, -x, +y, or -y`);
    return pageVector(hit, frame, units, origin, yaw, dir, `stairs "${id}"`);
  }
  const box = rectBox(hit, frame, units, id);
  const alongX = pageDelta(hit, box, box.maxX - box.minX, 0);
  const alongY = pageDelta(hit, box, 0, box.maxY - box.minY);
  const lenX = Math.hypot(alongX[0], alongX[1]);
  const lenY = Math.hypot(alongY[0], alongY[1]);
  if (Math.abs(lenX - lenY) <= 1e-4) throw new PlanError(`stairs "${id}" is square and needs data-up`);
  let [dx, dy] = lenX > lenY ? alongX : alongY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx < 0) { dx = -dx; dy = -dy; }
  } else if (dy < 0) {
    dx = -dx;
    dy = -dy;
  }
  const [sx, sy] = apply(hit.matrix, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  return svgDeltaToLocal(sx, sy, dx, dy, frame, origin, yaw, `stairs "${id}"`);
}

function pageVector(
  hit: Hit,
  frame: PageFrame,
  units: string | undefined,
  origin: Vec3,
  yaw: Yaw,
  dir: [number, number],
  what: string,
): [number, number] {
  const box = rectBox(hit, frame, units, what);
  const [sx, sy] = apply(hit.matrix, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  const delta = pageDelta(hit, box, dir[0], dir[1]);
  return svgDeltaToLocal(sx, sy, delta[0], delta[1], frame, origin, yaw, what);
}

function rectBox(
  hit: Hit,
  frame: PageFrame,
  units: string | undefined,
  id: string,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const box = rectBounds(hit.el, frame.meters, units);
  if (!box) throw new PlanError(`${id} has no footprint`);
  return box;
}

function pageDelta(
  hit: Hit,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  dx: number,
  dy: number,
): [number, number] {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const [x0, y0] = apply(hit.matrix, cx, cy);
  const [x1, y1] = apply(hit.matrix, cx + dx, cy + dy);
  return [x1 - x0, y1 - y0];
}

function svgDeltaToLocal(
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  frame: PageFrame,
  origin: Vec3,
  yaw: Yaw,
  what: string,
): [number, number] {
  const w0 = svgPointToWorld(sx, sy, 0, frame);
  const w1 = svgPointToWorld(sx + dx, sy + dy, 0, frame);
  const a = toLocal(w0[0], w0[2], origin, yaw);
  const b = toLocal(w1[0], w1[2], origin, yaw);
  const lx = b.x - a.x;
  const lz = b.z - a.z;
  const len = Math.hypot(lx, lz);
  if (len < 1e-9) throw new PlanError(`${what} has no direction`);
  return [lx / len, lz / len];
}

function parseStops(raw: string | undefined, id: string): number[] | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length < 2) throw new PlanError(`elevator "${id}" needs at least two stops`);
  const stops = parts.map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value)) throw new PlanError(`elevator "${id}" data-stops "${raw}" is not a list of heights`);
    return value;
  });
  for (let i = 1; i < stops.length; i += 1) {
    if (!(stops[i]! > stops[i - 1]!)) throw new PlanError(`elevator "${id}" stops must increase`);
  }
  return stops;
}

function positiveOr(raw: string | undefined, fallback: number, what: string): number {
  const value = optionalNumber(raw, what) ?? fallback;
  if (!(value > 0)) throw new PlanError(`${what} must be positive`);
  return value;
}

function spanAlong(polygon: readonly (readonly [number, number])[], up: readonly [number, number]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of polygon) {
    const proj = x * up[0] + z * up[1];
    if (proj < lo) lo = proj;
    if (proj > hi) hi = proj;
  }
  return hi - lo;
}

/** Area of `upper` that sits outside `lower`, for rectilinear outlines. */
function outsideArea(
  upper: readonly (readonly [number, number])[],
  lower: readonly (readonly [number, number])[],
): number {
  const xs = gridCoords(upper, lower, 0);
  const zs = gridCoords(upper, lower, 1);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let k = 0; k < zs.length - 1; k += 1) {
      const width = xs[i + 1]! - xs[i]!;
      const depth = zs[k + 1]! - zs[k]!;
      if (width <= 1e-8 || depth <= 1e-8) continue;
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      const cz = (zs[k]! + zs[k + 1]!) / 2;
      // A sliver inside the outline tolerance is the same floor, not an overhang.
      if (pointInRing(upper, cx, cz) && !withinOutline(lower, cx, cz)) area += width * depth;
    }
  }
  return area;
}

function gridCoords(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
  axis: 0 | 1,
): number[] {
  const values = [...a, ...b].map((point) => point[axis]);
  values.sort((left, right) => left - right);
  const out: number[] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last === undefined || value - last > 1e-8) out.push(value);
  }
  return out;
}

/** Inside the ring, or within `OUTLINE_TOL_M` of an edge. */
function withinOutline(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  if (pointInRing(polygon, x, z)) return true;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (distToSeg(x, z, a, b) <= OUTLINE_TOL_M) return true;
  }
  return false;
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

function formatArea(area: number): string {
  return String(Math.round(area * 1e4) / 1e4);
}

function classifyLayer(
  label: string,
):
  | { kind: "floor"; n: number }
  | { kind: "floor-texture"; n: number }
  | { kind: "doors" }
  | { kind: "stairs" }
  | { kind: "ignore" } {
  if (label === "doors-external") return { kind: "doors" };
  if (label === "stairs-external") return { kind: "stairs" };
  if (label === "ignore") return { kind: "ignore" };
  const texture = /^floor-(\d+)-texture$/.exec(label);
  if (texture) {
    const n = Number(texture[1]);
    if (Number.isInteger(n) && n >= 1) return { kind: "floor-texture", n };
  }
  const match = /^floor-(\d+)$/.exec(label);
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) return { kind: "floor", n };
  }
  throw new PlanError(
    `floors file layer "${label}" is not floor-<n>, floor-<n>-texture, doors-external, stairs-external or ignore`,
  );
}

function floorPose(floor: FloorAcc, frame: ReturnType<typeof pageFrame>): Pose {
  if (floor.stencils.length !== 1) throw new PlanError(`floor-${floor.n} needs exactly one footprint`);
  const hit = floor.stencils[0]!;
  const tagged = taggedModel(hit.el);
  const pose = stencilPose(hit.el, hit.matrix, frame);
  if (!tagged || !pose) throw new PlanError(`floor-${floor.n} needs exactly one footprint`);
  return {
    model: tagged.model,
    scale: pose.scale,
    yaw: yawFromSvgMatrix(hit.matrix, tagged.id),
    origin: [pose.origin[0], 0, pose.origin[2]],
    elevation: pose.origin[1],
  };
}

function sameFootprint(first: Pose, pose: Pose): boolean {
  if (pose.model !== first.model || pose.yaw !== first.yaw) return false;
  if (Math.abs(pose.origin[0] - first.origin[0]) > 1e-4) return false;
  if (Math.abs(pose.origin[2] - first.origin[2]) > 1e-4) return false;
  const span = Math.max(Math.abs(first.scale), Math.abs(pose.scale));
  return Math.abs(pose.scale - first.scale) <= 1e-4 * span;
}

function localYaw(elementYaw: Yaw, yaw: Yaw): Yaw {
  const turned = (elementYaw - yaw + 360) % 360;
  if (turned === 0 || turned === 90 || turned === 180 || turned === 270) return turned;
  throw new PlanError(`yaw ${turned} is not 0, 90, 180, or 270`);
}

function toLocalBox(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  origin: Vec3,
  yaw: Yaw,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let loX = Infinity;
  let hiX = -Infinity;
  let loZ = Infinity;
  let hiZ = -Infinity;
  for (const x of [minX, maxX]) {
    for (const z of [minZ, maxZ]) {
      const local = toLocal(x, z, origin, yaw);
      if (local.x < loX) loX = local.x;
      if (local.x > hiX) hiX = local.x;
      if (local.z < loZ) loZ = local.z;
      if (local.z > hiZ) hiZ = local.z;
    }
  }
  return { minX: loX, maxX: hiX, minZ: loZ, maxZ: hiZ };
}

function indexPatterns(svg: XmlNode): Map<string, XmlNode> {
  const map = new Map<string, XmlNode>();
  const walk = (el: XmlNode): void => {
    if (localName(el.name) === "pattern") {
      const id = attr(el, "id")?.trim();
      if (id) map.set(id, el);
    }
    for (const child of el.children) walk(child);
  };
  walk(svg);
  return map;
}

/**
 * First labelled `floor-texture` that carries an image or a pattern fill.
 * An image uses `data-tile-m` or `DEFAULT_TILE_M`. A pattern fill takes the
 * tile from `width`/`height` times `patternTransform`, in page metres.
 * `data-tile-m` overrides the pattern. The arena floors file stores the
 * image on `floor-<n>-texture` as `fill:url(#pattern)` with no `data-tile-m`.
 */
function readFloorTexture(
  hits: readonly Hit[],
  patterns: ReadonlyMap<string, XmlNode>,
  frame: PageFrame,
  svgPath: string,
  cache: Map<string, Uint8Array>,
  floorN: number,
): FloorTexture | undefined {
  if (hits.length === 0) return undefined;
  let failure: PlanError | undefined;
  for (const hit of hits) {
    try {
      const texture = textureFromElement(hit.el, patterns, frame, svgPath, cache, floorN);
      if (texture) return texture;
    } catch (err) {
      if (!(err instanceof PlanError)) throw err;
      failure = err;
    }
  }
  throw failure ?? new PlanError(`floor-${floorN} floor-texture has no image`);
}

function textureFromElement(
  el: XmlNode,
  patterns: ReadonlyMap<string, XmlNode>,
  frame: PageFrame,
  svgPath: string,
  cache: Map<string, Uint8Array>,
  floorN: number,
): FloorTexture | undefined {
  const what = `floor-${floorN} floor-texture data-tile-m`;
  const imageEl = localName(el.name) === "image" ? el : findDescendant(el, "image");
  const pattern = findPattern(el);
  const tileOverride = optionalNumber(attr(el, "data-tile-m"), what)
    ?? (imageEl ? optionalNumber(attr(imageEl, "data-tile-m"), what) : undefined);
  if (tileOverride !== undefined && !(tileOverride > 0)) {
    throw new PlanError(`floor-${floorN} floor-texture data-tile-m must be positive`);
  }
  // A linked image wins over a pattern fill on the same element.
  const imageHref = imageEl ? attr(imageEl, "href")?.trim() : undefined;
  if (imageHref) {
    const tile = tileOverride ?? DEFAULT_TILE_M;
    return { image: cachedImage(cache, svgPath, imageHref, `floor-${floorN}`), tileX: tile, tileZ: tile };
  }
  if (!pattern) return undefined;
  const chain = patternChain(pattern.id, patterns, floorN);
  const href = patternImageHref(chain);
  if (!href) return undefined;
  const tile = tileOverride !== undefined
    ? { x: tileOverride, z: tileOverride }
    : patternTile(chain, frame, pattern.host, floorN);
  return { image: cachedImage(cache, svgPath, href, `floor-${floorN}`), tileX: tile.x, tileZ: tile.z };
}

function cachedImage(cache: Map<string, Uint8Array>, svgPath: string, href: string, what: string): Uint8Array {
  const found = cache.get(href);
  if (found) return found;
  const bytes = loadTextureRef(svgPath, href, what, "floor texture");
  cache.set(href, bytes);
  return bytes;
}

function patternChain(id: string, patterns: ReadonlyMap<string, XmlNode>, floorN: number): XmlNode[] {
  const chain: XmlNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = patterns.get(current);
    if (!node) throw new PlanError(`floor-${floorN} floor-texture pattern "${current}" is missing`);
    chain.push(node);
    const href = attr(node, "href")?.trim();
    current = href?.startsWith("#") ? href.slice(1) : undefined;
  }
  return chain;
}

function patternImageHref(chain: readonly XmlNode[]): string | undefined {
  for (const node of chain) {
    const image = findDescendant(node, "image");
    const href = image ? attr(image, "href")?.trim() : undefined;
    if (href) return href;
  }
  return undefined;
}

/**
 * Tile period in metres. `patternUnits="userSpaceOnUse"` measures
 * `width`/`height` in the page's user units, then `patternTransform`
 * scales that rectangle. SVG y grows down and world z grows the other way,
 * so the height vector's length is the +Z period. The arena pattern is
 * axis-aligned, so that length is the vertical scale times the height.
 */
function patternTile(
  chain: readonly XmlNode[],
  frame: PageFrame,
  host: XmlNode,
  floorN: number,
): { x: number; z: number } {
  const units = inherited(chain, "patternUnits") ?? "objectBoundingBox";
  let width = Number(inherited(chain, "width"));
  let height = Number(inherited(chain, "height"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) {
    throw new PlanError(`floor-${floorN} floor-texture pattern has no tile size`);
  }
  if (units === "objectBoundingBox") {
    const box = userBox(host, floorN);
    width *= box.width;
    height *= box.height;
  } else if (units !== "userSpaceOnUse") {
    throw new PlanError(`floor-${floorN} floor-texture patternUnits "${units}" is not supported`);
  }
  const raw = inherited(chain, "patternTransform");
  const matrix = raw ? parseTransform(raw) : ident();
  const tileX = Math.hypot(matrix[0] * width, matrix[1] * width) * frame.meters;
  const tileZ = Math.hypot(matrix[2] * height, matrix[3] * height) * frame.meters;
  if (!(tileX > 1e-6) || !(tileZ > 1e-6)) throw new PlanError(`floor-${floorN} floor-texture tile size is zero`);
  return { x: tileX, z: tileZ };
}

function inherited(chain: readonly XmlNode[], name: string): string | undefined {
  for (const node of chain) {
    const value = attr(node, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function userBox(el: XmlNode, floorN: number): { width: number; height: number } {
  if (localName(el.name) === "rect") {
    const width = Number(attr(el, "width"));
    const height = Number(attr(el, "height"));
    if (width > 0 && height > 0) return { width, height };
  }
  const path = localName(el.name) === "path" ? el : findDescendant(el, "path");
  if (!path) throw new PlanError(`floor-${floorN} floor-texture has no shape`);
  const points = pathPoints(attr(path, "d"), attr(el, "id") ?? "floor-texture", "floor-texture");
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!(maxX > minX) || !(maxY > minY)) throw new PlanError(`floor-${floorN} floor-texture has no area`);
  return { width: maxX - minX, height: maxY - minY };
}

function findPattern(el: XmlNode): { id: string; host: XmlNode } | undefined {
  const id = patternId(el);
  if (id) return { id, host: el };
  for (const child of el.children) {
    const found = findPattern(child);
    if (found) return found;
  }
  return undefined;
}

function patternId(el: XmlNode): string | undefined {
  const style = attr(el, "style") ?? "";
  const fromStyle = /(?:^|;)\s*fill\s*:\s*url\(\s*#([^)\s]+)\s*\)/i.exec(style);
  if (fromStyle?.[1]) return fromStyle[1];
  const fill = attr(el, "fill")?.trim();
  const fromFill = fill ? /^url\(\s*#([^)\s]+)\s*\)$/i.exec(fill) : undefined;
  return fromFill?.[1];
}

function findDescendant(el: XmlNode, name: string): XmlNode | undefined {
  for (const child of el.children) {
    if (localName(child.name) === name) return child;
    const nested = findDescendant(child, name);
    if (nested) return nested;
  }
  return undefined;
}
