import assert from "node:assert/strict";
import test from "node:test";
import { readFloorsSvg } from "../src/floors-svg.ts";
import { hallCellsOf, outlinePieces } from "../src/hall-floor.ts";
import { derivePlaces } from "../src/places.ts";
import type { Vec3, Yaw } from "../src/types.ts";

const BUILDING = { id: "hall-b", model: "bldg", position: [0, 0, 0] as Vec3, yaw: 0 as Yaw, scale: 10 };

// Floor-2 is one path with two closed subpaths: x 0..8 and 12..20, a stairwell between.
const TWO_PIECES = "M 0 0 L 0.8 0 L 0.8 -1 L 0 -1 Z m 1.2 0 L 2 0 L 2 -1 L 1.2 -1 Z";

function svg(extra2 = "", extra1 = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="40mm" height="40mm" viewBox="0 0 40 40">
  <sodipodi:namedview inkscape:document-units="mm" inkscape:document-scale="1"/>
  <g inkscape:groupmode="layer" inkscape:label="floor-1">
    <g id="fp1" data-model="bldg" transform="matrix(10,0,0,10,0,40)"><path d="M 0 0 L 2 0 L 2 -1 L 0 -1 Z"/></g>${extra1}
  </g>
  <g inkscape:groupmode="layer" inkscape:label="floor-2">
    <g id="fp2" data-model="bldg" transform="matrix(10,0,0,10,0,40)" z="2.75"><path d="${TWO_PIECES}"/></g>${extra2}
  </g>
</svg>`;
}

const xsOf = (ring: readonly (readonly [number, number])[]) => ring.map(([x]) => x);

test("a two-subpath floor path yields two outline pieces; one-subpath floors have none", () => {
  const source = readFloorsSvg(svg());
  assert.equal(source.outlines, undefined);
  assert.equal(source.floors[0]!.outlines, undefined);
  const floor2 = source.floors[1]!;
  assert.equal(floor2.outlineFallback, undefined);
  const pieces = outlinePieces(floor2);
  assert.equal(pieces.length, 2);
  assert.deepEqual([Math.min(...xsOf(pieces[0]!)), Math.max(...xsOf(pieces[0]!))], [0, 8]);
  assert.deepEqual([Math.min(...xsOf(pieces[1]!)), Math.max(...xsOf(pieces[1]!))].map((v) => Math.round(v * 1e6) / 1e6), [12, 20]);
  // Footprint (and so building placement) stays the AABB of everything.
  assert.deepEqual(xsOf(floor2.footprint).map(Math.round), [0, 20, 20, 0]);
});

test("no hall cell of a two-piece floor covers the gap between its pieces", () => {
  const floor2 = readFloorsSvg(svg()).floors[1]!;
  const cells = hallCellsOf(outlinePieces(floor2), []);
  assert.ok(cells.length >= 2);
  for (const cell of cells) {
    assert.ok(cell.maxX <= 8 + 1e-6 || cell.minX >= 12 - 1e-6, `cell ${cell.minX}..${cell.maxX} crosses the gap`);
  }
});

test("a stair and landing in the gap between pieces still validate", () => {
  const landing = `<rect id="l1" inkscape:label="landing:l1" x="7" y="31" width="4.6" height="2" data-elevation="1.5"/>`;
  const s1 = `<rect id="s1" inkscape:label="stairs:s1" x="8.5" y="33.4" width="3" height="3.6" data-up="-y" data-top="1.5"/>`;
  const s2 = `<rect id="s2" inkscape:label="stairs:s2" x="9" y="31.4" width="3" height="1.2" data-up="+x" data-bottom="1.5" data-top="2.75"/>`;
  const source = readFloorsSvg(svg(landing, s1 + s2));
  const result = derivePlaces({ buildings: [BUILDING], floorsFor: () => source, roomFileFor: () => undefined });
  assert.deepEqual(result.warnings, []);
  const hall = result.places.find((place) => place.id === "hall-b.floor-2.hall")!;
  assert.ok(hall);
  assert.equal(result.places.filter((place) => place.id.startsWith("hall-b.floor-2.hall")).length, 1);
  const joins = (id: string) => (result.places.find((place) => place.id === id) as unknown as { joins: { from?: string; to?: string } }).joins;
  assert.deepEqual(joins("hall-b.s1"), { from: "hall-b.floor-1.hall", to: "hall-b.l1" });
  assert.deepEqual(joins("hall-b.s2"), { from: "hall-b.l1", to: "hall-b.floor-2.hall" });
  assert.ok(result.places.some((place) => place.id === "hall-b.l1"));
});
