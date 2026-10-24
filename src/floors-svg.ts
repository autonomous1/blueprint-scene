import { PlanError } from "./errors.ts";
import {
  documentUnits,
  doorFromElement,
  ident,
  measureTagged,
  mul,
  optionalNumber,
  pageFrame,
  parseTransform,
  propFromElement,
  requireId,
  stencilPose,
  taggedModel,
  uniformScale,
  yawFromSvgMatrix,
  type Mat,
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

export type FloorSource = {
  n: number;
  name: string;
  elevation: number;
  height?: number;
  rooms: RoomInstanceSource[];
};

export type FloorsSource = {
  model: string;
  /** Stencil model units → metres (30 for the arena buildings). */
  scale: number;
  /** Stencil yaw on the page. Local data has it removed. */
  yaw: Yaw;
  /** Page-world origin of the stencil, y = 0. */
  origin: Vec3;
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
        const floor: FloorAcc = { n: kind.n, name: label, layer: el, stencils: [], rooms: [] };
        floors.push(floor);
        scope = { kind: "floor", floor };
      } else if (kind.kind === "doors") {
        scope = { kind: "doors" };
      } else {
        scope = { kind: "stairs" };
      }
    } else if (isLayer && label === "ignore") {
      return;
    }

    const matrix = mul(parent, parseTransform(attr(el, "transform")));
    if (scope?.kind === "floor") {
      if (name === "g" && stencilPose(el, matrix, frame) && taggedModel(el)) {
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
    const source: FloorSource = { n: floor.n, name: floor.name, elevation, rooms };
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

  return { model, scale, yaw, origin, floors: floorSources, doors, props };
}

function classifyLayer(label: string): { kind: "floor"; n: number } | { kind: "doors" } | { kind: "stairs" } | { kind: "ignore" } {
  if (label === "doors-external") return { kind: "doors" };
  if (label === "stairs-external") return { kind: "stairs" };
  if (label === "ignore") return { kind: "ignore" };
  const match = /^floor-(\d+)$/.exec(label);
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) return { kind: "floor", n };
  }
  throw new PlanError(`floors file layer "${label}" is not floor-<n>, doors-external, stairs-external or ignore`);
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
  if (Math.abs(pose.origin[0] - first.origin[0]) > 1e-6) return false;
  if (Math.abs(pose.origin[2] - first.origin[2]) > 1e-6) return false;
  const span = Math.max(Math.abs(first.scale), Math.abs(pose.scale));
  return Math.abs(pose.scale - first.scale) <= 1e-6 * span;
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
