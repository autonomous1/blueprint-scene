import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeCrateProp } from "../src/crate.ts";
import { PlanError } from "../src/errors.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("one unlabeled texture is on all six faces and the box matches the rectangle", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const png = markedPng(1);
    const svgPath = path.join(dir, "crate.svg");
    const outPath = path.join(dir, "cover-crate.glb");
    writeFileSync(svgPath, page(`
      <rect id="panel" x="1" y="1" width="1.5" height="0.8">
        <image href="${dataUri(png)}" x="1" y="1" width="1.5" height="0.8"/>
      </rect>`));
    writeCrateProp({ svgPath, outPath });
    const collisionPath = path.join(dir, "cover-crate.collision.json");
    const { doc, bin } = readGlb(readFileSync(outPath));
    assert.equal(doc.skins, undefined);
    assert.equal(doc.animations, undefined);
    assert.equal(JSON.stringify(doc).includes("collision"), false);
    assert.deepEqual(doc.meshes?.map((mesh) => mesh.name), ["crate"]);
    assert.equal(doc.nodes?.length, 1);
    assert.equal(doc.nodes?.[0]?.translation, undefined);
    const mesh = doc.meshes?.[0];
    assert.equal(mesh?.primitives?.length, 6);
    let vertices = 0;
    for (const primitive of mesh?.primitives ?? []) {
      const position = doc.accessors?.[primitive.attributes?.POSITION ?? -1];
      assert.equal(position?.count, 4);
      vertices += position?.count ?? 0;
      assert.equal(doc.accessors?.[primitive.indices ?? -1]?.count, 6);
    }
    assert.equal(vertices, 24);
    const faces = facesByNormal(doc, bin);
    assert.deepEqual(Object.keys(faces).sort(), ["back", "bottom", "front", "left", "right", "top"]);
    const embedded = embeddedImages(doc, bin);
    assert.equal(embedded.length, 1);
    assert.equal(Buffer.compare(embedded[0]!, png), 0);
    const frontImage = primitiveImage(doc, bin, faces.front!.primitive);
    for (const name of ["front", "back", "left", "right", "top", "bottom"] as const) {
      assert.equal(Buffer.compare(primitiveImage(doc, bin, faces[name]!.primitive), frontImage), 0);
      assertOutward(faces[name]!.corners, NORMAL[name]);
    }
    const box = bounds(Object.values(faces).flatMap((face) => face.corners.map((corner) => corner.position)));
    assertNear(box.minX, -0.75);
    assertNear(box.maxX, 0.75);
    assertNear(box.minY, 0);
    assertNear(box.maxY, 0.8);
    assertNear(box.minZ, -0.75);
    assertNear(box.maxZ, 0.75);
    expectUv(faces.front!.corners, -0.75, 0, 0.75, 0, 1);
    expectUv(faces.front!.corners, 0.75, 0.8, 0.75, 1, 0);
    const collision = JSON.parse(readFileSync(collisionPath, "utf8")) as {
      id: string;
      origin: number[];
      yawConvention: string;
      boxes: Array<Record<string, number | string>>;
    };
    assert.equal(collision.id, "cover-crate");
    assert.deepEqual(collision.origin, [0, 0, 0]);
    assert.equal(collision.yawConvention, "y-up-90");
    assert.equal(collision.boxes.length, 1);
    assert.equal(collision.boxes[0]!.id, "box");
    assertNear(Number(collision.boxes[0]!.minX), box.minX);
    assertNear(Number(collision.boxes[0]!.maxX), box.maxX);
    assertNear(Number(collision.boxes[0]!.minY), box.minY);
    assertNear(Number(collision.boxes[0]!.maxY), box.maxY);
    assertNear(Number(collision.boxes[0]!.minZ), box.minZ);
    assertNear(Number(collision.boxes[0]!.maxZ), box.maxZ);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data-depth sets the unlabeled depth and a file texture is embedded", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const png = markedPng(2);
    const svgPath = path.join(dir, "crate.svg");
    writeFileSync(path.join(dir, "face.png"), png);
    writeFileSync(svgPath, page(`
      <rect id="panel" x="0" y="0" width="1.5" height="0.8" data-depth="0.4" data-texture="face.png"/>`));
    const outPath = path.join(dir, "crate.glb");
    writeCrateProp({ svgPath, outPath });
    const { doc, bin } = readGlb(readFileSync(outPath));
    const box = bounds(meshCorners(doc, bin, "crate").map((corner) => corner.position));
    assertNear(box.minX, -0.75);
    assertNear(box.maxX, 0.75);
    assertNear(box.minY, 0);
    assertNear(box.maxY, 0.8);
    assertNear(box.minZ, -0.2);
    assertNear(box.maxZ, 0.2);
    assert.equal(Buffer.compare(embeddedImages(doc, bin)[0]!, png), 0);
    const collision = JSON.parse(readFileSync(path.join(dir, "crate.collision.json"), "utf8")) as {
      boxes: Array<Record<string, number>>;
    };
    assert.deepEqual(collision.boxes[0], {
      id: "box",
      minX: -0.75,
      maxX: 0.75,
      minY: 0,
      maxY: 0.8,
      minZ: -0.2,
      maxZ: 0.2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("front, top, and right are copied onto the opposite faces", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const frontPng = markedPng(11);
    const rightPng = markedPng(22);
    const topPng = markedPng(33);
    const svgPath = path.join(dir, "crate.svg");
    const outPath = path.join(dir, "props", "cover-crate.glb");
    writeFileSync(svgPath, page(`
      <rect id="face-front" data-face="Front" x="0" y="0" width="2" height="1" data-texture="${dataUri(frontPng)}"/>
      <rect id="side" inkscape:label="right" x="3" y="0" width="0.5" height="1">
        <image href="${dataUri(rightPng)}" x="3" y="0" width="0.5" height="1"/>
      </rect>
      <image id="top" x="0" y="2" width="2" height="0.5" xlink:href="${dataUri(topPng)}"/>`));
    writeCrateProp({ svgPath, outPath });
    const { doc, bin } = readGlb(readFileSync(outPath));
    const faces = facesByNormal(doc, bin);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.front!.primitive), frontPng), 0);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.back!.primitive), frontPng), 0);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.right!.primitive), rightPng), 0);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.left!.primitive), rightPng), 0);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.top!.primitive), topPng), 0);
    assert.equal(Buffer.compare(primitiveImage(doc, bin, faces.bottom!.primitive), topPng), 0);
    assert.equal(embeddedImages(doc, bin).length, 3);
    const box = bounds(Object.values(faces).flatMap((face) => face.corners.map((corner) => corner.position)));
    assertNear(box.minX, -1);
    assertNear(box.maxX, 1);
    assertNear(box.minY, 0);
    assertNear(box.maxY, 1);
    assertNear(box.minZ, -0.25);
    assertNear(box.maxZ, 0.25);
    expectUv(faces.back!.corners, 1, 0, -0.25, 0, 1);
    expectUv(faces.back!.corners, -1, 1, -0.25, 1, 0);
    expectUv(faces.right!.corners, 1, 0, 0.25, 0, 1);
    expectUv(faces.right!.corners, 1, 1, -0.25, 1, 0);
    expectUv(faces.left!.corners, -1, 0, -0.25, 0, 1);
    expectUv(faces.left!.corners, -1, 1, 0.25, 1, 0);
    expectUv(faces.top!.corners, -1, 1, -0.25, 0, 0);
    expectUv(faces.top!.corners, 1, 1, 0.25, 1, 1);
    expectUv(faces.bottom!.corners, 1, 0, -0.25, 0, 0);
    expectUv(faces.bottom!.corners, -1, 0, 0.25, 1, 1);
    for (const name of ["front", "back", "left", "right", "top", "bottom"] as const) {
      assertOutward(faces[name]!.corners, NORMAL[name]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shared edge that disagrees fails and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const svgPath = path.join(dir, "crate.svg");
    const outPath = path.join(dir, "cover-crate.glb");
    writeFileSync(svgPath, page(`
      <rect id="front" data-face="front" x="0" y="0" width="2" height="1" data-texture="${dataUri(markedPng(1))}"/>
      <rect id="right" data-face="right" x="3" y="0" width="0.5" height="0.9" data-texture="${dataUri(markedPng(2))}"/>
      <rect id="top" data-face="top" x="0" y="2" width="2" height="0.5" data-texture="${dataUri(markedPng(3))}"/>`));
    assert.throws(
      () => writeCrateProp({ svgPath, outPath }),
      (err: unknown) => err instanceof PlanError && /crate face "right" height/.test((err as Error).message),
    );
    assert.equal(existsSync(outPath), false);
    assert.equal(existsSync(path.join(dir, "cover-crate.collision.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("labeled faces without a front fail and write nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const svgPath = path.join(dir, "crate.svg");
    const outPath = path.join(dir, "cover-crate.glb");
    writeFileSync(svgPath, page(`
      <rect id="right" data-face="right" x="0" y="0" width="0.5" height="1" data-texture="${dataUri(markedPng(1))}"/>
      <rect id="top" data-face="top" x="1" y="0" width="2" height="0.5" data-texture="${dataUri(markedPng(2))}"/>`));
    assert.throws(
      () => writeCrateProp({ svgPath, outPath }),
      (err: unknown) => err instanceof PlanError && /missing front/.test((err as Error).message),
    );
    assert.equal(existsSync(outPath), false);
    assert.equal(existsSync(path.join(dir, "cover-crate.collision.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prop --shape crate writes the glb and the collision file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-crate-"));
  try {
    const svgPath = path.join(dir, "crate.svg");
    const outPath = path.join(dir, "props", "cover-crate.glb");
    writeFileSync(svgPath, page(`
      <rect id="panel" x="0" y="0" width="1.5" height="0.8" data-texture="${dataUri(markedPng(4))}"/>`));
    const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
    const cli = spawnSync(bin, ["prop", "--shape", "crate", "--svg", svgPath, "--out", outPath], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.ok(cli.stdout.includes(`wrote ${outPath}`), cli.stdout);
    assert.ok(cli.stdout.includes(`wrote ${path.join(dir, "props", "cover-crate.collision.json")}`), cli.stdout);
    const { doc } = readGlb(readFileSync(outPath));
    assert.deepEqual(doc.meshes?.map((mesh) => mesh.name), ["crate"]);
    const unknown = spawnSync(bin, ["prop", "--shape", "tripo", "--svg", svgPath, "--out", outPath], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown prop shape "tripo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NORMAL = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
} as const;

function page(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="10mm" height="10mm" viewBox="0 0 10 10">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  <g inkscape:groupmode="layer" inkscape:label="crate-design">
    ${body}
  </g>
</svg>`;
}

function markedPng(mark: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes[20] = mark;
  return bytes;
}

function dataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function assertNear(got: number, expected: number): void {
  assert.ok(Math.abs(got - expected) < 1e-4, `${got} !== ${expected}`);
}

type GlbNode = { name?: string; translation?: unknown; mesh?: number };
type GlbPrimitive = { attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number }; indices?: number; material?: number };
type GlbDoc = {
  skins?: unknown;
  animations?: unknown;
  nodes?: GlbNode[];
  meshes?: Array<{ name?: string; primitives?: GlbPrimitive[] }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }>;
  images?: Array<{ bufferView?: number }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};
type Corner = { position: number[]; normal: number[]; uv?: number[] };

function readGlb(bytes: Buffer): { doc: GlbDoc; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GlbDoc;
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  return { doc, bin: bytes.subarray(binAt + 8, binAt + 8 + binLength) };
}

function meshCorners(doc: GlbDoc, bin: Uint8Array, name: string): Corner[] {
  const mesh = doc.meshes?.find((item) => item.name === name);
  if (!mesh) throw new Error(`missing mesh ${name}`);
  return (mesh.primitives ?? []).flatMap((primitive) => readCorners(doc, bin, primitive));
}

function facesByNormal(doc: GlbDoc, bin: Uint8Array): Record<string, { primitive: GlbPrimitive; corners: Corner[] }> {
  const mesh = doc.meshes?.find((item) => item.name === "crate");
  if (!mesh) throw new Error("missing crate");
  const found: Record<string, { primitive: GlbPrimitive; corners: Corner[] }> = {};
  for (const primitive of mesh.primitives ?? []) {
    const corners = readCorners(doc, bin, primitive);
    const normal = corners[0]?.normal;
    if (!normal) throw new Error("missing normal");
    const name = (Object.keys(NORMAL) as Array<keyof typeof NORMAL>).find((face) => dot(normal, NORMAL[face]) > 0.9);
    if (!name) throw new Error(`normal ${normal}`);
    if (found[name]) throw new Error(`duplicate ${name}`);
    found[name] = { primitive, corners };
  }
  return found;
}

function readCorners(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Corner[] {
  const positionAttr = primitive.attributes?.POSITION;
  const normalAttr = primitive.attributes?.NORMAL;
  const indexAttr = primitive.indices;
  if (positionAttr == null || normalAttr == null || indexAttr == null) throw new Error("primitive is missing attributes");
  const position = readAccessor(doc, bin, positionAttr);
  const normal = readAccessor(doc, bin, normalAttr);
  const uvAttr = primitive.attributes?.TEXCOORD_0;
  const uv = uvAttr == null ? undefined : readAccessor(doc, bin, uvAttr);
  return readAccessor(doc, bin, indexAttr).map((index) => ({
    position: position.slice(index * 3, index * 3 + 3),
    normal: normal.slice(index * 3, index * 3 + 3),
    ...(uv ? { uv: uv.slice(index * 2, index * 2 + 2) } : {}),
  }));
}

function readAccessor(doc: GlbDoc, bin: Uint8Array, index: number): number[] {
  const accessor = doc.accessors?.[index];
  const bufferView = accessor?.bufferView == null ? undefined : doc.bufferViews?.[accessor.bufferView];
  if (!accessor || !bufferView) throw new Error(`missing accessor ${index}`);
  const components = accessor.type === "VEC3" ? 3 : accessor.type === "VEC2" ? 2 : accessor.type === "SCALAR" ? 1 : 0;
  if (components === 0) throw new Error(`accessor type ${accessor.type}`);
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    for (let component = 0; component < components; component += 1) {
      const at = base + (vertex * components + component) * 4;
      out.push(accessor.componentType === 5126 ? view.getFloat32(at, true) : view.getUint32(at, true));
    }
  }
  return out;
}

function primitiveImage(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Buffer {
  const material = doc.materials?.[primitive.material ?? -1];
  const index = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (index == null) throw new Error("primitive has no texture");
  const images = embeddedImages(doc, bin);
  const image = images[index];
  if (!image) throw new Error(`missing image ${index}`);
  return image;
}

function embeddedImages(doc: GlbDoc, bin: Uint8Array): Buffer[] {
  return (doc.images ?? []).map((image) => {
    const bufferView = doc.bufferViews?.[image.bufferView ?? -1];
    if (!bufferView) throw new Error("missing image");
    const start = bufferView.byteOffset ?? 0;
    return Buffer.from(bin.subarray(start, start + bufferView.byteLength));
  });
}

function bounds(points: number[][]): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, y, z] of points) {
    if (x! < box.minX) box.minX = x!;
    if (x! > box.maxX) box.maxX = x!;
    if (y! < box.minY) box.minY = y!;
    if (y! > box.maxY) box.maxY = y!;
    if (z! < box.minZ) box.minZ = z!;
    if (z! > box.maxZ) box.maxZ = z!;
  }
  return box;
}

function expectUv(corners: Corner[], x: number, y: number, z: number, u: number, v: number): void {
  const hits = corners.filter((corner) =>
    Math.abs(corner.position[0]! - x) < 1e-4
    && Math.abs(corner.position[1]! - y) < 1e-4
    && Math.abs(corner.position[2]! - z) < 1e-4);
  assert.ok(hits.length > 0, `no corner at ${x}, ${y}, ${z}`);
  for (const hit of hits) {
    assert.ok(hit.uv, `missing uv at ${x}, ${y}, ${z}`);
    assert.ok(Math.abs(hit.uv[0]! - u) < 1e-4, `u ${hit.uv[0]}`);
    assert.ok(Math.abs(hit.uv[1]! - v) < 1e-4, `v ${hit.uv[1]}`);
  }
}

function assertOutward(corners: Corner[], expected: readonly number[]): void {
  const [a, b, c] = corners;
  if (!a || !b || !c) throw new Error("face is missing a triangle");
  const ab = [b.position[0]! - a.position[0]!, b.position[1]! - a.position[1]!, b.position[2]! - a.position[2]!];
  const ac = [c.position[0]! - a.position[0]!, c.position[1]! - a.position[1]!, c.position[2]! - a.position[2]!];
  const wound = [
    ab[1]! * ac[2]! - ab[2]! * ac[1]!,
    ab[2]! * ac[0]! - ab[0]! * ac[2]!,
    ab[0]! * ac[1]! - ab[1]! * ac[0]!,
  ];
  assert.ok(dot(wound, expected) > 0.9, `winding ${wound}`);
  for (const corner of corners) assert.ok(dot(corner.normal, expected) > 0.9, `normal ${corner.normal}`);
}

function dot(a: readonly number[], b: readonly number[]): number {
  const length = Math.hypot(a[0]!, a[1]!, a[2]!);
  return (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / length;
}
