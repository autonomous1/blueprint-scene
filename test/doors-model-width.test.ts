import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bake } from "../src/bake.ts";
import { cutDoorFromBoxes, doorPanelWidth, situateDoor } from "../src/doors.ts";
import { writeDoorProp } from "../src/prop.ts";
import { trianglesFromGlb } from "../src/glb.ts";
import type { DoorHinge, LocalBox, SceneDoor, Vec3, Yaw } from "../src/types.ts";
import { placeBox, transformXz } from "../src/yaw.ts";
import { trianglesFromBox } from "./boxes.ts";

const ORIGIN: Vec3 = [0, 0, 0];
const PANEL = 1.05;

function box(minX: number, maxX: number, minZ: number, maxZ: number): LocalBox {
  return { minX, maxX, minY: 0, maxY: 3, minZ, maxZ };
}

/** A 10 m room, walls 0.5 m thick. Outer faces: south z 5 (yaw 0), east x 5 (90), north z −5 (180), west x −5 (270). */
const ROOM: LocalBox[] = [
  box(-5, 5, 4.5, 5),
  box(4.5, 5, -4.5, 4.5),
  box(-5, 5, -5, -4.5),
  box(-5, -4.5, -4.5, 4.5),
];

type Wall = { yaw: Yaw; axis: "x" | "z"; outer: number; inward: number };
const WALLS: Wall[] = [
  { yaw: 0, axis: "z", outer: 5, inward: -1 },
  { yaw: 90, axis: "x", outer: 5, inward: -1 },
  { yaw: 180, axis: "z", outer: -5, inward: 1 },
  { yaw: 270, axis: "x", outer: -5, inward: 1 },
];

function drawn(wall: Wall, a0: number, a1: number, hinge: DoorHinge, width?: number): SceneDoor {
  const n0 = wall.outer;
  const n1 = wall.outer + wall.inward * 0.3;
  const [minN, maxN] = [Math.min(n0, n1), Math.max(n0, n1)];
  const along = (a0 + a1) / 2;
  const normal = (minN + maxN) / 2;
  const rect = wall.axis === "z"
    ? { minX: a0, maxX: a1, minZ: minN, maxZ: maxN, center: [along, 0, normal] as Vec3 }
    : { minX: minN, maxX: maxN, minZ: a0, maxZ: a1, center: [normal, 0, along] as Vec3 };
  return { id: `d-${wall.yaw}-${hinge}`, model: "door-1", building: "room", hinge, open: false, width, ...rect };
}

function alongSpan(position: Vec3, yaw: Yaw, x0: number, x1: number, axis: "x" | "z"): [number, number] {
  const ends = [x0, x1].map((x) => {
    const w = transformXz(x, 0, yaw);
    return axis === "z" ? position[0] + w.x : position[2] + w.z;
  });
  return [Math.min(...ends), Math.max(...ends)];
}

function near(actual: number, expected: number, label: string, tol = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < tol, `${label}: ${actual} ≠ ${expected}`);
}

function solid(boxes: readonly LocalBox[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ);
}

for (const wall of WALLS) {
  for (const hinge of ["left", "right"] as const) {
    test(`yaw ${wall.yaw}, ${hinge} hinge: a rectangle wider than the model opens only the panel width, from the hinge edge`, () => {
      const [a0, a1] = [-1, 0.9];
      const door = drawn(wall, a0, a1, hinge);
      const world = ROOM.map((b) => placeBox(b, ORIGIN, 0));
      const { placement, opening } = situateDoor(door, world, PANEL);
      near(placement.size[0], PANEL, "width is the panel");

      const localPlusX = transformXz(1, 0, wall.yaw);
      const alongPlus = wall.axis === "z" ? localPlusX.x : localPlusX.z;
      const hingeAtA0 = (hinge === "left") === (alongPlus > 0);
      const hingeAlong = wall.axis === "z" ? placement.position[0] : placement.position[2];
      near(hingeAlong, hingeAtA0 ? a0 : a1, "hinge at the drawn hinge edge");

      const [e0, e1] = hingeAtA0 ? [a0, a0 + PANEL] : [a1 - PANEL, a1];
      const [o0, o1] = alongSpan(placement.position, placement.yaw, opening.minX, opening.maxX, wall.axis);
      near(o0, e0, "opening start");
      near(o1, e1, "opening end");

      const cut = cutDoorFromBoxes(ROOM, { placement, opening }, ORIGIN, 0);
      const point = (along: number, y: number): [number, number, number] => {
        const n = wall.outer + wall.inward * 0.25;
        return wall.axis === "z" ? [along, y, n] : [n, y, along];
      };
      assert.equal(solid(cut, ...point((e0 + e1) / 2, 1)), false, "open in the panel span");
      assert.equal(solid(cut, ...point(e0 - 0.05, 1)), true, "jamb before the panel");
      assert.equal(solid(cut, ...point(e1 + 0.05, 1)), true, "jamb after the panel");
    });
  }
}

