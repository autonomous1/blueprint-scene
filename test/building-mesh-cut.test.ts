import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { cutBuildingGlb, extendSkinToFacade, meshProbe, openingInModel } from "../src/building-mesh-cut.ts";
import { readTexturedGlb, type TexturedGlb } from "../src/glb.ts";
import { writeMeshesGlb, writeTexturedGlb, writeTriangleGlb, type MeshPrimitive } from "../src/glb-write.ts";
import type { DoorPlacement, LocalBox, Triangle, Vec3 } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("openingInModel matches the door gap for a yaw-90 scale-30 building", () => {
  const door: DoorPlacement = {
    id: "brutalist-building-2-cbake.door-1-1-9-2-4",
    model: "door-2",
    position: [-23.754711, 2.75, 15.259191],
    yaw: 0,
    hinge: "left",
    size: [1.055523, 2.1, 0.08],
    open: false,
  };
  const box = openingInModel(door, [-20.611524, 0, 0.25919], 90, 30);
  // Local (0, 0, 0) is the face at the hinge. Inward 2 m is +X in this model.
  near(box.minX, -0.5);
  near(box.maxX, -0.5 + 2 / 30);
  near(box.minY, 2.75 / 30);
  near(box.maxY, 4.85 / 30);
  near(box.minZ, (-23.754711 - -20.611524) / 30);
  near(box.maxZ, box.minZ + 1.055523 / 30);
});

test("a skin short of the facade grows to that face and the cut misses it", () => {
  const faceZ = 0.1334;
  const cap = trianglesFromBox([-0.5, 0, faceZ], [0.5, 0.2, faceZ + 1e-4]);
  const skin: LocalBox = {
    minX: -0.2,
    maxX: 0.2,
    minY: 0.02,
    maxY: 0.12,
    minZ: 0.12,
    maxZ: 0.1333,
  };
  const grown = extendSkinToFacade(cap, skin);
  assert.ok(grown.maxZ >= faceZ, `maxZ ${grown.maxZ} did not reach the facade`);
  assert.equal(grown.minX, skin.minX);
  assert.equal(grown.maxX, skin.maxX);
  assert.equal(grown.minY, skin.minY);
  assert.equal(grown.maxY, skin.maxY);
  assert.equal(grown.minZ, skin.minZ);

  const beyond = extendSkinToFacade(trianglesFromBox([-0.5, 0, 0.2], [0.5, 0.2, 0.2001]), skin);
  assert.equal(beyond.maxZ, skin.maxZ);

  const near = trianglesFromBox([-0.5, 0, 0.1483], [0.5, 0.2, 0.1484]);
  const hop = trianglesFromBox([-0.5, 0, 0.1633], [0.5, 0.2, 0.1634]);
  const stopped = extendSkinToFacade([...near, ...hop], skin);
  assert.ok(stopped.maxZ >= 0.1483, `maxZ ${stopped.maxZ}`);
  assert.ok(stopped.maxZ < 0.16, `maxZ ${stopped.maxZ} walked past the reach`);

  const thick: LocalBox = { ...skin, minZ: -0.05 };
  const sliver = extendSkinToFacade(cap, thick);
  assert.ok(sliver.maxZ >= faceZ, `thick maxZ ${sliver.maxZ}`);
  const tooFar = extendSkinToFacade(trianglesFromBox([-0.5, 0, 0.15], [0.5, 0.2, 0.1501]), thick);
  assert.equal(tooFar.maxZ, thick.maxZ);

  const cut = triangles(cutBuildingGlb(writeTriangleGlb("facade", cap), [grown]));
  assert.ok(rayHits(cap, [0, 0.07, -1], [0, 0, 1]) > 0);
  assert.equal(rayHits(cut, [0, 0.07, -1], [0, 0, 1]), 0);
});

