import { PlanError } from "./errors.ts";
import type { DoorHinge, SceneDoor, SceneProp, SceneSpawn, Vec3, XzBounds, Yaw } from "./types.ts";
import { attr, localName, parseXml, type XmlNode } from "./xml.ts";

/**
 * A tagged instance before the model size is known.
 * `drawnWidth` / `drawnDepth` are world meters along model +X and model +Z.
 */
export type PlanPlacement = {
  id: string;
  model: string;
  position: Vec3;
  yaw: Yaw;
  drawnWidth: number;
  drawnDepth: number;
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CARDINALS: Yaw[] = [0, 90, 180, 270];

const METERS: Record<string, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  ft: 0.3048,
  px: 0.0254 / 96,
  pt: 0.0254 / 72,
  pc: (0.0254 / 72) * 12,
  q: 0.00025,
};

type Mat = [number, number, number, number, number, number];

function ident(): Mat {
  return [1, 0, 0, 1, 0, 0];
}

/** `m` is applied after `n`. */
function mul(m: Mat, n: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Inkscape toolbar coordinates are the room. The toolbar is user space, Y-up,
 * with its origin at the lower-left of the page. The SVG `y` attribute is
 * measured down from the top, so toolbar y is `pageMaxY - svgY`.
 * World x is toolbar x. World z is toolbar y. World y is 0.
 * The page height is not added again, toolbar y is not negated, and the
 * bounds rectangle is not subtracted.
 */
export function svgPointToWorld(svgX: number, svgY: number, frame: PageFrame): Vec3 {
  const toolbarY = frame.pageMaxY - svgY;
  return [svgX * frame.meters, 0, toolbarY * frame.meters];
}

/** SVG user units, plus the SVG y of the page bottom (toolbar y = 0). */
export type PageFrame = {
  meters: number;
  pageMaxY: number;
};

export type PlanScene = {
  placements: PlanPlacement[];
  /** True when an Inkscape layer named `bounds` is present and not under `ignore`. */
  sawBoundsLayer: boolean;
  bounds?: XzBounds;
  props: SceneProp[];
  spawns: SceneSpawn[];
  doors: SceneDoor[];
};

/**
 * One rectangle or image on a named Inkscape layer, in toolbar meters. Y is up.
 * The part is the element id: `data-part-frame`, `data-part-door`,
 * `data-part-hinge`, or `data-part-texture`.
 */
export type DesignRect = {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  part?: string;
  /** `data-part-texture` href: a data URI or a path relative to the SVG. */
  href?: string;
};

/**
 * World meters per SVG user unit. The drawing scale treats 1 mm as 1 m,
 * so this is millimeters per user unit:
 * `widthInMm / viewBoxWidth / documentScale`.
 */
export function metersPerUserUnit(svg: XmlNode): number {
  const viewBox = attr(svg, "viewBox");
  if (!viewBox) throw new PlanError("svg is missing viewBox");
  const box = parseViewBox(viewBox);
  const named = namedView(svg);
  const units = named ? attr(named, "document-units") : undefined;
  const width = attr(svg, "width");
  const height = attr(svg, "height");
  let mm: number;
  let span: number;
  if (width && !width.includes("%")) {
    mm = lengthToMm(width, units);
    span = box.width;
  } else if (height && !height.includes("%")) {
    mm = lengthToMm(height, units);
    span = box.height;
  } else {
    throw new PlanError("svg width or height must be a length (m, mm, cm, in, px)");
  }
  const scale = documentScale(svg, named);
  const factor = mm / span / scale;
  if (!Number.isFinite(factor) || factor <= 0) throw new PlanError("could not convert SVG units to meters");
  return factor;
}

export function readPlacements(svgText: string): PlanPlacement[] {
  return readScene(svgText).placements;
}

export function readScene(svgText: string): PlanScene {
  const svg = parseXml(svgText);
  const collect: Collect = {
    frame: pageFrame(svg),
    units: documentUnits(svg),
    placements: [],
    ids: new Set<string>(),
    props: [],
    propIds: new Set<string>(),
    spawns: [],
    spawnIds: new Set<string>(),
    doors: [],
    doorIds: new Set<string>(),
    sawBoundsLayer: false,
    boundsRects: 0,
  };
  walk(svg, ident(), [], collect);
  if (collect.placements.length === 0) throw new PlanError("no building placements in the SVG");
  for (const door of collect.doors) {
    if (!collect.ids.has(door.building)) {
      throw new PlanError(`door "${door.id}" data-building "${door.building}" does not match a placement`);
    }
  }
  if (collect.bounds) {
    for (const spawn of collect.spawns) {
      const [x, , z] = spawn.position;
      if (!insideBounds(collect.bounds, x, z)) {
        throw new PlanError(`spawn "${spawn.id}" is outside the bounds rectangle`);
      }
    }
  }
  return {
    placements: collect.placements,
    sawBoundsLayer: collect.sawBoundsLayer,
    ...(collect.bounds ? { bounds: collect.bounds } : {}),
    props: collect.props,
    spawns: collect.spawns,
    doors: collect.doors,
  };
}

const PART_BY_ID: Record<string, string> = {
  "data-part-frame": "frame",
  "data-part-door": "door",
  "data-part-hinge": "hinge",
  "data-part-texture": "texture",
};

/**
 * Rectangles and images on one Inkscape layer, in the same toolbar meters as the plan.
 * X is toolbar x. Y is toolbar y, up. A rotated rectangle fails.
 * A door design names each part with its element id.
 */
export function readDesignRects(svgText: string, layer: string): DesignRect[] {
  const svg = parseXml(svgText);
  const frame = pageFrame(svg);
  const units = documentUnits(svg);
  const rects: DesignRect[] = [];
  walkDesign(svg, ident(), [], layer, frame, units, rects);
  return rects;
}

/**
 * A rectangle or image on one Inkscape layer, in toolbar meters. Y is up.
 * `label` is the Inkscape label. `face` is `data-face`. `href` is an image
 * href. `dataTexture` and `depth` are the `data-texture` and `data-depth`
 * attributes. An image nested in a rectangle is that rectangle's texture,
 * not a second shape.
 */
export type LayerShape = {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  label?: string;
  face?: string;
  href?: string;
  dataTexture?: string;
  /** `data-depth` in meters. Absent when the attribute is omitted. */
  depth?: number;
};

export function readLayerShapes(svgText: string, layer: string): { found: boolean; shapes: LayerShape[] } {
  const svg = parseXml(svgText);
  const frame = pageFrame(svg);
  const units = documentUnits(svg);
  const shapes: LayerShape[] = [];
  let found = false;
  const visit = (el: XmlNode, parent: Mat, stack: string[]): void => {
    const name = localName(el.name);
    if (name === "defs" || name === "metadata" || name === "namedview") return;
    const isLayer = name === "g" && attr(el, "groupmode") === "layer";
    const nextStack = isLayer ? [...stack, attr(el, "label") ?? ""] : stack;
    if (isLayer && attr(el, "label") === layer) found = true;
    const matrix = mul(parent, parseTransform(attr(el, "transform")));
    if (!nextStack.includes("ignore") && nextStack.includes(layer) && (name === "rect" || name === "image")) {
      shapes.push(layerShape(el, matrix, frame, units));
      return;
    }
    for (const child of el.children) visit(child, matrix, nextStack);
  };
  visit(svg, ident(), []);
  return { found, shapes };
}

function layerShape(el: XmlNode, matrix: Mat, frame: PageFrame, units: string | undefined): LayerShape {
  const id = attr(el, "id")?.trim() || localName(el.name);
  const local = rectBounds(el, frame.meters, units);
  if (!local) throw new PlanError(`element "${id}" has no size`);
  const corners = [
    [local.minX, local.minY],
    [local.maxX, local.minY],
    [local.maxX, local.maxY],
    [local.minX, local.maxY],
  ].map(([x, y]) => {
    const [ux, uy] = apply(matrix, x!, y!);
    const [wx, , wy] = svgPointToWorld(ux, uy, frame);
    return [wx, wy] as [number, number];
  });
  const edge = (from: number, to: number): [number, number] => [
    corners[to]![0] - corners[from]![0],
    corners[to]![1] - corners[from]![1],
  ];
  if (!axisAligned(edge(0, 1)) || !axisAligned(edge(0, 3))) {
    throw new PlanError(`element "${id}" is not axis-aligned`);
  }
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (!(maxX > minX) || !(maxY > minY)) throw new PlanError(`element "${id}" has no size`);
  const label = attr(el, "label")?.trim();
  const face = attr(el, "data-face")?.trim();
  const dataTexture = attr(el, "data-texture")?.trim();
  const href = localName(el.name) === "image" ? attr(el, "href")?.trim() : imageHref(el);
  const depthRaw = attr(el, "data-depth");
  const depth = depthRaw == null || depthRaw.trim() === "" ? undefined : depthMeters(depthRaw, frame, units);
  return {
    id,
    minX,
    minY,
    maxX,
    maxY,
    ...(label ? { label } : {}),
    ...(face ? { face } : {}),
    ...(href ? { href } : {}),
    ...(dataTexture ? { dataTexture } : {}),
    ...(depth != null ? { depth } : {}),
  };
}

function imageHref(el: XmlNode): string | undefined {
  for (const child of el.children) {
    if (localName(child.name) !== "image") continue;
    const href = attr(child, "href")?.trim();
    if (href) return href;
  }
  return undefined;
}

function depthMeters(raw: string, frame: PageFrame, units: string | undefined): number {
  const user = userLength(raw, Number.NaN, frame.meters, units);
  if (!Number.isFinite(user) || user <= 0) throw new PlanError(`data-depth "${raw}" is not a positive length`);
  return user * frame.meters;
}

function walkDesign(
  el: XmlNode,
  parent: Mat,
  stack: string[],
  layer: string,
  frame: PageFrame,
  units: string | undefined,
  out: DesignRect[],
): void {
  const name = localName(el.name);
  if (name === "defs" || name === "metadata" || name === "namedview") return;
  const isLayer = name === "g" && attr(el, "groupmode") === "layer";
  const nextStack = isLayer ? [...stack, attr(el, "label") ?? ""] : stack;
  const matrix = mul(parent, parseTransform(attr(el, "transform")));
  if (!nextStack.includes("ignore") && nextStack.includes(layer) && (name === "rect" || name === "image")) {
    out.push(designPart(el, matrix, frame, units));
  }
  for (const child of el.children) walkDesign(child, matrix, nextStack, layer, frame, units, out);
}

function designPart(el: XmlNode, matrix: Mat, frame: PageFrame, units: string | undefined): DesignRect {
  const id = attr(el, "id")?.trim() || localName(el.name);
  const part = PART_BY_ID[id];
  if (!part) {
    throw new PlanError(`element "${id}" id is not data-part-frame, data-part-door, data-part-hinge, or data-part-texture`);
  }
  const tag = localName(el.name);
  if (part === "texture" && tag !== "image") throw new PlanError("data-part-texture must be an image");
  if (part !== "texture" && tag !== "rect") throw new PlanError(`${id} must be a rectangle`);
  const href = part === "texture" ? attr(el, "href")?.trim() : undefined;
  if (part === "texture" && !href) throw new PlanError("data-part-texture has no image");
  const local = rectBounds(el, frame.meters, units);
  if (!local) throw new PlanError(`element "${id}" has no size`);
  const corners = [
    [local.minX, local.minY],
    [local.maxX, local.minY],
    [local.maxX, local.maxY],
    [local.minX, local.maxY],
  ].map(([x, y]) => {
    const [ux, uy] = apply(matrix, x!, y!);
    const [wx, , wy] = svgPointToWorld(ux, uy, frame);
    return [wx, wy] as [number, number];
  });
  const edge = (from: number, to: number): [number, number] => [
    corners[to]![0] - corners[from]![0],
    corners[to]![1] - corners[from]![1],
  ];
  if (!axisAligned(edge(0, 1)) || !axisAligned(edge(0, 3))) {
    throw new PlanError(`element "${id}" is not axis-aligned`);
  }
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (!(maxX > minX) || !(maxY > minY)) throw new PlanError(`element "${id}" has no size`);
  return {
    id,
    minX,
    minY,
    maxX,
    maxY,
    part,
    ...(href ? { href } : {}),
  };
}

function axisAligned(edge: [number, number]): boolean {
  const [dx, dy] = edge;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return false;
  return Math.min(Math.abs(dx), Math.abs(dy)) <= 1e-3 * length;
}

function pageFrame(svg: XmlNode): PageFrame {
  const viewBox = attr(svg, "viewBox");
  if (!viewBox) throw new PlanError("svg is missing viewBox");
  const box = parseViewBox(viewBox);
  return { meters: metersPerUserUnit(svg), pageMaxY: box.minY + box.height };
}

export function snapYaw(degrees: number, id?: string): Yaw {
  if (!Number.isFinite(degrees)) throw new PlanError(yawMessage(id, "yaw is not a finite number"));
  let wrapped = degrees % 360;
  if (wrapped < 0) wrapped += 360;
  if (wrapped > 360 - 0.5) wrapped = 0;
  for (const cardinal of CARDINALS) {
    if (Math.abs(wrapped - cardinal) <= 0.5) return cardinal;
  }
  throw new PlanError(yawMessage(id, `rotation ${trimNum(degrees)}° is not 0, 90, 180, or 270`));
}

function yawMessage(id: string | undefined, message: string): string {
  return id ? `placement "${id}" ${message}` : message;
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function documentUnits(svg: XmlNode): string | undefined {
  const named = namedView(svg);
  return named ? attr(named, "document-units") : undefined;
}

function namedView(svg: XmlNode): XmlNode | undefined {
  return svg.children.find((child) => localName(child.name) === "namedview");
}

function documentScale(svg: XmlNode, named: XmlNode | undefined): number {
  const raw = attr(svg, "document-scale") ?? (named ? attr(named, "document-scale") : undefined);
  if (raw == null || raw.trim() === "") return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) throw new PlanError(`document scale "${raw}" is not a positive number`);
  return scale;
}

function parseViewBox(value: string): { minY: number; width: number; height: number } {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new PlanError(`invalid viewBox "${value}"`);
  }
  if ((parts[2] ?? 0) <= 0 || (parts[3] ?? 0) <= 0) throw new PlanError("viewBox size must be positive");
  return { minY: parts[1]!, width: parts[2]!, height: parts[3]! };
}

