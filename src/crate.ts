import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlanError } from "./errors.ts";
import { writeMeshesGlb, type DoorCorner, type MeshPrimitive, type NamedMesh } from "./glb-write.ts";
import { readLayerShapes, type LayerShape } from "./plan.ts";
import type { Vec3 } from "./types.ts";

export type CratePropOptions = {
  svgPath: string;
  outPath: string;
};

/** Model-space box. Y is included so the AABB matches the mesh. Bake boxes stay XZ-only. */
export type CrateCollisionFile = {
  id: string;
  origin: [number, number, number];
  yawConvention: "y-up-90";
  boxes: [{
    id: "box";
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }];
};

const FACES = ["front", "back", "left", "right", "top", "bottom"] as const;
type Face = (typeof FACES)[number];

/** Shared edges within this many meters are the same length. */
const EDGE_M = 1e-2;

const OPPOSITE: Record<Face, Face> = {
  front: "back",
  back: "front",
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

/**
 * One box from an Inkscape `crate-design` layer. 1 mm = 1 m.
 * The origin is the center of the bottom face, so y = 0 is the floor.
 * Front is +Z, right is +X, top is +Y. Each face is one quad.
 * A missing opposite reuses the given side. Collision is a sibling JSON file,
 * not a property of the GLB.
 */
export function writeCrateProp(options: CratePropOptions): { glbPath: string; collisionPath: string } {
  const svgText = readSvg(options.svgPath);
  const design = readCrateDesign(svgText);
  const images = loadFaces(options.svgPath, design);
  const mesh = crateMesh(design.size, images);
  const glbPath = options.outPath;
  const collisionPath = collisionPathFor(glbPath);
  const collision = collisionFile(path.basename(glbPath, path.extname(glbPath)), design.size);
  const bytes = writeMeshesGlb([mesh]);
  mkdirSync(path.dirname(path.resolve(glbPath)), { recursive: true });
  writeFileSync(glbPath, bytes);
  writeFileSync(collisionPath, `${JSON.stringify(collision, null, 2)}\n`);
  return { glbPath, collisionPath };
}

type Size = { width: number; height: number; depth: number };

type CrateDesign = {
  size: Size;
  /** Face that owns the texture. A copied opposite points at the face that was drawn. */
  source: Record<Face, Face>;
  shapes: Map<Face, LayerShape>;
};

function readSvg(svgPath: string): string {
  try {
    return readFileSync(svgPath, "utf8");
  } catch {
    throw new PlanError(`could not read "${svgPath}"`);
  }
}

function readCrateDesign(svgText: string): CrateDesign {
  const layer = readLayerShapes(svgText, "crate-design");
  if (!layer.found) throw new PlanError("svg has no crate-design layer");
  if (layer.shapes.length === 0) throw new PlanError("crate-design layer has no faces");
  const labeled = new Map<Face, LayerShape>();
  const plain: LayerShape[] = [];
  for (const shape of layer.shapes) {
    const face = faceOf(shape);
    if (!face) {
      plain.push(shape);
      continue;
    }
    if (labeled.has(face)) throw new PlanError(`crate-design layer has more than one "${face}"`);
    labeled.set(face, shape);
  }
  if (labeled.size > 0 && plain.length > 0) {
    throw new PlanError("crate-design layer mixes a labeled face with an unlabeled rectangle");
  }
  if (labeled.size === 0) return unlabeledDesign(plain);
  return labeledDesign(labeled);
}

function unlabeledDesign(shapes: LayerShape[]): CrateDesign {
  if (shapes.length !== 1) throw new PlanError("crate-design layer has more than one unlabeled rectangle");
  const shape = shapes[0]!;
  const width = spanX(shape);
  const height = spanY(shape);
  const depth = shape.depth ?? width;
  const shapesByFace = new Map<Face, LayerShape>([["front", shape]]);
  const source = Object.fromEntries(FACES.map((face) => [face, "front"])) as Record<Face, Face>;
  return { size: { width, height, depth }, source, shapes: shapesByFace };
}

function labeledDesign(faces: Map<Face, LayerShape>): CrateDesign {
  for (const [face, shape] of faces) {
    if (shape.depth != null) throw new PlanError(`data-depth on "${face}" is only for an unlabeled crate`);
  }
  const front = faces.get("front");
  if (!front) throw new PlanError("crate-design layer is missing front");
  const width = spanX(front);
  const height = spanY(front);
  const back = faces.get("back");
  if (back) {
    expectEdge("back", spanX(back), width, "width", "front width");
    expectEdge("back", spanY(back), height, "height", "front height");
  }
  const left = faces.get("left");
  const right = faces.get("right");
  if (!left && !right) throw new PlanError("crate-design layer is missing left and right");
  if (left && right) expectEdge("right", spanX(right), spanX(left), "width", "left width");
  const depth = spanX((left ?? right)!);
  if (left) expectEdge("left", spanY(left), height, "height", "front height");
  if (right) expectEdge("right", spanY(right), height, "height", "front height");
  const top = faces.get("top");
  const bottom = faces.get("bottom");
  if (!top && !bottom) throw new PlanError("crate-design layer is missing top and bottom");
  for (const [face, shape] of [["top", top], ["bottom", bottom]] as const) {
    if (!shape) continue;
    expectEdge(face, spanX(shape), width, "width", "front width");
    expectEdge(face, spanY(shape), depth, "height", "depth");
  }
  const source = Object.fromEntries(FACES.map((face) => {
    const owner: Face = faces.has(face) ? face : OPPOSITE[face];
    return [face, owner];
  })) as Record<Face, Face>;
  return { size: { width, height, depth }, source, shapes: faces };
}

function faceOf(shape: LayerShape): Face | undefined {
  if (shape.face) return requireFace(shape.face, `crate face "${shape.face}"`);
  if (shape.label) return requireFace(shape.label, `crate label "${shape.label}"`);
  return knownFace(shape.id);
}

function requireFace(raw: string, what: string): Face {
  const face = knownFace(raw);
  if (!face) throw new PlanError(`${what} is not front, back, left, right, top, or bottom`);
  return face;
}

function knownFace(raw: string): Face | undefined {
  const name = raw.trim().toLowerCase();
  return (FACES as readonly string[]).includes(name) ? name as Face : undefined;
}

function spanX(shape: LayerShape): number {
  return shape.maxX - shape.minX;
}

function spanY(shape: LayerShape): number {
  return shape.maxY - shape.minY;
}

function expectEdge(face: Face, got: number, expected: number, edge: string, against: string): void {
  if (Math.abs(got - expected) <= EDGE_M) return;
  throw new PlanError(`crate face "${face}" ${edge} ${trimNum(got)} does not match ${against} ${trimNum(expected)}`);
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function loadFaces(svgPath: string, design: CrateDesign): Record<Face, Uint8Array> {
  const loaded = new Map<Face, Uint8Array>();
  const imageOf = (face: Face): Uint8Array => {
    const cached = loaded.get(face);
    if (cached) return cached;
    const shape = design.shapes.get(face);
    if (!shape) throw new PlanError(`crate-design layer is missing ${face}`);
    const bytes = loadTexture(svgPath, shape, face);
    loaded.set(face, bytes);
    return bytes;
  };
  return Object.fromEntries(FACES.map((face) => [face, imageOf(design.source[face])])) as Record<Face, Uint8Array>;
}

function loadTexture(svgPath: string, shape: LayerShape, face: string): Uint8Array {
  const ref = (shape.dataTexture || shape.href || "").trim();
  if (!ref) throw new PlanError(`crate face "${face}" is missing a texture`);
  if (ref.startsWith("data:")) return pngFromDataUri(ref, face);
  return readPng(path.resolve(path.dirname(svgPath), ref), face);
}

function pngFromDataUri(value: string, face: string): Uint8Array {
  const comma = value.indexOf(",");
  const header = comma >= 0 ? value.slice(0, comma) : value;
  const payload = comma >= 0 ? value.slice(comma + 1) : "";
  if (!/^data:image\/png\b/i.test(header) || !/;base64\b/i.test(header)) {
    throw new PlanError(`crate texture "${face}" is not a png`);
  }
  return assertPng(Buffer.from(payload.replace(/\s+/g, ""), "base64"), face);
}

function readPng(file: string, face: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new PlanError(`crate texture "${face}" could not be read`);
  }
  return assertPng(bytes, face);
}

function assertPng(bytes: Uint8Array, face: string): Uint8Array {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.length < 8 || head[0] !== 0x89 || head.toString("ascii", 1, 4) !== "PNG") {
    throw new PlanError(`crate texture "${face}" is not a png`);
  }
  return new Uint8Array(bytes);
}