test("a textured slab loses the doorway and keeps the corner UV and the image", () => {
  const png = new Uint8Array(PNG);
  const source = slabGlb(png);
  const opening: LocalBox = { minX: -0.5, maxX: 0.5, minY: 0.5, maxY: 1.5, minZ: -1, maxZ: 1 };
  const cut = cutBuildingGlb(source, [opening]);
  const tris = triangles(cut);
  for (const x of [-0.3, 0, 0.3]) {
    for (const y of [0.7, 1, 1.3]) {
      assert.equal(rayHits(tris, [x, y, -2], [0, 0, 1]), 0, `ray through ${x},${y} still hits the slab`);
    }
  }
  assert.ok(rayHits(tris, [2, 1, -2], [0, 0, 1]) > 0, "the wall beside the doorway was removed");
  const doc = readTexturedGlb(cut);
  assert.equal(doc.meshes[0]?.nodeName, "wall");
  assert.deepEqual(doc.images[0]?.bytes, png);
  const corner = doc.meshes.flatMap((mesh) => mesh.primitives).flatMap((primitive) => primitive.vertices)
    .find((vertex) => nearPoint(vertex.position, [5, 0, 0.5]));
  assert.ok(corner?.uv);
  near(corner.uv[0], 1);
  near(corner.uv[1], 1);
  const edge = doc.meshes.flatMap((mesh) => mesh.primitives).flatMap((primitive) => primitive.vertices)
    .find((vertex) => Math.abs(vertex.position[0] - 0.5) < 1e-4 && Math.abs(vertex.position[2] - 0.5) < 1e-4);
  assert.ok(edge?.uv, "the cut did not split the face");
  near(edge.uv[0], (0.5 - -5) / 10);
});

test("two doorway openings are both a clean miss", () => {
  const source = slabGlb(new Uint8Array(PNG));
  const left: LocalBox = { minX: -3, maxX: -1, minY: 0.5, maxY: 2.2, minZ: -1, maxZ: 1 };
  const right: LocalBox = { minX: 1, maxX: 3, minY: 0.5, maxY: 2.2, minZ: -1, maxZ: 1 };
  const cut = cutBuildingGlb(source, [left, right]);
  const tris = triangles(cut);
  assert.equal(rayHits(tris, [-2, 1.2, -2], [0, 0, 1]), 0, "left doorway still hits");
  assert.equal(rayHits(tris, [2, 1.2, -2], [0, 0, 1]), 0, "right doorway still hits");
  assert.ok(rayHits(tris, [0, 1.2, -2], [0, 0, 1]) > 0, "the pier between the doorways was removed");
  assert.ok(rayHits(tris, [-4.2, 1.2, -2], [0, 0, 1]) > 0, "the wall outside the left doorway was removed");
  const probe = meshProbe(source);
  assert.equal(probe.blocks(left, 2, 1), true);
  assert.equal(meshProbe(cut).blocks(left, 2, 1), false);
  assert.equal(meshProbe(cut).blocks(right, 2, 1), false);
});

test("a node translation is applied before the opening is cut", () => {
  const bytes = writeGlb(
    [{
      name: "panel",
      triangles: [[[-1, -1, 0], [1, -1, 0], [1, 1, 0]]],
    }],
    [{ name: "moved", mesh: "panel", translation: [5, 0, 0] }],
  );
  const hole: LocalBox = { minX: 4.7, maxX: 5.3, minY: -0.2, maxY: 0.2, minZ: -1, maxZ: 1 };
  const cut = cutBuildingGlb(bytes, [hole]);
  assert.equal(rayHits(triangles(cut), [5, 0, -1], [0, 0, 1]), 0);
  assert.equal(readTexturedGlb(cut).meshes[0]?.nodeName, "moved");
  const missed = cutBuildingGlb(bytes, [{ minX: -0.2, maxX: 0.2, minY: -0.2, maxY: 0.2, minZ: -1, maxZ: 1 }]);
  assert.equal(rayHits(triangles(missed), [5, 0, -1], [0, 0, 1]), 1);
});

