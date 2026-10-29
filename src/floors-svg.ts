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
  floors: FloorSource[];
  /** Building-local. `center[1]` is the sill. */
  doors: SceneDoor[];
  /** `stairs-external`, building-local. */
  props: SceneProp[];
};

type Scope =
  | { kind: "floor"; floor: FloorAcc }
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
export function readFloorsSvg(svgText: string): FloorsSource {
  const svg = parseXml(svgText);
  const frame = pageFrame(svg);
  const units = documentUnits(svg);
  const floors: FloorAcc[] = [];
  const doorHits: Hit[] = [];
  const propHits: Hit[] = [];
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
          asPlatform: attr(el, "data-kind")?.trim() === "platform",
        };
        floors.push(floor);
        scope = { kind: "floor", floor };
      } else if (kind.kind === "doors") {
        scope = { kind: "doors" };
      } else if (kind.kind === "stairs") {
        scope = { kind: "stairs" };
      } else if (kind.kind === "floor-texture") {
        // TODO: collect data-tile-m paths for floor kind.n
        return;
      }
    } else if (isLayer && label === "ignore") {
      return;
    }

    const matrix = mul(parent, parseTransform(attr(el, "transform")));
    if (scope?.kind === "floor") {
      const platform = platformIdOf(el);
      if (platform && (name === "rect" || name === "path")) {
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
  const footprint = stencilFootprint(floors[0]!.stencils[0]!, frame, origin, yaw);
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

  return { model, scale, yaw, origin, footprint, floors: floorSources, doors, props };
}

function platformIdOf(el: XmlNode): string | undefined {
  const label = attr(el, "label");
  if (!label) return undefined;
  const match = label.trim().match(/^platform:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
  return match?.[1];
}

function stencilFootprint(hit: Hit, frame: PageFrame, origin: Vec3, yaw: Yaw): Array<[number, number]> {
  const id = attr(hit.el, "id")?.trim() || "footprint";
  return aabbPolygon(localPoints(hit.el, hit.matrix, frame, origin, yaw, id), id);
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
  const path = localName(el.name) === "path" ? el : el.children.find((child) => localName(child.name) === "path");
  if (!path) throw new PlanError(`footprint "${id}" has no path`);
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
