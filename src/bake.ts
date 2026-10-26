import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAssetFiles, readAssetTypes, stampPlacement } from "./asset-type.ts";
import { PlanError } from "./errors.ts";
import { boxInModel, cutBuildingGlb, extendSkinToFacade, meshProbe, openingInModel, openingOverlapCounts, uncutBuildingGlb, type MeshProbe } from "./building-mesh-cut.ts";
import { cutDoorFromBoxes, doorCutLocal, doorPanelWidth, situateDoor, subtractBox } from "./doors.ts";
import { coarseFootprint, measureFootprint } from "./footprint.ts";
import { trianglesFromGlb, type GlbLoad } from "./glb.ts";
import { derivePlaces } from "./places.ts";
import { readScene, type PlanPlacement } from "./plan.ts";
import type { RoomFile } from "./room-file.ts";
import { readFloorsSvg } from "./floors-svg.ts";
import { cutRoomWalls, loadFloors, placeRoomDoors, resolveExteriorDoors, type FloorBake, type RoomsLightsFile, type RoomsPlacementsFile } from "./rooms-bake.ts";
import { boundsOfTriangles, stencilBoxes, stencilSize } from "./stencil.ts";
import type { BoundsFile, CollisionFile, DoorPlacement, DoorsFile, LocalBox, Placement, PlacementsFile, ScenePlace, SceneProp, SpawnPoint, Triangle, Vec3, XzBounds, Yaw } from "./types.ts";
import { inverseYaw, placeBox, transformXz } from "./yaw.ts";

const DEFAULT_MODELS = path.join("web", "assets", "models");
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type BakeOptions = {
  svgPath: string;
  outPath: string;
  /** Directory of `<id>.glb`. Defaults to `web/assets/models`. */
  modelsDir?: string;
  /** Directory for `buildings/<id>.collision.json`. Defaults to `buildings`. */
  collisionDir?: string;
  /**
   * Triangle stand-in for a model. When set, that model is not loaded from a GLB.
   * Tests use this so CI does not need a building file.
   */
  walls?: Readonly<Record<string, Triangle[]>>;
  /**
   * Keep a mesh only when its mesh or node name starts with this prefix,
   * or when `extras.collision` is true. Omit it to use every triangle mesh.
   */
  meshPrefix?: string;
  /**
   * `arena.game.json`. Each placement `type` is that asset's `type`.
   * An asset with no type omits the field. Omit the path and no placement gets one.
   * Type is not read from the SVG.
   */
  gamePath?: string;
  /** Directory of `<model>.floors.svg`. Omit it and rooms are not baked. */
  floorsDir?: string;
  /** Directory of `<prefab>.room.json`. Required when a floors file has a room. */
  roomsDir?: string;
};

type ModelBake = {
  triangles: Triangle[];
  /** Unscaled collision runs, for the model-space file and the mesh log. */
  boxes: LocalBox[];
  meshNames: string[];
  vertexCount: number;
  /** False for the triangle stand-in, which has no mesh names to report. */
  fromGlb: boolean;
  /** XZ size of the stencil the SVG scale is measured against. */
  stencilWidth: number;
  stencilDepth: number;
  /** XZ center of that stencil extent, in model units. A drawn rectangle is centered on it. */
  stencilCenterX: number;
  stencilCenterZ: number;
  /**
   * Transformed vertex XZ bounds, every mesh. Node scale is already applied.
   * Logged against the drawn path. A copied stencil is not scaled onto this:
   * a lip thinner than the measure cell is outside the path and must not pull
   * the uniform scale.
   */
  measureMinX: number;
  measureMaxX: number;
  measureMinZ: number;
  measureMaxZ: number;
  measureWidth: number;
  measureDepth: number;
  /**
   * Union of the 0.05 m measure runs. A copied floors path is this outline,
   * so the footprint check uses it and not the vertex bounds.
   */
  runWidth: number;
  runDepth: number;
};

export type BakeResult = {
  /** Buildings layer only: placements and coarse XZ obstacles. */
  file: PlacementsFile;
  bounds: BoundsFile;
  props: PlacementsFile;
  spawns: SpawnPoint[];
  /** Hinged panels. `obstacles` is empty: a door is a gap, not a box. */
  doors: DoorsFile;
  /** Room placements, unmerged doors, and room obstacles. Omitted when there are no rooms. */
  rooms?: RoomsPlacementsFile;
  /** Room lights. Omitted when there are no rooms. */
  lights?: RoomsLightsFile;
  /** In memory only. Not written (scene-graph.json is a later task). */
  places: ScenePlace[];
  lines: string[];
};

const RESERVED_OUTPUTS = new Set([
  "bounds.json",
  "props.placements.json",
  "spawn-points.json",
  "doors.placements.json",
  "rooms.placements.json",
  "rooms.lights.json",
]);

