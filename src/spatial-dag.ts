/**
 * Static spatial DAG output: merged obstacle chunks plus a place hierarchy.
 * @why The runtime collision world gets a BVH without changing the flat boxes yet.
 */
// ARCHITECTURE: Build a static BVH over the baked obstacle boxes and the
//   building/place node tree, then serialize both to one JSON file.
// Wiring: cli.ts `spatial-dag`; the arena loads the file.
import { BufferGeometry, Float32BufferAttribute } from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { AnyPlace, BoundsFile, PlacementsFile } from "./types.ts";

type Portal = { a?: string; b?: string; kind?: string };
type SceneGraphFile = { places?: AnyPlace[]; portals?: Portal[] };
type Box = { min: [number, number, number]; max: [number, number, number] };

function encoded(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return { __type: value.constructor.name, data: [...(value as Uint8Array)] };
  }
  if (Array.isArray(value)) return value.map(encoded);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = encoded((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function fnv(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function boxTriangles(boxes: readonly Box[]): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const corners = (b: Box) => [
    [b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.min[0], b.min[1], b.max[2]],
    [b.min[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]],
  ];
  const faces = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
  for (const box of boxes) {
    const base = positions.length / 3;
    for (const corner of corners(box)) positions.push(...corner);
    for (const face of faces) indices.push(base + face[0]!, base + face[1]!, base + face[2]!);
  }
  return { positions, indices };
}

/**
 * Build and write the static DAG.
 * @post The file is byte-stable for the same placements, graph, and bounds.
 */
export function writeSpatialDag(opts: {
  placements: PlacementsFile;
  sceneGraph: SceneGraphFile;
  bounds: BoundsFile;
  outPath: string;
  write: (path: string, text: string) => void;
}): { hash: string; nodes: number; chunks: number } {
  const boxes = (opts.placements.obstacles ?? []).map((item) => ({ min: item.min, max: item.max }));
  const { positions, indices } = boxTriangles(boxes);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const bvh = new MeshBVH(geometry);
  const places = opts.sceneGraph.places ?? [];
  const byBuilding = new Map<string, AnyPlace[]>();
  for (const place of places) {
    const key = (place as { building?: string }).building ?? "outside";
    const list = byBuilding.get(key) ?? [];
    list.push(place);
    byBuilding.set(key, list);
  }
  const nodes: Array<Record<string, unknown>> = [];
  for (const [building, list] of [...byBuilding.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    nodes.push({
      id: building,
      kind: "building",
      bounds: {
        min: [Math.min(...list.map((p) => p.bounds.minX)), Math.min(...list.map((p) => p.y)), Math.min(...list.map((p) => p.bounds.minZ))],
        max: [Math.max(...list.map((p) => p.bounds.maxX)), Math.max(...list.map((p) => p.y + 3)), Math.max(...list.map((p) => p.bounds.maxZ))],
      },
      parentId: undefined,
      childIds: list.map((p) => p.id),
      adjacency: [],
    });
    for (const place of list) {
      const portalIds = (opts.sceneGraph.portals ?? [])
        .filter((portal) => portal.a === place.id || portal.b === place.id)
        .map((portal) => (portal.a === place.id ? portal.b : portal.a))
        .filter((id): id is string => typeof id === "string");
      nodes.push({
        id: place.id,
        kind: place.kind,
        bounds: { min: [place.bounds.minX, place.y, place.bounds.minZ], max: [place.bounds.maxX, place.y + 3, place.bounds.maxZ] },
        parentId: building,
        childIds: [],
        adjacency: [...new Set(portalIds)].sort(),
        placeId: place.id,
      });
    }
  }
  const chunks = [{
    id: "static",
    nodeId: "static",
    place: "static",
    positions,
    indices,
    bvh: encoded(MeshBVH.serialize(bvh)),
  }];
  const body = { formatVersion: 1, units: "meters", bounds: opts.bounds, nodes, chunks };
  const hash = fnv(JSON.stringify(body));
  const file = { ...body, hash };
  opts.write(opts.outPath, `${JSON.stringify(file)}\n`);
  return { hash, nodes: nodes.length, chunks: chunks.length };
}