function lengthToMeters(raw: string, fallbackUnit: string | undefined): number {
  const match = raw.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z%]*)$/);
  if (!match) throw new PlanError(`invalid length "${raw}"`);
  const magnitude = Number(match[1]);
  let unit = (match[2] ?? "").toLowerCase();
  if (unit === "%") throw new PlanError(`percentage length "${raw}" cannot be converted to meters`);
  if (!unit) unit = (fallbackUnit ?? "px").toLowerCase();
  const factor = METERS[unit];
  if (factor == null) throw new PlanError(`unknown unit "${unit}" in "${raw}"`);
  return magnitude * factor;
}

function lengthToMm(raw: string, fallbackUnit: string | undefined): number {
  return lengthToMeters(raw, fallbackUnit) * 1000;
}

function userLength(raw: string | undefined, fallback: number, mmPerUser: number, units: string | undefined): number {
  if (raw == null || raw.trim() === "") return fallback;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) return Number(raw);
  return lengthToMm(raw, units) / mmPerUser;
}

type Collect = {
  frame: PageFrame;
  units: string | undefined;
  placements: PlanPlacement[];
  ids: Set<string>;
  props: SceneProp[];
  propIds: Set<string>;
  spawns: SceneSpawn[];
  spawnIds: Set<string>;
  doors: SceneDoor[];
  doorIds: Set<string>;
  sawBoundsLayer: boolean;
  boundsRects: number;
  bounds?: XzBounds;
};

