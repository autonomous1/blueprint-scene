import { PlanError } from "./errors.ts";
import { ASSET_TYPES, type AssetType } from "./types.ts";

const ASSET_TYPE_SET: ReadonlySet<string> = new Set(ASSET_TYPES);

/**
 * Asset id to placement type, from `arena.game.json`.
 * `assets` may be an array of `{ id, type }` or an object of those records.
 * An asset with no type is absent from the map. `kind` (model or texture) is ignored.
 */
export function readAssetTypes(text: string, filePath: string): Map<string, AssetType> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new PlanError(`${filePath}: invalid json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new PlanError(`${filePath} has no assets`);
  const assets = (doc as { assets?: unknown }).assets;
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(assets)) {
    for (const item of assets) entries.push(["", item]);
  } else if (assets && typeof assets === "object") {
    for (const [key, item] of Object.entries(assets)) entries.push([key, item]);
  } else {
    throw new PlanError(`${filePath} has no assets`);
  }
  const types = new Map<string, AssetType>();
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { id?: unknown; type?: unknown };
    const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : key;
    if (!id) continue;
    if (rec.type === undefined || rec.type === null || rec.type === "") continue;
    if (typeof rec.type !== "string" || !ASSET_TYPE_SET.has(rec.type)) {
      throw new PlanError(`asset "${id}" type is not a placement type`);
    }
    types.set(id, rec.type as AssetType);
  }
  return types;
}

/**
 * Copy the asset type onto a placement, after `model`.
 * No asset type leaves the field off. A leftover `kind` is not written.
 */
export function stampPlacement<T extends { model: string }>(
  placement: T,
  types: ReadonlyMap<string, AssetType>,
): T {
  const type = types.get(placement.model);
  if (!type) {
    if (!("kind" in placement) && !("type" in placement)) return placement;
    const ordered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(placement)) {
      if (key === "kind" || key === "type") continue;
      ordered[key] = value;
    }
    return ordered as T;
  }
  const ordered: Record<string, unknown> = {};
  let wrote = false;
  for (const [key, value] of Object.entries(placement)) {
    if (key === "kind" || key === "type") continue;
    ordered[key] = value;
    if (key === "model") {
      ordered.type = type;
      wrote = true;
    }
  }
  if (!wrote) ordered.type = type;
  return ordered as T;
}
