import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { readFloorsSvg } from "../src/floors-svg.ts";
import { defaultFloorImage, HALL_EDGE_INSET_M, insetOutline } from "../src/hall-floor.ts";

import type { DoorPlacement, Obstacle, Placement } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG.slice(PNG.indexOf(",") + 1), "base64");
const WALLS = { blk: trianglesFromBox([-0.5, 0, -0.5], [0.5, 0.6, 0.5]) };
const ARENA_FLOORS = "/home/tim/dev/conveyor-engine-arena/dev/scenes/arena-1/designs/floorplans/brutalist-building-2-cbake.floors.svg";

type RoomSize = { w: number; h: number; minX: number; maxX: number; minZ: number; maxZ: number };

const FULL_DEPTH: RoomSize = { w: 4, h: 10, minX: -2, maxX: 2, minZ: -5, maxZ: 5 };
const CORNER: RoomSize = { w: 4, h: 4, minX: -2, maxX: 2, minZ: -2, maxZ: 2 };

type StageOpts = {
  yaw?: 0 | 90;
  room?: RoomSize;
  /** Markup inside each floor layer, after the footprint and the room rect. */
  floorExtra?: (n: number) => string;
  /** Layers after the floors. */
  extraLayers?: string;
  defs?: string;
};

function stage(opts: StageOpts = {}): { dir: string; svg: string; floors: string; models: string; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-hall-"));
  const floors = path.join(dir, "floors");
  const rooms = path.join(dir, "rooms");
  const models = path.join(dir, "models");
  mkdirSync(floors);
  mkdirSync(rooms);
  mkdirSync(models);
  const room = opts.room ?? FULL_DEPTH;
  writeFileSync(path.join(floors, "blk.floors.svg"), floorsSvg(room, opts));
  writeFileSync(path.join(rooms, "rm.room.json"), roomJson(room));
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, sceneSvg(opts.yaw ?? 0));
  return { dir, svg, floors, models, out: path.join(dir, "out", "buildings.placements.json") };
}

function run(staged: ReturnType<typeof stage>) {
  return bake({
    svgPath: staged.svg,
    outPath: staged.out,
    collisionDir: path.join(staged.dir, "collision"),
    modelsDir: staged.models,
    walls: WALLS,
    floorsDir: staged.floors,
    roomsDir: path.join(staged.dir, "rooms"),
  });
}