function walk(el: XmlNode, parent: Mat, stack: string[], collect: Collect): void {
  const name = localName(el.name);
  if (name === "defs" || name === "metadata" || name === "namedview") return;
  const isLayer = name === "g" && attr(el, "groupmode") === "layer";
  const nextStack = isLayer ? [...stack, attr(el, "label") ?? ""] : stack;
  const matrix = mul(parent, parseTransform(attr(el, "transform")));
  const layer = nextStack.length > 0 ? nextStack[nextStack.length - 1] : undefined;
  const ignored = nextStack.includes("ignore");
  if (isLayer && attr(el, "label") === "bounds" && !ignored) collect.sawBoundsLayer = true;
  if (!ignored && name === "rect" && layer === "bounds") {
    if (collect.boundsRects > 0) throw new PlanError("bounds layer has more than one rectangle");
    collect.boundsRects += 1;
    takeBounds(el, matrix, collect);
  }
  if (!ignored && name === "rect" && layer === "props") takeProp(el, matrix, collect);
  if (!ignored && name === "rect" && layer === "doors") takeDoor(el, matrix, collect);
  if (!ignored && (name === "text" || name === "path" || name === "rect") && layer === "spawn-points") {
    takeSpawn(el, matrix, collect);
  }
  if (!isLayer && (name === "rect" || name === "g") && isPlacement(el, nextStack)) {
    consider(el, matrix, nextStack, collect);
    return;
  }
  for (const child of el.children) walk(child, matrix, nextStack, collect);
}