export function bake(options: BakeOptions): BakeResult {
  const svgText = readText(options.svgPath);
  const assetTypes = options.gamePath ? readAssetTypes(readText(options.gamePath), options.gamePath) : new Map();
  const scene = readScene(svgText);
  if (!scene.sawBoundsLayer) throw new PlanError("bounds layer is missing");
  if (!scene.bounds) throw new PlanError("bounds layer has no rectangle");
  const bounds = boundsFile(scene.bounds);
  const placements = scene.placements;
  const modelsDir = options.modelsDir ?? DEFAULT_MODELS;
  const collisionDir = options.collisionDir ?? "buildings";
  const boxesByModel = new Map<string, ModelBake>();

  for (const model of new Set(placements.map((placement) => placement.model))) {
    if (!MODEL_RE.test(model)) throw new PlanError(`invalid model id "${model}"`);
    const geometry = geometryFor(options, modelsDir, model);
    const stencil = stencilBoxes(geometry.triangles);
    const size = stencilSize(stencil);
    const center = stencilCenter(stencil);
    const measured = measureBounds(geometry.triangles);
    const runs = stencilSize(measureFootprint(geometry.triangles));
    boxesByModel.set(model, {
      triangles: geometry.triangles,
      boxes: coarseFootprint(geometry.triangles).boxes,
      meshNames: geometry.meshNames,
      vertexCount: geometry.vertexCount,
      fromGlb: geometry.fromGlb,
      stencilWidth: size.width,
      stencilDepth: size.depth,
      stencilCenterX: center.x,
      stencilCenterZ: center.z,
      runWidth: runs.width,
      runDepth: runs.depth,
      ...measured,
    });
  }

  const scales = new Map<string, number>();
  const positions = new Map<string, Vec3>();
  const warnings: string[] = [];
  for (const placement of placements) {
    const model = boxesByModel.get(placement.model)!;
    const pose = poseForPlacement(placement, model, warnings);
    scales.set(placement.id, pose.scale);
    positions.set(placement.id, pose.position);
  }

  const file: PlacementsFile = {
    formatVersion: 1,
    units: "meters",
    placements: placements.map((placement) => stampPlacement({
      id: placement.id,
      model: placement.model,
      position: roundVec(positions.get(placement.id)!),
      yaw: placement.yaw,
      scale: roundM(scales.get(placement.id)!),
    }, assetTypes)),
    obstacles: [],
  };
  const assetFiles = options.gamePath ? readAssetFiles(readText(options.gamePath), options.gamePath) : new Map<string, string>();
  const scaledGrids = new Map<string, { triangles: Triangle[]; boxes: LocalBox[]; cellSize: number; facetsDropped: number }>();
  const gridFor = (placement: Placement): {
    model: ModelBake;
    grid: { triangles: Triangle[]; boxes: LocalBox[]; cellSize: number; facetsDropped: number };
  } => {
    const model = boxesByModel.get(placement.model);
    if (!model) throw new PlanError(`missing model "${placement.model}"`);
    const key = `${placement.model}\0${placement.scale}`;
    let grid = scaledGrids.get(key);
    if (!grid) {
      const triangles = scaleTriangles(model.triangles, placement.scale);
      const uncut = coarseFootprint(triangles);
      grid = { triangles, boxes: uncut.boxes, cellSize: uncut.cellSize, facetsDropped: uncut.facetsDropped };
      scaledGrids.set(key, grid);
    }
    return { model, grid };
  };
  // Model-scoped scene doors become one leaf per placement before floors
  // claim ids. Floors doors are already expanded and stay model-scoped.
  scene.doors = resolveExteriorDoors(
    scene.doors,
    file.placements,
    (placement) => gridFor(placement).grid.boxes.map((box) => placeBox(box, placement.position, placement.yaw)),
    new Set([
      ...file.placements.map((placement) => placement.id),
      ...scene.props.map((prop) => prop.id),
    ]),
  );
  const floors: FloorBake | undefined = options.floorsDir
    ? loadFloors({
      floorsDir: options.floorsDir,
      roomsDir: options.roomsDir,
      buildings: file.placements,
      taken: new Set([
        ...file.placements.map((placement) => placement.id),
        ...scene.props.map((prop) => prop.id),
        ...scene.doors.map((door) => door.id),
      ]),
      assets: new Set([...assetTypes.keys(), ...assetFiles.keys()]),
      assetTypes,
      warnings,
      measures: new Map([...boxesByModel].map(([model, baked]) => [model, {
        width: baked.runWidth,
        depth: baked.runDepth,
      }])),
    })
    : undefined;
  if (floors) {
    scene.doors.push(...floors.doors);
    scene.props.push(...floors.props);
  }
  const derived = scenePlaces(options, file.placements, new Set([
    ...file.placements.map((placement) => placement.id),
    ...scene.props.map((prop) => prop.id),
    ...scene.doors.map((door) => door.id),
  ]), new Map([...boxesByModel].map(([model, baked]) => [model, {
    width: baked.runWidth,
    depth: baked.runDepth,
  }])));
  scene.places = derived.places;
  warnings.push(...derived.warnings);
  const propBoxes = new Map<string, LocalBox | undefined>();
  for (const prop of scene.props) {
    if (propBoxes.has(prop.model)) continue;
    propBoxes.set(prop.model, loadPropBox(options, modelsDir, prop.model));
  }
  const props: PlacementsFile = {
    formatVersion: 1,
    units: "meters",
    placements: scene.props.map((prop) => stampPlacement({
      id: prop.id,
      model: prop.model,
      position: roundVec(prop.position),
      yaw: prop.yaw,
      scale: roundM(prop.scale),
    }, assetTypes)),
    obstacles: scene.props.map((prop) => propObstacle(prop, propBoxes.get(prop.model))),
  };
  const spawns: SpawnPoint[] = scene.spawns.map((spawn) => ({
    id: spawn.id,
    x: roundM(spawn.position[0]),
    y: 0,
    z: roundM(spawn.position[2]),
    yaw: spawn.yaw,
  }));
  const doorPlacements: DoorPlacement[] = [];
  const roomDoorPlacements: DoorPlacement[] = [];
  const doorWidths = new Map<string, number | undefined>();
  for (const door of scene.doors) {
    if (!doorWidths.has(door.model)) doorWidths.set(door.model, loadDoorPanelWidth(modelsDir, door.model, assetFiles, warnings));
  }
  const lines: string[] = [...warnings];
  for (const [model, baked] of boxesByModel) {
    if (baked.fromGlb) lines.push(meshLine(model, baked));
  }
  const openingsByModel = new Map<string, CutOpening[][]>();
  const placementOnlyModels = new Set<string>();
  const modelScopedDoors: { buildingId: string; door: DoorPlacement }[] = [];
  const floorsDoorIds = new Set(floors?.doors.map((door) => door.id) ?? []);
  const sceneSvg = path.resolve(options.svgPath);
  for (const placement of file.placements) {
    const { model, grid } = gridFor(placement);
    const mine = scene.doors.filter((door) => door.building === placement.id);
    let boxes = grid.boxes;
    const facetsDropped = grid.facetsDropped;
    const situated: DoorPlacement[] = [];
    let situatedDoors: ReturnType<typeof situateDoor>[] = [];
    const modelOpenings: CutOpening[] = [];
    if (mine.length > 0) {
      const worldBoxes = grid.boxes.map((box) => placeBox(box, placement.position, placement.yaw));
      situatedDoors = mine.map((door) => situateDoor(door, worldBoxes, doorWidths.get(door.model)));
      for (let index = 0; index < situatedDoors.length; index += 1) {
        const door = situatedDoors[index]!;
        const source = mine[index]!;
        // Measure the volume before the boxes are split. The punch is that
        // volume, including a skin proud of the hinge, not the 2 m stamp.
        const cutLocal = doorCutLocal(boxes, door, placement.position, placement.yaw);
        boxes = cutDoorFromBoxes(boxes, door, placement.position, placement.yaw);
        const stamped = stampPlacement(roundDoor(door.placement), assetTypes);
        doorPlacements.push(stamped);
        situated.push(stamped);
        // Only a model-scoped opening may punch the shared mesh. A
        // placement-scoped leaf cuts this instance's boxes and stops there.
        // A room door on this wall is added after placeRoomDoors, from the
        // same door-local volume.
        if (source.bind === "model") {
          const fromFloors = floorsDoorIds.has(source.id);
          if (cutLocal) {
            pushOpening(modelOpenings, {
              id: source.id,
              source: fromFloors ? "floors" : "scene",
              file: fromFloors
                ? path.resolve(options.floorsDir!, `${placement.model}.floors.svg`)
                : sceneSvg,
              box: extendSkinToFacade(
                model.triangles,
                boxInModel(door.placement, cutLocal, placement.position, placement.yaw, placement.scale),
              ),
            });
          }
          modelScopedDoors.push({ buildingId: placement.id, door: stamped });
        } else {
          placementOnlyModels.add(placement.model);
        }
      }
    }
    const groups = openingsByModel.get(placement.model) ?? [];
    groups.push(modelOpenings);
    openingsByModel.set(placement.model, groups);
    // Room obstacles are already world AABBs. The same opening that cut the
    // building shell has to leave the room wall, including a solid face that
    // never had its own room door.
    if (floors && situatedDoors.length > 0) cutRoomWalls(floors.obstacles, placement.id, situatedDoors);
    const rooms = floors?.buildings.get(placement.id);
    const pieceCount = rooms && rooms.interiors.length > 0
      ? emitHollow(file, placement.id, boxes, placement.position, placement.yaw, rooms.interiors)
      : emitPlaced(file, placement.id, boxes, placement.position, placement.yaw);
    if (rooms && floors) {
      const placed = placeRoomDoors(rooms.pending, situated, assetTypes, lines, {
        buildingId: placement.id,
        rooms: floors.obstacles,
        buildings: file.obstacles,
      });
      roomDoorPlacements.push(...placed.placements);
      for (const cut of placed.wallCuts) {
        pushOpening(modelOpenings, {
          id: cut.id,
          source: "room",
          file: path.resolve(cut.file),
          box: extendSkinToFacade(
            model.triangles,
            boxInModel(cut.placement, cut.local, placement.position, placement.yaw, placement.scale),
          ),
        });
      }
    }
    lines.push(instanceLine(placement.id, model.meshNames, placement.scale, grid.cellSize, pieceCount, facetsDropped));
  }
  const doors: DoorsFile = {
    formatVersion: 1,
    units: "meters",
    placements: doorPlacements,
    obstacles: [],
  };

  const outputs = layerPaths(options.outPath);
  mkdirSync(path.dirname(path.resolve(outputs.buildings)), { recursive: true });
  writeJson(outputs.buildings, file);
  writeJson(outputs.bounds, bounds);
  writeJson(outputs.props, props);
  writeJson(outputs.spawns, spawns);
  writeJson(outputs.doors, doors);
  lines.push(`wrote ${outputs.buildings}`);
  lines.push(`wrote ${outputs.bounds}`);
  lines.push(`wrote ${outputs.props}`);
  lines.push(`wrote ${outputs.spawns}`);
  lines.push(`wrote ${outputs.doors}`);

  let roomsFile: RoomsPlacementsFile | undefined;
  let lightsFile: RoomsLightsFile | undefined;
  if (floors && floors.roomCount > 0) {
    cutBlockedRoomMeshes(
      modelsDir,
      modelScopedDoors,
      floors.placements,
      new Set([...assetTypes.keys(), ...assetFiles.keys()]),
      lines,
    );
    roomsFile = {
      formatVersion: 1,
      units: "meters",
      placements: [...floors.placements, ...roomDoorPlacements],
      obstacles: floors.obstacles,
    };
    lightsFile = { formatVersion: 1, units: "meters", lights: floors.lights };
    writeJson(outputs.rooms, roomsFile);
    writeJson(outputs.lights, lightsFile);
    lines.push(`wrote ${outputs.rooms}`);
    lines.push(`wrote ${outputs.lights}`);
  }

  lines.push(
    `bake-inputs svg=${sceneSvg} floors=${options.floorsDir ? path.resolve(options.floorsDir) : "none"} rooms=${options.roomsDir ? path.resolve(options.roomsDir) : "none"}`,
  );
  for (const [model, groups] of openingsByModel) {
    for (const group of groups) {
      for (const opening of group) lines.push(cutOpenLine(model, opening));
    }
    const shared = sharedOpenings(groups);
    lines.push(`cut-shared ${model} ${shared.length}`);
    const baked = boxesByModel.get(model);
    if (!baked?.fromGlb) continue;
    const anyModelDoor = groups.some((group) => group.length > 0);
    if (!anyModelDoor) {
      // Placement-scoped openings never enter the shared mesh. Warn when
      // another copy of the model would have shown a hole it does not have.
      if (placementOnlyModels.has(model) && groups.length > 1) {
        lines.push(
          `warning: ${model}: external doors are not on every placement; the shared mesh is left whole`,
        );
      }
      // The live list is empty. A cut written for doors that have since been
      // removed would keep those holes. Replace it with the uncut mesh.
      rewriteEmptyCut(modelsDir, model, lines);
      continue;
    }
    if (shared.length === 0) {
      lines.push(
        `warning: ${model}: external doors are not on every placement; the shared mesh is left whole`,
      );
      rewriteEmptyCut(modelsDir, model, lines);
      continue;
    }
    const widest = Math.max(...groups.map((group) => group.length));
    if (shared.length < widest) {
      lines.push(`warning: ${model}: cut keeps ${shared.length} openings shared by every placement`);
    }
    lines.push(`wrote ${writeBuildingCut(modelsDir, model, shared, lines)}`);
  }

  mkdirSync(collisionDir, { recursive: true });
  for (const [model, baked] of boxesByModel) {
    const boxes = baked.boxes;
    const collision: CollisionFile = {
      id: model,
      origin: [0, 0, 0],
      yawConvention: "y-up-90",
      boxes: boxes.map((box, index) => ({
        id: `wall-${index}`,
        minX: roundM(box.minX),
        maxX: roundM(box.maxX),
        minZ: roundM(box.minZ),
        maxZ: roundM(box.maxZ),
      })),
    };
    const collisionPath = path.join(collisionDir, `${model}.collision.json`);
    writeJson(collisionPath, collision);
    lines.push(`wrote ${collisionPath}`);
  }
  const floorsScales = floorsScaleByModel(options.floorsDir, boxesByModel.keys());
  for (const placement of placements) {
    lines.push(scaleReport(placement, boxesByModel.get(placement.model)!, scales.get(placement.id)!, floorsScales.get(placement.model)));
  }
  return {
    file,
    bounds,
    props,
    spawns,
    doors,
    places: scene.places,
    lines,
    ...(roomsFile && lightsFile ? { rooms: roomsFile, lights: lightsFile } : {}),
  };
}