test("data-width overrides the model width; no model width falls back to the drawn span", () => {
  const world = ROOM.map((b) => placeBox(b, ORIGIN, 0));
  const marker = drawn(WALLS[0]!, 0.9, 1.1, "left", 2);
  const over = situateDoor(marker, world, PANEL);
  near(over.placement.size[0], 2, "data-width wins");
  near(over.placement.position[0], 0, "data-width stays centered");
  const plain = situateDoor(drawn(WALLS[0]!, -1, 0.9, "left"), world);
  near(plain.placement.size[0], 1.9, "drawn span");
  assert.throws(() => situateDoor(drawn(WALLS[0]!, -1, 0.9, "left"), world, 0), /panel width must be positive/);
});

test("doorPanelWidth reads the door mesh of a prop --shape door GLB, not the frame", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-panel-"));
  try {
    const glb = path.join(dir, "door-1.glb");
    writeDoorProp({ svgPath: path.join(import.meta.dirname, "fixtures", "door", "door-design.svg"), outPath: glb });
    const bytes = readFileSync(glb);
    const panel = doorPanelWidth(trianglesFromGlb(bytes, { meshPrefix: "door" }).triangles)!;
    const all = doorPanelWidth(trianglesFromGlb(bytes).triangles)!;
    assert.ok(panel > 0 && panel < all, `panel ${panel} inside frame ${all}`);
    assert.equal(doorPanelWidth([]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bake takes the opening width from the door GLB in --models, and the rectangle when it is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "blueprint-scene-door-width-"));
  const ns = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`;
  const svg = path.join(dir, "plan.svg");
  writeFileSync(svg, `<?xml version="1.0"?><svg ${ns} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="bounds"><rect id="room" x="0" y="0" width="20" height="20"/></g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="hall" data-model="m" x="5" y="9.5" width="10" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="doors">
      <rect id="front" data-building="hall" inkscape:label="model:door-1" x="8" y="9.5" width="2" height="1"/>
      <rect id="side" data-building="hall" inkscape:label="model:door-9" x="12" y="9.5" width="2" height="1"/>
    </g>
  </svg>`);
  const models = path.join(dir, "models");
  mkdirSync(models);
  writeDoorProp({ svgPath: path.join(import.meta.dirname, "fixtures", "door", "door-design.svg"), outPath: path.join(models, "door-1.glb") });
  const panel = doorPanelWidth(trianglesFromGlb(readFileSync(path.join(models, "door-1.glb")), { meshPrefix: "door" }).triangles)!;
  assert.ok(panel < 1.9, `fixture panel ${panel} is narrower than the 2 m rectangle`);
  try {
    const result = bake({
      svgPath: svg,
      outPath: path.join(dir, "buildings.placements.json"),
      collisionDir: path.join(dir, "buildings"),
      modelsDir: models,
      walls: { m: trianglesFromBox([-5, 0, -0.5], [5, 3, 0.5]) },
    });
    const [front, side] = result.doors.placements;
    near(front!.size[0], panel, "front uses the GLB panel", 1e-3);
    near(side!.size[0], 2, "side has no GLB: drawn span", 1e-3);
    // Both hinges sit on the drawn rectangles' hinge edges.
    const hinges = result.doors.placements.map((d) => d.position[0]).sort((a, b) => a - b);
    assert.ok([8, 10].some((x) => Math.abs(hinges[0]! - x) < 1e-3), `front hinge ${hinges[0]}`);
    assert.ok([12, 14].some((x) => Math.abs(hinges[1]! - x) < 1e-3), `side hinge ${hinges[1]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
