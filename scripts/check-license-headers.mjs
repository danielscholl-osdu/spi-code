// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh"]);
const mitNotice = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** @param {string} source */
export function hasLicenseHeader(source) {
  const text = source.replace(/\r\n/g, "\n").replace(/^#![^\n]*\n/, "");
  if (
    text.startsWith("// Copyright 2026, Daniel Scholl\n// SPDX-License-Identifier: MIT\n") ||
    text.startsWith("# Copyright 2026, Daniel Scholl\n# SPDX-License-Identifier: MIT\n")
  ) {
    return true;
  }
  const comment = text.match(/^(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)+/)?.[0];
  if (!comment || !/Copyright[^\n]*T3 Tools Inc\./.test(comment)) {
    return false;
  }
  const normalized = comment
    .replace(/^\/\*|\*\/$/g, "")
    .replace(/^\s*(?:\/\/|\*) ?/gm, "")
    .replace(/\s+/g, " ");
  return normalized.includes(mitNotice.replace(/\s+/g, " "));
}

/** @param {string} root */
export function checkLicenseHeaders(root) {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return [...new Set(files.split("\0").filter(Boolean))].sort().filter((file) => {
    const segments = file.split("/");
    let path = root;
    // Git on Windows can list files beneath junctions, unlike POSIX directory symlinks.
    for (const [index, segment] of segments.entries()) {
      path = resolve(path, segment);
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry || (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
        return false;
      }
    }
    const source = readFileSync(path, "utf8");
    return (extensions.has(extname(file)) || source.startsWith("#!")) && !hasLicenseHeader(source);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkLicenseHeaders(process.cwd());
  if (failures.length > 0) {
    console.error(`Missing MIT license header:\n${failures.map((file) => `  ${file}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("license headers: ok");
  }
}