function scenePlaces(
  options: BakeOptions,
  buildings: readonly Placement[],
  taken: ReadonlySet<string>,
  measures: ReadonlyMap<string, { width: number; depth: number }>,
): { places: ScenePlace[]; warnings: string[] } {
  if (!options.floorsDir) return { places: [], warnings: [] };
  const floorsDir = options.floorsDir;
  const roomsDir = options.roomsDir;
  return derivePlaces({
    buildings,
    measures,
    floorsFor: (model) => {
      const floorsPath = path.join(floorsDir, `${model}.floors.svg`);
      if (!existsSync(floorsPath)) return undefined;
      return readFloorsSvg(readText(floorsPath));
    },
    roomFileFor: (prefab) => {
      if (!roomsDir) return undefined;
      const filePath = path.join(roomsDir, `${prefab}.room.json`);
      if (!existsSync(filePath)) return undefined;
      return JSON.parse(readText(filePath)) as RoomFile;
    },
    taken,
  });
}

/**
 * World obstacles for a building with no room interior. `placeBox` then
 * `roundVec`, the same path bake used before floors files.
 */
function emitPlaced(
  file: PlacementsFile,
  id: string,
  boxes: readonly LocalBox[],
  position: Vec3,
  yaw: Yaw,
): number {
  boxes.forEach((box, index) => {
    const placed = placeBox(box, position, yaw);
    file.obstacles.push({
      id: `${id}-wall-${index}`,
      kind: "aabb",
      min: roundVec(placed.min),
      max: roundVec(placed.max),
    });
  });
  return boxes.length;
}

