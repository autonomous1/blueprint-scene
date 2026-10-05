import assert from "node:assert/strict";
import test from "node:test";
import { PlanError } from "../src/errors.ts";
import { readPlacements, readScene } from "../src/plan.ts";

const NS = `xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"`;

function plan(body: string, attrs = `width="10mm" height="10mm" viewBox="0 0 10 10"`): string {
  return `<?xml version="1.0"?><svg ${NS} ${attrs}><g inkscape:groupmode="layer" inkscape:label="buildings">${body}</g></svg>`;
}

test("a stencil path is the group footprint, and the gap stays inside that box", () => {
  const [placed] = readPlacements(plan(`
    <g id="gap" data-model="wall">
      <path fill-rule="evenodd" d="M 0 0 L 4 0 L 4 -0.5 L 0 -0.5 Z M 6 0 L 10 0 L 10 -0.5 L 6 -0.5 Z"/>
    </g>
  `));
  assert.ok(placed);
  assert.equal(placed.drawnWidth, 10);
  assert.equal(placed.drawnDepth, 0.5);
  assert.deepEqual(placed.position, [5, 0, 10.25]);
});

test("rectangle center uses toolbar y as z, and a quarter turn", () => {
  const placements = readPlacements(plan(`
    <rect id="south" data-model="building-a" x="0" y="0" width="2" height="2"/>
    <rect id="turned" data-model="building-a" x="0" y="0" width="2" height="2" transform="rotate(90 1 1)"/>
  `));
  assert.deepEqual(placements, [
    { id: "south", model: "building-a", position: [1, 0, 9], yaw: 0, drawnWidth: 2, drawnDepth: 2 },
    { id: "turned", model: "building-a", position: [1, 0, 9], yaw: 90, drawnWidth: 2, drawnDepth: 2 },
  ]);
});

test("SVG transforms apply right to left, then the parent", () => {
  const [placed] = readPlacements(plan(
    `<g transform="translate(10 0)"><rect id="b" data-model="m" x="0" y="0" width="2" height="2" transform="rotate(90)"/></g>`,
  ));
  assert.ok(placed);
  assert.equal(placed.yaw, 90);
  assert.deepEqual(placed.position, [9, 0, 9]);
});

test("layer translate moves the center", () => {
  const [placed] = readPlacements(
    `<?xml version="1.0"?><svg ${NS} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="buildings" transform="translate(2 -3)">
        <rect id="b" data-model="m" x="0" y="0" width="2" height="2"/>
      </g>
    </svg>`,
  );
  assert.ok(placed);
  assert.deepEqual(placed.position, [3, 0, 12]);
  assert.equal(placed.yaw, 0);
});

test("a uniform enlarge is the drawn size, and a non-uniform scale fails", () => {
  const [placed] = readPlacements(plan(
    `<g id="b" data-model="m" transform="scale(2)"><rect x="0" y="0" width="1" height="1"/></g>`,
  ));
  assert.equal(placed?.drawnWidth, 2);
  assert.equal(placed?.drawnDepth, 2);
  assert.deepEqual(placed?.position, [1, 0, 9]);
  assert.throws(
    () => readPlacements(plan(
      `<rect id="b" data-model="m" x="0" y="0" width="2" height="2" transform="scale(2, 3)"/>`,
    )),
    /not uniform/,
  );
});

test("data-yaw overrides the transform", () => {
  const [placed] = readPlacements(plan(
    `<rect id="b" data-model="m" data-yaw="270deg" x="0" y="0" width="2" height="2" transform="rotate(90 1 1)"/>`,
  ));
  assert.ok(placed);
  assert.equal(placed.yaw, 270);
  assert.deepEqual(placed.position, [1, 0, 9]);
});

test("an Inkscape label model:id is a placement", () => {
  const [placed] = readPlacements(plan(
    `<rect id="b1" inkscape:label="model:building-a" x="0" y="0" width="2" height="4"/>`,
  ));
  assert.ok(placed);
  assert.equal(placed.model, "building-a");
  assert.deepEqual(placed.position, [1, 0, 8]);
});

