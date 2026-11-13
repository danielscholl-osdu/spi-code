// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// pnpm build && TZ=UTC node scripts/watch-snapshot.mjs && pnpm biome check --write
// Biome formats the written files back to their checked-in bytes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/**
 * Each project whose output the generator loads: its tsconfig, its sources and its build.
 * @type {[project: string, source: string, built: string][]}
 */
const builds = [
  ["packages/contracts/tsconfig.json", "packages/contracts/src", "packages/contracts/dist"],
  ["packages/core/tsconfig.build.json", "packages/core/src", "packages/core/dist"],
  ["packages/tools/tsconfig.json", "packages/tools/src", "packages/tools/dist"],
  ["packages/host/tsconfig.build.json", "packages/host/src", "packages/host/dist"],
  ["packages/host/test/tsconfig.json", "packages/host/test", "packages/host/build"],
];

/**
 * Why the build the generator would load cannot be trusted: a source with no emitted module, or a
 * project tsc -b would still build. Undefined only when tsc reports each of those projects current.
 * @param {string} [root]
 * @returns {string | undefined}
 */
export function staleBuild(root = repository) {
  const missing = builds.flatMap(([, source, built]) =>
    existsSync(join(root, source))
      ? readdirSync(join(root, source), { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".ts") && !/\.(test|d)\.ts$/.test(file))
          .filter((file) => !existsSync(join(root, built, file.replace(/\.ts$/, ".js"))))
          .map((file) => `${source}/${file.split("\\").join("/")}`)
      : [`${source}/`],
  );
  if (missing.length > 0) return `${missing[0]} has no built module`;
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

/**
 * A loader hook that sends the compiled builders' imports of host source to the host's build.
 * @param {string} host the packages/host directory's file URL, ending in a slash
 */
const hostSourceHook = (host) => `const [source, built, builders] = ${JSON.stringify([
  `${host}src/`,
  `${host}dist/`,
  `${host}build/`,
])};
export function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  const url = relative && context.parentURL?.startsWith(builders)
    ? new URL(specifier, context.parentURL).href
    : "";
  return next(url.startsWith(source) ? built + url.slice(source.length) : specifier, context);
}`;

/**
 * Writes every file in packages/host/test/watch/outputs.ts under root from the built host, or
 * throws and writes nothing when that build is stale.
 * @param {string} [root] where the files go
 * @param {string} [build] the checkout whose built host and builders run
 */
export async function generate(root = repository, build = repository) {
  const stale = staleBuild(build);
  if (stale !== undefined)
    throw new Error(
      `The built host is stale (${stale}). Run pnpm build first; nothing was written.`,
    );
  process.env.TZ = "UTC";
  const host = pathToFileURL(join(build, "packages/host/")).href;
  register(`data:text/javascript,${encodeURIComponent(hostSourceHook(host))}`);
  /** @type {{watchOutputs: readonly {path: string, value: () => unknown}[]}} */
  const { watchOutputs } = await import(`${host}build/watch/outputs.js`);
  const files = [];
  for (const { path, value } of watchOutputs)
    files.push({ path: join(root, path), text: `${JSON.stringify(await value(), null, 2)}\n` });
  for (const { path, text } of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
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