test("KTX2 image bytes and the material extension survive the cut", () => {
  const payload = Uint8Array.of(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 9, 8, 7);
  const doc: TexturedGlb = {
    meshes: [{
      nodeName: "Building",
      meshName: "Cube.002",
      primitives: [{
        material: 0,
        vertices: [
          { position: [0, 0, 0], uv: [0, 0], normal: [0, 0, 1] },
          { position: [1, 0, 0], uv: [1, 0], normal: [0, 0, 1] },
          { position: [0, 1, 0], uv: [0, 1], normal: [0, 0, 1] },
          { position: [4, 0, 0], uv: [0, 0], normal: [0, 0, 1] },
          { position: [5, 0, 0], uv: [1, 0], normal: [0, 0, 1] },
          { position: [4, 1, 0], uv: [0, 1], normal: [0, 0, 1] },
        ],
        indices: [0, 1, 2, 3, 4, 5],
      }],
    }],
    materials: [{
      name: "building-material",
      doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.5 },
      extensions: { KHR_materials_specular: { specularFactor: 0 } },
    }],
    textures: [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ bytes: payload, json: { mimeType: "image/ktx2", name: "building-2" } }],
    samplers: [{ magFilter: 9729, minFilter: 9729 }],
    extensionsUsed: ["KHR_texture_basisu", "KHR_materials_specular"],
  };
  const cut = cutBuildingGlb(writeTexturedGlb(doc), [{ minX: -0.1, maxX: 0.4, minY: -0.1, maxY: 0.4, minZ: -0.2, maxZ: 0.2 }]);
  const back = readTexturedGlb(cut);
  assert.deepEqual(back.images[0]?.bytes, payload);
  assert.equal(back.images[0]?.json.mimeType, "image/ktx2");
  assert.deepEqual(back.extensionsUsed, ["KHR_texture_basisu", "KHR_materials_specular"]);
  assert.equal(back.meshes[0]?.nodeName, "Building");
  assert.equal(back.meshes[0]?.meshName, "Cube.002");
  assert.deepEqual(back.textures[0], doc.textures[0]);
  assert.equal(rayHits(triangles(cut), [0.1, 0.1, -1], [0, 0, 1]), 0);
  assert.equal(rayHits(triangles(cut), [4.2, 0.2, -1], [0, 0, 1]), 1);
});

test("bake writes one cut glb for a shared external door and leaves the source", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-mesh-cut-"));
  const png = new Uint8Array(PNG);
  const source = slabGlb(png);
  const glbPath = path.join(dir, "m.glb");
  writeFileSync(glbPath, source);
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="doors">
      <rect id="front" data-building="m" inkscape:label="model:door-1" x="9" y="9.5" width="2" height="1"/>
    </g>
  </svg>`);
  const result = bake({
    svgPath: svg,
    outPath: path.join(dir, "buildings.placements.json"),
    collisionDir: path.join(dir, "buildings"),
    modelsDir: dir,
  });
  assert.ok(readFileSync(glbPath).equals(Buffer.from(source)));
  assert.ok(result.lines.some((line) => line.endsWith(`${path.sep}m.cut.glb`) || line.endsWith("/m.cut.glb")));
  const door = result.doors.placements[0];
  const building = result.file.placements[0];
  assert.ok(door && building);
  const opening = openingInModel(door, building.position, building.yaw, building.scale);
  const cut = readFileSync(path.join(dir, "m.cut.glb"));
  const center: Vec3 = [
    (opening.minX + opening.maxX) / 2,
    (opening.minY + opening.maxY) / 2,
    (opening.minZ + opening.maxZ) / 2,
  ];
  assert.equal(rayHits(triangles(cut), [center[0], center[1], -2], [0, 0, 1]), 0);
  assert.ok(rayHits(triangles(cut), [center[0] - 3, center[1], -2], [0, 0, 1]) > 0);
  assert.deepEqual(readTexturedGlb(cut).images[0]?.bytes, png);

  const skipped = path.join(dir, "two.svg");
  writeFileSync(skipped, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
      <rect id="other" data-model="m" x="5" y="14" width="10" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="doors">
      <rect id="front" data-building="hall" inkscape:label="model:door-1" x="9" y="9.5" width="2" height="1"/>
    </g>
  </svg>`);
  const before = readFileSync(path.join(dir, "m.cut.glb"));
  const second = bake({
    svgPath: skipped,
    outPath: path.join(dir, "two.placements.json"),
    collisionDir: path.join(dir, "two-buildings"),
    modelsDir: dir,
  });
  assert.ok(second.lines.some((line) => line.includes("external doors are not on every placement")));
  assert.ok(second.lines.some((line) => line === "cut-shared m 0"));
  const restored = readFileSync(path.join(dir, "m.cut.glb"));
  assert.equal(restored.equals(before), false);
  assert.ok(readFileSync(glbPath).equals(Buffer.from(source)));
  assert.ok(rayHits(triangles(restored), [center[0], center[1], -2], [0, 0, 1]) > 0);
  assert.ok(rayHits(triangles(restored), [center[0] - 3, center[1], -2], [0, 0, 1]) > 0);
});

