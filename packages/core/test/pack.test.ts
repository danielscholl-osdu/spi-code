// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

type Killer = (pid: number) => Promise<string | undefined>;

async function killTree(pid: number, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    return new Promise<string | undefined>((resolve) => {
      execFile(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { timeout: 10_000 },
        (error, _stdout, stderr) =>
          resolve(error ? `${error.message} ${stderr}`.trim() : undefined),
      );
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return undefined;
    return String(error);
  }
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

type Run = {
  step: string;
  budget: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  kill?: Killer;
  killBound?: number;
  closeGrace?: number;
};

async function run(
  file: string,
  args: string[],
  {
    step,
    budget,
    cwd,
    env,
    shell = false,
    kill = killTree,
    killBound = 15_000,
    closeGrace = 2_000,
  }: Run,
) {
  const child = spawn(file, args, {
    cwd,
    env,
    shell,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), budget);
  });
  try {
    const outcome = await Promise.race([closed, expired]);
    if (outcome === "expired") {
      const pid = child.pid;
      const failure =
        pid === undefined
          ? undefined
          : await within(
              kill(pid).catch((error: unknown) => String(error)),
              killBound,
              `did not finish within ${killBound} ms`,
            );
      await within(
        closed.then(
          () => undefined,
          () => undefined,
        ),
        closeGrace,
        undefined,
      );
      const diagnostic = failure === undefined ? "" : `; tree kill failed: ${failure}`;
      throw Object.assign(
        new Error(`${step} timed out after ${budget} ms${diagnostic}\n${stderr}`),
        { stdout, stderr },
      );
    }
    const [code, signal] = outcome;
    if (code !== 0) {
      const status = signal === null ? `exit code ${code}` : `signal ${signal}`;
      throw Object.assign(new Error(`${step} failed with ${status}\n${stderr}`), {
        stdout,
        stderr,
      });
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const core = fileURLToPath(new URL("../", import.meta.url));
const shell = process.platform === "win32";
const npm = shell ? "npm.cmd" : "npm";
const arg = (value: string) => {
  if (!shell) return value;
  if (/["%]/.test(value)) throw new Error(`Cannot pass ${value} through cmd.exe`);
  return `"${value}"`;
};

async function cleanup(
  temporary: string,
  platform: NodeJS.Platform = process.platform,
  remove = rm,
) {
  try {
    await remove(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (
      platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EBUSY"
    ) {
      throw error;
    }
    console.warn(
      `Could not remove temporary pack-test directory ${temporary} after retries:`,
      error,
    );
  }
}

it("warns instead of failing when Windows pack-test cleanup exhausts EBUSY retries", async () => {
  const temporary = join(tmpdir(), "spi core pack-test-locked");
  const error = Object.assign(new Error("Directory is busy"), { code: "EBUSY" });
  const remove = vi.fn<typeof rm>().mockRejectedValue(error);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(cleanup(temporary, "win32", remove)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      `Could not remove temporary pack-test directory ${temporary} after retries:`,
      error,
    );
  } finally {
    warning.mockRestore();
  }
});

it.each<[NodeJS.Platform, string]>([
  ["linux", "EBUSY"],
  ["win32", "EACCES"],
])("preserves %s cleanup failures with code %s", async (platform, code) => {
  const error = Object.assign(new Error("Cleanup failed"), { code });
  const remove = vi.fn<typeof rm>().mockRejectedValue(error);
  await expect(cleanup("unused", platform, remove)).rejects.toBe(error);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

it("kills a timed-out step's whole process tree and names the step and budget", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });",
    "console.log(process.pid + ' ' + sleeper.pid);",
    "setTimeout(() => {}, 20000);",
  ].join("\n");
  let pids: number[] = [];
  try {
    for (const budget of [1_000, 4_000, 8_000]) {
      const failure = await run(process.execPath, ["-e", script], {
        step: "sleeper",
        budget,
        cwd: tmpdir(),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        new RegExp(`^sleeper timed out after ${budget} ms\n`),
      );
      pids = String((failure as { stdout?: string }).stdout)
        .trim()
        .split(" ")
        .filter(Boolean)
        .map(Number);
      if (pids.length > 0) break;
    }
    expect(pids).toHaveLength(2);
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), {
      timeout: 5_000,
      interval: 50,
    });
  } finally {
    for (const pid of pids.filter(alive)) process.kill(pid, "SIGKILL");
  }
}, 45_000);

it.each<[string, Killer, string]>([
  [
    "fails",
    async () => "taskkill exited 1: Access is denied.",
    "taskkill exited 1: Access is denied.",
  ],
  ["never settles", () => new Promise<never>(() => {}), "did not finish within 100 ms"],
])(
  "rejects with the step and budget when the tree kill %s",
  async (_case, killer, diagnostic) => {
    let pid: number | undefined;
    const kill: Killer = (target) => {
      pid = target;
      return killer(target);
    };
    try {
      await expect(
        run(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
          step: "npm install",
          budget: 25,
          cwd: tmpdir(),
          kill,
          killBound: 100,
          closeGrace: 100,
        }),
      ).rejects.toThrow(`npm install timed out after 25 ms; tree kill failed: ${diagnostic}`);
      expect(pid).toBeDefined();
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    }
  },
  10_000,
);

it("keeps the README vendoring version aligned with the package manifest", async () => {
  const manifest = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
  const readme = await readFile(join(core, "README.md"), "utf8");
  const vendoring = readme
    .split(/^## /m)
    .find((section) => section.startsWith("Vendoring version "));
  expect(vendoring?.split("\n")[0]).toBe(`Vendoring version ${manifest.version}`);
  expect(vendoring).toContain(`spi-code-core-${manifest.version}.tgz`);
});

it("packs a pinned, source-free tarball that installs outside the workspace", async (test) => {
  const temporary = await mkdtemp(join(tmpdir(), "spi core pack-test-"));
  try {
    const release = join(temporary, "release");
    const packed = await run(process.execPath, ["scripts/pack.mjs", release], {
      step: "pack",
      budget: 120_000,
      cwd: core,
    });
    const { version } = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
    const filename = `spi-code-core-${version}.tgz`;
    const tarball = join(release, filename);
    const bytes = await readFile(tarball);
    expect(bytes[9]).toBe(19);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(packed.stdout).toContain(`${sha256}  ${tarball}`);
    const vendored: Record<string, string> = JSON.parse(
      await readFile(join(core, "pack-shas.json"), "utf8"),
    );
    const recorded = vendored[version];
    if (recorded !== undefined && sha256 !== recorded) {
      expect.fail(`core ${version} was vendored as ${recorded}; bump the version`);
    }
    const { stdout: listing } = await run("tar", ["-tzf", filename], {
      step: "tar list",
      budget: 10_000,
      cwd: release,
    });
    const entries = listing.trim().split("\n");
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/dist/index.d.ts");
    expect(entries).toContain("package/LICENSE");
    expect(entries).toContain("package/README.md");
    expect(entries.filter((entry) => /\/(?:src|test|fixtures)\//.test(entry))).toEqual([]);
    expect(entries.filter((entry) => /\.test\.|\.map$/.test(entry))).toEqual([]);
    const { stdout: manifest } = await run("tar", ["-xOzf", filename, "package/package.json"], {
      step: "tar extract",
      budget: 10_000,
      cwd: release,
    });
    const pkg = JSON.parse(manifest);
    expect(pkg.version).toBe(version);
    expect(pkg.dependencies).toEqual({ yaml: "2.9.1", zod: "4.6.7" });
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });

    const npmProject = [
      "--global=false",
      "--location=project",
      "--prefix",
      arg(temporary),
      "--cache",
      arg(join(temporary, "cache")),
    ];
    try {
      await run(
        npm,
        [
          "view",
          "yaml@2.9.1",
          "version",
          "--fetch-retries=0",
          "--fetch-timeout=5000",
          ...npmProject,
        ],
        { step: "npm view", budget: 10_000, cwd: temporary, shell },
      );
    } catch (error) {
      test.skip(`npm registry unreachable; isolated tarball install not run: ${String(error)}`);
    }
    await run(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--fetch-retries=0",
        "--fetch-timeout=15000",
        ...npmProject,
        arg(tarball),
      ],
      { step: "npm install", budget: 180_000, cwd: temporary, shell },
    );
    expect(await realpath(join(temporary, "node_modules/@spi-code/core"))).toBe(
      join(await realpath(temporary), "node_modules/@spi-code/core"),
    );
    const installed = JSON.parse(
      await readFile(join(temporary, "node_modules/@spi-code/core/package.json"), "utf8"),
    );
    expect(installed.version).toBe(version);
    await run(
      process.execPath,
      [
        "-e",
        "import('@spi-code/core').then(m=>{if(typeof m.buildBriefing!=='function')process.exit(1)})",
      ],
      {
        step: "import",
        budget: 10_000,
        cwd: temporary,
        env: { ...process.env, NODE_PATH: "" },
      },
    );
  } finally {
    await cleanup(temporary);
  }
}, 400_000);
