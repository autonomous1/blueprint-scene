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

export type FloorSource = {
  n: number;
  name: string;
  elevation: number;
  height?: number;
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
  /** Building-local footprint AABB, counter-clockwise. The same on every floor. */
  footprint: Array<[number, number]>;
  /**
   * Building-local stencil outline, counter-clockwise, with consecutive
   * duplicates removed. A rectilinear path keeps its vertices. A diagonal
   * edge or a curve falls back to `footprint`.
   */
  outline: Array<[number, number]>;
  /** Set when `outline` fell back to the footprint AABB. */
  outlineFallback?: "diagonal" | "curve";
  floors: FloorSource[];
  /** Building-local. `center[1]` is the sill. */
  doors: SceneDoor[];
  /** `stairs-external`, building-local. */
  props: SceneProp[];
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
      if (attr(el, "label")?.trim() === "floor-texture") {
        scope.floor.textures.push({ el, matrix });
      } else if (platform && (name === "rect" || name === "path")) {
        claim(platform);
        scope.floor.platforms.push({ el, matrix });
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
      const tagged = taggedModel(el);
      if (tagged) claim(tagged.id);
      propHits.push({ el, matrix });
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
      throw new PlanError(`floor-${floor.n} footprint does not match floor-${floors[0]!.n}`);
    }
  }
  for (let i = 1; i < poses.length; i += 1) {
    if (!(poses[i]!.elevation > poses[i - 1]!.elevation)) {
      throw new PlanError(`floor-${floors[i]!.n} elevation must be above floor-${floors[i - 1]!.n}`);
    }
  }

  const { model, scale, yaw, origin } = first;
  const shapes = floors.map((floor, index) => {
    const pose = poses[index]!;
    return stencilShape(floor.stencils[0]!, frame, pose.origin, pose.yaw);
  });
  const shape = shapes[0]!;
  for (let i = 1; i < shapes.length; i += 1) {
    if (!sameOutline(shape.outline, shapes[i]!.outline)) {
      throw new PlanError(`floor-${floors[i]!.n} outline does not match floor-${floors[0]!.n}`);
    }
  }
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
    const source: FloorSource = { n: floor.n, name: floor.name, elevation, rooms, platforms };
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
  };
}

function platformIdOf(el: XmlNode): string | undefined {
  const label = attr(el, "label");
  if (!label) return undefined;
  const match = label.trim().match(/^platform:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
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

function sameOutline(first: readonly (readonly [number, number])[], other: readonly (readonly [number, number])[]): boolean {
  if (first.length !== other.length) return false;
  const a = rotateStart(first);
  const b = rotateStart(other);
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i]![0] - b[i]![0]) > OUTLINE_TOL_M) return false;
    if (Math.abs(a[i]![1] - b[i]![1]) > OUTLINE_TOL_M) return false;
  }
  return true;
}

function rotateStart(poly: readonly (readonly [number, number])[]): Array<[number, number]> {
  let best = 0;
  for (let i = 1; i < poly.length; i += 1) {
    const point = poly[i]!;
    const at = poly[best]!;
    if (point[0] < at[0] - 1e-6 || (Math.abs(point[0] - at[0]) <= 1e-6 && point[1] < at[1])) best = i;
  }
  return [...poly.slice(best), ...poly.slice(0, best)].map(([x, z]) => [x, z]);
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