function floorsSvg(room: RoomSize, opts: StageOpts): string {
  const floor = (n: number, z: string) => {
    const y = -room.h;
    return `<g inkscape:groupmode="layer" inkscape:label="floor-${n}">
      <g id="fp${n}" data-model="blk" transform="matrix(10,0,0,10,0,0)" ${z}><path d="M 0 0 L 1 0 L 1 -1 L 0 -1 Z"/></g>
      <rect id="r${n}" inkscape:label="model:rm" x="0" y="${y}" width="${room.w}" height="${room.h}"/>
      ${opts.floorExtra?.(n) ?? ""}
    </g>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="20mm" height="20mm" viewBox="0 0 20 20">
  <sodipodi:namedview inkscape:document-units="mm"/>
  ${opts.defs ?? ""}
  ${floor(1, "")}
  ${floor(2, 'z="2.75"')}
  ${opts.extraLayers ?? ""}
</svg>`;
}

function sceneSvg(yaw: 0 | 90): string {
  const yawAttr = yaw === 0 ? "" : ` data-yaw="${yaw}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="40mm" height="40mm" viewBox="0 0 40 40">
  <sodipodi:namedview inkscape:document-units="mm"/>
  <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="yard" x="0" y="0" width="40" height="40"/></g>
  <g inkscape:groupmode="layer" inkscape:label="buildings">
    <rect id="B" data-model="blk" x="5" y="25" width="10" height="10"${yawAttr}/>
  </g>
</svg>`;
}

function roomJson(room: RoomSize): string {
  return JSON.stringify({
    formatVersion: 1,
    units: "meters",
    id: "rm",
    glb: "rm.glb",
    source: "svg",
    footprint: { minX: room.minX, maxX: room.maxX, minZ: room.minZ, maxZ: room.maxZ },
    height: 2.5,
    obstacles: [{
      id: "floor.0",
      minX: room.minX,
      maxX: room.maxX,
      minY: -0.1,
      maxY: 0,
      minZ: room.minZ,
      maxZ: room.maxZ,
    }],
    walkable: [],
    holes: [],
    doors: [],
    props: [],
    lights: [],
  });
}

function patternDefs(): string {
  return `<defs>
    <pattern id="src" patternUnits="userSpaceOnUse" width="100" height="50">
      <image width="100" height="50" xlink:href="${PNG}"/>
    </pattern>
    <pattern id="ref" xlink:href="#src" patternTransform="matrix(0.02,0,0,0.04,1,2)"/>
  </defs>`;
}

function textureLayer(n: number, tile: string): string {
  const tileAttr = tile === "" ? "" : ` data-tile-m="${tile}"`;
  return `<g inkscape:groupmode="layer" inkscape:label="floor-${n}-texture">
    <path id="t${n}" inkscape:label="floor-texture" d="M 0 0 L 10 0 L 10 -10 L 0 -10 Z" style="fill:url(#ref)"${tileAttr}/>
  </g>`;
}

function imageOnFloor(n: number): string {
  return `<image id="img${n}" inkscape:label="floor-texture" href="${PNG}" data-tile-m="4" x="0" y="-10" width="10" height="10"/>`;
}

test("elevated hall gets one slab and a default mesh; the ground floor does not", () => {
  const staged = stage();
  try {
    const result = run(staged);
    const obstacles = result.rooms!.obstacles;
    assert.equal(obstacles.some((item) => item.id.includes("floor-1")), false, ids(obstacles));
    assert.equal(result.rooms!.placements.some((item) => item.id.includes("floor-1")), false);
    assert.equal(existsSync(path.join(staged.models, "blk.floor-1.hall.glb")), false);

    const slab = obstacles.find((item) => item.id === "B.floor-2.slab-0");
    assert.ok(slab, ids(obstacles));
    assert.equal(obstacles.filter((item) => item.id.startsWith("B.floor-2.slab")).length, 1);
    nearBox(slab, { min: [14, 2.65, 10 + HALL_EDGE_INSET_M], max: [20 - HALL_EDGE_INSET_M, 2.75, 20 - HALL_EDGE_INSET_M] });
    assert.equal(covers(slab, [17, 2.7, 15]), true);
    assert.equal(covers(slab, [12, 2.7, 15]), false);

    const roomFloor = obstacles.find((item) => item.id === "B.r2.floor.0");
    assert.ok(roomFloor, ids(obstacles));
    nearBox(roomFloor, { min: [10, 2.65, 10], max: [14, 2.75, 20] });
    assert.equal(obstacles.some((item) => item.id === "B.r1.floor.0"), false);

    const hall = result.rooms!.placements.find((item) => item.id === "B.floor-2.hall");
    assert.ok(hall && isStatic(hall));
    assert.deepEqual(placementOf(hall), {
      id: "B.floor-2.hall",
      model: "blk.floor-2.hall",
      position: [10, 0, 10],
      yaw: 0,
      scale: 1,
    });
    const building = result.file.placements.find((item) => item.id === "B");
    assert.deepEqual(building && { position: building.position, yaw: building.yaw, scale: building.scale }, {
      position: [10, 0, 10],
      yaw: 0,
      scale: 10,
    });

    const glbPath = path.join(staged.models, "blk.floor-2.hall.glb");
    const mesh = readHall(readFileSync(glbPath));
    assert.deepEqual([...mesh.image], [...defaultFloorImage()]);
    assert.equal(mesh.wrapS, 10497);
    assertQuad(mesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 2);
    assertHallMatches(staged, result, mesh);
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false, result.lines.join("\n"));
    assert.equal(result.lines.includes(
      '{"id":"blk.floor-2.hall","kind":"model","type":"floor","instance":"static","uri":"/assets/models/blk.floor-2.hall.glb","mediaType":"model/gltf-binary"}',
    ), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(staged.dir, "out", "rooms.placements.json"), "utf8")), result.rooms);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a floor-texture image is the hall albedo, and a ground-floor texture is not a mesh", () => {
  const staged = stage({ floorExtra: (n) => imageOnFloor(n) });
  try {
    const source = readFloorsSvg(readFileSync(path.join(staged.floors, "blk.floors.svg"), "utf8"), path.join(staged.floors, "blk.floors.svg"));
    assert.equal(source.floors[0]!.texture?.tileX, 4);
    assert.equal(source.floors[1]!.texture?.tileX, 4);
    const result = run(staged);
    assert.equal(existsSync(path.join(staged.models, "blk.floor-1.hall.glb")), false);
    const mesh = readHall(readFileSync(path.join(staged.models, "blk.floor-2.hall.glb")));
    assert.deepEqual([...mesh.image], [...PNG_BYTES]);
    assertQuad(mesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 4);
    assert.equal(result.rooms!.obstacles.some((item) => item.id === "B.floor-2.slab-0"), true);
    assert.equal(result.rooms!.obstacles.some((item) => item.id.includes("floor-1")), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a pattern fill supplies the tile size, and data-tile-m overrides it", () => {
  const staged = stage({
    defs: patternDefs(),
    extraLayers: `${textureLayer(1, "")}${textureLayer(2, "")}`,
  });
  const overridden = stage({
    defs: patternDefs(),
    extraLayers: `${textureLayer(1, "")}${textureLayer(2, "4")}`,
  });
  try {
    const svgPath = path.join(staged.floors, "blk.floors.svg");
    const source = readFloorsSvg(readFileSync(svgPath, "utf8"), svgPath);
    const texture = source.floors[1]!.texture;
    assert.ok(texture);
    assert.ok(Math.abs(texture.tileX - 2) < 1e-6, String(texture.tileX));
    assert.ok(Math.abs(texture.tileZ - 2) < 1e-6, String(texture.tileZ));
    assert.equal(source.floors[0]!.elevation, 0);
    assert.ok(source.floors[0]!.texture);
    run(staged);
    const mesh = readHall(readFileSync(path.join(staged.models, "blk.floor-2.hall.glb")));
    assert.deepEqual([...mesh.image], [...PNG_BYTES]);
    assertQuad(mesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 2);

    const overPath = path.join(overridden.floors, "blk.floors.svg");
    const over = readFloorsSvg(readFileSync(overPath, "utf8"), overPath);
    assert.equal(over.floors[1]!.texture?.tileX, 4);
    assert.equal(over.floors[1]!.texture?.tileZ, 4);
    const baked = run(overridden);
    const bakedMesh = readHall(readFileSync(path.join(overridden.models, "blk.floor-2.hall.glb")));
    assertQuad(bakedMesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 4);
    assert.equal(baked.rooms!.placements.some((item) => item.id === "B.floor-1.hall"), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
    rmSync(overridden.dir, { recursive: true, force: true });
  }
});

test("yaw 90 turns the hall slab with the building and leaves the mesh in building-local space", () => {
  const staged = stage({ yaw: 90 });
  try {
    const result = run(staged);
    const building = result.file.placements.find((item) => item.id === "B");
    assert.deepEqual(building && { position: building.position, yaw: building.yaw, scale: building.scale }, {
      position: [10, 0, 10],
      yaw: 90,
      scale: 10,
    });
    const slab = result.rooms!.obstacles.find((item) => item.id === "B.floor-2.slab-0");
    assert.ok(slab);
    // 90° sends local +X to world −Z and local +Z to world +X.
    // Local hall x 4..9.95, z 0.05..9.95 at building (10, 0, 10) → world x 10.05..19.95, z 0.05..6.
    nearBox(slab, {
      min: [10 + HALL_EDGE_INSET_M, 2.65, HALL_EDGE_INSET_M],
      max: [20 - HALL_EDGE_INSET_M, 2.75, 6],
    });
    assert.equal(covers(slab, [15, 2.7, 3]), true);
    assert.equal(covers(slab, [15, 2.7, 8]), false);
    const hall = result.rooms!.placements.find((item) => item.id === "B.floor-2.hall");
    assert.ok(hall && isStatic(hall));
    assert.deepEqual({ position: hall.position, yaw: hall.yaw, scale: hall.scale }, {
      position: [10, 0, 10],
      yaw: 90,
      scale: 1,
    });
    const mesh = readHall(readFileSync(path.join(staged.models, "blk.floor-2.hall.glb")));
    assertQuad(mesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 2);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a hall that is not one rectangle is several slabs from the same cells as the mesh", () => {
  const staged = stage({ room: CORNER });
  try {
    const result = run(staged);
    const slabs = result.rooms!.obstacles.filter((item) => item.id.startsWith("B.floor-2.slab"));
    assert.deepEqual(slabs.map((item) => item.id), ["B.floor-2.slab-0", "B.floor-2.slab-1"]);
    nearBox(slabs[0]!, { min: [14, 2.65, 10 + HALL_EDGE_INSET_M], max: [20 - HALL_EDGE_INSET_M, 2.75, 14] });
    nearBox(slabs[1]!, { min: [10 + HALL_EDGE_INSET_M, 2.65, 14], max: [20 - HALL_EDGE_INSET_M, 2.75, 20 - HALL_EDGE_INSET_M] });
    assert.equal(covers(slabs[0]!, [17, 2.7, 12]), true);
    assert.equal(covers(slabs[1]!, [12, 2.7, 17]), true);
    assert.equal(slabs.some((item) => covers(item, [12, 2.7, 12])), false);
    const mesh = readHall(readFileSync(path.join(staged.models, "blk.floor-2.hall.glb")));
    assert.equal(mesh.quads.length, 2);
    assertQuad(mesh, { minX: 4, maxX: 10 - HALL_EDGE_INSET_M, minZ: HALL_EDGE_INSET_M, maxZ: 4 }, 2.749, 2, 0);
    assertQuad(mesh, { minX: HALL_EDGE_INSET_M, maxX: 10 - HALL_EDGE_INSET_M, minZ: 4, maxZ: 10 - HALL_EDGE_INSET_M }, 2.749, 2, 1);
    assertHallMatches(staged, result, mesh);
    const roomFloor = result.rooms!.obstacles.find((item) => item.id === "B.r2.floor.0");
    assert.ok(roomFloor);
    nearBox(roomFloor, { min: [10, 2.65, 10], max: [14, 2.75, 14] });
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("rooms that cover the footprint emit no hall slab", () => {
  const staged = stage({
    room: { w: 10, h: 10, minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
  });
  try {
    const result = run(staged);
    assert.equal(result.rooms!.obstacles.some((item) => item.id.includes(".slab")), false);
    assert.equal(result.rooms!.placements.some((item) => item.model.includes(".hall")), false);
    assert.equal(existsSync(path.join(staged.models, "blk.floor-2.hall.glb")), false);
    assert.equal(
      result.lines.includes('hall floor "B.floor-2" covers no area outside rooms; no slab'),
      true,
      result.lines.join("\n"),
    );
    assert.equal(result.lines.some((line) => line.startsWith("warning:")), false);
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("the arena floors pattern is the hall tile, in page metres", () => {
  const source = readFloorsSvg(readFileSync(ARENA_FLOORS, "utf8"), ARENA_FLOORS);
  const width = 341.33333;
  for (const floor of source.floors) {
    const texture = floor.texture;
    assert.ok(texture, `floor-${floor.n}`);
    assert.ok(Math.abs(texture.tileX - width * 0.02500155) < 1e-4, String(texture.tileX));
    assert.ok(Math.abs(texture.tileZ - width * 0.02283606) < 1e-4, String(texture.tileZ));
    assert.equal(texture.image[0], 0x89);
    assert.equal(texture.image[1], 0x50);
    assert.equal(texture.image[2], 0x4e);
    assert.equal(texture.image[3], 0x47);
  }
  assert.equal(source.floors[0]!.elevation <= 0.05, true);
  assert.ok(source.floors[1]!.elevation > 0.05);
  assert.ok(source.floors[2]!.elevation > 0.05);
});

function ids(obstacles: readonly Obstacle[]): string {
  return obstacles.map((item) => item.id).join(",");
}

function covers(obstacle: Obstacle, point: readonly [number, number, number]): boolean {
  const [x, y, z] = point;
  return x > obstacle.min[0] && x < obstacle.max[0]
    && y > obstacle.min[1] && y < obstacle.max[1]
    && z > obstacle.min[2] && z < obstacle.max[2];
}

function nearBox(obstacle: Obstacle, expected: { min: number[]; max: number[] }): void {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(obstacle.min[i]! - expected.min[i]!) < 1e-4, `${obstacle.id} min ${obstacle.min}`);
    assert.ok(Math.abs(obstacle.max[i]! - expected.max[i]!) < 1e-4, `${obstacle.id} max ${obstacle.max}`);
  }
}

function isStatic(item: Placement | DoorPlacement): item is Placement {
  return "scale" in item;
}

function placementOf(item: Placement): { id: string; model: string; position: number[]; yaw: number; scale: number } {
  return { id: item.id, model: item.model, position: [...item.position], yaw: item.yaw, scale: item.scale };
}

type Vec3 = [number, number, number];

type HallQuad = { positions: Vec3[]; uvs: Array<[number, number]> };

type HallMesh = { image: Uint8Array; wrapS: number; quads: HallQuad[] };

type GlbDoc = {
  nodes?: Array<{ name?: string; mesh?: number }>;
  meshes?: Array<{ name?: string; primitives?: Array<{
    attributes?: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
    indices?: number;
    material?: number;
  }> }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: { index?: number } } }>;
  textures?: Array<{ sampler?: number; source?: number }>;
  samplers?: Array<{ wrapS?: number; wrapT?: number }>;
  images?: Array<{ bufferView?: number; mimeType?: string }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
};

function readHall(bytes: Buffer): HallMesh {
  const { doc, bin } = readGlb(bytes);
  const node = doc.nodes?.find((item) => item.name === "floor");
  assert.ok(node, "floor node");
  const mesh = doc.meshes?.[node.mesh ?? -1];
  assert.equal(mesh?.name, "floor");
  const primitive = mesh?.primitives?.[0];
  const positionAttr = primitive?.attributes?.POSITION;
  const normalAttr = primitive?.attributes?.NORMAL;
  const uvAttr = primitive?.attributes?.TEXCOORD_0;
  if (positionAttr == null || normalAttr == null || uvAttr == null || primitive?.indices == null) {
    throw new Error("hall primitive is missing attributes");
  }
  const material = doc.materials?.[primitive.material ?? -1];
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  assert.equal(typeof textureIndex, "number");
  const texture = doc.textures?.[textureIndex ?? -1];
  const wrapS = doc.samplers?.[texture?.sampler ?? -1]?.wrapS;
  assert.equal(wrapS, 10497);
  assert.equal(doc.samplers?.[0]?.wrapS, 33071);
  const imageView = doc.images?.[texture?.source ?? -1]?.bufferView;
  const image = viewBytes(doc, bin, imageView);
  const positions = vecs(doc, bin, positionAttr, 3);
  const normals = vecs(doc, bin, normalAttr, 3);
  const indices = scalars(doc, bin, primitive.indices);
  const uvs = vecs(doc, bin, uvAttr, 2);
  for (const normal of normals) {
    assert.ok(Math.abs(normal[0]!) < 1e-4 && Math.abs(normal[1]! - 1) < 1e-4 && Math.abs(normal[2]!) < 1e-4, String(normal));
  }
  assert.equal(indices.length % 6, 0);
  const quads: HallQuad[] = [];
  for (let q = 0; q < indices.length; q += 6) {
    const corner = (slot: number): Vec3 => {
      const index = indices[q + slot]!;
      const p = positions[index]!;
      return [p[0]!, p[1]!, p[2]!];
    };
    const a = corner(0);
    const b = corner(1);
    const c = corner(2);
    const normal = cross(sub(b, a), sub(c, a));
    assert.ok(normal[1] > 0, `normal ${normal}`);
    assert.ok(Math.abs(normal[0]) < 1e-3 && Math.abs(normal[2]) < 1e-3, `normal ${normal}`);
    const used = [0, 1, 2, 3].map((slot) => indices[q + (slot === 3 ? 5 : slot)]!);
    quads.push({
      positions: used.map((index) => {
        const p = positions[index]!;
        return [p[0]!, p[1]!, p[2]!];
      }),
      uvs: used.map((index) => {
        const uv = uvs[index]!;
        return [uv[0]!, uv[1]!];
      }),
    });
  }
  return { image, wrapS, quads };
}

function assertHallMatches(
  staged: ReturnType<typeof stage>,
  result: ReturnType<typeof run>,
  mesh: HallMesh,
): void {
  const svgPath = path.join(staged.floors, "blk.floors.svg");
  const source = readFloorsSvg(readFileSync(svgPath, "utf8"), svgPath);
  const inset = insetOutline(source.outline);
  const slabs = result.rooms!.obstacles.filter((item) => item.id.startsWith("B.floor-2.slab"));
  const hall = result.places.find((item) => item.id === "B.floor-2.hall");
  assert.ok(hall);
  const slabsArea = slabs.reduce((sum, item) => sum + (item.max[0] - item.min[0]) * (item.max[2] - item.min[2]), 0);
  const hallArea = Math.abs(polygonArea(hall.polygon));
  assert.ok(Math.abs(slabsArea - hallArea) < 1e-6, `slabs ${slabsArea} hall ${hallArea}`);
  let meshArea = 0;
  for (const quad of mesh.quads) {
    const xs = quad.positions.map((position) => position[0]);
    const zs = quad.positions.map((position) => position[2]);
    meshArea += (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
    for (const position of quad.positions) {
      assert.equal(inside(source.outline, position[0], position[2]), true, `vertex ${position}`);
    }
  }
  // Positions are float32 in the GLB, so the triangle area is a few millionths off the slab.
  assert.ok(Math.abs(meshArea - slabsArea) < 1e-4, `mesh ${meshArea} slabs ${slabsArea}`);
  for (const slab of slabs) {
    const corners: Array<[number, number]> = [
      [slab.min[0] - 10, slab.min[2] - 10],
      [slab.max[0] - 10, slab.min[2] - 10],
      [slab.max[0] - 10, slab.max[2] - 10],
      [slab.min[0] - 10, slab.max[2] - 10],
    ];
    for (const [x, z] of corners) {
      assert.equal(insideOrOn(inset, x, z), true, `${slab.id} corner ${x},${z} is outside the inset outline`);
      assert.equal(inside(source.outline, x, z), true, `${slab.id} corner ${x},${z} is outside the outline`);
    }
  }
}

function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const point = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}

function inside(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let hits = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]![0];
    const zi = polygon[i]![1];
    const xj = polygon[j]![0];
    const zj = polygon[j]![1];
    const crosses = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (crosses) hits = !hits;
  }
  return hits;
}

function insideOrOn(polygon: readonly (readonly [number, number])[], x: number, z: number): boolean {
  if (inside(polygon, x, z)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    if (segmentDistance(x, z, polygon[j]![0], polygon[j]![1], polygon[i]![0], polygon[i]![1]) <= 1e-4) return true;
  }
  return false;
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len = dx * dx + dz * dz;
  if (len <= 1e-12) return Math.hypot(x - ax, z - az);
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len));
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

function assertQuad(
  mesh: HallMesh,
  cell: { minX: number; maxX: number; minZ: number; maxZ: number },
  y: number,
  tile: number,
  index = 0,
): void {
  const quad = mesh.quads[index];
  assert.ok(quad, `quad ${index}`);
  const xs = quad.positions.map((p) => p[0]);
  const zs = quad.positions.map((p) => p[2]);
  assert.ok(Math.abs(Math.min(...xs) - cell.minX) < 1e-4, String(xs));
  assert.ok(Math.abs(Math.max(...xs) - cell.maxX) < 1e-4, String(xs));
  assert.ok(Math.abs(Math.min(...zs) - cell.minZ) < 1e-4, String(zs));
  assert.ok(Math.abs(Math.max(...zs) - cell.maxZ) < 1e-4, String(zs));
  for (const position of quad.positions) {
    assert.ok(Math.abs(position[1] - y) < 1e-4, String(position[1]));
  }
  for (let i = 0; i < quad.positions.length; i += 1) {
    const position = quad.positions[i]!;
    const uv = quad.uvs[i]!;
    assert.ok(Math.abs(uv[0] - position[0] / tile) < 1e-4, String(uv));
    assert.ok(Math.abs(uv[1] - position[2] / tile) < 1e-4, String(uv));
  }
}

function readGlb(bytes: Buffer): { doc: GlbDoc; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GlbDoc;
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  return { doc, bin: bytes.subarray(binAt + 8, binAt + 8 + binLength) };
}

function viewBytes(doc: GlbDoc, bin: Uint8Array, index: number | undefined): Uint8Array {
  const bufferView = index == null ? undefined : doc.bufferViews?.[index];
  if (!bufferView) throw new Error("missing image");
  const start = bufferView.byteOffset ?? 0;
  return bin.subarray(start, start + bufferView.byteLength);
}

function scalars(doc: GlbDoc, bin: Uint8Array, index: number | undefined): number[] {
  return readComponents(doc, bin, index, 1);
}

function vecs(doc: GlbDoc, bin: Uint8Array, index: number | undefined, width: number): number[][] {
  const flat = readComponents(doc, bin, index, width);
  const out: number[][] = [];
  for (let i = 0; i < flat.length; i += width) out.push(flat.slice(i, i + width));
  return out;
}

function readComponents(doc: GlbDoc, bin: Uint8Array, index: number | undefined, width: number): number[] {
  const accessor = index == null ? undefined : doc.accessors?.[index];
  const bufferView = accessor?.bufferView == null ? undefined : doc.bufferViews?.[accessor.bufferView];
  if (!accessor || !bufferView) throw new Error(`missing accessor ${index}`);
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    for (let component = 0; component < width; component += 1) {
      const at = base + (vertex * width + component) * 4;
      out.push(accessor.componentType === 5126 ? view.getFloat32(at, true) : view.getUint32(at, true));
    }
  }
  return out;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