function slabGlb(png: Uint8Array): Uint8Array {
  const x0 = -5, x1 = 5, y0 = 0, y1 = 3, z0 = -0.5, z1 = 0.5;
  const face = (
    corners: ReadonlyArray<readonly [number, number, number, number, number]>,
    normal: Vec3,
  ): MeshPrimitive => ({
    quads: true,
    image: png,
    corners: corners.map(([x, y, z, u, v]) => ({ position: [x, y, z], normal, uv: [u, v] })),
  });
  return writeMeshesGlb([{
    name: "wall",
    primitives: [
      face([[x0, y0, z1, 0, 1], [x1, y0, z1, 1, 1], [x1, y1, z1, 1, 0], [x0, y1, z1, 0, 0]], [0, 0, 1]),
      face([[x1, y0, z0, 0, 1], [x0, y0, z0, 1, 1], [x0, y1, z0, 1, 0], [x1, y1, z0, 0, 0]], [0, 0, -1]),
      face([[x0, y0, z0, 0, 1], [x0, y0, z1, 1, 1], [x0, y1, z1, 1, 0], [x0, y1, z0, 0, 0]], [-1, 0, 0]),
      face([[x1, y0, z1, 0, 1], [x1, y0, z0, 1, 1], [x1, y1, z0, 1, 0], [x1, y1, z1, 0, 0]], [1, 0, 0]),
      face([[x0, y1, z1, 0, 1], [x1, y1, z1, 1, 1], [x1, y1, z0, 1, 0], [x0, y1, z0, 0, 0]], [0, 1, 0]),
      face([[x0, y0, z0, 0, 1], [x1, y0, z0, 1, 1], [x1, y0, z1, 1, 0], [x0, y0, z1, 0, 0]], [0, -1, 0]),
    ],
  }]);
}

function triangles(bytes: Uint8Array): Triangle[] {
  const doc = readTexturedGlb(bytes);
  const out: Triangle[] = [];
  for (const mesh of doc.meshes) {
    for (const primitive of mesh.primitives) {
      for (let index = 0; index < primitive.indices.length; index += 3) {
        const a = primitive.vertices[primitive.indices[index]!]?.position;
        const b = primitive.vertices[primitive.indices[index + 1]!]?.position;
        const c = primitive.vertices[primitive.indices[index + 2]!]?.position;
        if (a && b && c) out.push([a, b, c]);
      }
    }
  }
  return out;
}

/** Möller–Trumbore. A hit is a positive ray parameter through the triangle. */
function rayHits(tris: readonly Triangle[], origin: Vec3, dir: Vec3): number {
  let count = 0;
  for (const [a, b, c] of tris) {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p: Vec3 = [
      dir[1] * ac[2] - dir[2] * ac[1],
      dir[2] * ac[0] - dir[0] * ac[2],
      dir[0] * ac[1] - dir[1] * ac[0],
    ];
    const det = ab[0] * p[0] + ab[1] * p[1] + ab[2] * p[2];
    if (Math.abs(det) < 1e-10) continue;
    const inv = 1 / det;
    const tvec: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const q: Vec3 = [
      tvec[1] * ab[2] - tvec[2] * ab[1],
      tvec[2] * ab[0] - tvec[0] * ab[2],
      tvec[0] * ab[1] - tvec[1] * ab[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const t = (ac[0] * q[0] + ac[1] * q[1] + ac[2] * q[2]) * inv;
    if (t > 1e-6) count += 1;
  }
  return count;
}

function nearPoint(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} expected ${expected}`);
}