/**
 * Place each cut box in world, then subtract room interiors. The pieces are
 * already world AABBs; they are not passed through `placeBox` again.
 */
function emitHollow(
  file: PlacementsFile,
  id: string,
  boxes: readonly LocalBox[],
  position: Vec3,
  yaw: Yaw,
  interiors: readonly LocalBox[],
): number {
  let pieces: LocalBox[] = boxes.map((box) => {
    const placed = placeBox(box, position, yaw);
    return {
      minX: placed.min[0],
      maxX: placed.max[0],
      minY: placed.min[1],
      maxY: placed.max[1],
      minZ: placed.min[2],
      maxZ: placed.max[2],
    };
  });
  for (const interior of interiors) {
    pieces = pieces.flatMap((box) => subtractBox(box, interior));
  }
  pieces.forEach((box, index) => {
    file.obstacles.push({
      id: `${id}-wall-${index}`,
      kind: "aabb",
      min: roundVec([box.minX, box.minY, box.minZ]),
      max: roundVec([box.maxX, box.maxY, box.maxZ]),
    });
  });
  return pieces.length;
}

type CutOpening = {
  id: string;
  source: "scene" | "floors" | "room";
  file: string;
  box: LocalBox;
};

function pushOpening(list: CutOpening[], opening: CutOpening): void {
  if (list.some((other) => sameOpening(other.box, opening.box))) return;
  list.push(opening);
}

function cutOpenLine(model: string, opening: CutOpening): string {
  const box = opening.box;
  const n = (value: number) => value.toFixed(4);
  const aabb = [box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ].map(n).join(",");
  return `cut-open ${model} id=${opening.id} source=${opening.source} file=${opening.file} aabb=${aabb}`;
}

/**
 * A previous `<model>.cut.glb` is replaced when this bake's shared list is
 * empty. No file is created when there was none: a model that never had a
 * shared opening stays on its source GLB.
 */
