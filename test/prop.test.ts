import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { writeDoorProp } from "../src/prop.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "door", "door-design.svg");

test("a 1.2 by 2.4 frame and a 1 by 2.1 left-hinged door are four frame meshes and one door", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-prop-"));
  const outPath = path.join(dir, "door.glb");
  try {
    writeDoorProp({ svgPath: fixture, outPath });
    assert.deepEqual(readdirSync(dir), ["door.glb"]);
    const { doc, bin } = readGlb(readFileSync(outPath));
    assert.equal(doc.skins, undefined);
    assert.equal(doc.animations, undefined);
    assert.equal(JSON.stringify(doc).includes("collision"), false);
    assert.deepEqual(doc.meshes?.map((mesh) => mesh.name), [
      "frame-left", "frame-right", "frame-bottom", "frame-top", "door",
    ]);
    assert.equal(doc.nodes?.find((node) => node.name === "frame")?.mesh, undefined);
    assert.deepEqual(doc.nodes?.[0]?.children, [1, 2, 3, 4]);
    assert.equal(doc.nodes?.find((node) => node.name === "door")?.mesh, 4);
    for (const node of doc.nodes ?? []) {
      assert.equal(node.translation, undefined);
      assert.equal(node.rotation, undefined);
      assert.equal(node.scale, undefined);
    }
    const door = meshCorners(doc, bin, "door");
    const frame = frameCorners(doc, bin);
    const doorBox = bounds(door.map((corner) => corner.position));
    const frameBox = bounds(frame.map((corner) => corner.position));
    assert.ok(Math.abs(doorBox.minX) < 1e-4, `door minX ${doorBox.minX}`);
    assert.ok(Math.abs(doorBox.maxX - 1) < 1e-4, `door maxX ${doorBox.maxX}`);
    assert.ok(Math.abs(doorBox.minY + 1.05) < 1e-4, `door minY ${doorBox.minY}`);
    assert.ok(Math.abs(doorBox.maxY - 1.05) < 1e-4, `door maxY ${doorBox.maxY}`);
    assert.ok(Math.abs(doorBox.minZ) < 1e-4, `door minZ ${doorBox.minZ}`);
    assert.ok(Math.abs(doorBox.maxZ - 0.08) < 1e-4, `door maxZ ${doorBox.maxZ}`);
    const hingeEdge = door.filter((corner) => Math.abs(corner.position[0]!) < 1e-4 && Math.abs(corner.position[2]!) < 1e-4);
    assert.ok(hingeEdge.length >= 2, "origin is not on the hinge edge");
    const hingeYs = hingeEdge.map((corner) => corner.position[1]!);
    const mid = (Math.min(...hingeYs) + Math.max(...hingeYs)) / 2;
    assert.ok(Math.abs(mid) < 1e-4, `hinge midpoint y ${mid}`);
    assert.ok(Math.abs(frameBox.minX + 0.1) < 1e-4, `frame minX ${frameBox.minX}`);
    assert.ok(Math.abs(frameBox.maxX - 1.1) < 1e-4, `frame maxX ${frameBox.maxX}`);
    assert.ok(Math.abs(frameBox.minY + 1.2) < 1e-4, `frame minY ${frameBox.minY}`);
    assert.ok(Math.abs(frameBox.maxY - 1.2) < 1e-4, `frame maxY ${frameBox.maxY}`);
    assert.ok(Math.abs(frameBox.minZ) < 1e-4);
    assert.ok(Math.abs(frameBox.maxZ - 0.12) < 1e-4, `frame maxZ ${frameBox.maxZ}`);
    for (const corner of frame) {
      const [x, y] = corner.position;
      const inHole = x! > 1e-3 && x! < 1 - 1e-3 && y! > -1.05 + 1e-3 && y! < 1.05 - 1e-3;
      assert.equal(inHole, false, `frame vertex in the hole ${x}, ${y}`);
    }

    expectUv(door, 0, -1.05, 0.08, 1 / 12, 0.9375);
    expectUv(door, 1, -1.05, 0.08, 11 / 12, 0.9375);
    expectUv(door, 1, 1.05, 0.08, 11 / 12, 0.0625);
    expectUv(door, 0, 1.05, 0.08, 1 / 12, 0.0625);
    expectUv(door, 0, -1.05, 0, 1 / 12, 0.9375);
    const left = meshCorners(doc, bin, "frame-left");
    expectUv(left, -0.1, -1.2, 0.12, 0, 1);
    expectUv(left, 0, -1.2, 0.12, 1 / 12, 1);
    const doorCenter = { x: 0.5, y: 0 };
    for (const name of ["frame-left", "frame-right", "frame-bottom", "frame-top"]) {
      const box = bounds(meshCorners(doc, bin, name).map((corner) => corner.position));
      const coversDoor = box.minX < doorCenter.x && box.maxX > doorCenter.x && box.minY < doorCenter.y && box.maxY > doorCenter.y;
      assert.equal(coversDoor, false, `${name} covers the door`);
    }
    const front = readFileSync(path.join(path.dirname(fixture), "front.png"));
    const embedded = embeddedImages(doc, bin);
    assert.equal(embedded.length, 1);
    assert.ok(embedded.some((image) => Buffer.compare(image, front) === 0));
    assertFrontWinding(door);

    for (const corner of hingeEdge) {
      const moved = rotY(corner.position, 100);
      assert.ok(Math.abs(moved[0]!) < 1e-4 && Math.abs(moved[2]!) < 1e-4, "hinge edge moved");
    }
    const latch = door.find((corner) =>
      Math.abs(corner.position[0]! - 1) < 1e-4
      && Math.abs(corner.position[1]! + 1.05) < 1e-4
      && Math.abs(corner.position[2]!) < 1e-4);
    assert.ok(latch, "missing latch");
    const swungLatch = rotY(latch.position, 100);
    assert.ok(swungLatch[2]! < -0.9, `latch z ${swungLatch[2]}`);
    const frameCorner = frame.find((corner) => Math.abs(corner.position[0]! + 0.1) < 1e-4 && Math.abs(corner.position[1]! + 1.2) < 1e-4);
    assert.ok(frameCorner, "missing frame corner");
    const swungFrame = rotY(frameCorner.position, 100);
    const movedX = swungFrame[0]! - frameCorner.position[0]!;
    const movedZ = swungFrame[2]! - frameCorner.position[2]!;
    assert.ok(Math.hypot(movedX, movedZ) > 0.05, "frame corner is on the hinge axis");

    const binPath = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
    const cliOut = path.join(dir, "cli.glb");
    const cli = spawnSync(binPath, ["prop", "--shape", "door", "--svg", fixture, "--out", cliOut], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const cliDoc = readGlb(readFileSync(cliOut)).doc;
    assert.deepEqual(cliDoc.meshes?.map((mesh) => mesh.name), [
      "frame-left", "frame-right", "frame-bottom", "frame-top", "door",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hinge that is not on a side edge fails and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-prop-"));
  try {
    const middle = designSvg(`<rect id="data-part-hinge" x="1.55" y="8.7" width="0.1" height="0.2" />`);
    const top = designSvg(`<rect id="data-part-hinge" x="1.55" y="7.65" width="0.1" height="0.2" />`);
    const svgMiddle = path.join(dir, "middle.svg");
    const svgTop = path.join(dir, "top.svg");
    writeFileSync(svgMiddle, middle);
    writeFileSync(svgTop, top);
    const outPath = path.join(dir, "door.glb");
    assert.throws(
      () => writeDoorProp({ svgPath: svgMiddle, outPath }),
      (err: unknown) => err instanceof PlanError && /not on an edge/.test(err.message),
    );
    assert.throws(
      () => writeDoorProp({ svgPath: svgTop, outPath }),
      (err: unknown) => err instanceof PlanError && /not on an edge/.test(err.message),
    );
    assert.equal(readdirSync(dir).includes("door.glb"), false);

    const right = designSvg(`<rect id="data-part-hinge" x="2.05" y="8.7" width="0.1" height="0.2" />`);
    const svgRight = path.join(dir, "right.svg");
    writeFileSync(svgRight, right);
    const rightOut = path.join(dir, "right.glb");
    writeDoorProp({ svgPath: svgRight, outPath: rightOut });
    const { doc, bin } = readGlb(readFileSync(rightOut));
    const box = bounds(meshCorners(doc, bin, "door").map((corner) => corner.position));
    assert.ok(Math.abs(box.minX + 1) < 1e-4, `right minX ${box.minX}`);
    assert.ok(Math.abs(box.maxX) < 1e-4, `right maxX ${box.maxX}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function designSvg(hinge: string): string {
  const source = readFileSync(fixture, "utf8");
  return source.replace(/<rect\s+id="data-part-hinge"[\s\S]*?\/>/, hinge);
}

type GlbNode = {
  name?: string;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
  mesh?: number;
  children?: number[];
};
type GlbDoc = {
  skins?: unknown;
  animations?: unknown;
  nodes?: GlbNode[];
  meshes?: Array<{ name?: string; primitives?: GlbPrimitive[] }>;
  images?: Array<{ bufferView?: number; mimeType?: string }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};
type GlbPrimitive = {
  attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  indices?: number;
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

function frameCorners(doc: GlbDoc, bin: Uint8Array): Corner[] {
  const names = (doc.meshes ?? []).flatMap((mesh) => mesh.name?.startsWith("frame-") ? [mesh.name] : []);
  return names.flatMap((name) => meshCorners(doc, bin, name));
}

function meshCorners(doc: GlbDoc, bin: Uint8Array, name: string): Corner[] {
  const meshIndex = doc.meshes?.findIndex((mesh) => mesh.name === name) ?? -1;
  const mesh = doc.meshes?.[meshIndex];
  if (!mesh || meshIndex < 0) throw new Error(`missing mesh ${name}`);
  const corners: Corner[] = [];
  for (const primitive of mesh.primitives ?? []) corners.push(...readCorners(doc, bin, primitive));
  return corners;
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
  const textured = hits.filter((hit) => hit.uv);
  assert.ok(textured.length > 0, `missing uv at ${x}, ${y}, ${z}`);
  for (const hit of textured) {
    assert.ok(Math.abs(hit.uv![0]! - u) < 1e-4, `u ${hit.uv![0]}`);
    assert.ok(Math.abs(hit.uv![1]! - v) < 1e-4, `v ${hit.uv![1]}`);
  }
}

function assertFrontWinding(corners: Corner[]): void {
  let seen = 0;
  for (let index = 0; index + 2 < corners.length; index += 3) {
    const tri = [corners[index]!, corners[index + 1]!, corners[index + 2]!];
    if (!tri.every((corner) => Math.abs(corner.position[2]! - 0.08) < 1e-4)) continue;
    seen += 1;
    const [a, b, c] = tri.map((corner) => corner.position);
    const ab = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
    const ac = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
    const z = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    assert.ok(z > 0, `front winding ${z}`);
    assert.ok(tri.every((corner) => corner.normal[2]! > 0.9));
  }
  assert.ok(seen >= 2, "front face is missing");
}

/** Three.js rotation.y. +100° sends local +X toward −Z. */
function rotY(position: number[], degrees: number): number[] {
  const radians = degrees * Math.PI / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const [x, y, z] = position;
  return [x! * c + z! * s, y!, -x! * s + z! * c];
}