function isPlacement(el: XmlNode, stack: string[]): boolean {
  if (!stack.includes("buildings") || stack.includes("ignore")) return false;
  return Boolean(attr(el, "data-model")?.trim() || modelFromLabel(attr(el, "label")));
}

function consider(el: XmlNode, matrix: Mat, stack: string[], collect: Collect): void {
  if (!stack.includes("buildings") || stack.includes("ignore")) return;
  const tagged = taggedModel(el);
  if (!tagged) return;
  const { id, model } = tagged;
  claimPlacementId(collect, id);
  const measured = measureTagged(el, matrix, collect, id);
  collect.ids.add(id);
  collect.placements.push({ id, model, ...measured });
}

function taggedModel(el: XmlNode): { id: string; model: string } | undefined {
  const dataModel = attr(el, "data-model")?.trim();
  const labelModel = modelFromLabel(attr(el, "label"));
  if (!dataModel && !labelModel) return undefined;
  const id = attr(el, "id")?.trim() || "?";
  if (dataModel && labelModel && dataModel !== labelModel) {
    throw new PlanError(`rect "${id}" data-model "${dataModel}" disagrees with label "model:${labelModel}"`);
  }
  const model = (dataModel || labelModel)!;
  if (!ID_RE.test(model)) throw new PlanError(`rect "${id}" has invalid model id "${model}"`);
  if (id === "?" || !attr(el, "id")?.trim()) throw new PlanError(`placement of model "${model}" is missing id`);
  if (!ID_RE.test(id)) throw new PlanError(`invalid placement id "${id}"`);
  return { id, model };
}

