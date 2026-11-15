# AGENTS.md — blueprint-scene

CLI and library that bakes Inkscape SVGs plus GLBs into placement JSON and prop GLBs for conveyor-engine-arena (`measure`, `bake`, `prop --shape door|crate`, `room`). The arena installs it as a package and runs `npx blueprint-scene ...`.

Repo: `/home/tim/dev/blueprint-scene`. Work only in this repo unless the task names another path. Tasks live in `agents/` next to this file.
Node version: use /home/tim/.nvm/versions/node/v24.0.2/bin/node

## Find code fast
- **Codemap:** `/home/tim/dev/blueprint-scene/agents/codemap.md`. Read it before you open any source file.
- **Symbol index:** each line is the name in backticks, then `file:line kind`. Find a symbol in one step with `grep -n 'readScene' agents/codemap.md`.
- **Module sections:** each `src/` file has its `imports`, `used by` and exported signatures.
- **Reading:** go to the line the codemap gives and read only that range (about ±20 lines, or to the end of the function). Do not read whole files. Do not run broad `rg`/`grep` symbol searches over `src/`.
- Grep the source only when the codemap can't answer the question, for example a local helper or a call site inside a function, and limit the grep to the one file.
- If a task has a **Files** section, read only those files.

## Keeping the codemap current
- **Generator:** `scripts/codemap.ts`. It uses the TypeScript compiler API from the existing `typescript` dev dependency, so nothing new is installed. It parses only and does not typecheck.
- **Regenerate:** run `npm run codemap` from `/home/tim/dev/blueprint-scene` after you add, move, rename or delete a function, type, constant or file in `src/`. Run it last, after tests pass, so the line numbers match the final code. It rewrites `agents/codemap.md`.
- **Check:** `npm run codemap:check` exits 1 if `agents/codemap.md` is stale. Run it before you finish.
- **Options** (`node scripts/codemap.ts ...`):
  - All top-level functions, types, interfaces, classes and constants are listed, exported or not (local ones are marked `(local)`). `--exports-only` limits it to the public API.
  - `--max-sig <n>` sets the signature truncation.
  - `--root`, `--project` and `--out` override the defaults (repo root, `tsconfig.json`, `agents/codemap.md`).
- Do not hand-edit `agents/codemap.md`.

## Comment as contract
Comments carry what types cannot: *why*, *when*, and cross-call invariants. They are load-bearing, not decorative — the codemap extracts them and the per-task diff surfaces them. A stale comment is a bug.

**Module header.** Every module that exports more than one symbol opens with four labeled slots, one line each. Omit a slot rather than fill it with filler.
// TODO(B21): example

// ARCHITECTURE: <what this module is for, one sentence>.
// Wiring: <who constructs it, who calls it, what it composes>.
// Order: <load/init invariants a refactor would break>.
// Invariants: <state that must hold across calls and is not typed>.

**Tag vocabulary (closed set — additions need a consumer).**
- `@invariant` — must remain true across calls. Pair with an explicit `(test: <name>)` reference to an existing test in `test/`, or defer with `(test lands …)` if the test is scheduled for a later task. Silence is a bug; `test/contract-grep.test.ts` enforces this.
- `@pre` / `@post` — contracts the type cannot express: call order, required prior action.
- `@why` — the non-obvious choice; the "looks wrong but isn't". Highest-value tag.
- `@when` — lifecycle.
// TODO(B21): example
- `@see` — cross-reference the codemap can link.
- `@internal` — excluded from the exported surface.

Do not tag `@param` / `@returns` when the signature already says it. Do not restate the types.

**Editorial rule: why and when, not how.** "How it works" duplicates the body and rots fastest. If the *how* is non-obvious, the fix is a named type, a helper, or a test — not a comment. The exception is *how to use it* (calling convention), which is `@pre` / `@when`.

**Tag on touch.** When a task edits a file, bring that file's comments up to this standard as part of the task. No bulk pass — the touched surface becomes excellent, the rest stays honestly bare, and the codemap still lists signatures and reverse deps for it. Acceptance gate for every task that edits code: *codemap diff is reviewable and includes no unexplained comment churn*.

## Layout
Flat `src/`. The CLI is `src/cli.ts`. The bake entry is `src/bake.ts`.

