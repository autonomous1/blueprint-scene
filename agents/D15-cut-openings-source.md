Read agents/AGENTS.md first. Then this file. Then agents/codemap.md only for symbols in the Files table.

**Do not read** `~/.grok/memory-v2/`, `~/.grok/memory/`, `~/.grok/bundled/skills/`, or any other Grok memory / topic / skill file.
**Do not open** `../conveyor-engine-packages` unless the Files table names a path there.
**Codemap:** at most one exact-symbol search from the Files table, then open that source file. Do not scroll or re-open codemap.md.

**Repos:** cut / rooms-bake / door open list in `/home/tim/dev/blueprint-scene`. Re-bake in `/home/tim/dev/conveyor-engine-arena`. Do not change conveyor-engine-packages. Do not read `~/.grok/memory-v2`.

**Task: D15 — Shared cut openings must follow current floors + scene exteriors only (follows D4/D8/D10/D14)**

### Problem
Building-2 (`brutalist-building-2-cbake`) still shows **two stacked facade cutouts** at the old exterior stations (ground `door-1-1-9-2`, upper landing `door-1-1-9-2-4`, sill ~2.75) after the user:
- removed those outer doors from the **scene plan** (`arena-1.svg` `doors` layer), **and**
- removed them from the **floorplan** (`brutalist-building-2-cbake.floors.svg` layer `doors-external`).

**Only `room-b.svg` still contains those doors** (as room prefab doors).

Ruled out (do not re-investigate): missed bake (cut + uncut GLB mtimes match → bake rewrote both), browser cache (hard reset done), scale (D14 fixed).

### Design (D4 / D8 / D10)
Shared `<model>.cut.glb` is punched **only** from model-scoped exteriors:
- floors `doors-external` (expanded `${placement}.${doorId}`), plus
- scene `doors` with `data-building` = model id (model-scoped per D8).

Room prefab doors (unmerged interior) must **NOT** punch the shared building mesh (D10). Merged room doors only reuse an existing external opening; they never create one.

With floors + scene exteriors empty for building-2, the cut should have **no** facade holes at those stations. Holes remain → cut source of truth is wrong. Suspects (prove, don't guess): room-b doors leaking into `openingsByModel` (e.g. room door merge/classify treating room-b doors as exterior, or room-b placement id matching model id); stale opening list / cache file reused by bake; leftover ids in `doors.placements.json` fed back into cut; bake reading a different SVG path than the one edited (unsaved Inkscape copy, `bake.sh --svg/--floors` path); floors parse falling back to another layer.

### Required
1. **Inventory** before changing code: log every opening that enters `openingsByModel` / `sharedOpenings` for `brutalist-building-2-cbake` — id, source (floors / scene / room / placements json / other), source file path, model-local AABB. Also log the actual `--svg`, `--floors`, `--rooms` paths bake reads.
2. **Prove** whether room-b doors are in the shared cut input. If yes, find the classify/merge step that lets them in.
3. **Fix** so the cut list is built live each bake from floors `doors-external` + scene model-scoped doors only. Empty exteriors → no punches; current exteriors → holes only at current stations. Room doors never add openings to the shared cut.
4. Room-b doors still work as **room doors** (collision/leaf/open behavior in rooms path unchanged).
5. Re-bake arena; confirm `.cut.glb` regenerated, `doors.placements.json` has no stale building-2 exterior leaves, game URI is `.cut.glb`.
6. Tests: (a) floors + scene exteriors empty, room prefab has doors → model has zero shared openings; (b) floors exterior moved → opening at new station only; (c) room door merged with an external → single opening, not duplicated. `npm test`, typecheck; arena `npm run bake:scene` / `bake.sh`.

### Acceptance (hard gate)
- With floors + scene exteriors removed, `brutalist-building-2-cbake.cut.glb` has **no** holes at old `door-1-1-9-2` / `door-1-1-9-2-4` stations (verify via bake log of opening list = empty for building-2, and play/visual check).
- Room-b doors still function as room doors.
- Bake regenerates the cut from the live list only; inventory log printed in report.
- Report: root cause (which source fed the stale openings), files changed, before/after opening list.

### Out of scope
D12 room-a.open (unless it feeds the cut list), scale/measure, hollow, D9 locks, z-fight.

### Files (read only these)
| File | Repo | Use |
|---|---|---|
| `src/building-mesh-cut.ts` | blueprint-scene | Punches openings into shared `.cut.glb`; log inputs. |
| `src/rooms-bake.ts` | blueprint-scene | Floors door expand, room door merge/classify — check room-b leak. |
| `src/bake.ts` `openingsByModel` / `sharedOpenings` | blueprint-scene | Builds shared cut list; ensure live sources only. |
| `src/floors-svg.ts` | blueprint-scene | `doors-external` parse. |
| doors module (scene door classify, D8 model-scoped) | blueprint-scene | Model vs placement vs room scope. |
| tests for cut / rooms-bake / doors | blueprint-scene | Cases (a)–(c). |
| `dev/scenes/arena-1/designs/arena-1.svg` `doors` layer | arena | Confirm building-2 exteriors gone. |
| `dev/scenes/arena-1/designs/floorplans/brutalist-building-2-cbake.floors.svg` `doors-external` | arena | Confirm empty / current. |
| `room-b.svg` | arena | Only remaining holder of those doors; must stay room-only. |
| `web/assets/models/brutalist-building-2-cbake.cut.glb` | arena | Output; holes gone. |
| `web/game/doors.placements.json` | arena | No stale building-2 exterior leaves. |
| `scripts/bake.sh` / `npm run bake:scene` | arena | Paths passed; re-bake. |
