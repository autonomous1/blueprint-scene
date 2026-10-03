import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { PlanError } from "../src/errors.ts";
import { footprintFromTriangles } from "../src/footprint.ts";
import { trianglesFromGlb } from "../src/glb.ts";
import type { PlacementsFile, Vec3 } from "../src/types.ts";
import { trianglesFromBox, trianglesFromWalls } from "./boxes.ts";
import { writeGlb, type GlbMesh, type GlbNode } from "./glb-writer.ts";

const pkg = path.join(import.meta.dirname, "..");
const fixtureSvg = path.join(import.meta.dirname, "fixtures", "plan.svg");
const wallsFile = path.join(import.meta.dirname, "fixtures", "building-a.walls.json");

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} is not ${expected}`);
}

test("wall_ names and extras.collision are kept; props, glass, trim, and a bare wall name are not", () => {
  const box = (min: Vec3, max: Vec3) => trianglesFromBox(min, max);
  const meshes: GlbMesh[] = [
    { name: "Cube", triangles: box([0, 0, 0], [1, 2, 0.5]) },
    { name: "wall_b", triangles: box([3, 0, 0], [4, 2, 0.5]) },
    { name: "pier", triangles: box([6, 0, 0], [7, 2, 0.5]), extras: { collision: true } },
    { name: "glass_panel", triangles: box([1.2, 0, 0], [1.8, 2, 0.5]) },
    { name: "trim_cap", triangles: box([8, 0, 0], [9, 2, 0.5]) },
    { name: "prop_crate", triangles: box([20, 0, 20], [21, 1, 21]) },
    { name: "wall", triangles: box([10, 0, 0], [11, 2, 0.5]) },
  ];
  const nodes: GlbNode[] = [
    { name: "wall_a", mesh: "Cube" },
    { name: "Door", mesh: "wall_b" },
    { name: "pier", mesh: "pier" },
    { name: "glass_panel", mesh: "glass_panel" },
    { name: "trim_cap", mesh: "trim_cap" },
    { name: "prop_crate", mesh: "prop_crate" },
    { name: "wall", mesh: "wall" },
  ];
  const bytes = writeGlb(meshes, nodes);
  const filtered = footprintFromTriangles(trianglesFromGlb(bytes, { meshPrefix: "wall_" }).triangles);
  assert.deepEqual(filtered.map((b) => [b.minX, b.maxX]), [[0, 1], [3, 4], [6, 7]]);
  const all = footprintFromTriangles(trianglesFromGlb(bytes).triangles);
  assert.equal(all.some((box) => box.minX === 20), true);
});

test("a parent yaw is applied after the child translation", () => {
  const yaw90 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const bytes = writeGlb(
    [{ name: "wall_child", triangles: trianglesFromBox([0, 0, 0], [1, 2, 0.5]) }],
    [{
      name: "root",
      matrix: yaw90,
      children: [{ name: "wall_child", mesh: "wall_child", translation: [2, 0, 0] }],
    }],
  );
  const [box] = footprintFromTriangles(trianglesFromGlb(bytes).triangles);
  assert.ok(box);
  assert.equal(box.minX, 0);
  assert.equal(box.maxX, 0.5);
  assert.equal(box.minY, 0);
  assert.equal(box.maxY, 2);
  assert.equal(box.minZ, -3);
  assert.equal(box.maxZ, -2);
});

test("a +90° glTF quaternion matches y-up-90", () => {
  const s = Math.SQRT1_2;
  const bytes = writeGlb(
    [{ name: "wall_q", triangles: trianglesFromBox([0, 0, 0], [1, 2, 0.5]) }],
    [{ name: "wall_q", mesh: "wall_q", rotation: [0, s, 0, s] }],
  );
  const [box] = footprintFromTriangles(trianglesFromGlb(bytes).triangles);
  assert.ok(box);
  near(box.minX, 0);
  near(box.maxX, 0.5);
  near(box.minY, 0);
  near(box.maxY, 2);
  near(box.minZ, -1);
  near(box.maxZ, 0);
});

test("cli bake matches the fake wall list and does not seal the doorway", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-cli-"));
  try {
    const doc = JSON.parse(readFileSync(wallsFile, "utf8")) as { walls: Array<{ min: Vec3; max: Vec3 }> };
    const meshes: GlbMesh[] = doc.walls.map((wall, index) => ({
      name: index === 2 ? "Cube" : `wall_${index}`,
      triangles: trianglesFromBox(wall.min, wall.max),
    }));
    meshes.push(
      { name: "wall", triangles: trianglesFromBox([-0.4, 0, 1.5], [0.4, 3, 2]) },
      { name: "glass_door", triangles: trianglesFromBox([-0.4, 0, 1.5], [0.4, 3, 2]) },
      { name: "prop_crate", triangles: trianglesFromBox([20, 0, 20], [21, 1, 21]) },
    );
    const nodes: GlbNode[] = doc.walls.map((_, index) => {
      if (index === 2) return { name: "wall_south_left", mesh: "Cube" };
      if (index === 3) return { name: "DoorRight", mesh: "wall_3" };
      return { name: `wall_${index}`, mesh: `wall_${index}` };
    });
    nodes.push(
      { name: "wall", mesh: "wall" },
      { name: "glass_door", mesh: "glass_door" },
      { name: "prop_crate", mesh: "prop_crate" },
    );
    const models = path.join(dir, "models");
    mkdirSync(models);
    writeFileSync(path.join(models, "building-a.glb"), writeGlb(meshes, nodes));
    const outPath = path.join(dir, "arena.placements.json");
    const bin = path.join(pkg, "bin", "blueprint-scene");
    const res = spawnSync(bin, [
      "bake", "--svg", fixtureSvg, "--models", models, "--out", outPath, "--mesh-prefix", "wall_",
    ], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /bldg-south: meshes wall_0, wall_1, Cube, wall_3, wall_4, wall_5, wall_6; scale 1; cell 0.5 m; 5 boxes/);
    assert.match(res.stdout, /bldg-north: meshes wall_0, wall_1, Cube, wall_3, wall_4, wall_5, wall_6; scale 1; cell 0.5 m; 5 boxes/);

    const cli = JSON.parse(readFileSync(outPath, "utf8")) as PlacementsFile;
    const api = bake({
      svgPath: fixtureSvg,
      outPath: path.join(dir, "api.json"),
      collisionDir: path.join(dir, "api-buildings"),
      walls: { "building-a": trianglesFromWalls(doc.walls) },
    });
    assert.deepEqual(cli, api.file);
    const gap: Vec3 = [9.75, 1, 36];
    const rotated = cli.obstacles.filter((obstacle) => obstacle.id.startsWith("bldg-north-"));
    assert.equal(rotated.some((obstacle) =>
      gap[0] > obstacle.min[0] && gap[0] < obstacle.max[0] &&
      gap[1] > obstacle.min[1] && gap[1] < obstacle.max[1] &&
      gap[2] > obstacle.min[2] && gap[2] < obstacle.max[2],
    ), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty primitive is skipped, and a GLB with no triangle positions fails", () => {
  const box = trianglesFromBox([0, 0, 0], [2, 3, 1]);
  const loaded = trianglesFromGlb(writeGlb(
    [
      { name: "blank", triangles: [], omitPosition: true },
      { name: "edges", triangles: box, mode: 1 },
      { name: "tripo_node_abc", triangles: box },
    ],
    [
      { name: "blank", mesh: "blank" },
      { name: "edges", mesh: "edges" },
      { name: "tripo_node_abc", mesh: "tripo_node_abc" },
    ],
  ));
  assert.deepEqual(loaded.meshNames, ["tripo_node_abc"]);
  assert.equal(loaded.vertexCount, box.length * 3);
  assert.ok(footprintFromTriangles(loaded.triangles).length >= 1);

  const rejects = (meshes: GlbMesh[], nodes: GlbNode[]) => assert.throws(
    () => trianglesFromGlb(writeGlb(meshes, nodes)),
    (err: unknown) => err instanceof PlanError && /no triangle position data/.test(err.message),
  );
  rejects(
    [{ name: "blank", triangles: [], omitPosition: true }],
    [{ name: "blank", mesh: "blank" }],
  );
  rejects(
    [{ name: "edges", triangles: box, mode: 1 }],
    [{ name: "edges", mesh: "edges" }],
  );
});

test("a tripo_node mesh bakes an AABB, and --mesh-prefix wall_ bakes none", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-tripo-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  try {
    const models = path.join(dir, "models");
    mkdirSync(models);
    const footprint = trianglesFromBox([0, 0, 0], [4, 3, 2]);
    writeFileSync(path.join(models, "shell.glb"), writeGlb(
      [
        { name: "blank", triangles: [], omitPosition: true },
        { name: "tripo_node_abc", triangles: footprint },
      ],
      [
        { name: "blank", mesh: "blank" },
        { name: "tripo_node_abc", mesh: "tripo_node_abc" },
      ],
    ));
    const svg = path.join(dir, "plan.svg");
    writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="1" height="1"/></g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="south" data-model="shell" x="0" y="0" width="4" height="2"/>
      </g>
    </svg>`);
    const bin = path.join(pkg, "bin", "blueprint-scene");
    const run = (outName: string, extra: string[]) => {
      const outPath = path.join(dir, outName);
      const res = spawnSync(bin, ["bake", "--svg", svg, "--models", models, "--out", outPath, ...extra], {
        cwd: dir,
        encoding: "utf8",
      });
      return { res, outPath };
    };

    const open = run("open.json", []);
    assert.equal(open.res.status, 0, open.res.stderr || open.res.stdout);
    assert.match(open.res.stdout, /shell: meshes tripo_node_abc; 36 vertices/);
    assert.match(open.res.stdout, /south: meshes tripo_node_abc; scale 1; cell 0.5 m; 1 boxes/);
    const openFile = JSON.parse(readFileSync(open.outPath, "utf8")) as PlacementsFile;
    assert.ok(openFile.obstacles.length >= 1);
    assert.equal(openFile.obstacles[0]?.kind, "aabb");

    const filtered = run("filtered.json", ["--mesh-prefix", "wall_"]);
    assert.equal(filtered.res.status, 0, filtered.res.stderr || filtered.res.stdout);
    assert.match(filtered.res.stdout, /shell: meshes \(none\); 0 vertices/);
    assert.match(filtered.res.stdout, /south: meshes \(none\); scale 1; cell 0.5 m; 0 boxes/);
    const filteredFile = JSON.parse(readFileSync(filtered.outPath, "utf8")) as PlacementsFile;
    assert.equal(filteredFile.obstacles.length, 0);
    const collision = JSON.parse(readFileSync(path.join(dir, "buildings", "shell.collision.json"), "utf8")) as {
      boxes: unknown[];
    };
    assert.equal(collision.boxes.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
