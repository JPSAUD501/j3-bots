// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- a build script run by plain Node, outside any Effect program.
//
// Builds the web client and checks what a browser loads before each of its
// windows can show anything against the budget in apps/web/bundle-budget.json,
// as CI runs it:
//
//   node scripts/web-budget.ts            build, report, and fail over budget
//   node scripts/web-budget.ts --update   build, report, and write new budgets
//
// A window's first load is its entry, its route's code, and every chunk and
// stylesheet those import statically, followed through the build's manifest.
// The budget counts those bytes gzipped, as the server sends them. Code a
// window loads only once it is up (`deferred` components, documents, the
// language catalog the operator does not read) is reported, not budgeted.
// See docs/operations/performance.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const WEB = NodePath.join(ROOT, "apps", "web");
const DIST = NodePath.join(WEB, "dist");
const BUDGET_FILE = NodePath.join(WEB, "bundle-budget.json");

/**
 * Each window's first load, by the manifest keys it starts from: the page,
 * and the window's route.
 */
const SURFACES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["app", ["index.html", "src/routes/_app.tsx?tsr-split=component"]],
  ["quick", ["index.html", "src/routes/quick.tsx?tsr-split=component"]],
  ["record", ["index.html", "src/routes/record.tsx?tsr-split=component"]],
]);
/**
 * And the operator's language, which every window reads before it shows
 * anything: the larger catalog (packages/i18n/src/pt-BR.ts) stands for
 * either. It is a chunk of its own only while it loads apart; otherwise it is
 * in the chunks above, and counted there.
 */
const CATALOG = "pt-BR";

/** Room above the measured size a new budget leaves, so small changes pass. */
const HEADROOM = 1.02;

interface ManifestChunk {
  readonly file: string;
  /** The module the chunk is named after, without its extension. */
  readonly name?: string;
  readonly imports?: ReadonlyArray<string>;
  readonly css?: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const readManifest = (): ReadonlyMap<string, ManifestChunk> => {
  const parsed: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(DIST, ".vite", "manifest.json"), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error("The build's manifest is not an object.");
  const chunks = new Map<string, ManifestChunk>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.file !== "string")
      throw new Error(`The manifest's entry ${key} names no file.`);
    const { file, name, imports, css } = value;
    if (
      (name !== undefined && typeof name !== "string") ||
      (imports !== undefined && !isStrings(imports)) ||
      (css !== undefined && !isStrings(css))
    )
      throw new Error(`The manifest's entry ${key} is not a chunk's.`);
    chunks.set(key, {
      file,
      ...(name === undefined ? {} : { name }),
      ...(imports === undefined ? {} : { imports }),
      ...(css === undefined ? {} : { css }),
    });
  }
  return chunks;
};

/** Each window's budget, in gzipped bytes; none before one is written. */
const readBudget = (): ReadonlyMap<string, number> | null => {
  if (!NodeFS.existsSync(BUDGET_FILE)) return null;
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(BUDGET_FILE, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${BUDGET_FILE} is not an object.`);
  const budget = new Map<string, number>();
  for (const surface of SURFACES.keys()) {
    const bytes = parsed[surface];
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0)
      throw new Error(`${BUDGET_FILE} has no budget in bytes for "${surface}".`);
    budget.set(surface, bytes);
  }
  return budget;
};

/** Every file a window loads first, from its manifest keys through their static imports. */
const firstLoad = (manifest: ReadonlyMap<string, ManifestChunk>, keys: ReadonlyArray<string>) => {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest.get(key);
    if (chunk === undefined) throw new Error(`The build has no chunk for ${key}.`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const key of keys) visit(key);
  return files;
};

interface Size {
  readonly raw: number;
  readonly gzip: number;
}

const sizeCache = new Map<string, Size>();
const sizeOf = (file: string): Size => {
  const known = sizeCache.get(file);
  if (known !== undefined) return known;
  const bytes = NodeFS.readFileSync(NodePath.join(DIST, file));
  const size = { raw: bytes.length, gzip: NodeZlib.gzipSync(bytes).length };
  sizeCache.set(file, size);
  return size;
};
const total = (files: Iterable<string>): Size => {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const size = sizeOf(file);
    raw += size.raw;
    gzip += size.gzip;
  }
  return { raw, gzip };
};

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const { values } = NodeUtil.parseArgs({
  options: { update: { type: "boolean", default: false } },
  strict: true,
});

NodeChildProcess.execFileSync("vp", ["build", "--manifest"], {
  cwd: WEB,
  stdio: ["ignore", "ignore", "inherit"],
});
const manifest = readManifest();
const budget = readBudget();

const catalog = [...manifest].find(([, chunk]) => chunk.name === CATALOG)?.[0];

const measured = new Map<string, Size>();
const loadedFirst = new Set<string>();
for (const [surface, keys] of SURFACES) {
  const files = firstLoad(manifest, catalog === undefined ? keys : [...keys, catalog]);
  for (const file of files) loadedFirst.add(file);
  measured.set(surface, total(files));
}
const later = [...manifest.values()]
  .map((chunk) => chunk.file)
  .filter((file) => /\.(js|css)$/.test(file) && !loadedFirst.has(file));

console.log("First load, by window (JavaScript and CSS):");
for (const [surface, { raw, gzip }] of measured) {
  const limit = budget?.get(surface);
  console.log(
    `  ${surface.padEnd(7)} ${kib(raw).padStart(11)} raw  ${kib(gzip).padStart(10)} gzip` +
      (limit === undefined ? "" : ` / budget ${kib(limit)}`),
  );
}
const deferredTotal = total(new Set(later));
console.log(
  `Loaded later, on demand: ${later.length} files, ${kib(deferredTotal.raw)} raw, ${kib(deferredTotal.gzip)} gzip.`,
);

if (values.update) {
  const next = Object.fromEntries(
    [...measured].map(([surface, { gzip }]) => [
      surface,
      Math.ceil((gzip * HEADROOM) / 1024) * 1024,
    ]),
  );
  NodeFS.writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${NodePath.relative(ROOT, BUDGET_FILE)}.`);
} else {
  if (budget === null) throw new Error(`${BUDGET_FILE} is missing: run with --update to write it.`);
  const over = [...measured].filter(([surface, { gzip }]) => gzip > (budget.get(surface) ?? 0));
  if (over.length > 0) {
    console.error(
      `Over budget: ${over.map(([surface]) => surface).join(", ")}. Load what this change adds on demand ` +
        "(apps/web/src/lib/deferred.tsx), or, if the window must have it at first, raise the budget " +
        "with --update and say why in the pull request.",
    );
    process.exitCode = 1;
  }
}