function rewriteEmptyCut(modelsDir: string, model: string, lines: string[]): void {
  const cutPath = path.join(modelsDir, `${model}.cut.glb`);
  if (!existsSync(cutPath)) return;
  lines.push(`wrote ${writeBuildingCut(modelsDir, model, [], lines)}`);
}

/**
 * Openings present on every placement of one model. Static instances share
 * one mesh, so a door that only one copy has cannot be a hole in that mesh.
 */
function sharedOpenings(groups: readonly (readonly CutOpening[])[]): CutOpening[] {
  const first = groups[0];
  if (!first) return [];
  return first.filter((opening) => groups.every((group) => group.some((other) => sameOpening(opening.box, other.box))));
}

function sameOpening(a: LocalBox, b: LocalBox): boolean {
  const eps = 1e-4;
  return Math.abs(a.minX - b.minX) < eps && Math.abs(a.maxX - b.maxX) < eps
    && Math.abs(a.minY - b.minY) < eps && Math.abs(a.maxY - b.maxY) < eps
    && Math.abs(a.minZ - b.minZ) < eps && Math.abs(a.maxZ - b.maxZ) < eps;
}

/**
 * A model-scoped exterior door that still hits a room mesh is punched out of
 * a shared variant of that mesh. Instances the door does not block keep the
 * original GLB, so an interior copy of the same prefab is not holed.
 * The variant id is `<model>.open` (then `.open-2`, …). The source GLB is
 * not modified. A missing game-file asset is reported as a JSON line.
 */