function claimPlacementId(collect: Collect, id: string): void {
  if (collect.ids.has(id) || collect.propIds.has(id) || collect.doorIds.has(id)) {
    throw new PlanError(`duplicate placement id "${id}"`);
  }
}

function measureTagged(
  el: XmlNode,
  matrix: Mat,
  collect: Collect,
  id: string,
): { position: Vec3; yaw: Yaw; drawnWidth: number; drawnDepth: number } {
  const { frame, units } = collect;
  const local = localName(el.name) === "rect"
    ? rectBounds(el, frame.meters, units)
    : localBounds(el, frame.meters, units, id);
  if (!local || local.maxX - local.minX <= 0 || local.maxY - local.minY <= 0) {
    throw new PlanError(`placement "${id}" has no footprint`);
  }
  const lenX = Math.hypot(matrix[0], matrix[1]);
  const lenY = Math.hypot(matrix[2], matrix[3]);
  const [cx, cy] = apply(matrix, (local.minX + local.maxX) / 2, (local.minY + local.maxY) / 2);
  return {
    position: svgPointToWorld(cx, cy, frame),
    yaw: yawOf(el, matrix, id),
    drawnWidth: (local.maxX - local.minX) * lenX * frame.meters,
    drawnDepth: (local.maxY - local.minY) * lenY * frame.meters,
  };
}

/** Uniform SVG scale. A plain rectangle is 1. `scale(2)` is 2. */
function uniformScale(matrix: Mat, id: string): number {
  const lenX = Math.hypot(matrix[0], matrix[1]);
  const lenY = Math.hypot(matrix[2], matrix[3]);
  if (lenX < 1e-9 || lenY < 1e-9) throw new PlanError(`placement "${id}" transform scale is zero`);
  if (Math.abs(lenX - lenY) > 1e-3 * Math.max(lenX, lenY)) {
    throw new PlanError(`placement "${id}" scale is not uniform`);
  }
  return lenX;
}

function takeBounds(el: XmlNode, matrix: Mat, collect: Collect): void {
  const local = rectBounds(el, collect.frame.meters, collect.units);
  if (!local) throw new PlanError("bounds rectangle has no footprint");
  const box = worldAabb(local, matrix, collect.frame);
  const minY = optionalNumber(attr(el, "data-min-y"), "bounds data-min-y");
  const maxY = optionalNumber(attr(el, "data-max-y"), "bounds data-max-y");
  collect.bounds = {
    ...box,
    ...(minY !== undefined ? { minY } : {}),
    ...(maxY !== undefined ? { maxY } : {}),
  };
}

function takeProp(el: XmlNode, matrix: Mat, collect: Collect): void {
  const tagged = taggedModel(el);
  if (!tagged) return;
  const { id, model } = tagged;
  claimPlacementId(collect, id);
  const measured = measureTagged(el, matrix, collect, id);
  const minY = optionalNumber(attr(el, "data-min-y"), `prop "${id}" data-min-y`);
  const maxY = optionalNumber(attr(el, "data-max-y"), `prop "${id}" data-max-y`);
  if (minY !== undefined && maxY !== undefined && maxY < minY) {
    throw new PlanError(`prop "${id}" maxY must exceed minY`);
  }
  collect.propIds.add(id);
  collect.props.push({
    id,
    model,
    position: measured.position,
    yaw: measured.yaw,
    scale: uniformScale(matrix, id),
    drawnWidth: measured.drawnWidth,
    drawnDepth: measured.drawnDepth,
    ...(minY !== undefined ? { minY } : {}),
    ...(maxY !== undefined ? { maxY } : {}),
  });
}

function takeDoor(el: XmlNode, matrix: Mat, collect: Collect): void {
  const id = requireId(el, "door");
  const building = attr(el, "data-building")?.trim();
  if (!building) throw new PlanError(`door "${id}" is missing data-building`);
  if (!ID_RE.test(building)) throw new PlanError(`door "${id}" has invalid data-building "${building}"`);
  const model = doorModel(el, id);
  claimPlacementId(collect, id);
  const local = rectBounds(el, collect.frame.meters, collect.units);
  if (!local) throw new PlanError(`door "${id}" has no footprint`);
  const box = worldAabb(local, matrix, collect.frame);
  const [cx, cy] = apply(matrix, (local.minX + local.maxX) / 2, (local.minY + local.maxY) / 2);
  const width = optionalPositive(attr(el, "data-width"), `door "${id}" data-width`);
  const height = optionalPositive(attr(el, "data-height"), `door "${id}" data-height`);
  const depth = optionalPositive(attr(el, "data-depth"), `door "${id}" data-depth`);
  collect.doorIds.add(id);
  collect.doors.push({
    id,
    model,
    building,
    center: svgPointToWorld(cx, cy, collect.frame),
    minX: box.minX,
    maxX: box.maxX,
    minZ: box.minZ,
    maxZ: box.maxZ,
    hinge: parseHinge(el, id),
    open: parseOpen(el, id),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(depth !== undefined ? { depth } : {}),
  });
}

