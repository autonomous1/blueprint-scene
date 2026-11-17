import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { extractTags } from "../scripts/codemap.ts";

const ROOT = "src";
/** Documented exports on this crawl. Locked so a new JSDoc block is a visible count change. */
const DOCUMENTED_EXPORTS = 143;
/**
 * Documented exports that carry a rendered contract tag.
 * 138 of 143. Each tag is a sentence that was already in the prose.
 */
const BREADTH_FLOOR = 137;

type Export = {
  file: string;
  name: string;
  documented: boolean;
  tags: string[];
  jsdocTags: string[];
};

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(path);
    else if (ent.name.endsWith(".ts")) yield path;
  }
}

function exportedName(st: ts.Statement): string | undefined {
  if (!ts.canHaveModifiers(st)) return undefined;
  if (!(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
  if (ts.isVariableStatement(st)) {
    const first = st.declarationList.declarations[0];
    return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  }
  const named = st as ts.DeclarationStatement;
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

/** A variable's JSDoc may attach to the statement or to the declaration. Check both. */
function nodesOf(st: ts.Statement): ts.Node[] {
  return ts.isVariableStatement(st) ? [st, ...st.declarationList.declarations] : [st];
}

function scan(): Export[] {
  const out: Export[] = [];
  for (const file of [...walk(ROOT)].sort()) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
      const name = exportedName(st);
      if (!name) continue;
      const nodes = nodesOf(st);
      const documented = nodes.some((n) => ts.getJSDocCommentsAndTags(n).some((d) => ts.isJSDoc(d)));
      const tags = [...new Set(nodes.flatMap((n) => extractTags(n).map((t) => t.name)))];
      const jsdocTags = nodes.flatMap((n) => ts.getJSDocTags(n).map((t) => t.tagName.text));
      out.push({ file: relative(".", file), name, documented, tags, jsdocTags });
    }
  }
  return out;
}

/** @internal is extracted but never rendered, so it cannot satisfy coverage. */
const rendered = (e: Export): boolean => e.tags.some((t) => t !== "internal");
const key = (e: { file: string; name: string }): string => `${e.file}:${e.name}`;

/**
 * Documented exports whose prose is a summary with no contract to carry.
 * Each entry is the symbol key and the reason it stays prose.
 */
const SUMMARY_ONLY: ReadonlyArray<readonly [string, string]> = [
  ["src/floors-svg.ts:FloorPlatformSource", "names the element; the building-local frame is on readFloorsSvg"],
  ["src/rooms-bake.ts:buildingToWorld", "restates the function name"],
  ["src/rooms-bake.ts:mapBox", "describes the corner procedure"],
  ["src/types.ts:SceneSpawn", "names the layer the mark comes from"],
  ["src/union.ts:Aabb2", "names the shape"],
];

test("documented_export_count", () => {
  const documented = scan().filter((e) => e.documented);
  console.log(`documented exports: ${documented.length}`);
  assert.equal(documented.length, DOCUMENTED_EXPORTS);
});

test("documented_exports_are_tagged_or_listed", () => {
  const documented = scan().filter((e) => e.documented);
  const byKey = new Map(documented.map((e) => [key(e), e]));
  const listed = new Set(SUMMARY_ONLY.map(([k]) => k));
  const unexplained = documented.filter((e) => !rendered(e) && !listed.has(key(e))).map(key);
  const tagged = documented.filter(rendered).length;
  console.log(`tagged ${tagged} of ${documented.length}`);
  assert.deepEqual(unexplained, []);
  const bogus = SUMMARY_ONLY.filter(([k]) => !byKey.has(k) || rendered(byKey.get(k)!)).map(([k]) => k);
  assert.deepEqual(bogus, [], "SUMMARY_ONLY may only name documented, untagged exports");
  assert.equal(new Set(SUMMARY_ONLY.map(([k]) => k)).size, SUMMARY_ONLY.length, "SUMMARY_ONLY keys are unique");
  assert.ok(SUMMARY_ONLY.every(([, reason]) => reason.trim().length > 0), "each SUMMARY_ONLY entry needs a reason");
  assert.ok(tagged >= BREADTH_FLOOR, `only ${tagged} of ${documented.length} documented exports carry a tag`);
});

test("has_no_param_or_returns_tags", () => {
  const bad = scan().flatMap((e) =>
    e.jsdocTags.some((t) => t === "param" || t === "returns") ? [key(e)] : [],
  );
  assert.deepEqual(bad, []);
});
