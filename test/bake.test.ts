import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { PlanError } from "../src/errors.ts";
import type { Obstacle, PlacementsFile, Vec3 } from "../src/types.ts";
import { trianglesFromBox, trianglesFromWalls } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const root = import.meta.dirname;
const fixtureSvg = path.join(root, "fixtures", "plan.svg");
const wallsFile = path.join(root, "fixtures", "building-a.walls.json");

const south: Obstacle[] = [
  { id: "bldg-south-wall-0", kind: "aabb", min: [6, 0, 22], max: [6.5, 3, 26] },
  { id: "bldg-south-wall-1", kind: "aabb", min: [6, 0, 22], max: [10, 3, 22.5] },
  { id: "bldg-south-wall-2", kind: "aabb", min: [6, 0, 25.5], max: [7.5, 3, 26] },
  { id: "bldg-south-wall-3", kind: "aabb", min: [8.5, 0, 25.5], max: [10, 3, 26] },
  { id: "bldg-south-wall-4", kind: "aabb", min: [9.5, 0, 22], max: [10, 3, 26] },
];

const north: Obstacle[] = [
  { id: "bldg-north-wall-0", kind: "aabb", min: [6, 0, 37.5], max: [10, 3, 38] },
  { id: "bldg-north-wall-1", kind: "aabb", min: [6, 0, 34], max: [6.5, 3, 38] },
  { id: "bldg-north-wall-2", kind: "aabb", min: [9.5, 0, 36.5], max: [10, 3, 38] },
  { id: "bldg-north-wall-3", kind: "aabb", min: [9.5, 0, 34], max: [10, 3, 35.5] },
  { id: "bldg-north-wall-4", kind: "aabb", min: [6, 0, 34], max: [10, 3, 34.5] },
];

function loadWalls(): ReturnType<typeof trianglesFromWalls> {
  const doc = JSON.parse(readFileSync(wallsFile, "utf8")) as {
    walls: Array<{ min: Vec3; max: Vec3 }>;
  };
  return trianglesFromWalls(doc.walls);
}

function covers(box: Obstacle, point: Vec3): boolean {
  const [x, y, z] = point;
  return x > box.min[0] && x < box.max[0] && y > box.min[1] && y < box.max[1] && z > box.min[2] && z < box.max[2];
}