function cutBlockedRoomMeshes(
  modelsDir: string,
  doors: readonly { buildingId: string; door: DoorPlacement }[],
  placements: readonly Placement[],
  knownAssets: ReadonlySet<string>,
  lines: string[],
): void {
  const rooms = placements.filter(isRoomMesh);
  const byModel = new Map<string, Placement[]>();
  for (const room of rooms) {
    const group = byModel.get(room.model) ?? [];
    group.push(room);
    byModel.set(room.model, group);
  }
  for (const [model, group] of byModel) {
    const source = path.join(modelsDir, `${model}.glb`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch {
      continue;
    }
    const probe = meshProbe(bytes);
    const signed = group.map((room) => ({
      room,
      openings: blockedOpenings(doors, room, probe),
    }));
    const signatures = [...new Set(signed.map((item) => openingSignature(item.openings)).filter((sig) => sig !== ""))].sort();
    const variantOf = new Map<string, string>();
    signatures.forEach((sig, index) => {
      variantOf.set(sig, signatures.length === 1 ? `${model}.open` : `${model}.open-${index + 1}`);
    });
    const written = new Set<string>();
    for (const item of signed) {
      const sig = openingSignature(item.openings);
      const variant = variantOf.get(sig);
      if (!variant) continue;
      if (!written.has(variant)) {
        const outPath = path.join(modelsDir, `${variant}.glb`);
        writeFileSync(outPath, cutBuildingGlb(bytes, item.openings));
        written.add(variant);
        lines.push(`wrote ${outPath}`);
        if (!knownAssets.has(variant)) {
          lines.push(
            `{"id":"${variant}","kind":"model","type":"room","instance":"static","uri":"/assets/models/${variant}.glb","mediaType":"model/gltf-binary"}`,
          );
        }
      }
      item.room.model = variant;
    }
  }
}

function isRoomMesh(placement: Placement): boolean {
  if (placement.type === "room") return true;
  if (placement.type !== undefined) return false;
  return placement.model === "room" || placement.model.startsWith("room-");
}

/**
 * Model-scoped doors of this room's building whose clear volume covers most
 * of the room's height and whose inward ray still hits the room mesh.
 */
function blockedOpenings(
  doors: readonly { buildingId: string; door: DoorPlacement }[],
  room: Placement,
  probe: MeshProbe,
): LocalBox[] {
  const openings: LocalBox[] = [];
  for (const leaf of doors) {
    if (!room.id.startsWith(`${leaf.buildingId}.`)) continue;
    const opening = openingInModel(leaf.door, room.position, room.yaw, room.scale);
    const height = opening.maxY - opening.minY;
    const overlap = Math.min(opening.maxY, probe.maxY) - Math.max(opening.minY, 0);
    if (!(overlap > height * 0.5)) continue;
    const worldIn = transformXz(0, -1, leaf.door.yaw);
    const inward = transformXz(worldIn.x, worldIn.z, inverseYaw(room.yaw));
    const axis: 0 | 2 = Math.abs(inward.x) >= Math.abs(inward.z) ? 0 : 2;
    const direction: -1 | 1 = (axis === 0 ? inward.x : inward.z) >= 0 ? 1 : -1;
    if (!probe.blocks(opening, axis, direction)) continue;
    openings.push(opening);
  }
  return openings;
}

function openingSignature(openings: readonly LocalBox[]): string {
  const q = (n: number) => Math.round(n * 1e4) / 1e4;
  return openings
    .map((box) => [box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ].map(q).join(","))
    .sort()
    .join(";");
}

/** `<model>.cut.glb` beside the source. The source file is not modified. */
function writeBuildingCut(modelsDir: string, model: string, openings: readonly CutOpening[], lines: string[]): string {
  const source = path.join(modelsDir, `${model}.glb`);
  const outPath = path.join(modelsDir, `${model}.cut.glb`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(source);
  } catch {
    throw new PlanError(`${model}: cannot read ${source}`);
  }
  if (openings.length > 0) {
    const removed = openingOverlapCounts(bytes, openings.map((opening) => opening.box));
    openings.forEach((opening, index) => {
      lines.push(`cut-tris ${model} id=${opening.id} removed=${removed[index] ?? 0}`);
    });
  }
  const cut = openings.length === 0 ? uncutBuildingGlb(bytes) : cutBuildingGlb(bytes, openings.map((opening) => opening.box));
  writeFileSync(outPath, cut);
  return outPath;
}

function roundDoor(door: DoorPlacement): DoorPlacement {
  return {
    ...door,
    position: roundVec(door.position),
    size: roundVec(door.size),
  };
}

function layerPaths(outPath: string): {
  buildings: string;
  bounds: string;
  props: string;
  spawns: string;
  doors: string;
  rooms: string;
  lights: string;
} {
  const base = path.basename(outPath);
  if (RESERVED_OUTPUTS.has(base)) {
    throw new PlanError(`--out is the buildings file; ${base} is written beside it`);
  }
  const dir = path.dirname(outPath);
  return {
    buildings: outPath,
    bounds: path.join(dir, "bounds.json"),
    props: path.join(dir, "props.placements.json"),
    spawns: path.join(dir, "spawn-points.json"),
    doors: path.join(dir, "doors.placements.json"),
    rooms: path.join(dir, "rooms.placements.json"),
    lights: path.join(dir, "rooms.lights.json"),
  };
}

/**
 * One world AABB for a prop. The box is the GLB bounds, origin at the bottom
 * center, multiplied by the placement scale, then turned and moved.
 * A model that was not loaded uses the SVG rectangle instead.
 * Do not grow either box by the pawn radius. The solver already pushes a
 * 0.5 m capsule out of the AABB, so padding here would double-count.
 */
function propObstacle(prop: SceneProp, modelBox: LocalBox | undefined): PlacementsFile["obstacles"][number] {
  const local = modelBox ? scaleBox(modelBox, prop.scale) : rectangleBox(prop);
  const placed = placeBox(local, prop.position, prop.yaw);
  return {
    id: `${prop.id}-box`,
    kind: "aabb",
    min: roundVec(placed.min),
    max: roundVec(placed.max),
  };
}

/** GLB bounds for a prop. A test stand-in wins. A missing file is no box. */
function loadPropBox(options: BakeOptions, modelsDir: string, model: string): LocalBox | undefined {
  if (!MODEL_RE.test(model)) throw new PlanError(`invalid model id "${model}"`);
  if (options.walls && Object.prototype.hasOwnProperty.call(options.walls, model)) {
    return boundsBox(model, geometryFor(options, modelsDir, model).triangles);
  }
  const glbPath = path.join(modelsDir, `${model}.glb`);
  if (!existsSync(glbPath)) return undefined;
  return boundsBox(model, loadGlb(modelsDir, model, undefined).triangles);
}

/** A mesh that may be the swinging panel when no mesh is named exactly `door`. */
const PANEL_NAME_RE = /door|panel|leaf/i;
const FRAME_NAME_RE = /frame|jamb|stile|rail|lintel|sill/i;

/**
 * Panel width of a door model, from its GLB in `modelsDir`. The arena mounts
 * that GLB unscaled, so the opening takes this width, not the drawn rectangle.
 *
 * The file is `<model>.glb`, else the file named by that asset's `uri` in
 * `arena.game.json` (`door-1` → `door1.glb`). The panel is the mesh named
 * `door` (what `prop --shape door` writes), else meshes whose node or mesh
 * name has door/panel/leaf and not frame/jamb/stile/rail/lintel/sill.
 *
 * Undefined when no GLB or no panel is found. Then the drawn rectangle (or
 * `data-width`) is used, and a `warning:` line says why and where it looked.
 */
function loadDoorPanelWidth(
  modelsDir: string,
  model: string,
  assetFiles: ReadonlyMap<string, string>,
  lines: string[],
): number | undefined {
  if (!MODEL_RE.test(model)) throw new PlanError(`invalid model id "${model}"`);
  const names = [`${model}.glb`];
  const declared = assetFiles.get(model);
  if (declared && !names.includes(declared)) names.push(declared);
  const found = names.find((name) => existsSync(path.join(modelsDir, name)));
  const where = path.resolve(modelsDir);
  if (!found) {
    lines.push(
      `warning: door model "${model}": no GLB in ${where} (tried ${names.join(", ")}); `
      + "openings use the drawn rectangle width. Pass --models <dir with the door GLB>"
      + (declared ? "" : " or --game <arena.game.json> so its asset uri is used"),
    );
    return undefined;
  }
  const glbPath = path.join(modelsDir, found);
  const bytes = readGlbBytes(model, glbPath);
  const exact = panelTriangles(model, bytes, (node, mesh) => node === "door" || mesh === "door");
  if (exact.triangles.length > 0) {
    const width = doorPanelWidth(exact.triangles);
    if (width !== undefined) {
      lines.push(`door model "${model}": panel ${roundM(width)} m from ${glbPath}`);
      return width;
    }
  }
  const named = (name: string | undefined) => typeof name === "string" && PANEL_NAME_RE.test(name) && !FRAME_NAME_RE.test(name);
  const loose = panelTriangles(model, bytes, (node, mesh) => named(node) || named(mesh));
  const width = loose.triangles.length > 0 ? doorPanelWidth(loose.triangles) : undefined;
  if (width !== undefined) {
    lines.push(`door model "${model}": panel ${roundM(width)} m from ${glbPath} (meshes ${loose.meshNames.join(", ")}; no mesh named "door")`);
    return width;
  }
  lines.push(
    `warning: door model "${model}": ${glbPath} has no panel mesh (named "door", or door/panel/leaf); `
    + "openings use the drawn rectangle width",
  );
  return undefined;
}

function readGlbBytes(model: string, glbPath: string): Buffer {
  try {
    return readFileSync(glbPath);
  } catch {
    throw new PlanError(`${model}: cannot read ${glbPath}`);
  }
}

function panelTriangles(
  model: string,
  bytes: Buffer,
  meshFilter: (nodeName: string | undefined, meshName: string | undefined) => boolean,
): GlbLoad {
  try {
    return trianglesFromGlb(bytes, { meshFilter });
  } catch (err) {
    if (err instanceof PlanError) throw new PlanError(`${model}: ${err.message}`);
    throw err;
  }
}

function boundsBox(model: string, triangles: Triangle[]): LocalBox {
  const bounds = boundsOfTriangles(triangles);
  if (!bounds) throw new PlanError(`${model}: no triangle position data`);
  return {
    minX: bounds.min[0],
    maxX: bounds.max[0],
    minY: bounds.min[1],
    maxY: bounds.max[1],
    minZ: bounds.min[2],
    maxZ: bounds.max[2],
  };
}

/** Scale about the model origin, the same scalar the mesh uses. */
function scaleBox(box: LocalBox, scale: number): LocalBox {
  return {
    minX: box.minX * scale,
    maxX: box.maxX * scale,
    minY: box.minY * scale,
    maxY: box.maxY * scale,
    minZ: box.minZ * scale,
    maxZ: box.maxZ * scale,
  };
}

/** Drawn rectangle when the model file is absent. Width and depth already include its scale. */
function rectangleBox(prop: SceneProp): LocalBox {
  const minY = prop.minY ?? 0;
  const maxY = prop.maxY ?? minY;
  if (maxY < minY) throw new PlanError(`prop "${prop.id}" maxY must exceed minY`);
  return {
    minX: -prop.drawnWidth / 2,
    maxX: prop.drawnWidth / 2,
    minY,
    maxY,
    minZ: -prop.drawnDepth / 2,
    maxZ: prop.drawnDepth / 2,
  };
}

function boundsFile(box: XzBounds): BoundsFile {
  const minY = box.minY ?? -2;
  const maxY = box.maxY ?? 12;
  if (!(maxY > minY)) throw new PlanError("bounds maxY must exceed minY");
  return {
    minX: roundM(box.minX),
    maxX: roundM(box.maxX),
    minY: roundM(minY),
    maxY: roundM(maxY),
    minZ: roundM(box.minZ),
    maxZ: roundM(box.maxZ),
  };
}

function geometryFor(options: BakeOptions, modelsDir: string, model: string): GlbLoad & { fromGlb: boolean } {
  const supplied = options.walls?.[model];
  if (supplied) {
    if (supplied.length === 0) throw new PlanError(`${model}: no triangle position data`);
    return { triangles: [...supplied], meshNames: [], vertexCount: 0, fromGlb: false };
  }
  return { ...loadGlb(modelsDir, model, options.meshPrefix), fromGlb: true };
}

/**
 * Where the GLB origin goes and its uniform scale.
 *
 * A copied stencil group keeps the model origin at the group origin and the
 * group's uniform scale. Floors reads that same matrix scale. The scale is
 * not drawn size over the vertex extent: a lip the measure grid drops makes
 * those two axes disagree, and averaging them misses the floors scale.
 * Axes that disagree by more than 1% add a warning that names each fit
 * (drawn metres / vertex extent). The group scale is still the one used.
 *
 * Any other placement (a rectangle, or a group of rectangles) is drawn around
 * the thin-triangle stencil extent. The scale is drawn size over that extent,
 * the average of the two axes. The same 1% warning applies, and the average
 * is used. The drawn center is the extent's center, so the origin is the
 * drawn center minus the turned, scaled offset of that center from the origin.
 *
 * Check: a 2 m rectangle centered at x 10 for a 1 m stencil whose extent is
 * x 0..1 (center 0.5) at yaw 0: scale 2, origin x 10 − 2 × 0.5 = 9.
 */
function poseForPlacement(
  placement: PlanPlacement,
  model: ModelBake,
  warnings: string[],
): { position: Vec3; scale: number } {
  if (placement.stencil) {
    const scale = placement.stencil.scale;
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new PlanError(`placement "${placement.id}" scale is not positive`);
    }
    noteAxisFit(placement, model.measureWidth, model.measureDepth, scale, warnings, true);
    return { position: placement.stencil.origin, scale };
  }
  if (model.stencilWidth < 1e-9 || model.stencilDepth < 1e-9) return { position: placement.position, scale: 1 };
  const scale = scaleForPlacement(placement, model.stencilWidth, model.stencilDepth, warnings);
  const offset = transformXz(model.stencilCenterX * scale, model.stencilCenterZ * scale, placement.yaw);
  return {
    position: [placement.position[0] - offset.x, placement.position[1], placement.position[2] - offset.z],
    scale,
  };
}

