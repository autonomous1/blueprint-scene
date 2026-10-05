import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlanError } from "./errors.ts";
import { measureFootprint } from "./footprint.ts";
import { trianglesFromGlb } from "./glb.ts";
import { boundsOfTriangles } from "./stencil.ts";
import type { LocalBox, Vec3 } from "./types.ts";
import { unionAabbs, type Ring } from "./union.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type MeasureFile = {
  id: string;
  /** Raw GLB coordinates. Arena meters come from the SVG instance scale. */
  units: "glb";
  bounds: { min: Vec3; max: Vec3 };
  footprint: Array<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }>;
};

export type MeasureOptions = {
  glbPath: string;
  outPath: string;
  svgPath: string;
};

export type MeasureResult = {
  file: MeasureFile;
  svg: string;
  /** POSITION vertices of the meshes that contributed. */
  vertexCount: number;
  /** Local XZ runs written into `file.footprint`. */
  runCount: number;
};

/**
 * Raw GLB bounds and an SVG footprint group, both in GLB units. One GLB unit
 * is 1 mm on the page. The path is the union of the 0.05-unit runs. It is
 * not scaled to arena meters, not a layout, and not a collider. The bake's
 * 1 m cutoff is not applied.
 */
export function measure(options: MeasureOptions): MeasureResult {
  const id = path.basename(options.outPath, path.extname(options.outPath));
  if (!ID_RE.test(id)) throw new PlanError(`invalid model id "${id}"`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(options.glbPath);
  } catch {
    throw new PlanError(`cannot read ${options.glbPath}`);
  }
  let loaded: ReturnType<typeof trianglesFromGlb>;
  try {
    loaded = trianglesFromGlb(bytes);
  } catch (err) {
    if (err instanceof PlanError && !err.message.startsWith(`${id}:`)) {
      throw new PlanError(`${id}: ${err.message}`);
    }
    throw err;
  }
  const bounds = boundsOfTriangles(loaded.triangles);
  if (!bounds) throw new PlanError(`${id}: no triangle position data`);
  const boxes = measureFootprint(loaded.triangles);
  if (loaded.vertexCount > 0 && boxes.length === 0) {
    throw new PlanError(`${id}: ${loaded.vertexCount} vertices and 0 runs`);
  }
  const file: MeasureFile = {
    id,
    units: "glb",
    bounds: { min: roundVec(bounds.min), max: roundVec(bounds.max) },
    footprint: boxes.map(roundBox),
  };
  const svg = stencilSvg(id, boxes);
  mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  mkdirSync(path.dirname(path.resolve(options.svgPath)), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(options.svgPath, svg);
  return { file, svg, vertexCount: loaded.vertexCount, runCount: boxes.length };
}

/**
 * Model X → SVG x, model Z → SVG −y, so toolbar +y (world +z) follows model +Z.
 * One filled path: the union of the runs. A courtyard that is fully enclosed
 * stays a hole (`fill-rule="evenodd"`). This is not the outer bounds rectangle.
 */
export function stencilSvg(id: string, boxes: readonly LocalBox[]): string {
  const rings = unionAabbs(boxes);
  const live = boxes.some((box) => box.maxX > box.minX && box.maxZ > box.minZ);
  if (live && rings.length === 0) throw new PlanError(`${id}: wall union produced no outline`);
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  if (boxes.length > 0) {
    minX = Math.min(...boxes.map((box) => box.minX));
    maxX = Math.max(...boxes.map((box) => box.maxX));
    const minZ = Math.min(...boxes.map((box) => box.minZ));
    const maxZ = Math.max(...boxes.map((box) => box.maxZ));
    minY = -maxZ;
    maxY = -minZ;
  }
  const viewW = Math.max(maxX - minX, 1e-6);
  const viewH = Math.max(maxY - minY, 1e-6);
  const body = rings.length === 0 ? "" : `    <path fill-rule="evenodd" d="${pathData(rings)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${fmt(viewW)}mm" height="${fmt(viewH)}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(viewW)} ${fmt(viewH)}">
  <g id="${id}" data-model="${id}" inkscape:label="model:${id}">
${body}
  </g>
</svg>
`;
}

/** XZ rings, model +Z stored as SVG −y. Outers and holes are subpaths of one path. */
function pathData(rings: readonly Ring[]): string {
  return rings.map((ring) => {
    const commands = ring.points.map((point, index) => {
      const head = index === 0 ? "M" : "L";
      return `${head} ${fmt(point.x)} ${fmt(-point.z)}`;
    });
    return `${commands.join(" ")} Z`;
  }).join(" ");
}

function roundBox(box: LocalBox): MeasureFile["footprint"][number] {
  return {
    minX: roundM(box.minX),
    maxX: roundM(box.maxX),
    minY: roundM(box.minY),
    maxY: roundM(box.maxY),
    minZ: roundM(box.minZ),
    maxZ: roundM(box.maxZ),
  };
}

function roundVec(v: Vec3): Vec3 {
  return [roundM(v[0]), roundM(v[1]), roundM(v[2])];
}

function roundM(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function fmt(n: number): string {
  const rounded = roundM(n);
  return String(rounded === 0 ? 0 : rounded);
}
