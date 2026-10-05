import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlanError } from "./errors.ts";
import { writeMeshesGlb, type NamedMesh } from "./glb-write.ts";
import { readDesignRects, type DesignRect } from "./plan.ts";
import type { Vec3 } from "./types.ts";

export type DoorPropOptions = {
  svgPath: string;
  outPath: string;
};

/** The frame does not swing. Its depth is the wall thickness of the ring. */
export const FRAME_DEPTH_M = 0.12;

/** The panel is thinner than the frame and sits against the back of the ring. */
export const DOOR_LEAF_DEPTH_M = 0.08;

const EDGE_EPS = 1e-3;

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type HingeSide = "left" | "right";

/**
 * One GLB from an Inkscape `door-design` layer.
 * Part ids are `data-part-frame`, `data-part-door`, `data-part-hinge`,
 * and `data-part-texture`.
 * The frame is four boxes, the outer rectangle minus the door, parented
 * under a node named `frame`. That node does not swing. Depth is 0.12 m.
 * `door` is the panel. Its origin is the hinge edge, midway up, on the
 * back of the frame (z = 0). The panel extends toward +Z, the outward face.
 *
 * A left hinge occupies x 0..width. A right hinge occupies x −width..0.
 * Check, left hinge, door 1 m by 2.1 m inside a 1.2 m by 2.4 m frame: the
 * back hinge edge is x = 0, y = ±1.05, z = 0. The left stile is x −0.1..0.
 * The texture image is the full face. Each frame piece samples the strip
 * of that image it covers, so the left stile reads the left edge. The door
 * front and back sample only the door rectangle. V = 0 is the top of the PNG.
 */
export function writeDoorProp(options: DoorPropOptions): void {
  const svgText = readSvg(options.svgPath);
  const design = readDoorDesign(svgText);
  const image = loadTexture(options.svgPath, design.textureHref);
  const bytes = writeMeshesGlb(doorMeshes(design, image));
  mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  writeFileSync(options.outPath, bytes);
}

type DoorDesign = {
  frame: Rect;
  door: Rect;
  hinge: HingeSide;
  /** Image rectangle in elevation meters. Absent when the design has no texture. */
  texture?: Rect;
  textureHref?: string;
};

function readSvg(svgPath: string): string {
  try {
    return readFileSync(svgPath, "utf8");
  } catch {
    throw new PlanError(`could not read "${svgPath}"`);
  }
}

function readDoorDesign(svgText: string): DoorDesign {
  const rects = readDesignRects(svgText, "door-design");
  const frame = requirePart(rects, "frame");
  const door = requirePart(rects, "door");
  const hinge = requirePart(rects, "hinge");
  const texture = onePart(rects, "texture");
  if (!inside(door, frame)) throw new PlanError("door is outside the frame");
  const frameArea = (frame.maxX - frame.minX) * (frame.maxY - frame.minY);
  const doorArea = (door.maxX - door.minX) * (door.maxY - door.minY);
  if (doorArea >= frameArea - 1e-6) throw new PlanError("door fills the frame; the frame needs a border");
  if (texture && !overlaps(door, texture)) throw new PlanError("door texture does not cover the door");
  return {
    frame,
    door,
    hinge: hingeSide(door, hinge),
    ...(texture ? { texture, textureHref: texture.href } : {}),
  };
}

function onePart(rects: DesignRect[], part: string): DesignRect | undefined {
  const found = rects.filter((rect) => rect.part === part);
  if (found.length > 1) throw new PlanError(`door-design layer has more than one data-part-${part}`);
  return found[0];
}

function requirePart(rects: DesignRect[], part: string): DesignRect {
  const found = onePart(rects, part);
  if (!found) throw new PlanError(`door-design layer is missing data-part-${part}`);
  return found;
}

function inside(inner: Rect, outer: Rect): boolean {
  return inner.minX >= outer.minX - EDGE_EPS
    && inner.maxX <= outer.maxX + EDGE_EPS
    && inner.minY >= outer.minY - EDGE_EPS
    && inner.maxY <= outer.maxY + EDGE_EPS;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX - 1e-6 && a.maxX > b.minX + 1e-6 && a.minY < b.maxY - 1e-6 && a.maxY > b.minY + 1e-6;
}

/**
 * The mark's center has to sit on the door's left or right edge, within
 * half the mark. A mark nearer the top or bottom, or in the middle, fails.
 */
function hingeSide(door: Rect, mark: Rect): HingeSide {
  const cx = (mark.minX + mark.maxX) / 2;
  const cy = (mark.minY + mark.maxY) / 2;
  const distLeft = Math.abs(cx - door.minX);
  const distRight = Math.abs(cx - door.maxX);
  const distBottom = Math.abs(cy - door.minY);
  const distTop = Math.abs(cy - door.maxY);
  const halfWidth = (mark.maxX - mark.minX) / 2;
  const overlapsY = mark.maxY >= door.minY - EDGE_EPS && mark.minY <= door.maxY + EDGE_EPS;
  const onLeft = overlapsY && distLeft <= halfWidth + EDGE_EPS && distLeft + EDGE_EPS < distRight;
  const onRight = overlapsY && distRight <= halfWidth + EDGE_EPS && distRight + EDGE_EPS < distLeft;
  const sideDist = onLeft ? distLeft : distRight;
  const endDist = Math.min(distBottom, distTop);
  if (onLeft === onRight || endDist + EDGE_EPS < sideDist) throw new PlanError("hinge is not on an edge");
  return onLeft ? "left" : "right";
}

