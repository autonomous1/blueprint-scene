import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { PlanError } from "../src/errors.ts";
import { measure } from "../src/measure.ts";
import { attr, localName, parseXml } from "../src/xml.ts";
import type { Triangle, Vec3 } from "../src/types.ts";
import { trianglesFromBox } from "./boxes.ts";
import { writeGlb } from "./glb-writer.ts";

const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;

test("a 10 m wall with a 2 m gap writes a path with that gap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-gap-"));
  try {
    const measured = measureWalls(dir, "gap", [
      [[0, 0, 0], [4, 3, 0.5]],
      [[6, 0, 0], [10, 3, 0.5]],
    ]);
    assert.equal(measured.file.footprint.length, 2);
    const shape = onlyPath(measured.svg);
    assert.equal(shape.model, "gap");
    assert.equal(shape.d, "M 0 0 L 4 0 L 4 -0.5 L 0 -0.5 Z M 6 0 L 10 0 L 10 -0.5 L 6 -0.5 Z");
    assert.equal(shape.subs.length, 2);
    assert.equal(evenOdd(shape.subs, 2, -0.25), true);
    assert.equal(evenOdd(shape.subs, 8, -0.25), true);
    assert.equal(evenOdd(shape.subs, 5, -0.25), false);
    assert.equal(attr(parseXml(measured.svg), "width"), "10mm");
    assert.equal(attr(parseXml(measured.svg), "height"), "0.5mm");

    const baked = bake({
      svgPath: planAround(dir, measured.svg, `viewBox="-1 -1 12 2" width="12mm" height="2mm"`),
      modelsDir: path.join(dir, "models"),
      outPath: path.join(dir, "gap.placements.json"),
      collisionDir: path.join(dir, "collision"),
    });
    assert.equal(baked.file.placements[0]?.scale, 1);
    assert.equal(baked.file.obstacles.length, 2);
    const spans = baked.file.obstacles.map((box) => [box.min[0], box.max[0]]).sort((a, b) => a[0]! - b[0]!);
    assert.ok(spans[1]![0]! - spans[0]![1]! >= 1.5);
    assert.equal(baked.file.obstacles.some((box) => box.max[0] - box.min[0] > 9), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two parallel walls are two outlines, and a closed court keeps a hole", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-court-"));
  try {
    const parallel = measureWalls(dir, "parallel", [
      [[0, 0, 0], [10, 3, 0.5]],
      [[0, 0, 4], [10, 3, 4.5]],
    ]);
    const walls = onlyPath(parallel.svg);
    assert.equal(walls.subs.length, 2);
    const wallBoxes = walls.subs.map(ringBox);
    assert.equal(containsBox(wallBoxes[0]!, wallBoxes[1]!) || containsBox(wallBoxes[1]!, wallBoxes[0]!), false);
    assert.equal(evenOdd(walls.subs, 5, -0.25), true);
    assert.equal(evenOdd(walls.subs, 5, -4.25), true);
    assert.equal(evenOdd(walls.subs, 5, -2), false);

    const court = measureWalls(dir, "court", [
      [[0, 0, 0], [10, 3, 0.5]],
      [[0, 0, 7.5], [10, 3, 8]],
      [[0, 0, 0], [0.5, 3, 8]],
      [[9.5, 0, 0], [10, 3, 8]],
    ]);
    const ring = onlyPath(court.svg);
    assert.equal(ring.subs.length, 2);
    const courtBoxes = ring.subs.map(ringBox);
    assert.equal(
      containsBox(courtBoxes[0]!, courtBoxes[1]!) || containsBox(courtBoxes[1]!, courtBoxes[0]!),
      true,
    );
    assert.equal(evenOdd(ring.subs, 5, -0.25), true);
    assert.equal(evenOdd(ring.subs, 0.25, -4), true);
    assert.equal(evenOdd(ring.subs, 5, -4), false);
    assert.equal(court.file.footprint.some((box) =>
      box.minX < 5 && box.maxX > 5 && box.minZ < 4 && box.maxZ > 4,
    ), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function measureWalls(
  dir: string,
  id: string,
  spans: Array<[Vec3, Vec3]>,
): ReturnType<typeof measure> {
  const models = path.join(dir, "models");
  mkdirSync(models, { recursive: true });
  const triangles: Triangle[] = spans.flatMap(([min, max]) => trianglesFromBox(min, max));
  const glb = path.join(models, `${id}.glb`);
  writeFileSync(glb, writeGlb([{ name: id, triangles }], [{ name: id, mesh: id }]));
  return measure({
    glbPath: glb,
    outPath: path.join(dir, `${id}.json`),
    svgPath: path.join(dir, `${id}.svg`),
  });
}

function planAround(dir: string, svg: string, page: string): string {
  const start = svg.indexOf("<g ");
  const end = svg.indexOf("</g>") + "</g>".length;
  const file = path.join(dir, "plan.svg");
  writeFileSync(file, `<?xml version="1.0"?><svg ${ns} ${page}>
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="-1" y="-1" width="12" height="2"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">${svg.slice(start, end)}</g>
  </svg>`);
  return file;
}

function onlyPath(svg: string): { model: string; d: string; subs: Array<Array<[number, number]>> } {
  const root = parseXml(svg);
  const group = root.children.find((child) => localName(child.name) === "g");
  assert.ok(group);
  assert.equal(group.children.some((child) => localName(child.name) === "rect"), false);
  const paths = group.children.filter((child) => localName(child.name) === "path");
  assert.equal(paths.length, 1);
  const d = attr(paths[0]!, "d");
  assert.equal(attr(paths[0]!, "fill-rule"), "evenodd");
  assert.ok(d);
  return { model: attr(group, "data-model") ?? "", d, subs: subpaths(d) };
}

function subpaths(d: string): Array<Array<[number, number]>> {
  const tokens = d.match(/[MLZ]|[+-]?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const subs: Array<Array<[number, number]>> = [];
  let index = 0;
  let current: Array<[number, number]> | undefined;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "M" || token === "L") {
      const point: [number, number] = [Number(tokens[index + 1]), Number(tokens[index + 2])];
      if (token === "M") {
        current = [point];
        subs.push(current);
      } else {
        current!.push(point);
      }
      index += 3;
    } else if (token === "Z") {
      index += 1;
    } else {
      throw new Error(`unexpected path token ${token}`);
    }
  }
  return subs;
}

function evenOdd(subs: Array<Array<[number, number]>>, x: number, y: number): boolean {
  let inside = false;
  for (const ring of subs) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i]!;
      const b = ring[j]!;
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

function xzSpan(boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minZ: Math.min(...boxes.map((box) => box.minZ)),
    maxZ: Math.max(...boxes.map((box) => box.maxZ)),
  };
}

