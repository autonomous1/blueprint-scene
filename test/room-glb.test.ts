import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { writeRoom } from "../src/room-glb.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FIXTURE = path.join(import.meta.dirname, "fixtures", "rooms", "room-b.svg");
const PNG_NAMES = ["floor.png", "ceiling.png", "long-wall.png", "long-wall-2.png", "short-wall.png", "short-wall-2.png"];

test("room-b glb has the floor, the ceiling, and four inside walls", () => {
  const staged = stage();
  const out = path.join(staged.dir, "room-b.glb");
  try {
    writeRoom({ svgPath: staged.svgPath, outPath: out });
    const { doc, bin } = readGlb(readFileSync(out));
    assert.deepEqual(doc.meshes?.map((mesh) => mesh.name), ["floor", "ceiling", "walls"]);
    assert.equal(doc.samplers?.[0]?.wrapS, 33071);
    for (const node of doc.nodes ?? []) assert.equal(node.translation, undefined);
    const images = embeddedImages(doc, bin);
    assert.equal(images.length, 6);

    const floor = oneQuad(doc, bin, "floor");
    const ceiling = oneQuad(doc, bin, "ceiling");
    const walls = doc.meshes?.find((mesh) => mesh.name === "walls");
    assert.equal(walls?.primitives?.length, 4);
    const front = quadByNormal(doc, bin, walls?.primitives ?? [], [0, 0, -1]);
    const back = quadByNormal(doc, bin, walls?.primitives ?? [], [0, 0, 1]);
    const left = quadByNormal(doc, bin, walls?.primitives ?? [], [1, 0, 0], 12);
    const right = quadByNormal(doc, bin, walls?.primitives ?? [], [-1, 0, 0]);

    assert.equal(imageMark(doc, bin, floor.primitive), 1);
    assert.equal(imageMark(doc, bin, ceiling.primitive), 2);
    assert.equal(imageMark(doc, bin, front.primitive), 3);
    assert.equal(imageMark(doc, bin, right.primitive), 4);
    assert.equal(imageMark(doc, bin, back.primitive), 5);
    assert.equal(imageMark(doc, bin, left.primitive), 6);

    assertAxis(front.corners, 2, 3);
    assertNormal(front.corners, [0, 0, -1]);
    expectUv(front.corners, 3, 3, 3, 0, 0);
    expectUv(front.corners, -3, 0, 3, 1, 1);

    assertAxis(left.corners, 0, -3);
    assertNormal(left.corners, [1, 0, 0]);
    expectUv(left.corners, -3, 3, 3, 0, 0);
    expectUv(left.corners, -3, 0, -3, 1, 1);

    assertAxis(floor.corners, 1, 0);
    assertNormal(floor.corners, [0, 1, 0]);
    expectUv(floor.corners, -3, 0, 3, 0, 0);
    expectUv(floor.corners, 3, 0, -3, 1, 1);

    assertAxis(ceiling.corners, 1, 3);
    assertNormal(ceiling.corners, [0, -1, 0]);
    expectUv(ceiling.corners, -3, 3, 3, 0, 0);

    for (const quad of [floor, ceiling, front, back, left, right]) assertInside(quad.corners);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a reused face keeps its own corners and the source image", () => {
  const staged = stage({
    mutate: (svg) => dropCeiling(dropImage(dropImage(svg, "image17655"), "image17817")),
  });
  const out = path.join(staged.dir, "room-b.glb");
  try {
    writeRoom({ svgPath: staged.svgPath, outPath: out });
    const { doc, bin } = readGlb(readFileSync(out));
    const images = embeddedImages(doc, bin);
    assert.equal(images.length, 3);
    assert.deepEqual(images.map((image) => image[20]).sort((a, b) => a - b), [1, 3, 6]);

    const ceiling = oneQuad(doc, bin, "ceiling");
    const walls = doc.meshes?.find((mesh) => mesh.name === "walls");
    const back = quadByNormal(doc, bin, walls?.primitives ?? [], [0, 0, 1]);
    const right = quadByNormal(doc, bin, walls?.primitives ?? [], [-1, 0, 0]);
    assert.equal(imageMark(doc, bin, ceiling.primitive), 1);
    assert.equal(imageMark(doc, bin, back.primitive), 3);
    assert.equal(imageMark(doc, bin, right.primitive), 6);
    assertNormal(back.corners, [0, 0, 1]);
    expectUv(back.corners, -3, 3, -3, 0, 0);
    assertInside(back.corners);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a rotated floor image fails", () => {
  const staged = stage({ mutate: rotateFloor });
  const out = path.join(staged.dir, "room-b.glb");
  try {
    assert.throws(
      () => writeRoom({ svgPath: staged.svgPath, outPath: out }),
      (err: unknown) => err instanceof PlanError && /floor image must not be rotated/.test(err.message),
    );
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a missing room svg fails with could not read", () => {
  const missing = path.join(tmpdir(), "blueprint-scene-missing-room.svg");
  const out = path.join(tmpdir(), "blueprint-scene-missing-room", "room.glb");
  assert.throws(
    () => writeRoom({ svgPath: missing, outPath: out }),
    (err: unknown) => err instanceof PlanError && err.message === `could not read "${missing}"`,
  );
  assert.equal(existsSync(out), false);
});

test("front and floor jpeg faces stay jpeg and the other four stay png", () => {
  const staged = stage({
    mutate: (svg) => svg
      .replace('xlink:href="floor.png"', 'xlink:href="floor.jpg"')
      .replace('xlink:href="long-wall.png"', 'xlink:href="long-wall.jpg"'),
    skip: ["floor.png", "long-wall.png"],
  });
  const out = path.join(staged.dir, "room-b.glb");
  try {
    writeFileSync(path.join(staged.dir, "floor.jpg"), jpegBytes(1));
    writeFileSync(path.join(staged.dir, "long-wall.jpg"), jpegBytes(3));
    writeRoom({ svgPath: staged.svgPath, outPath: out });
    const { doc, bin } = readGlb(readFileSync(out));
    assert.equal(embeddedImages(doc, bin).length, 6);
    const floor = oneQuad(doc, bin, "floor");
    const ceiling = oneQuad(doc, bin, "ceiling");
    const walls = doc.meshes?.find((mesh) => mesh.name === "walls");
    const front = quadByNormal(doc, bin, walls?.primitives ?? [], [0, 0, -1]);
    const back = quadByNormal(doc, bin, walls?.primitives ?? [], [0, 0, 1]);
    const left = quadByNormal(doc, bin, walls?.primitives ?? [], [1, 0, 0], 12);
    const right = quadByNormal(doc, bin, walls?.primitives ?? [], [-1, 0, 0]);
    assert.equal(primitiveMime(doc, floor.primitive), "image/jpeg");
    assert.equal(primitiveMime(doc, front.primitive), "image/jpeg");
    assert.equal(primitiveMime(doc, ceiling.primitive), "image/png");
    assert.equal(primitiveMime(doc, back.primitive), "image/png");
    assert.equal(primitiveMime(doc, left.primitive), "image/png");
    assert.equal(primitiveMime(doc, right.primitive), "image/png");
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("blueprint-scene room writes the glb under --out", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const staged = stage();
  const outDir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-out-"));
  const out = path.join(outDir, "sub", "room-b.glb");
  try {
    const cli = spawnSync(bin, ["room", "--svg", staged.svgPath, "--out", out], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const json = path.join(outDir, "sub", "room-b.room.json");
    assert.equal(
      cli.stdout,
      `room room-b: 6\u00d76\u00d73 m, 1 doors, 0 windows, 0 openings, 0 holes, 2 props, 0 lights\nwrote ${out}\nwrote ${json}\n`,
    );
    assert.equal(existsSync(out), true);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

function stage(options?: { mutate?: (svg: string) => string; skip?: string[] }): { dir: string; svgPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svgPath = path.join(dir, "room-b.svg");
  let svg = readFileSync(FIXTURE, "utf8");
  if (options?.mutate) svg = options.mutate(svg);
  writeFileSync(svgPath, svg);
  const skip = new Set(options?.skip ?? []);
  PNG_NAMES.forEach((name, index) => {
    if (!skip.has(name)) writeFileSync(path.join(dir, name), markedPng(index + 1));
  });
  return { dir, svgPath };
}

function dropImage(svg: string, id: string): string {
  const next = svg.replace(new RegExp(`\\s*<image\\b[^>]*\\bid="${id}"[^>]*/>`), "");
  if (next === svg) throw new Error(`fixture image ${id} not found`);
  return next;
}

function dropCeiling(svg: string): string {
  const next = svg.replace(/\s*<g\b[^>]*inkscape:label="ceiling"[\s\S]*?<\/g>/, "");
  if (next === svg) throw new Error("fixture ceiling layer not found");
  return next;
}

function rotateFloor(svg: string): string {
  const next = svg.replace(
    /(id="image17885"[^>]*?)\sx="0"\s*y="291"/,
    `$1 x="-297" y="0" transform="rotate(-90)"`,
  );
  if (next === svg) throw new Error("floor image not found");
  return next;
}

function markedPng(mark: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes[20] = mark;
  return bytes;
}

function jpegBytes(mark: number): Buffer {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  bytes[12] = mark;
  return bytes;
}

function assertNear(got: number, expected: number): void {
  assert.ok(Math.abs(got - expected) < 1e-4, `${got} !== ${expected}`);
}

type GlbNode = { name?: string; translation?: unknown; mesh?: number };
type GlbPrimitive = {
  attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  indices?: number;
  material?: number;
};
type GlbDoc = {
  nodes?: GlbNode[];
  meshes?: Array<{ name?: string; primitives?: GlbPrimitive[] }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }>;
  textures?: Array<{ source?: number }>;
  samplers?: Array<{ wrapS?: number }>;
  images?: Array<{ mimeType?: string; bufferView?: number }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};
type Corner = { position: number[]; normal: number[]; uv?: number[] };
type Quad = { primitive: GlbPrimitive; corners: Corner[] };

function readGlb(bytes: Buffer): { doc: GlbDoc; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GlbDoc;
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  return { doc, bin: bytes.subarray(binAt + 8, binAt + 8 + binLength) };
}

function oneQuad(doc: GlbDoc, bin: Uint8Array, name: string): Quad {
  const mesh = doc.meshes?.find((item) => item.name === name);
  assert.equal(mesh?.primitives?.length, 1, name);
  const primitive = mesh?.primitives?.[0];
  if (!primitive) throw new Error(`missing ${name}`);
  const corners = readCorners(doc, bin, primitive);
  assert.equal(corners.length, 4, name);
  return { primitive, corners };
}

function quadByNormal(
  doc: GlbDoc,
  bin: Uint8Array,
  primitives: readonly GlbPrimitive[],
  normal: readonly [number, number, number],
  count = 4,
): Quad {
  for (const primitive of primitives) {
    const corners = readCorners(doc, bin, primitive);
    const got = corners[0]?.normal;
    if (!got) continue;
    if (got.every((value, index) => Math.abs(value - normal[index]!) < 1e-4)) {
      assert.equal(corners.length, count);
      return { primitive, corners };
    }
  }
  throw new Error(`missing normal ${normal.join(",")}`);
}

function readCorners(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): Corner[] {
  const positionAttr = primitive.attributes?.POSITION;
  const normalAttr = primitive.attributes?.NORMAL;
  const uvAttr = primitive.attributes?.TEXCOORD_0;
  if (positionAttr == null || normalAttr == null || uvAttr == null) throw new Error("primitive is missing attributes");
  const position = readAccessor(doc, bin, positionAttr);
  const normal = readAccessor(doc, bin, normalAttr);
  const uv = readAccessor(doc, bin, uvAttr);
  const count = (doc.accessors?.[positionAttr]?.count ?? 0);
  const corners: Corner[] = [];
  for (let index = 0; index < count; index += 1) {
    corners.push({
      position: position.slice(index * 3, index * 3 + 3),
      normal: normal.slice(index * 3, index * 3 + 3),
      uv: uv.slice(index * 2, index * 2 + 2),
    });
  }
  return corners;
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

function primitiveMime(doc: GlbDoc, primitive: GlbPrimitive): string | undefined {
  const material = doc.materials?.[primitive.material ?? -1];
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (textureIndex == null) throw new Error("primitive has no texture");
  const source = doc.textures?.[textureIndex]?.source;
  if (source == null) throw new Error("texture has no image");
  return doc.images?.[source]?.mimeType;
}

function imageMark(doc: GlbDoc, bin: Uint8Array, primitive: GlbPrimitive): number {
  const material = doc.materials?.[primitive.material ?? -1];
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (textureIndex == null) throw new Error("primitive has no texture");
  const source = doc.textures?.[textureIndex]?.source;
  if (source == null) throw new Error("texture has no image");
  const image = embeddedImages(doc, bin)[source];
  if (!image) throw new Error(`missing image ${source}`);
  return image[20] ?? -1;
}

function embeddedImages(doc: GlbDoc, bin: Uint8Array): Buffer[] {
  return (doc.images ?? []).map((image) => {
    const bufferView = doc.bufferViews?.[image.bufferView ?? -1];
    if (!bufferView) throw new Error("missing image");
    const start = bufferView.byteOffset ?? 0;
    return Buffer.from(bin.subarray(start, start + bufferView.byteLength));
  });
}

function assertAxis(corners: Corner[], axis: 0 | 1 | 2, value: number): void {
  for (const corner of corners) assertNear(corner.position[axis]!, value);
}

function assertNormal(corners: Corner[], normal: readonly [number, number, number]): void {
  for (const corner of corners) {
    assertNear(corner.normal[0]!, normal[0]);
    assertNear(corner.normal[1]!, normal[1]);
    assertNear(corner.normal[2]!, normal[2]);
  }
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

function assertInside(corners: Corner[]): void {
  const p0 = corners[0];
  const p1 = corners[1];
  const p2 = corners[2];
  if (!p0 || !p1 || !p2) throw new Error("quad is missing a corner");
  const e1 = [p1.position[0]! - p0.position[0]!, p1.position[1]! - p0.position[1]!, p1.position[2]! - p0.position[2]!];
  const e2 = [p2.position[0]! - p0.position[0]!, p2.position[1]! - p0.position[1]!, p2.position[2]! - p0.position[2]!];
  const cross = [
    e1[1]! * e2[2]! - e1[2]! * e2[1]!,
    e1[2]! * e2[0]! - e1[0]! * e2[2]!,
    e1[0]! * e2[1]! - e1[1]! * e2[0]!,
  ];
  const normal = p0.normal;
  const dot = cross[0]! * normal[0]! + cross[1]! * normal[1]! + cross[2]! * normal[2]!;
  assert.ok(dot > 0, `winding ${dot}`);
}