/**
 * 24 corners, four per face, wound counter-clockwise from outside.
 * U grows toward the viewer's right. V = 0 is the top of the PNG.
 * On the top, V = 0 is the back edge. On the bottom, the viewer's right is −X and V = 0 is the back edge.
 */
function crateMesh(size: Size, images: Record<Face, Uint8Array>): NamedMesh {
  const hx = size.width / 2;
  const hz = size.depth / 2;
  const y1 = size.height;
  const quad = (corners: readonly DoorCorner[], image: Uint8Array): MeshPrimitive => ({
    corners,
    image,
    quads: true,
  });
  const corner = (position: Vec3, normal: Vec3, uv: readonly [number, number]): DoorCorner => ({ position, normal, uv });
  return {
    name: "crate",
    primitives: [
      quad([
        corner([-hx, 0, hz], [0, 0, 1], [0, 1]),
        corner([hx, 0, hz], [0, 0, 1], [1, 1]),
        corner([hx, y1, hz], [0, 0, 1], [1, 0]),
        corner([-hx, y1, hz], [0, 0, 1], [0, 0]),
      ], images.front),
      quad([
        corner([hx, 0, -hz], [0, 0, -1], [0, 1]),
        corner([-hx, 0, -hz], [0, 0, -1], [1, 1]),
        corner([-hx, y1, -hz], [0, 0, -1], [1, 0]),
        corner([hx, y1, -hz], [0, 0, -1], [0, 0]),
      ], images.back),
      quad([
        corner([-hx, 0, -hz], [-1, 0, 0], [0, 1]),
        corner([-hx, 0, hz], [-1, 0, 0], [1, 1]),
        corner([-hx, y1, hz], [-1, 0, 0], [1, 0]),
        corner([-hx, y1, -hz], [-1, 0, 0], [0, 0]),
      ], images.left),
      quad([
        corner([hx, 0, hz], [1, 0, 0], [0, 1]),
        corner([hx, 0, -hz], [1, 0, 0], [1, 1]),
        corner([hx, y1, -hz], [1, 0, 0], [1, 0]),
        corner([hx, y1, hz], [1, 0, 0], [0, 0]),
      ], images.right),
      quad([
        corner([-hx, y1, hz], [0, 1, 0], [0, 1]),
        corner([hx, y1, hz], [0, 1, 0], [1, 1]),
        corner([hx, y1, -hz], [0, 1, 0], [1, 0]),
        corner([-hx, y1, -hz], [0, 1, 0], [0, 0]),
      ], images.top),
      quad([
        corner([hx, 0, hz], [0, -1, 0], [0, 1]),
        corner([-hx, 0, hz], [0, -1, 0], [1, 1]),
        corner([-hx, 0, -hz], [0, -1, 0], [1, 0]),
        corner([hx, 0, -hz], [0, -1, 0], [0, 0]),
      ], images.bottom),
    ],
  };
}

function collisionFile(id: string, size: Size): CrateCollisionFile {
  const hx = round6(size.width / 2);
  const hz = round6(size.depth / 2);
  return {
    id,
    origin: [0, 0, 0],
    yawConvention: "y-up-90",
    boxes: [{
      id: "box",
      minX: -hx,
      maxX: hx,
      minY: 0,
      maxY: round6(size.height),
      minZ: -hz,
      maxZ: hz,
    }],
  };
}

function collisionPathFor(outPath: string): string {
  return path.join(path.dirname(outPath), `${path.basename(outPath, path.extname(outPath))}.collision.json`);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
