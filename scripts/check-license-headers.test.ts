// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkLicenseHeaders, hasLicenseHeader } from "./check-license-headers.mjs";

const header = "// Copyright 2026, Daniel Scholl\n// SPDX-License-Identifier: MIT\n";
const shellHeader = "# Copyright 2026, Daniel Scholl\n# SPDX-License-Identifier: MIT\n";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("license headers", () => {
  it("accepts the project header and a shell header after a shebang", () => {
    expect(hasLicenseHeader(`${header}export {};\n`)).toBe(true);
    expect(hasLicenseHeader(`#!/usr/bin/env bash\n${shellHeader}echo ok\n`)).toBe(true);
    expect(hasLicenseHeader(`#!/usr/bin/env node\n${header}export {};\n`)).toBe(true);
  });

  it("rejects missing, misplaced and non-MIT headers", () => {
    expect(hasLicenseHeader("export {};\n")).toBe(false);
    expect(hasLicenseHeader(`export {};\n${header}`)).toBe(false);
    expect(hasLicenseHeader(header.replace("MIT", "Apache-2.0"))).toBe(false);
    expect(hasLicenseHeader("// Copyright 2026, T3 Tools Inc.\n")).toBe(false);
  });

  it("accepts a complete T3 MIT notice, including a port with project attribution", () => {
    const notice = readFileSync(new URL("../LICENSE", import.meta.url), "utf8").replace(
      "Copyright (c) 2026 Daniel Scholl",
      "Copyright (c) 2026 T3 Tools Inc.",
    );
    expect(hasLicenseHeader(`/*\n${notice}*/\nexport {};\n`)).toBe(true);
    expect(
      hasLicenseHeader(`// Copyright 2026, Daniel Scholl\n\n/*\n${notice}*/\nexport {};\n`),
    ).toBe(true);
    expect(
      hasLicenseHeader(
        notice
          .split("\n")
          .map((line) => `// ${line}`)
          .join("\n"),
      ),
    ).toBe(true);
    expect(
      hasLicenseHeader(`/*\n${notice.replace("THE SOFTWARE IS PROVIDED", "OMITTED")}*/\n`),
    ).toBe(false);
  });

  it("checks untracked sources and extensionless scripts but ignores generated files", () => {
    const directory = mkdtempSync(join(tmpdir(), "spi-code-headers-"));
    directories.push(directory);
    execFileSync("git", ["init", "--quiet", directory]);
    writeFileSync(join(directory, ".gitignore"), "generated.js\n");
    symlinkSync(directory, join(directory, "linked"), "junction");
    writeFileSync(join(directory, "deleted.ts"), "export {};\n");
    execFileSync("git", ["add", "deleted.ts"], { cwd: directory });
    unlinkSync(join(directory, "deleted.ts"));
    writeFileSync(join(directory, "generated.js"), "export {};\n");
    writeFileSync(join(directory, "good.ts"), `${header}export {};\n`);
    writeFileSync(join(directory, "missing.tsx"), "export {};\n");
    writeFileSync(join(directory, "missing.mjs"), "export {};\n");
    writeFileSync(join(directory, "missing.sh"), "echo ok\n");
    writeFileSync(join(directory, "script"), "#!/usr/bin/env bash\necho ok\n");
    expect(checkLicenseHeaders(directory)).toEqual([
      "missing.mjs",
      "missing.sh",
      "missing.tsx",
      "script",
    ]);
    const checker = fileURLToPath(new URL("./check-license-headers.mjs", import.meta.url));
    const failed = spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Missing MIT license header:");
    expect(failed.stderr).toContain("missing.tsx");
    writeFileSync(join(directory, "missing.tsx"), `${header}export {};\n`);
    writeFileSync(join(directory, "missing.mjs"), `${header}export {};\n`);
    writeFileSync(join(directory, "missing.sh"), `${shellHeader}echo ok\n`);
    writeFileSync(join(directory, "script"), `#!/usr/bin/env bash\n${shellHeader}echo ok\n`);
    expect(checkLicenseHeaders(directory)).toEqual([]);
    const passed = spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("license headers: ok");
  });
});