- `src/cli.ts`: the entry point (`main(argv)`, `USAGE`). It dispatches to `bake.ts`, `measure.ts`, `prop.ts` (door GLB), `crate.ts` (crate GLB) and `room-svg.ts` (room, task R1 onward).
- `src/plan.ts`: SVG plan reading (layers, placements, scene, doors, props, page frame, transforms). `src/xml.ts` is a minimal XML parser, and its `attr` matches by local name, so `href` finds `xlink:href`.
- `src/bake.ts`: the bake pipeline, producing buildings/props/doors placements, `bounds.json` and `spawn-points.json`.
- `src/footprint.ts`: triangles to an XZ occupancy grid to AABB runs. `src/union.ts` makes box union rings, and `src/stencil.ts` computes stencil bounds.
- `src/doors.ts`: door placement and wall cutting. `src/yaw.ts`: quarter-turn transforms.
- `src/glb.ts` reads GLBs and `src/glb-write.ts` writes them. `src/asset-type.ts` reads the asset types in `arena.game.json`.
- `src/types.ts` holds the shared file and placement types, and `src/errors.ts` holds `PlanError`.
- `test/*.test.ts`: node:test suites, with fixtures in `test/fixtures/`. `test/crate.test.ts` has the `page()`, `markedPng()` and `dataUri()` helpers.
- `docs/commands-and-plan.md`: flags and plan layers. Read it only when a task points to it.

## Toolchain
- **Shell setup:** the shell starts in the arena repo, and PATH `node` is nvm v4.4.2, which cannot run this repo. Start every shell command with `cd /home/tim/dev/blueprint-scene && export PATH=/home/tim/.nvm/versions/node/v24.0.2/bin:$PATH &&`. That makes `node`, `npm` and `npx` the Node 24 versions.
- **Node binary:** where a command calls node directly, use `/home/tim/.nvm/versions/node/v24.0.2/bin/node` (for example, `/home/tim/.nvm/versions/node/v24.0.2/bin/node src/cli.ts room --svg ... --out ...`).
- **Node version:** Node 24.0.2 is the only version to use. Do not search for another or try v22.15.1, because it needs `--experimental-strip-types` and `bin/blueprint-scene` does not pass it.

## Conventions the codemap does not show
- **Plan frame:** world x = SVG x and world z = page height − SVG y (`svgPointToWorld`). Do not negate it again or add the page height a second time. World y comes from the `z` attribute.
- **Yaw:** degrees about +Y, the same as Three.js `rotation.y`. +90° sends model +X to world −Z. Yaw is snapped to 0/90/180/270 by the single `yawOf` in plan.ts plus `src/yaw.ts`; do not add a second mapping. A non-quarter-turn fails.
- **Crate faces:** `labeledDesign` in crate.ts. Front is +Z, right is +X, top is +Y, and the origin is the bottom-face centre. Spans are taken after `rotate()`, so a side face drawn under `rotate(-90)` has its width and height swapped. A missing opposite face reuses the drawn one. Textures are a PNG data URI or a path relative to the SVG.
- **Doors:** the model comes from `data-model` or `model:<id>` (there is no default). `z` is the sill in metres. The other attributes are `data-hinge` (left by default), `data-open`, `data-locked`, `data-key`, `data-width`, `data-height` and `data-depth`. A scene door needs `data-building`.
- **Bake:** validation runs before any write. Bake never writes `arena.game.json`, and it must not rename GLB nodes.

## Commands (run from /home/tim/dev/blueprint-scene)
- Test: `npm test` (`NODE_NO_WARNINGS=1 node --test test/*.test.ts`), with the PATH export above. Run a single suite with `NODE_NO_WARNINGS=1 /home/tim/.nvm/versions/node/v24.0.2/bin/node --test test/<name>.test.ts`.
- Typecheck: `npm run typecheck` (`tsc -p tsconfig.json --noEmit`, which includes `test/`).
- Build: `npm run build` (`tsc -p tsconfig.build.json`, output in `dist/`, which is the published `bin`). For a dev run, use `/home/tim/.nvm/versions/node/v24.0.2/bin/node src/cli.ts <command> ...`.
- Bake: `npm run bake` (`node src/cli.ts`). `prepare` runs `build`.
- Codemap: `npm run codemap`, then `npm run codemap:check`.

## Finishing a task
Before you finish:
1. Run `npm test`.
2. Run `npm run typecheck`.
3. Run `npm run codemap`.
4. Run `npm run codemap:check`.
5. Report the files you changed and the test count.

## Rules
- Published npm package used by arena. Do not edit conveyor-engine-arena from here.
- Bake output must stay byte-stable for unchanged inputs.
- Do not change the kernel (conveyor-engine-packages). This repo does not depend on it.
- Source is ESM and strict TS with `noUnusedLocals`/`noUnusedParameters`. Local imports use `.ts` extensions, which the build rewrites to `.js`.
- Use only erasable TS syntax (no enums, namespaces or parameter properties), so `node src/cli.ts` keeps working.
- Type stripping does not check types, so run `npm run typecheck` as well as `npm test`.
- Existing tests must pass unchanged unless the task says otherwise.
- Units: SVGs are 1 mm = 1 m, and world units are metres. The bake flips SVG y (world z = page height − y). Yaw is in degrees about +Y, snapped to 0/90/180/270.
- Ids match `ID_RE` (`[A-Za-z0-9][A-Za-z0-9_.-]*`), with no `:` or `/`.
- Do not add dependencies.
- Do not create files in `agents/` other than what the task asks for.