/** Drawn metres over the model extent. One uniform scale, the average of the axes. */
function scaleForPlacement(placement: PlanPlacement, width: number, depth: number, warnings: string[]): number {
  const fit = axisFit(placement, width, depth);
  const scale = (fit.sx + fit.sz) / 2;
  if (Math.abs(fit.sx - fit.sz) > 0.01 * scale) {
    warnings.push(axisWarning(placement, width, depth, fit.sx, fit.sz, trimNum(scale)));
  }
  return scale;
}

/**
 * Per-axis drawn/vertex fits. `group` keeps `used` (the stencil matrix scale)
 * when the axes disagree. The warning names the drawn metres and the vertex
 * extent each fit came from.
 */
function noteAxisFit(
  placement: PlanPlacement,
  width: number,
  depth: number,
  used: number,
  warnings: string[],
  group: boolean,
): void {
  const fit = axisFit(placement, width, depth);
  const span = (fit.sx + fit.sz) / 2;
  if (Math.abs(fit.sx - fit.sz) <= 0.01 * span) return;
  const via = group ? `group scale ${trimNum(used)}` : trimNum(used);
  warnings.push(axisWarning(placement, width, depth, fit.sx, fit.sz, via));
}

function axisFit(placement: PlanPlacement, width: number, depth: number): { sx: number; sz: number } {
  if (width < 1e-9 || depth < 1e-9) throw new PlanError(`placement "${placement.id}" model has no footprint`);
  const sx = placement.drawnWidth / width;
  const sz = placement.drawnDepth / depth;
  if (!Number.isFinite(sx) || !Number.isFinite(sz) || sx <= 0 || sz <= 0) {
    throw new PlanError(`placement "${placement.id}" scale is not positive`);
  }
  return { sx, sz };
}