function ringBox(ring: Array<[number, number]>): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = ring.map((point) => point[0]);
  const ys = ring.map((point) => point[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function containsBox(
  outer: { minX: number; maxX: number; minY: number; maxY: number },
  inner: { minX: number; maxX: number; minY: number; maxY: number },
): boolean {
  return inner.minX > outer.minX && inner.maxX < outer.maxX && inner.minY > outer.minY && inner.maxY < outer.maxY;
}

test("a 1 m by 0.4 m box writes a footprint and a path with those bounds", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-small-"));
  try {
    const measured = measureWalls(dir, "slab", [
      [[-0.5, 0, -0.2], [0.5, 1, 0.2]],
    ]);
    assert.equal(measured.file.units, "glb");
    assert.ok(measured.file.footprint.length >= 1);
    assert.equal(measured.runCount, measured.file.footprint.length);
    assert.equal(measured.vertexCount > 0, true);
    const span = xzSpan(measured.file.footprint);
    assert.equal(span.minX, -0.5);
    assert.equal(span.maxX, 0.5);
    assert.equal(span.minZ, -0.2);
    assert.equal(span.maxZ, 0.2);
    const shape = onlyPath(measured.svg);
    assert.equal(shape.model, "slab");
    const box = ringBox(shape.subs[0]!);
    assert.equal(box.minX, -0.5);
    assert.equal(box.maxX, 0.5);
    assert.equal(box.minY, -0.2);
    assert.equal(box.maxY, 0.2);
    assert.equal(evenOdd(shape.subs, 0, 0), true);
    assert.equal(evenOdd(shape.subs, 0, 0.3), false);
    const root = parseXml(measured.svg);
    assert.equal(attr(root, "width"), "1mm");
    assert.equal(attr(root, "height"), "0.4mm");
    assert.equal(attr(root, "viewBox"), "-0.5 -0.2 1 0.4");

    const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
    const glb = path.join(dir, "models", "slab.glb");
    const cli = spawnSync(bin, [
      "measure",
      "--glb", glb,
      "--out", path.join(dir, "cli.json"),
      "--svg", path.join(dir, "cli.svg"),
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const line = `${glb}: ${measured.vertexCount} vertices, ${measured.runCount} runs`;
    assert.equal(cli.stdout.includes(line), true, cli.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positions with no covered cell fail and write nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-empty-run-"));
  try {
    const models = path.join(dir, "models");
    mkdirSync(models);
    const glb = path.join(models, "speck.glb");
    const speck: Triangle[] = [[
      [0.001, 0.2, 0.001],
      [0.004, 0.2, 0.001],
      [0.001, 0.2, 0.004],
    ]];
    writeFileSync(glb, writeGlb([{ name: "speck", triangles: speck }], [{ name: "speck", mesh: "speck" }]));
    const jsonPath = path.join(dir, "speck.json");
    const svgPath = path.join(dir, "speck.svg");
    assert.throws(
      () => measure({ glbPath: glb, outPath: jsonPath, svgPath }),
      (err: unknown) => err instanceof PlanError && /0 runs/.test(err.message),
    );
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(svgPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli help states the drawing scale once", () => {
  const bin = path.join(import.meta.dirname, "..", "bin", "blueprint-scene");
  const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.deepEqual(help.stdout.match(/1 mm = 1 m/g), ["1 mm = 1 m"]);
});
