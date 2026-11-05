// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateNotices } from "./third-party-notices.mjs";

const fixtures: string[] = [];

async function fixture(license = "MIT", text = "Copyright fixture author\nPermission granted.") {
  const root = await mkdtemp(join(tmpdir(), "spi-notices-"));
  fixtures.push(root);
  const dependency = join(root, "node_modules/fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@spi-code/fixture",
      dependencies: { fixture: "1.0.0" },
      devDependencies: { "not-installed-dev-tool": "1.0.0" },
      optionalDependencies: { "not-installed-platform": "1.0.0" },
    }),
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", license }),
  );
  if (text) await writeFile(join(dependency, "LICENSE"), text);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("includes production notices and T3 attribution, excluding development and absent optional deps", async () => {
  const root = await fixture();
  await writeFile(join(root, "node_modules/fixture/NOTICE"), "Additional attribution");
  const result = await generateNotices([root], "44.10.0");
  expect(result).toContain("fixture@1.0.0");
  expect(result).toContain("License: MIT");
  expect(result).toContain("Copyright fixture author\nPermission granted.");
  expect(result).toContain("Additional attribution");
  expect(result).toContain("T3 Code");
  expect(result).toContain("Copyright (c) 2026 T3 Tools Inc.");
  expect(result).toContain("electron@44.10.0");
  expect(result).toContain("LICENSES.chromium.html");
  expect(result).not.toContain("not-installed");
});

it("fails when a bundled dependency has no license text", async () => {
  await expect(generateNotices([await fixture("MIT", "")], "44.10.0")).rejects.toThrow(
    "fixture@1.0.0: missing license text",
  );
});

it("fails when a dependency has an empty license or only an attribution notice", async () => {
  const root = await fixture("MIT", "  \n");
  await expect(generateNotices([root], "44.10.0")).rejects.toThrow("empty license/notice file");
  await rm(join(root, "node_modules/fixture/LICENSE"));
  await writeFile(join(root, "node_modules/fixture/NOTICE"), "Attribution without license");
  await expect(generateNotices([root], "44.10.0")).rejects.toThrow("missing license text");
});

it("follows nested transitive versions rather than the hoisted copy", async () => {
  const root = await fixture();
  const nested = join(root, "node_modules/fixture/node_modules/fixture");
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(root, "node_modules/fixture/package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      license: "MIT",
      dependencies: { fixture: "2.0.0" },
    }),
  );
  await writeFile(
    join(nested, "package.json"),
    JSON.stringify({ name: "fixture", version: "2.0.0", license: "ISC" }),
  );
  await writeFile(join(nested, "LICENSE"), "Nested license text");
  const text = await generateNotices([root], "44.10.0");
  expect(text).toContain("fixture@1.0.0");
  expect(text).toContain("fixture@2.0.0");
  expect(text).toContain("License: ISC\n\n### LICENSE\n\nNested license text");
});

it.each(["GPL-3.0-only", "(MIT OR GPL-3.0-only)", "UNKNOWN"])(
  "fails closed on a disallowed or unparsed license: %s",
  async (license) => {
    await expect(generateNotices([await fixture(license)], "44.10.0")).rejects.toThrow(
      "disallowed license",
    );
  },
);

it("fails instead of omitting an unresolved required dependency", async () => {
  const root = await fixture();
  await rm(join(root, "node_modules/fixture"), { recursive: true });
  await expect(generateNotices([root], "44.10.0")).rejects.toThrow(
    "Cannot resolve production dependency fixture",
  );
});