test("bake writes placements and keeps the rotated doorway open", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-"));
  try {
    const outPath = path.join(dir, "arena.placements.json");
    const collisionDir = path.join(dir, "buildings");
    const result = bake({
      svgPath: fixtureSvg,
      outPath,
      collisionDir,
      walls: { "building-a": loadWalls() },
    });
    const written = JSON.parse(readFileSync(outPath, "utf8")) as PlacementsFile;
    assert.deepEqual(written, result.file);
    assert.deepEqual(written.placements, [
      { id: "bldg-south", model: "building-a", position: [8, 0, 24], yaw: 0, scale: 1 },
      { id: "bldg-north", model: "building-a", position: [8, 0, 36], yaw: 90, scale: 1 },
    ]);
    assert.deepEqual(written.obstacles, [...south, ...north]);
    assert.deepEqual(
      result.lines.slice(0, 2),
      [
        "bldg-south: meshes (none); scale 1; cell 0.5 m; 5 boxes; 0 facets dropped",
        "bldg-north: meshes (none); scale 1; cell 0.5 m; 5 boxes; 0 facets dropped",
      ],
    );

    const collision = JSON.parse(readFileSync(path.join(collisionDir, "building-a.collision.json"), "utf8")) as {
      id: string;
      origin: Vec3;
      yawConvention: string;
      boxes: Array<{ id: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number }>;
    };
    assert.equal(collision.id, "building-a");
    assert.deepEqual(collision.origin, [0, 0, 0]);
    assert.equal(collision.yawConvention, "y-up-90");
    assert.equal(collision.boxes.length, 5);
    assert.equal("minY" in collision.boxes[0]!, false);
    const mergedNorth = collision.boxes[1]!;
    assert.equal(mergedNorth.minX, -2);
    assert.equal(mergedNorth.maxX, 2);
    assert.deepEqual(
      collision.boxes.filter((box) => box.minZ === 1.5).map((box) => [box.minX, box.maxX]),
      [[-2, -0.5], [0.5, 2]],
    );

    const rotated = written.obstacles.filter((obstacle) => obstacle.id.startsWith("bldg-north-"));
    const leftJamb: Vec3 = [9.75, 1, 37];
    const rightJamb: Vec3 = [9.75, 1, 35];
    const gap: Vec3 = [9.75, 1, 36];
    assert.equal(rotated.some((obstacle) => covers(obstacle, leftJamb)), true);
    assert.equal(rotated.some((obstacle) => covers(obstacle, rightJamb)), true);
    assert.equal(rotated.some((obstacle) => covers(obstacle, gap)), false);
    assert.equal(rotated.some((obstacle) => covers(obstacle, leftJamb) && covers(obstacle, rightJamb)), false);
    const southLeft = rotated.find((obstacle) => obstacle.id === "bldg-north-wall-2")!;
    const southRight = rotated.find((obstacle) => obstacle.id === "bldg-north-wall-3")!;
    assert.equal(southLeft.min[2] - southRight.max[2], 1);

    const straight = written.obstacles.filter((obstacle) => obstacle.id.startsWith("bldg-south-"));
    assert.equal(straight.some((obstacle) => covers(obstacle, [8, 1, 25.75])), false);
    assert.equal(straight.some((obstacle) => covers(obstacle, [7, 1, 25.75])), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("180 and 270 yaw swap the model box without a second formula", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-"));
  const svg = path.join(dir, "turn.svg");
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const body = (id: string, extra: string) =>
    `<rect id="${id}" data-model="m" x="0" y="0" width="2" height="2" ${extra}/>`;
  try {
    writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        ${body("spin", `transform="rotate(180 1 1)"`)}
        ${body("override", `data-yaw="270" transform="rotate(90 1 1)"`)}
      </g>
    </svg>`);
    const walls = trianglesFromWalls([{ min: [0, 0, 0], max: [2, 3, 2] }]);
    const result = bake({
      svgPath: svg,
      outPath: path.join(dir, "out.json"),
      collisionDir: path.join(dir, "buildings"),
      walls: { m: walls },
    });
    assert.deepEqual(result.file.placements, [
      { id: "spin", model: "m", position: [1, 0, 9], yaw: 180, scale: 1 },
      { id: "override", model: "m", position: [1, 0, 9], yaw: 270, scale: 1 },
    ]);
    assert.deepEqual(result.file.obstacles, [
      { id: "spin-wall-0", kind: "aabb", min: [-1, 0, 7], max: [1, 3, 9] },
      { id: "override-wall-0", kind: "aabb", min: [-1, 0, 9], max: [1, 3, 11] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("svg scale is applied before a short sheet is dropped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-scale-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const sheet = trianglesFromBox([0, 0, 0], [1, 3, 0.02]);
  const svgFor = (extra: string) => `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="south" data-model="m" x="0" y="0" width="1" height="0.02" ${extra}/>
    </g>
  </svg>`;
  try {
    const unscaled = path.join(dir, "plain.svg");
    writeFileSync(unscaled, svgFor(""));
    const plain = bake({
      svgPath: unscaled,
      outPath: path.join(dir, "plain.json"),
      collisionDir: path.join(dir, "plain-buildings"),
      walls: { m: sheet },
    });
    assert.equal(plain.file.obstacles.length, 0);
    assert.equal(plain.file.placements[0]?.scale, 1);

    const stillThin = path.join(dir, "thin.svg");
    writeFileSync(stillThin, svgFor(`transform="scale(4)"`));
    const thin = bake({
      svgPath: stillThin,
      outPath: path.join(dir, "thin.json"),
      collisionDir: path.join(dir, "thin-buildings"),
      walls: { m: sheet },
    });
    assert.equal(thin.file.placements[0]?.scale, 4);
    assert.equal(thin.file.obstacles.length, 1);
    assert.equal(thin.file.obstacles[0]!.max[0]! - thin.file.obstacles[0]!.min[0]!, 4);
    assert.ok(Math.abs((thin.file.obstacles[0]!.max[2]! - thin.file.obstacles[0]!.min[2]!) - 0.08) < 1e-9);

    const scaledSvg = path.join(dir, "scaled.svg");
    writeFileSync(scaledSvg, svgFor(`transform="scale(20)"`));
    const scaled = bake({
      svgPath: scaledSvg,
      outPath: path.join(dir, "scaled.json"),
      collisionDir: path.join(dir, "scaled-buildings"),
      walls: { m: sheet },
    });
    const collision = JSON.parse(readFileSync(path.join(dir, "scaled-buildings", "m.collision.json"), "utf8")) as {
      boxes: unknown[];
    };
    assert.equal(collision.boxes.length, 0);
    assert.equal(scaled.file.placements[0]?.scale, 20);
    assert.equal(scaled.file.obstacles.length, 1);
    assert.equal(scaled.file.obstacles[0]!.max[0]! - scaled.file.obstacles[0]!.min[0]!, 20);
    assert.ok(Math.abs(scaled.file.obstacles[0]!.max[2]! - scaled.file.obstacles[0]!.min[2]! - 0.4) < 1e-9);

    const pair = path.join(dir, "pair.svg");
    writeFileSync(pair, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="a" data-model="cube" x="-0.5" y="-0.5" width="1" height="1"/>
        <g id="b" data-model="cube" transform="translate(4 0) scale(2)">
          <rect x="-0.5" y="-0.5" width="1" height="1"/>
        </g>
      </g>
    </svg>`);
    const both = bake({
      svgPath: pair,
      outPath: path.join(dir, "pair.json"),
      collisionDir: path.join(dir, "pair-buildings"),
      walls: { cube: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) },
    });
    assert.equal(both.file.placements[0]?.scale, 1);
    assert.equal(both.file.placements[1]?.scale, 2);
    assert.equal(both.file.obstacles[0]!.max[0]! - both.file.obstacles[0]!.min[0]!, 1);
    assert.equal(both.file.obstacles[1]!.max[0]! - both.file.obstacles[1]!.min[0]!, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a doorway gap stays open after a 90 degree yaw and a uniform scale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-gap-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  try {
    const svg = path.join(dir, "gap.svg");
    writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="door" data-model="m" x="-1" y="-0.25" width="2" height="0.5" transform="rotate(90) scale(2)"/>
      </g>
    </svg>`);
    const walls = trianglesFromWalls([
      { min: [-1, 0, -0.25], max: [-0.2, 2, 0.25] },
      { min: [0.2, 0, -0.25], max: [1, 2, 0.25] },
    ]);
    const result = bake({
      svgPath: svg,
      outPath: path.join(dir, "out.json"),
      collisionDir: path.join(dir, "buildings"),
      walls: { m: walls },
    });
    assert.equal(result.file.placements[0]?.scale, 2);
    assert.equal(result.file.placements[0]?.yaw, 90);
    const left: Vec3 = [0, 1, 11.2];
    const right: Vec3 = [0, 1, 8.8];
    const gap: Vec3 = [0, 1, 10];
    const boxes = result.file.obstacles;
    assert.equal(boxes.some((obstacle) => covers(obstacle, left)), true);
    assert.equal(boxes.some((obstacle) => covers(obstacle, right)), true);
    assert.equal(boxes.some((obstacle) => covers(obstacle, gap)), false);
    assert.equal(boxes.some((obstacle) => covers(obstacle, left) && covers(obstacle, right)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli stencil scale grows a thin sheet into a box", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-scale-cli-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  try {
    const models = path.join(dir, "models");
    mkdirSync(models);
    writeFileSync(path.join(models, "sheet.glb"), writeGlb(
      [{ name: "tripo_node_sheet", triangles: trianglesFromBox([0, 0, 0], [1, 3, 0.02]) }],
      [{ name: "tripo_node_sheet", mesh: "tripo_node_sheet" }],
    ));
    const bareSvg = path.join(dir, "bare.svg");
    const grownSvg = path.join(dir, "grown.svg");
    const rect = (extra: string) => `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="south" data-model="sheet" x="0" y="0" width="1" height="0.02" ${extra}/>
      </g>
    </svg>`;
    writeFileSync(bareSvg, rect(""));
    writeFileSync(grownSvg, rect(`transform="scale(20)"`));
    const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
    const bare = spawnSync(bin, ["bake", "--svg", bareSvg, "--models", models, "--out", path.join(dir, "bare.json")], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(bare.status, 0, bare.stderr || bare.stdout);
    assert.match(bare.stdout, /meshes tripo_node_sheet; 36 vertices/);
    assert.match(bare.stdout, /south: meshes tripo_node_sheet; scale 1; cell 0.5 m; 0 boxes/);
    const grown = spawnSync(bin, [
      "bake", "--svg", grownSvg, "--models", models, "--out", path.join(dir, "grown.json"),
    ], { cwd: dir, encoding: "utf8" });
    assert.equal(grown.status, 0, grown.stderr || grown.stdout);
    assert.match(grown.stdout, /south: meshes tripo_node_sheet; scale 20; cell 0.5 m; 1 boxes/);
    const file = JSON.parse(readFileSync(path.join(dir, "grown.json"), "utf8")) as PlacementsFile;
    assert.equal(file.obstacles.length, 1);
    assert.equal(file.obstacles[0]!.max[0] - file.obstacles[0]!.min[0], 20);
    assert.ok(Math.abs(file.obstacles[0]!.max[2] - file.obstacles[0]!.min[2] - 0.4) < 1e-9);
    const bad = spawnSync(bin, ["bake", "--svg", bareSvg, "--models", models, "--out", path.join(dir, "bad.json"), "--scale", "10"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown option --scale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each layer is its own file, and a toolbar square at -24 stays at -24", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-room-"));
  const svg = path.join(dir, "room.svg");
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const page = `<?xml version="1.0"?><svg ${ns} width="48mm" height="48mm" viewBox="0 0 48 48">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="-24" y="24" width="48" height="48"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="origin" data-model="m" x="-0.5" y="47.5" width="1" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="props">
        <rect id="crate" data-model="cover-crate" x="10" y="41" width="2" height="4"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="spawn-points">
        <path id="cross" d="M -0.5,-0.5 L 0.5,0.5 M -0.5,0.5 L 0.5,-0.5" transform="translate(-10 68)"/>
        <text id="corner" x="-24" y="72">x</text>
      </g>
    </svg>`;
  try {
    writeFileSync(svg, page);
    const outPath = path.join(dir, "buildings.placements.json");
    const result = bake({
      svgPath: svg,
      outPath,
      collisionDir: path.join(dir, "buildings"),
      walls: { m: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) },
    });
    const buildings = JSON.parse(readFileSync(outPath, "utf8")) as PlacementsFile;
    const bounds = JSON.parse(readFileSync(path.join(dir, "bounds.json"), "utf8")) as {
      minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
    };
    const props = JSON.parse(readFileSync(path.join(dir, "props.placements.json"), "utf8")) as PlacementsFile;
    const spawns = JSON.parse(readFileSync(path.join(dir, "spawn-points.json"), "utf8")) as Array<{
      id: string; x: number; y: number; z: number; yaw: number;
    }>;
    const doors = JSON.parse(readFileSync(path.join(dir, "doors.placements.json"), "utf8")) as {
      placements: unknown[];
      obstacles: unknown[];
    };
    assert.deepEqual(buildings, result.file);
    assert.equal("scene" in buildings, false);
    assert.equal("bounds" in buildings, false);
    assert.equal("props" in buildings, false);
    assert.equal("spawns" in buildings, false);
    assert.deepEqual(buildings.placements[0]?.position, [0, 0, 0]);
    assert.equal(buildings.placements[0]?.scale, 1);
    assert.deepEqual(bounds, { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 });
    assert.equal("scene" in bounds, false);
    assert.deepEqual(props.placements, [{
      id: "crate", model: "cover-crate", position: [11, 0, 5], yaw: 0, scale: 1,
    }]);
    assert.deepEqual(props.obstacles, [{
      id: "crate-box", kind: "aabb", min: [10, 0, 3], max: [12, 0, 7],
    }]);
    assert.equal("scene" in props, false);
    assert.deepEqual(doors, { formatVersion: 1, units: "meters", placements: [], obstacles: [] });
    assert.equal("scene" in doors, false);
    assert.deepEqual(spawns, [
      { id: "cross", x: -10, y: 0, z: -20, yaw: 0 },
      { id: "corner", x: -24, y: 0, z: -24, yaw: 0 },
    ]);
    assert.ok(Array.isArray(spawns));

    const outside = path.join(dir, "outside.svg");
    writeFileSync(outside, page.replace(
      `<text id="corner" x="-24" y="72">x</text>`,
      `<text id="corner" x="-24" y="72">x</text><text id="out" x="30" y="48">x</text>`,
    ));
    const missed = path.join(dir, "missed.placements.json");
    assert.throws(
      () => bake({
        svgPath: outside,
        outPath: missed,
        collisionDir: path.join(dir, "missed-buildings"),
        walls: { m: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]) },
      }),
      /spawn "out" is outside the bounds rectangle/,
    );
    assert.throws(() => readFileSync(missed));
    const kept = JSON.parse(readFileSync(path.join(dir, "spawn-points.json"), "utf8")) as Array<{ id: string }>;
    assert.deepEqual(kept.map((spawn) => spawn.id), ["cross", "corner"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounds come from the one rectangle, and a missing layer writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-bounds-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const buildings = `<g inkscape:groupmode="layer" inkscape:label="buildings">
    <rect id="origin" data-model="m" x="0" y="0" width="1" height="1"/>
  </g>`;
  try {
    const bare = path.join(dir, "bare.svg");
    writeFileSync(bare, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">${buildings}</svg>`);
    const bareOut = path.join(dir, "bare.placements.json");
    assert.throws(
      () => bake({ svgPath: bare, outPath: bareOut, collisionDir: path.join(dir, "c1"), walls: { m: [] } }),
      /bounds layer is missing/,
    );
    assert.throws(() => readFileSync(bareOut));
    assert.throws(() => readFileSync(path.join(dir, "bounds.json")));

    const tall = path.join(dir, "tall.svg");
    writeFileSync(tall, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="0" y="0" width="4" height="4" data-min-y="-1" data-max-y="9"/>
      </g>
      ${buildings}
    </svg>`);
    const tallResult = bake({
      svgPath: tall,
      outPath: path.join(dir, "tall.placements.json"),
      collisionDir: path.join(dir, "c2"),
      walls: { m: trianglesFromBox([0, 0, 0], [1, 1, 1]) },
    });
    assert.deepEqual(tallResult.bounds, { minX: 0, maxX: 4, minY: -1, maxY: 9, minZ: 6, maxZ: 10 });

    const turned = path.join(dir, "turned.svg");
    writeFileSync(turned, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="0" y="0" width="10" height="10"/>
      </g>
      ${buildings}
      <g inkscape:groupmode="layer" inkscape:label="props">
        <rect id="crate" data-model="cover-crate" x="0" y="0" width="2" height="4" transform="rotate(90 1 2)"/>
      </g>
    </svg>`);
    const turnedResult = bake({
      svgPath: turned,
      outPath: path.join(dir, "turned.placements.json"),
      collisionDir: path.join(dir, "c3"),
      walls: { m: trianglesFromBox([0, 0, 0], [1, 1, 1]) },
    });
    assert.equal(turnedResult.props.placements[0]?.yaw, 90);
    assert.equal(turnedResult.props.placements[0]?.scale, 1);
    assert.deepEqual(turnedResult.props.placements[0]?.position, [1, 0, 8]);
    assert.deepEqual(turnedResult.props.obstacles[0], {
      id: "crate-box", kind: "aabb", min: [-1, 0, 7], max: [3, 0, 9],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prop AABB is the model box, not the rectangle plus the pawn radius", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-prop-box-"));
  const svg = path.join(dir, "room.svg");
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  // The drawn rectangles are 2.2 by 1.8. The model is 1.2 × 0.8 × 0.8.
  // Padding each horizontal side by 0.5 would write 2.2 × 0.8 × 1.8.
  const page = `<?xml version="1.0"?><svg ${ns} width="48mm" height="48mm" viewBox="0 0 48 48">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="-24" y="24" width="48" height="48"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="origin" data-model="m" x="-0.5" y="47.5" width="1" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="props">
        <rect id="crate" data-model="crate" x="-1.1" y="47.1" width="2.2" height="1.8"/>
        <rect id="turned" data-model="crate" x="8.9" y="43.1" width="2.2" height="1.8" data-yaw="90"/>
        <rect id="grown" data-model="crate" x="-1.1" y="-0.9" width="2.2" height="1.8" transform="translate(6 20) scale(2)"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="spawn-points">
        <text id="near" x="1.2" y="48">x</text>
      </g>
    </svg>`;
  try {
    writeFileSync(svg, page);
    const result = bake({
      svgPath: svg,
      outPath: path.join(dir, "buildings.placements.json"),
      collisionDir: path.join(dir, "buildings"),
      walls: {
        m: trianglesFromBox([-0.5, 0, -0.5], [0.5, 1, 0.5]),
        crate: trianglesFromBox([-0.6, 0, -0.4], [0.6, 0.8, 0.4]),
      },
    });
    const crate = result.props.obstacles.find((box) => box.id === "crate-box");
    const turned = result.props.obstacles.find((box) => box.id === "turned-box");
    const grown = result.props.obstacles.find((box) => box.id === "grown-box");
    const grownPlace = result.props.placements.find((item) => item.id === "grown");
    assert.ok(crate);
    assert.ok(turned);
    assert.ok(grown);
    assert.ok(grownPlace);
    assert.deepEqual(result.props.placements.find((item) => item.id === "crate")?.position, [0, 0, 0]);
    assert.deepEqual(crate, {
      id: "crate-box", kind: "aabb", min: [-0.6, 0, -0.4], max: [0.6, 0.8, 0.4],
    });
    assertSpan(turned, [0.8, 0.8, 1.2]);
    const turnedPlace = result.props.placements.find((item) => item.id === "turned")!;
    assertCenter(turned, [turnedPlace.position[0], 0.4, turnedPlace.position[2]]);
    assert.equal(grownPlace.scale, 2);
    assertSpan(grown, [2.4, 1.6, 1.6]);
    assertCenter(grown, [grownPlace.position[0], 0.8, grownPlace.position[2]]);
    assert.deepEqual(result.spawns.find((spawn) => spawn.id === "near"), { id: "near", x: 1.2, y: 0, z: 0, yaw: 0 });
    // 0.6 m outside the face clears a 0.5 m pawn. 0.4 m does not.
    assert.equal(pawnBlocked(1.2, 0, [crate], 0.5), false);
    assert.equal(pawnBlocked(1.0, 0, [crate], 0.5), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertSpan(box: Obstacle, expected: [number, number, number]): void {
  near(box.max[0] - box.min[0], expected[0]);
  near(box.max[1] - box.min[1], expected[1]);
  near(box.max[2] - box.min[2], expected[2]);
}

function assertCenter(box: Obstacle, expected: [number, number, number]): void {
  near((box.min[0] + box.max[0]) / 2, expected[0]);
  near((box.min[1] + box.max[1]) / 2, expected[1]);
  near((box.min[2] + box.max[2]) / 2, expected[2]);
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} expected ${expected}`);
}

/** Host rule: a pawn center inside an AABB expanded by its radius is blocked. */
function pawnBlocked(x: number, z: number, obstacles: Obstacle[], radius: number): boolean {
  return obstacles.some((box) => {
    const minX = box.min[0] - radius;
    const maxX = box.max[0] + radius;
    const minZ = box.min[2] - radius;
    const maxZ = box.max[2] + radius;
    return x > minX && x < maxX && z > minZ && z < maxZ;
  });
}

test("a 10 m wall and a 2 m door are two boxes and one hinged placement", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-"));
  const svg = path.join(dir, "door.svg");
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  try {
    writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="0" y="0" width="20" height="20"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="doors">
        <rect id="front" data-building="hall" inkscape:label="model:door-1" x="9" y="9.5" width="2" height="1"/>
      </g>
    </svg>`);
    const outPath = path.join(dir, "buildings.placements.json");
    const result = bake({
      svgPath: svg,
      outPath,
      collisionDir: path.join(dir, "buildings"),
      walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) },
    });
    assert.equal(result.file.obstacles.length, 2);
    assert.equal(result.file.obstacles.some((box) => covers(box, [7, 1, 10]) && covers(box, [13, 1, 10])), false);
    assert.equal(result.file.obstacles.some((box) => covers(box, [7, 1, 10])), true);
    assert.equal(result.file.obstacles.some((box) => covers(box, [13, 1, 10])), true);
    assert.equal(result.file.obstacles.some((box) => covers(box, [10, 1, 10])), false);
    const gap = result.file.obstacles[1]!.min[0] - result.file.obstacles[0]!.max[0];
    assert.ok(gap >= 2 && gap <= 2.5, `gap ${gap}`);
    for (const box of result.file.obstacles) {
      assert.ok(box.max[2] - box.min[2] <= 1.05, `wall thickness in z ${box.max[2] - box.min[2]}`);
    }
    for (let z = 8; z <= 12; z += 0.25) {
      assert.equal(pawnBlocked(10, z, result.file.obstacles, 0.5), false, `z ${z}`);
    }
    assert.equal(pawnBlocked(7, 10, result.file.obstacles, 0.5), true);

    const doors = JSON.parse(readFileSync(path.join(dir, "doors.placements.json"), "utf8")) as {
      placements: Array<{ id: string; model: string; position: number[]; yaw: number; hinge: string; size: number[]; open: boolean }>;
      obstacles: unknown[];
    };
    assert.deepEqual(doors, result.doors);
    assert.deepEqual(doors.obstacles, []);
    assert.equal(JSON.stringify(doors).includes("-box"), false);
    assert.deepEqual(doors.placements, [{
      id: "front",
      model: "door-1",
      position: [10, 0, 10.5],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: false,
    }]);
    const modelCollision = JSON.parse(readFileSync(path.join(dir, "buildings", "m.collision.json"), "utf8")) as {
      boxes: unknown[];
    };
    assert.equal(modelCollision.boxes.length, 1);

    const unknown = path.join(dir, "unknown.svg");
    writeFileSync(unknown, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="0" y="0" width="20" height="20"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="doors">
        <rect id="front" data-building="missing" inkscape:label="model:door-1" x="9" y="9.5" width="2" height="1"/>
      </g>
    </svg>`);
    const missed = path.join(dir, "missed.placements.json");
    assert.throws(
      () => bake({
        svgPath: unknown,
        outPath: missed,
        collisionDir: path.join(dir, "missed-buildings"),
        walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) },
      }),
      /door "front" data-building "missing" does not match a placement/,
    );
    assert.throws(() => readFileSync(missed));
    assert.throws(() => readFileSync(path.join(dir, "missed-buildings", "m.collision.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a yaw 90 wall keeps the door on the turned face and a width marker still opens 2 m", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-yaw-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const shell = (buildings: string, doors: string) => `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">${buildings}</g>
    <g inkscape:groupmode="layer" inkscape:label="doors">${doors}</g>
  </svg>`;
  try {
    const turned = path.join(dir, "turned.svg");
    writeFileSync(turned, shell(
      `<rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1" transform="rotate(90 10 10)"/>`,
      `<rect id="front" data-building="hall" data-hinge="right" data-open="true" inkscape:label="model:door-1" x="9.5" y="9" width="1" height="2"/>`,
    ));
    const turnedResult = bake({
      svgPath: turned,
      outPath: path.join(dir, "turned.placements.json"),
      collisionDir: path.join(dir, "turned-buildings"),
      walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) },
    });
    assert.equal(turnedResult.file.obstacles.length, 2);
    assert.equal(turnedResult.file.obstacles.some((box) => covers(box, [10, 1, 10])), false);
    assert.equal(turnedResult.doors.obstacles.length, 0);
    assert.deepEqual(turnedResult.doors.placements[0], {
      id: "front",
      model: "door-1",
      position: [10.5, 0, 10],
      yaw: 90,
      hinge: "right",
      size: [2, 2.1, 0.08],
      open: true,
    });
    for (const box of turnedResult.file.obstacles) {
      assert.ok(box.max[0] - box.min[0] <= 1.05, `turned wall thickness in x ${box.max[0] - box.min[0]}`);
    }
    for (let x = 8; x <= 12; x += 0.25) {
      assert.equal(pawnBlocked(x, 10, turnedResult.file.obstacles, 0.5), false, `turned x ${x}`);
    }
    assert.equal(pawnBlocked(10, 7, turnedResult.file.obstacles, 0.5), true);

    const marker = path.join(dir, "marker.svg");
    writeFileSync(marker, shell(
      `<rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>`,
      `<rect id="front" data-building="hall" data-width="2" data-height="2.4" data-depth="0.1" data-model="door-1" x="9.9" y="9.9" width="0.2" height="0.2"/>`,
    ));
    const marked = bake({
      svgPath: marker,
      outPath: path.join(dir, "marker.placements.json"),
      collisionDir: path.join(dir, "marker-buildings"),
      walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) },
    });
    assert.equal(marked.file.obstacles.length, 2);
    assert.equal(marked.file.obstacles.some((box) => covers(box, [10, 1, 10])), false);
    assert.deepEqual(marked.doors.placements[0]?.size, [2, 2.4, 0.1]);
    assert.deepEqual(marked.doors.placements[0]?.position, [10, 0, 10.5]);
    assert.deepEqual(marked.doors.obstacles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deep block keeps the door gap on the wall and the cell beside the jamb solid", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-deep-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const shell = (buildings: string, doors: string) => `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">${buildings}</g>
    <g inkscape:groupmode="layer" inkscape:label="doors">${doors}</g>
  </svg>`;
  const block = trianglesFromBox([-5, 0, -5], [5, 3, 5]);
  try {
    const alongX = path.join(dir, "along-x.svg");
    writeFileSync(alongX, shell(
      `<rect id="hall" data-model="m" x="5" y="5" width="10" height="10"/>`,
      `<rect id="front" data-building="hall" inkscape:label="model:door-1" x="9" y="4.8" width="2" height="0.4"/>`,
    ));
    const yaw0 = bake({
      svgPath: alongX,
      outPath: path.join(dir, "along-x.placements.json"),
      collisionDir: path.join(dir, "along-x-buildings"),
      walls: { m: block },
    });
    assert.equal(yaw0.doors.placements[0]?.yaw, 0);
    assert.equal(pawnBlocked(10, 14.5, yaw0.file.obstacles, 0.5), false);
    assert.equal(pawnBlocked(8, 14.5, yaw0.file.obstacles, 0.5), true);
    assert.equal(pawnBlocked(10, 11, yaw0.file.obstacles, 0.5), true);

    const alongZ = path.join(dir, "along-z.svg");
    writeFileSync(alongZ, shell(
      `<rect id="hall" data-model="m" data-yaw="90" x="5" y="5" width="10" height="10"/>`,
      `<rect id="front" data-building="hall" inkscape:label="model:door-1" x="14.8" y="9" width="0.4" height="2"/>`,
    ));
    const yaw90 = bake({
      svgPath: alongZ,
      outPath: path.join(dir, "along-z.placements.json"),
      collisionDir: path.join(dir, "along-z-buildings"),
      walls: { m: block },
    });
    assert.equal(yaw90.doors.placements[0]?.yaw, 90);
    assert.equal(pawnBlocked(14.5, 10, yaw90.file.obstacles, 0.5), false);
    assert.equal(pawnBlocked(14.5, 8, yaw90.file.obstacles, 0.5), true);
    assert.equal(pawnBlocked(11, 10, yaw90.file.obstacles, 0.5), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model:door-1 and model:door-2 are written, and a door with no model fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-models-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const shell = (doors: string) => `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="doors">${doors}</g>
  </svg>`;
  const walls = { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) };
  try {
    const svg = path.join(dir, "two.svg");
    writeFileSync(svg, shell(`
      <rect id="door-north" data-building="hall" inkscape:label="model:door-1" x="8" y="9.5" width="2" height="1"/>
      <rect id="door-south" data-building="hall" inkscape:label="model:door-2" x="12" y="9.5" width="2" height="1"/>
    `));
    const outPath = path.join(dir, "buildings.placements.json");
    const result = bake({
      svgPath: svg,
      outPath,
      collisionDir: path.join(dir, "buildings"),
      walls,
    });
    assert.deepEqual(result.doors.placements.map((door) => door.model), ["door-1", "door-2"]);
    assert.deepEqual(result.doors.placements.map((door) => door.id), ["door-north", "door-south"]);
    assert.deepEqual(result.doors.obstacles, []);
    const written = JSON.parse(readFileSync(path.join(dir, "doors.placements.json"), "utf8")) as {
      placements: Array<{ model: string }>;
    };
    assert.deepEqual(written.placements.map((door) => door.model), ["door-1", "door-2"]);

    const bare = path.join(dir, "bare.svg");
    writeFileSync(bare, shell(`<rect id="front" data-building="hall" x="9" y="9.5" width="2" height="1"/>`));
    const missed = path.join(dir, "missed.placements.json");
    assert.throws(
      () => bake({
        svgPath: bare,
        outPath: missed,
        collisionDir: path.join(dir, "missed-buildings"),
        walls,
      }),
      /door "front" is missing a model/,
    );
    assert.throws(() => readFileSync(missed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model with no GLB fails and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-"));
  const outPath = path.join(dir, "missing.json");
  try {
    assert.throws(
      () => bake({ svgPath: fixtureSvg, outPath, modelsDir: dir, collisionDir: path.join(dir, "buildings") }),
      (err: unknown) => err instanceof PlanError && /no GLB/.test(err.message),
    );
    assert.throws(() => readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

