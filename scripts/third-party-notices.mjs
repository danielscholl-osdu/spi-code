// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowed = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Python-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
]);

/** @param {string} path */
async function manifest(path) {
  return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}

/** @param {unknown} error */
function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {string} from @param {string} name @param {boolean} optional */
async function dependencyPath(from, name, optional) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    try {
      await readFile(join(candidate, "package.json"), "utf8");
      return await realpath(candidate);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (dirname(dir) === dir) break;
  }
  if (optional) return undefined;
  throw new Error(`Cannot resolve production dependency ${name} from ${from}`);
}

/** @param {string} directory @param {string} [prefix] @returns {Promise<string[]>} */
async function noticeFiles(directory, prefix = "") {
  const results = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) results.push(...(await noticeFiles(directory, relative)));
    else if (
      /(?:^|[._-])(?:licen[cs]es?|notices?)(?:[._-]|$)/i.test(entry.name) ||
      /^thirdparty.*notices?/i.test(entry.name)
    )
      results.push(relative);
  }
  return results.sort();
}

/**
 * @param {string[]} packageRoots Production roots, including the bundled renderer.
 * @param {string} electronVersion Electron is supplied separately by electron-builder.
 */
export async function generateNotices(packageRoots, electronVersion) {
  const visited = new Set();
  /** @type {Map<string, string>} */
  const notices = new Map();
  /** @param {string} directory @param {boolean} [firstParty] */
  async function visit(directory, firstParty = false) {
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const pkg = await manifest(directory);
    const id = `${pkg.name}@${pkg.version}`;
    if (!firstParty && !pkg.name.startsWith("@spi-code/")) {
      if (!allowed.has(pkg.license)) throw new Error(`${id}: disallowed license ${pkg.license}`);
      const files = await noticeFiles(directory);
      const texts = await Promise.all(
        files.map(
          async (file) =>
            `### ${file}\n\n${(await readFile(join(directory, file), "utf8")).trim()}`,
        ),
      );
      let hasLicense = files.some((file) => /licen[cs]e/i.test(file));
      // These pinned npm archives omit their project's MIT notice.
      if (
        (pkg.name === "@github/copilot-sdk" ||
          /^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-/.test(pkg.name)) &&
        pkg.version === "1.0.26" &&
        pkg.license === "MIT"
      ) {
        texts.unshift(await readFile(join(root, "scripts/licenses/copilot-sdk-MIT.txt"), "utf8"));
        hasLicense = true;
      } else if (
        pkg.name.startsWith("@koromix/koffi-") &&
        pkg.version === "3.2.1" &&
        pkg.license === "MIT"
      ) {
        const koffi = await dependencyPath(directory, "koffi", false);
        if (!koffi || (await manifest(koffi)).version !== pkg.version)
          throw new Error(`${id}: no matching koffi license source`);
        texts.unshift(await readFile(join(koffi, "LICENSE.txt"), "utf8"));
        hasLicense = true;
      }
      if (!hasLicense || texts.length === 0 || !texts.some((text) => text.trim()))
        throw new Error(`${id}: missing license text`);
      for (const file of files) {
        if (!(await readFile(join(directory, file), "utf8")).trim())
          throw new Error(`${id}: empty license/notice file ${file}`);
      }
      notices.set(id, `## ${id}\n\nLicense: ${pkg.license}\n\n${texts.join("\n\n")}`);
    }
    const optional = pkg.optionalDependencies ?? {};
    for (const name of Object.keys({ ...pkg.dependencies, ...optional }).sort()) {
      const path = await dependencyPath(directory, name, Object.hasOwn(optional, name));
      if (path) await visit(path);
    }
  }
  for (const path of packageRoots) await visit(path, true);
  const t3 = await readFile(join(root, "scripts/licenses/t3-code-MIT.txt"), "utf8");
  return [
    "# Third-party notices",
    "Production dependencies of the packaged host and bundled renderer. Development tools are excluded.",
    `## electron@${electronVersion}\n\nLicense: MIT\n\nElectron's full MIT notice is shipped by electron-builder as LICENSE.electron.txt. Chromium and Electron's bundled components are covered by LICENSES.chromium.html. Both files are in the application's Resources directory on macOS, and alongside the executable on Windows.`,
    ...[...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
    `## T3 Code\n\nLicense: MIT\n\nCopied and ported portions of T3 Code.\n\n${t3}`,
    "",
  ].join("\n\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = await manifest(join(root, "apps/desktop"));
  const text = await generateNotices(
    [join(root, "apps/desktop"), join(root, "apps/window")],
    desktop.devDependencies.electron,
  );
  const output = join(root, "build/THIRD_PARTY_NOTICES.md");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text);
  console.log(`third-party licenses: ok (${output})`);
}