test("disagreeing data-model and label fail the file", () => {
  assert.throws(
    () => readPlacements(plan(
      `<rect id="b" data-model="building-b" inkscape:label="model:building-a" x="0" y="0" width="1" height="1"/>`,
    )),
    PlanError,
  );
});

test("a non-cardinal rotation fails the file", () => {
  assert.throws(
    () => readPlacements(plan(`<rect id="bad" data-model="m" x="0" y="0" width="2" height="2" transform="rotate(30)"/>`)),
    /not 0, 90, 180, or 270/,
  );
});

test("ignore, notes, and unlabeled rectangles are not placements", () => {
  const placements = readPlacements(`<?xml version="1.0"?><svg ${NS} width="10mm" height="10mm" viewBox="0 0 10 10">
    <g inkscape:groupmode="layer" inkscape:label="ignore">
      <rect id="nope" data-model="m" x="0" y="0" width="1" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="notes">
      <rect id="note" data-model="m" x="0" y="0" width="1" height="1"/>
    </g>
    <rect id="loose" data-model="m" x="0" y="0" width="1" height="1"/>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="caption" x="0" y="0" width="1" height="1"/>
      <rect id="kept" data-model="m" x="4" y="4" width="2" height="2"/>
    </g>
  </svg>`);
  assert.deepEqual(placements.map((placement) => placement.id), ["kept"]);
});

test("one millimetre of the page is one world meter", () => {
  const [mm] = readPlacements(`<?xml version="1.0"?><svg ${NS} width="20mm" height="20mm" viewBox="0 0 20 20">
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="b" data-model="m" x="0" y="0" width="8" height="4"/>
    </g>
  </svg>`);
  assert.deepEqual(mm?.position, [4, 0, 18]);
  assert.equal(mm?.drawnWidth, 8);

  const scaled = readPlacements(`<?xml version="1.0"?><svg ${NS} width="40mm" height="40mm" viewBox="0 0 40 40">
    <sodipodi:namedview inkscape:document-scale="2"/>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="b" data-model="m" x="6" y="14" width="4" height="4"/>
    </g>
  </svg>`);
  assert.deepEqual(scaled[0]?.position, [4, 0, 12]);
});

test("one inch is 25.4 m per user unit when the viewBox matches the width", () => {
  const [placed] = readPlacements(`<?xml version="1.0"?><svg ${NS} width="1in" height="1in" viewBox="0 0 1 1">
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="b" data-model="m" x="0" y="0" width="2" height="2"/>
    </g>
  </svg>`);
  assert.ok(placed);
  assert.ok(Math.abs(placed.position[0] - 25.4) < 1e-9);
  assert.ok(Math.abs(placed.position[2]) < 1e-9);
});

test("matrix() from Inkscape is the same yaw as rotate()", () => {
  const [placed] = readPlacements(plan(
    `<rect id="b" data-model="m" x="0" y="0" width="2" height="2" transform="matrix(0 1 -1 0 0 0)"/>`,
  ));
  assert.ok(placed);
  assert.equal(placed.yaw, 90);
  assert.deepEqual(placed.position, [-1, 0, 9]);
});