const TEXTURE_ID = "data-part-texture";

function loadTexture(svgPath: string, href: string | undefined): Uint8Array | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (value.startsWith("data:")) return pngFromDataUri(value);
  return readPng(path.resolve(path.dirname(svgPath), value), TEXTURE_ID);
}

function pngFromDataUri(value: string): Uint8Array {
  const comma = value.indexOf(",");
  const header = comma >= 0 ? value.slice(0, comma) : value;
  const payload = comma >= 0 ? value.slice(comma + 1) : "";
  if (!/^data:image\/png\b/i.test(header) || !/;base64\b/i.test(header)) {
    throw new PlanError(`door texture "${TEXTURE_ID}" is not a png`);
  }
  return assertPng(Buffer.from(payload.replace(/\s+/g, ""), "base64"));
}

function readPng(file: string, label: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new PlanError(`door texture "${label}" could not be read`);
  }
  return assertPng(bytes);
}

function assertPng(bytes: Uint8Array): Uint8Array {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.length < 8 || head[0] !== 0x89 || head.toString("ascii", 1, 4) !== "PNG") {
    throw new PlanError(`door texture "${TEXTURE_ID}" is not a png`);
  }
  return new Uint8Array(bytes);
}

function doorMeshes(design: DoorDesign, image: Uint8Array | undefined): NamedMesh[] {
  const hingeX = design.hinge === "left" ? design.door.minX : design.door.maxX;
  const hingeY = (design.door.minY + design.door.maxY) / 2;
  const toModel = (elevX: number, elevY: number, z: number): Vec3 => [elevX - hingeX, elevY - hingeY, z];
  const texture = design.texture;
  const uvAt = texture && image
    ? (position: Vec3) => placedUv(position, hingeX, hingeY, texture)
    : undefined;
  const door = boxParts(
    toModel(design.door.minX, design.door.minY, 0),
    toModel(design.door.maxX, design.door.maxY, DOOR_LEAF_DEPTH_M),
    uvAt,
  );
  const bars = frameBars(design.frame, design.door);
  if (bars.length === 0) throw new PlanError("frame has no border");
  const frame = bars.map((bar): NamedMesh => {
    const parts = boxParts(
      toModel(bar.minX, bar.minY, 0),
      toModel(bar.maxX, bar.maxY, FRAME_DEPTH_M),
      uvAt,
    );
    return {
      name: bar.name,
      parent: "frame",
      primitives: [
        { corners: parts.front, ...(image ? { image } : {}) },
        { corners: parts.back, ...(image ? { image } : {}) },
        { corners: parts.edges },
      ],
    };
  });
  return [
    ...frame,
    {
      name: "door",
      primitives: [
        { corners: door.front, ...(image ? { image } : {}) },
        { corners: door.back, ...(image ? { image } : {}) },
        { corners: door.edges },
      ],
    },
  ];
}

/**
 * Left and right stiles run the full frame height. The rails sit between
 * them, so the four boxes leave a hole the size of the door.
 */
function frameBars(frame: Rect, door: Rect): Array<Rect & { name: string }> {
  const bars = [
    { name: "frame-left", minX: frame.minX, maxX: door.minX, minY: frame.minY, maxY: frame.maxY },
    { name: "frame-right", minX: door.maxX, maxX: frame.maxX, minY: frame.minY, maxY: frame.maxY },
    { name: "frame-bottom", minX: door.minX, maxX: door.maxX, minY: frame.minY, maxY: door.minY },
    { name: "frame-top", minX: door.minX, maxX: door.maxX, minY: door.maxY, maxY: frame.maxY },
  ];
  return bars.filter((bar) => bar.maxX - bar.minX > 1e-6 && bar.maxY - bar.minY > 1e-6);
}

/**
 * The image element is the full face. U = 0 is the left of that image and
 * V = 0 is its top. A frame piece uses the strip it covers: the left stile
 * stays on the left edge, and the door front and back use only the door
 * rectangle. The back uses the same map. A left hinge is not mirrored.
 */
function placedUv(position: Vec3, hingeX: number, hingeY: number, image: Rect): [number, number] {
  const elevX = position[0] + hingeX;
  const elevY = position[1] + hingeY;
  return [
    (elevX - image.minX) / (image.maxX - image.minX),
    (image.maxY - elevY) / (image.maxY - image.minY),
  ];
}

function boxParts(
  min: Vec3,
  max: Vec3,
  uvAt?: (position: Vec3) => [number, number],
): { front: DoorCorner[]; back: DoorCorner[]; edges: DoorCorner[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    front: quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], uvAt),
    back: quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], uvAt),
    edges: [
      ...quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]),
      ...quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]),
      ...quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]),
      ...quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]),
    ],
  };
}

function quad(
  corners: [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  uvAt?: (position: Vec3) => [number, number],
): DoorCorner[] {
  const at = (index: 0 | 1 | 2 | 3): DoorCorner => {
    const position = corners[index];
    const uv = uvAt?.(position);
    return uv ? { position, normal, uv } : { position, normal };
  };
  return [at(0), at(1), at(2), at(0), at(2), at(3)];
}