/**
 * The same id a prop reads: `data-model` or the label `model:<id>`.
 * A door with neither fails. There is no default model.
 */
function doorModel(el: XmlNode, id: string): string {
  const tagged = taggedModel(el);
  if (!tagged) throw new PlanError(`door "${id}" is missing a model`);
  return tagged.model;
}

function parseHinge(el: XmlNode, id: string): DoorHinge {
  const raw = attr(el, "data-hinge")?.trim();
  if (!raw) return "left";
  if (raw === "left" || raw === "right") return raw;
  throw new PlanError(`door "${id}" data-hinge "${raw}" is not left or right`);
}

function parseOpen(el: XmlNode, id: string): boolean {
  const raw = attr(el, "data-open")?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  throw new PlanError(`door "${id}" data-open "${raw}" is not true or false`);
}

function optionalPositive(raw: string | undefined, what: string): number | undefined {
  const value = optionalNumber(raw, what);
  if (value === undefined) return undefined;
  if (!(value > 0)) throw new PlanError(`${what} must be positive`);
  return value;
}

function takeSpawn(el: XmlNode, matrix: Mat, collect: Collect): void {
  const id = requireId(el, "spawn");
  if (collect.spawnIds.has(id)) throw new PlanError(`duplicate spawn id "${id}"`);
  const [sx, sy] = spawnPoint(el, matrix, collect, id);
  collect.spawnIds.add(id);
  collect.spawns.push({
    id,
    position: svgPointToWorld(sx, sy, collect.frame),
    yaw: yawOf(el, matrix, id),
  });
}