test("toolbar lower-left is world z, and a building on the page origin stays there", () => {
  const scene = readScene(`<?xml version="1.0"?><svg ${NS} width="210mm" height="297mm" viewBox="0 0 210 297">
    <g inkscape:groupmode="layer" inkscape:label="bounds">
      <rect id="room" x="-24" y="273" width="48" height="48"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="ignore">
      <rect id="skip" x="-400" y="0" width="10" height="10"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="origin" data-model="m" x="-0.5" y="296.5" width="1" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="props">
      <rect id="crate" data-model="cover-crate" x="10" y="290" width="2" height="4"/>
      <rect id="caption" x="0" y="0" width="1" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="spawn-points">
      <text id="mark" x="-24" y="321">x</text>
    </g>
  </svg>`);
  assert.deepEqual(scene.bounds, { minX: -24, maxX: 24, minZ: -24, maxZ: 24 });
  assert.deepEqual(scene.placements[0]?.position, [0, 0, 0]);
  assert.equal(scene.props.length, 1);
  assert.equal(scene.props[0]?.model, "cover-crate");
  assert.equal(scene.props[0]?.scale, 1);
  assert.equal(scene.props[0]?.yaw, 0);
  assert.deepEqual(scene.props[0]?.position, [11, 0, 5]);
  assert.deepEqual(scene.spawns[0], { id: "mark", position: [-24, 0, -24], yaw: 0 });
});

test("a path cross, a text mark, and a small rectangle are spawns", () => {
  const scene = readScene(`<?xml version="1.0"?><svg ${NS} width="48mm" height="48mm" viewBox="0 0 48 48">
    <g inkscape:groupmode="layer" inkscape:label="bounds">
      <rect id="room" x="-24" y="24" width="48" height="48"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="b" data-model="m" x="0" y="0" width="1" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="spawn-points">
      <path id="cross" d="M -0.5,-0.5 L 0.5,0.5 M -0.5,0.5 L 0.5,-0.5" transform="translate(-10 68)"/>
      <text id="corner" x="-24" y="72">x</text>
      <rect id="pad" x="4" y="30" width="2" height="2" transform="rotate(90 5 31)"/>
    </g>
  </svg>`);
  assert.deepEqual(scene.spawns.find((spawn) => spawn.id === "cross"), {
    id: "cross", position: [-10, 0, -20], yaw: 0,
  });
  assert.deepEqual(scene.spawns.find((spawn) => spawn.id === "corner"), {
    id: "corner", position: [-24, 0, -24], yaw: 0,
  });
  const pad = scene.spawns.find((spawn) => spawn.id === "pad");
  assert.ok(pad);
  assert.equal(pad.yaw, 90);
  assert.deepEqual(pad.position, [5, 0, 17]);
});

test("a spawn outside the bounds rectangle fails", () => {
  assert.throws(
    () => readScene(`<?xml version="1.0"?><svg ${NS} width="48mm" height="48mm" viewBox="0 0 48 48">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="room" x="-24" y="24" width="48" height="48"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="b" data-model="m" x="0" y="0" width="1" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="spawn-points">
        <text id="out" x="30" y="48">x</text>
      </g>
    </svg>`),
    /spawn "out" is outside the bounds rectangle/,
  );
});

test("two bounds rectangles fail, and a model: label selects a prop", () => {
  assert.throws(
    () => readScene(`<?xml version="1.0"?><svg ${NS} width="10mm" height="10mm" viewBox="0 0 10 10">
      <g inkscape:groupmode="layer" inkscape:label="bounds">
        <rect id="a" x="0" y="0" width="1" height="1"/>
        <rect id="b" x="2" y="2" width="1" height="1"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="buildings">
        <rect id="bldg" data-model="m" x="0" y="0" width="1" height="1"/>
      </g>
    </svg>`),
    /more than one rectangle/,
  );
  const scene = readScene(`<?xml version="1.0"?><svg ${NS} width="10mm" height="10mm" viewBox="0 0 10 10">
    <g inkscape:groupmode="layer" inkscape:label="buildings">
      <rect id="bldg" data-model="m" x="0" y="0" width="1" height="1"/>
    </g>
    <g inkscape:groupmode="layer" inkscape:label="props">
      <rect id="crate" inkscape:label="model:cover-crate" x="1" y="1" width="2" height="2" transform="scale(2)"/>
    </g>
  </svg>`);
  assert.equal(scene.props[0]?.model, "cover-crate");
  assert.equal(scene.props[0]?.scale, 2);
  assert.equal(scene.sawBoundsLayer, false);
});
