import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PlanError } from "./errors.ts";
import { coarseFootprint } from "./footprint.ts";
import { trianglesFromGlb } from "./glb.ts";
import { boundsOfTriangles, stencilBoxes } from "./stencil.ts";
import type { LocalBox, Vec3 } from "./types.ts";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type MeasureFile = {
  id: string;
  units: "meters";
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

/**
 * Model bounds and an SVG footprint group. The group is a stencil: 1 m of
 * model is 1 mm of drawing, tagged `data-model`. It is not a layout.
 */
export function measure(options: MeasureOptions): { file: MeasureFile; svg: string } {
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
  const file: MeasureFile = {
    id,
    units: "meters",
    bounds: { min: roundVec(bounds.min), max: roundVec(bounds.max) },
    footprint: coarseFootprint(loaded.triangles).boxes.map(roundBox),
  };
  const svg = stencilSvg(id, stencilBoxes(loaded.triangles));
  mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  mkdirSync(path.dirname(path.resolve(options.svgPath)), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(options.svgPath, svg);
  return { file, svg };
}

/** Model X → SVG x, model Z → SVG −y, so toolbar +y (world +z) follows model +Z. */
export function stencilSvg(id: string, boxes: readonly LocalBox[]): string {
  const rects = boxes.map((box) => {
    const x = box.minX;
    const y = -box.maxZ;
    const width = box.maxX - box.minX;
    const height = box.maxZ - box.minZ;
    return { x, y, width, height };
  });
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  if (rects.length > 0) {
    minX = Math.min(...rects.map((rect) => rect.x));
    minY = Math.min(...rects.map((rect) => rect.y));
    maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  }
  const viewW = Math.max(maxX - minX, 1e-6);
  const viewH = Math.max(maxY - minY, 1e-6);
  const body = rects.map((rect) =>
    `    <rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}"/>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${fmt(viewW)}mm" height="${fmt(viewH)}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(viewW)} ${fmt(viewH)}">
  <g id="${id}" data-model="${id}" inkscape:label="model:${id}">
${body}
  </g>
</svg>
`;
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