function axisWarning(
  placement: PlanPlacement,
  width: number,
  depth: number,
  sx: number,
  sz: number,
  via: string,
): string {
  return `warning: placement "${placement.id}" drawn size is not the model's proportions `
    + `(scale x ${trimNum(sx)} from drawn ${trimNum(placement.drawnWidth)} / mesh ${trimNum(width)}`
    + ` vs z ${trimNum(sz)} from drawn ${trimNum(placement.drawnDepth)} / mesh ${trimNum(depth)}); `
    + `using ${via}`;
}

function stencilCenter(boxes: readonly LocalBox[]): { x: number; z: number } {
  if (boxes.length === 0) return { x: 0, z: 0 };
  const minX = Math.min(...boxes.map((box) => box.minX));
  const maxX = Math.max(...boxes.map((box) => box.maxX));
  const minZ = Math.min(...boxes.map((box) => box.minZ));
  const maxZ = Math.max(...boxes.map((box) => box.maxZ));
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

function trimNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Uniform scale about the model origin. Node transforms are already in the vertices. */
function scaleTriangles(triangles: Triangle[], scale: number): Triangle[] {
  if (scale === 1) return triangles;
  return triangles.map(([a, b, c]) => [
    [a[0] * scale, a[1] * scale, a[2] * scale],
    [b[0] * scale, b[1] * scale, b[2] * scale],
    [c[0] * scale, c[1] * scale, c[2] * scale],
  ]);
}

function meshNames(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

function meshLine(model: string, baked: ModelBake): string {
  return `${model}: meshes ${meshNames(baked.meshNames)}; ${baked.vertexCount} vertices`;
}

function instanceLine(id: string, names: string[], scale: number, cellSize: number, count: number, facetsDropped: number): string {
  return `${id}: meshes ${meshNames(names)}; scale ${roundM(scale)}; cell ${cellSize} m; ${count} boxes; ${facetsDropped} facets dropped`;
}

function loadGlb(modelsDir: string, model: string, meshPrefix: string | undefined): GlbLoad {
  const glbPath = path.join(modelsDir, `${model}.glb`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(glbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new PlanError(`${model}: no GLB at ${glbPath}`);
    throw new PlanError(`${model}: cannot read ${glbPath}`);
  }
  try {
    return trianglesFromGlb(bytes, { meshPrefix });
  } catch (err) {
    if (err instanceof PlanError && !err.message.startsWith(`${model}:`)) {
      throw new PlanError(`${model}: ${err.message}`);
    }
    throw err;
  }
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new PlanError(`cannot read ${filePath}`);
  }
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function measureBounds(triangles: Triangle[]): Pick<ModelBake, "measureMinX" | "measureMaxX" | "measureMinZ" | "measureMaxZ" | "measureWidth" | "measureDepth"> {
  const bounds = boundsOfTriangles(triangles);
  if (!bounds) {
    return {
      measureMinX: 0,
      measureMaxX: 0,
      measureMinZ: 0,
      measureMaxZ: 0,
      measureWidth: 0,
      measureDepth: 0,
    };
  }
  const measureMinX = bounds.min[0];
  const measureMaxX = bounds.max[0];
  const measureMinZ = bounds.min[2];
  const measureMaxZ = bounds.max[2];
  return {
    measureMinX,
    measureMaxX,
    measureMinZ,
    measureMaxZ,
    measureWidth: measureMaxX - measureMinX,
    measureDepth: measureMaxZ - measureMinZ,
  };
}

function floorsScaleByModel(floorsDir: string | undefined, models: Iterable<string>): Map<string, number> {
  const scales = new Map<string, number>();
  if (!floorsDir) return scales;
  for (const model of models) {
    const floorsPath = path.join(floorsDir, `${model}.floors.svg`);
    if (!existsSync(floorsPath)) continue;
    scales.set(model, readFloorsSvg(readText(floorsPath)).scale);
  }
  return scales;
}

/** One line: measured GLB bounds, stencil size, drawn size, scale, floors scale. */
function scaleReport(placement: PlanPlacement, model: ModelBake, scale: number, floorsScale: number | undefined): string {
  const stencilW = placement.stencil ? placement.drawnWidth / placement.stencil.scale : model.stencilWidth;
  const stencilD = placement.stencil ? placement.drawnDepth / placement.stencil.scale : model.stencilDepth;
  const usedW = placement.stencil ? model.measureWidth : model.stencilWidth;
  const usedD = placement.stencil ? model.measureDepth : model.stencilDepth;
  const sx = usedW > 1e-9 ? placement.drawnWidth / usedW : 0;
  const sz = usedD > 1e-9 ? placement.drawnDepth / usedD : 0;
  const floors = floorsScale === undefined ? "none" : roundM(floorsScale);
  return `${placement.id}: measure ${roundM(model.measureMinX)}..${roundM(model.measureMaxX)} × ${roundM(model.measureMinZ)}..${roundM(model.measureMaxZ)}`
    + ` (${roundM(model.measureWidth)}×${roundM(model.measureDepth)})`
    + ` stencil ${roundM(stencilW)}×${roundM(stencilD)}`
    + ` drawn ${roundM(placement.drawnWidth)}×${roundM(placement.drawnDepth)}`
    + ` scaleForPlacement ${roundM(scale)} (x ${roundM(sx)} z ${roundM(sz)})`
    + ` floors.scale ${floors}`;
}

function roundM(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundVec(v: Vec3): Vec3 {
  return [roundM(v[0]), roundM(v[1]), roundM(v[2])];
}