/** SVG user-space point of a spawn mark, after the element transform. */
function spawnPoint(el: XmlNode, matrix: Mat, collect: Collect, id: string): [number, number] {
  const name = localName(el.name);
  if (name === "rect") {
    const local = rectBounds(el, collect.frame.meters, collect.units);
    if (!local) throw new PlanError(`spawn "${id}" has no position`);
    return apply(matrix, (local.minX + local.maxX) / 2, (local.minY + local.maxY) / 2);
  }
  if (name === "path") {
    const points = pathPoints(attr(el, "d"), id).map(([x, y]) => apply(matrix, x, y));
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  const anchor = textAnchor(el);
  const x = userLength(firstToken(anchor.x), 0, collect.frame.meters, collect.units);
  const y = userLength(firstToken(anchor.y), 0, collect.frame.meters, collect.units);
  return apply(matrix, x, y);
}

function textAnchor(el: XmlNode): { x?: string; y?: string } {
  const ownX = attr(el, "x");
  const ownY = attr(el, "y");
  if (ownX != null && ownY != null) return { x: ownX, y: ownY };
  const tspan = el.children.find((child) => localName(child.name) === "tspan");
  return {
    x: ownX ?? (tspan ? attr(tspan, "x") : undefined),
    y: ownY ?? (tspan ? attr(tspan, "y") : undefined),
  };
}

function requireId(el: XmlNode, kind: string): string {
  const id = attr(el, "id")?.trim();
  if (!id) throw new PlanError(`${kind} is missing id`);
  if (!ID_RE.test(id)) throw new PlanError(`invalid ${kind} id "${id}"`);
  return id;
}

function firstToken(raw: string | undefined): string | undefined {
  const token = raw?.trim().split(/[\s,]+/)[0];
  return token || undefined;
}

function worldAabb(box: Bounds2, matrix: Mat, frame: PageFrame): XzBounds {
  const corners = [
    apply(matrix, box.minX, box.minY),
    apply(matrix, box.maxX, box.minY),
    apply(matrix, box.minX, box.maxY),
    apply(matrix, box.maxX, box.maxY),
  ].map(([x, y]) => svgPointToWorld(x, y, frame));
  const xs = corners.map((corner) => corner[0]);
  const zs = corners.map((corner) => corner[2]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function optionalNumber(raw: string | undefined, what: string): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new PlanError(`${what} "${raw}" is not a finite number`);
  return value;
}

/** Inclusive. A mark on the rectangle edge is inside. */
function insideBounds(box: XzBounds, x: number, z: number): boolean {
  const eps = 1e-6;
  return x >= box.minX - eps && x <= box.maxX + eps && z >= box.minZ - eps && z <= box.maxZ + eps;
}

const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Endpoints and control points of an SVG path, in the element's local space. */
function pathPoints(raw: string | undefined, id: string, kind = "spawn"): Array<[number, number]> {
  const label = `${kind} "${id}"`;
  const tokens = raw?.match(PATH_TOKEN) ?? [];
  if (tokens.length === 0) throw new PlanError(`${label} has no position`);
  const points: Array<[number, number]> = [];
  let index = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const isCommand = (token: string | undefined): boolean => token != null && /^[A-Za-z]$/.test(token);
  const read = (): number => {
    const token = tokens[index];
    if (token == null || isCommand(token)) throw new PlanError(`${label} has a bad path`);
    index += 1;
    return Number(token);
  };
  const at = (x: number, y: number, ox: number, oy: number, rel: boolean): [number, number] =>
    rel ? [ox + x, oy + y] : [x, y];

  while (index < tokens.length) {
    if (isCommand(tokens[index])) cmd = tokens[index++]!;
    else if (!cmd) throw new PlanError(`${label} has a bad path`);
    const rel = cmd === cmd.toLowerCase();
    const op = cmd.toUpperCase();
    if (op === "Z") {
      cx = sx;
      cy = sy;
      points.push([cx, cy]);
      cmd = "";
      continue;
    }
    if (op === "H") {
      const x = read();
      cx = rel ? cx + x : x;
      points.push([cx, cy]);
      continue;
    }
    if (op === "V") {
      const y = read();
      cy = rel ? cy + y : y;
      points.push([cx, cy]);
      continue;
    }
    if (op === "M" || op === "L" || op === "T") {
      const ox = cx;
      const oy = cy;
      const point = at(read(), read(), ox, oy, rel);
      cx = point[0];
      cy = point[1];
      if (op === "M") {
        sx = cx;
        sy = cy;
        cmd = rel ? "l" : "L";
      }
      points.push(point);
      continue;
    }
    if (op === "C" || op === "S" || op === "Q") {
      const ox = cx;
      const oy = cy;
      const pairs = op === "C" ? 3 : 2;
      let end: [number, number] = [cx, cy];
      for (let pair = 0; pair < pairs; pair += 1) {
        end = at(read(), read(), ox, oy, rel);
        points.push(end);
      }
      cx = end[0];
      cy = end[1];
      continue;
    }
    if (op === "A") {
      read();
      read();
      read();
      read();
      read();
      const ox = cx;
      const oy = cy;
      const end = at(read(), read(), ox, oy, rel);
      points.push(end);
      cx = end[0];
      cy = end[1];
      continue;
    }
    throw new PlanError(`${label} has a bad path`);
  }
  if (points.length === 0) throw new PlanError(`${label} has no position`);
  return points;
}

type Bounds2 = { minX: number; minY: number; maxX: number; maxY: number };

/** Geometry in the element's local space, before its own transform. */
function localBounds(el: XmlNode, meters: number, units: string | undefined, id: string): Bounds2 {
  const box = localName(el.name) === "rect"
    ? rectBounds(el, meters, units)
    : groupBounds(el, meters, units);
  if (!box || box.maxX - box.minX <= 0 || box.maxY - box.minY <= 0) {
    throw new PlanError(`placement "${id}" has no footprint`);
  }
  return box;
}

function rectBounds(el: XmlNode, meters: number, units: string | undefined): Bounds2 | undefined {
  const x = userLength(attr(el, "x"), 0, meters, units);
  const y = userLength(attr(el, "y"), 0, meters, units);
  const width = userLength(attr(el, "width"), Number.NaN, meters, units);
  const height = userLength(attr(el, "height"), Number.NaN, meters, units);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

function groupBounds(el: XmlNode, meters: number, units: string | undefined): Bounds2 | undefined {
  let box: Bounds2 | undefined;
  for (const child of el.children) box = unionBounds(box, mappedBounds(child, ident(), meters, units));
  return box;
}

function mappedBounds(el: XmlNode, parent: Mat, meters: number, units: string | undefined): Bounds2 | undefined {
  const name = localName(el.name);
  if (name === "defs" || name === "metadata" || name === "namedview") return undefined;
  const matrix = mul(parent, parseTransform(attr(el, "transform")));
  if (name === "rect") {
    const raw = rectBounds(el, meters, units);
    return raw ? transformBounds(raw, matrix) : undefined;
  }
  if (name === "path") {
    const raw = attr(el, "d");
    if (raw == null || raw.trim() === "") return undefined;
    const points = pathPoints(raw, attr(el, "id")?.trim() || "path", "path");
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      const [tx, ty] = apply(matrix, x, y);
      if (tx < minX) minX = tx;
      if (ty < minY) minY = ty;
      if (tx > maxX) maxX = tx;
      if (ty > maxY) maxY = ty;
    }
    if (!(maxX > minX) || !(maxY > minY)) return undefined;
    return { minX, minY, maxX, maxY };
  }
  let box: Bounds2 | undefined;
  for (const child of el.children) box = unionBounds(box, mappedBounds(child, matrix, meters, units));
  return box;
}

function transformBounds(box: Bounds2, matrix: Mat): Bounds2 {
  const corners = [
    apply(matrix, box.minX, box.minY),
    apply(matrix, box.maxX, box.minY),
    apply(matrix, box.minX, box.maxY),
    apply(matrix, box.maxX, box.maxY),
  ];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function unionBounds(a: Bounds2 | undefined, b: Bounds2 | undefined): Bounds2 | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function modelFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = label.trim().match(/^model:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
  return match?.[1];
}

function yawOf(el: XmlNode, matrix: Mat, id: string): Yaw {
  const raw = attr(el, "data-yaw");
  if (raw != null && raw.trim() !== "") return snapYaw(parseYawText(raw, id), id);
  return yawFromSvgMatrix(matrix, id);
}

function parseYawText(raw: string, id: string): number {
  const match = raw.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:deg|°)?$/i);
  if (!match) throw new PlanError(`placement "${id}" data-yaw "${raw}" is not a number of degrees`);
  return Number(match[1]);
}

function yawFromSvgMatrix(m: Mat, id: string): Yaw {
  const lenX = Math.hypot(m[0], m[1]);
  const lenY = Math.hypot(m[2], m[3]);
  if (lenX < 1e-9 || lenY < 1e-9) throw new PlanError(`placement "${id}" transform scale is zero`);
  const axisX = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const axisY = (Math.atan2(m[3], m[2]) * 180) / Math.PI;
  let delta = axisY - axisX;
  while (delta <= -180) delta += 360;
  while (delta > 180) delta -= 360;
  if (Math.abs(delta - 90) > 0.5) throw new PlanError(`placement "${id}" transform is not a quarter turn`);
  const dx = m[0] / lenX;
  // Toolbar y decreases as SVG y increases, and world z is toolbar y.
  const dz = -m[1] / lenX;
  const theta = (Math.atan2(-dz, dx) * 180) / Math.PI;
  const yaw = snapYaw(theta, id);
  if (Math.abs(lenX - lenY) > 1e-3 * Math.max(lenX, lenY)) {
    throw new PlanError(`placement "${id}" scale is not uniform`);
  }
  return yaw;
}

function parseTransform(raw: string | undefined): Mat {
  if (!raw || !raw.trim()) return ident();
  const pattern = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let matrix = ident();
  let saw = false;
  for (const match of raw.matchAll(pattern)) {
    saw = true;
    const name = match[1]!.toLowerCase();
    const args = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some((arg) => !Number.isFinite(arg))) throw new PlanError(`invalid transform "${raw}"`);
    matrix = mul(matrix, transformFn(name, args));
  }
  if (!saw) throw new PlanError(`invalid transform "${raw}"`);
  return matrix;
}

