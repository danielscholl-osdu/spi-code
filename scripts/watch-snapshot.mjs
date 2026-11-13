// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// pnpm build && TZ=UTC node scripts/watch-snapshot.mjs && pnpm biome check --write
// Biome formats the written files back to their checked-in bytes.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/**
 * Each project whose modules the generator loads: its tsconfig and where pnpm build emits it.
 * @type {[project: string, built: string][]}
 */
const builds = [
  ["packages/contracts/tsconfig.json", "packages/contracts/dist"],
  ["packages/core/tsconfig.build.json", "packages/core/dist"],
  ["packages/tools/tsconfig.json", "packages/tools/dist"],
  ["packages/host/tsconfig.build.json", "packages/host/dist"],
  ["packages/host/test/tsconfig.json", "packages/host/build"],
];

/**
 * Why the type-checked build is behind the sources: a project tsc -b would still build.
 * @param {string} [root]
 * @returns {string | undefined}
 */
export function staleBuild(root = repository) {
  let report;
  try {
    report = execFileSync(process.execPath, [tsc, "-b", "--dry", "packages/host/test"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    return `tsc -b --dry failed: ${error instanceof Error ? error.message : error}`;
  }
  const lines = report.split(/\r?\n/).map((line) => line.replaceAll("\\", "/"));
  for (const [project] of builds) {
    const status = lines.find((line) => line.includes(`/${project}'`));
    if (status === undefined) return `tsc -b --dry did not report ${project}`;
    if (!status.endsWith(" is up to date")) return status.slice(status.indexOf(" - ") + 3);
  }
  return undefined;
}

/** @param {string} path @returns {string} the directory's file URL, ending in a slash */
const directoryUrl = (path) => pathToFileURL(join(path, "/")).href;

/**
 * Compiles each project's current sources, without checking, into its own directory under out.
 * @param {string} root
 * @param {string} out
 * @returns {{built: string, compiled: string}[]} each project's built and compiled directory URLs
 */
function compile(root, out) {
  return builds.map(([project, built], index) => {
    const directory = join(out, String(index));
    spawnSync(
      process.execPath,
      [
        tsc,
        ...["-p", project, "--outDir", directory, "--noCheck", "--composite", "false"],
        ...["--declaration", "false", "--incremental", "false"],
      ],
      { cwd: root, stdio: "ignore" },
    );
    return { built: directoryUrl(join(root, built)), compiled: directoryUrl(directory) };
  });
}

/**
 * Workspace package names mapped to the built entry their exports name.
 * @param {string} root
 */
function workspaceEntries(root) {
  /** @type {Record<string, string>} */
  const entries = {};
  for (const [, built] of builds) {
    const manifest = join(root, dirname(built), "package.json");
    if (!existsSync(manifest)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = exports?.["."]?.import;
    if (typeof name === "string" && typeof entry === "string")
      entries[name] = pathToFileURL(join(root, dirname(built), entry)).href;
  }
  return entries;
}

/**
 * Loader hooks under which every module at a built path is read from the matching compile of the
 * current sources instead, so the built files themselves are never loaded. The builders' imports
 * of host source go to the host's built path, and so to its compile.
 * @param {{built: string, compiled: string}[]} places file URLs, each ending in a slash
 * @param {Record<string, string>} entries
 * @param {{source: string, built: string, builders: string}} host file URLs, ending in a slash
 */
const compiledHooks = (places, entries, host) => `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [places, entries, host] = ${JSON.stringify([places, entries, host])};
const place = (url) => places.find(({ built }) => url.startsWith(built));
export function resolve(specifier, context, next) {
  if (Object.hasOwn(entries, specifier)) return { url: entries[specifier], shortCircuit: true };
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  let url = relative && context.parentURL ? new URL(specifier, context.parentURL).href : specifier;
  if (relative && context.parentURL?.startsWith(host.builders) && url.startsWith(host.source))
    url = host.built + url.slice(host.source.length);
  return place(url) ? { url, shortCircuit: true } : next(specifier, context);
}
export function load(url, context, next) {
  const at = place(url);
  if (at === undefined) return next(url, context);
  let source;
  try {
    source = readFileSync(new URL(at.compiled + url.slice(at.built.length)));
  } catch {
    throw new Error(fileURLToPath(url) + " is not compiled from any current source");
  }
  return { format: "module", source, shortCircuit: true };
}`;

/**
 * Writes every file in packages/host/test/watch/outputs.ts under root, running the host and the
 * builders compiled from the current sources, or throws and writes nothing when the type-checked
 * build is behind those sources or a module they need has no source.
 * @param {string} [root] where the files go
 * @param {string} [build] the checkout whose sources run
 */
export async function generate(root = repository, build = repository) {
  const stale = staleBuild(build);
  if (stale !== undefined)
    throw new Error(
      `The built host is stale (${stale}). Run pnpm build first; nothing was written.`,
    );
  process.env.TZ = "UTC";
  const out = mkdtempSync(join(tmpdir(), "spi-watch-compile-"));
  try {
    const places = compile(build, out);
    const hostUrl = directoryUrl(join(build, "packages/host"));
    const host = {
      source: `${hostUrl}src/`,
      built: `${hostUrl}dist/`,
      builders: `${hostUrl}build/`,
    };
    register(
      `data:text/javascript,${encodeURIComponent(compiledHooks(places, workspaceEntries(build), host))}`,
    );
    /** @type {{watchOutputs: readonly {path: string, value: () => unknown}[]}} */
    let outputs;
    try {
      outputs = await import(`${host.builders}watch/outputs.js`);
    } catch (error) {
      throw new Error(
        `The builders do not load from the current sources (${error instanceof Error ? error.message : error}); nothing was written.`,
      );
    }
    const files = [];
    for (const { path, value } of outputs.watchOutputs)
      files.push({ path: join(root, path), text: `${JSON.stringify(await value(), null, 2)}\n` });
    for (const { path, text } of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await generate(resolve(process.argv[2] ?? repository));
  } catch (error) {
    console.error(`watch-snapshot: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