function transformFn(name: string, args: number[]): Mat {
  switch (name) {
    case "matrix":
      if (args.length !== 6) throw new PlanError("matrix() needs 6 numbers");
      return [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
    case "translate":
      return [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    case "scale": {
      const sx = args[0] ?? 1;
      const sy = args.length > 1 ? args[1]! : sx;
      return [sx, 0, 0, sy, 0, 0];
    }
    case "rotate": {
      if (args.length !== 1 && args.length !== 3) throw new PlanError("rotate() needs 1 or 3 numbers");
      const [cos, sin] = exactCosSin(args[0]!);
      const rot: Mat = [cos, sin, -sin, cos, 0, 0];
      if (args.length === 1) return rot;
      const cx = args[1]!;
      const cy = args[2]!;
      return mul(mul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
    }
    case "skewx":
      return [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
    case "skewy":
      return [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
    default:
      throw new PlanError(`unsupported transform ${name}`);
  }
}

/** Cardinal degrees use exact 0/±1. `Math.cos(π/2)` is not zero. */
function exactCosSin(degrees: number): [number, number] {
  let wrapped = degrees % 360;
  if (wrapped < 0) wrapped += 360;
  if (Math.abs(wrapped) < 1e-9 || Math.abs(wrapped - 360) < 1e-9) return [1, 0];
  if (Math.abs(wrapped - 90) < 1e-9) return [0, 1];
  if (Math.abs(wrapped - 180) < 1e-9) return [-1, 0];
  if (Math.abs(wrapped - 270) < 1e-9) return [0, -1];
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}
