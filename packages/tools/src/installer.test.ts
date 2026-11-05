// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import {
  chmod,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createToolInstaller,
  extractBinary,
  flushPayloadFile,
  ToolInstaller,
} from "./installer.js";
import { parseManifest } from "./manifest.js";

const fsHooks = vi.hoisted(() => {
  const hooks = {
    rename: undefined as undefined | ((from: string, to: string) => void),
    readdir: undefined as undefined | ((path: string) => void),
    readdirCallback: undefined as undefined | ((path: string) => void),
  };
  // Node's recursive rm binds the callback readdir when it first loads, so patch it before any rm.
  const fs = process.getBuiltinModule("node:fs");
  const readdir = fs.readdir;
  Object.assign(fs, {
    readdir: (path: string, ...rest: unknown[]) => {
      hooks.readdirCallback?.(String(path));
      return Reflect.apply(readdir, fs, [path, ...rest]);
    },
  });
  return hooks;
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      fsHooks.readdir?.(String(args[0]));
      return actual.readdir(...args);
    },
    rename: async (from: string, to: string) => {
      fsHooks.rename?.(from, to);
      return actual.rename(from, to);
    },
  };
});

const exec = promisify(execFile);
const executable = Buffer.from("fixture executable\n");
const platform = process.platform === "win32" ? "win32-x64" : "darwin-arm64";
const binary = platform === "win32-x64" ? "gh.exe" : "gh";
let home: string;
let archive: Buffer;
let url: string;
let server: Server | undefined;

function manifest(
  version = "1.0.0",
  checksum = createHash("sha256").update(archive).digest("hex"),
) {
  return {
    tools: [
      {
        tool: "gh",
        version,
        platforms: {
          "darwin-arm64": { url, sha256: checksum },
          "win32-x64": { url, sha256: checksum },
        },
      },
    ],
  };
}

beforeEach(async () => {
  server = undefined;
  home = await mkdtemp(join(tmpdir(), "spi-tools-home-"));
  await mkdir(join(home, "fixture", "bin"), { recursive: true });
  await writeFile(join(home, "fixture", "bin", binary), executable);
  // Relative paths: GNU tar from Git for Windows reads "C:" in an archive path as a remote host.
  await exec("tar", ["-czf", "fixture.tar.gz", "-C", "fixture", `bin/${binary}`], { cwd: home });
  archive = await readFile(join(home, "fixture.tar.gz"));
  const listening = createServer((_request, response) => response.end(archive));
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const address = listening.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  url = `http://127.0.0.1:${address.port}/fixture.tar.gz`;
});

afterEach(async () => {
  fsHooks.rename = undefined;
  fsHooks.readdir = undefined;
  fsHooks.readdirCallback = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  const listening = server;
  if (listening)
    await new Promise<void>((resolve, reject) =>
      listening.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(home, { recursive: true, force: true });
});

test("checksum mismatch never extracts or changes tools, including an existing current", async () => {
  const appData = join(home, "app");
  const installer = new ToolInstaller(appData, manifest(), platform);
  await installer.install("gh");
  const extract = vi.fn(extractBinary);
  const bad = new ToolInstaller(appData, manifest("2.0.0", "0".repeat(64)), platform, extract);
  await expect(bad.install("gh")).rejects.toThrow("SHA-256 mismatch");
  expect(extract).not.toHaveBeenCalled();
  expect(await readdir(join(appData, "tools", "gh"))).toEqual(["1.0.0", "current"]);
  expect(await bad.binDir("gh")).toBe(join(appData, "tools", "gh", "1.0.0", "bin"));
  const freshData = join(home, "fresh");
  await expect(
    new ToolInstaller(freshData, manifest("1.0.0", "0".repeat(64)), platform).install("gh"),
  ).rejects.toThrow("SHA-256 mismatch");
  expect(await readdir(freshData)).toEqual([]);
  expect(await bad.readiness("gh")).toEqual({ state: "failed", error: "SHA-256 mismatch for gh" });
});

test.each(["win32", "darwin"])(
  "payload flush restores read-only permissions on %s",
  async (host) => {
    const path = join(home, "readonly");
    await writeFile(path, "payload");
    await chmod(path, 0o444);
    const flags: string[] = [];
    let fail = false;
    const opener = async (path: string, flag: "r" | "r+") => {
      flags.push(flag);
      const handle = await open(path, flag);
      return {
        close: () => handle.close(),
        sync: async () => {
          if (flag === "r") throw Object.assign(new Error("FlushFileBuffers"), { code: "EPERM" });
          expect((await stat(path)).mode & 0o200).not.toBe(0);
          if (fail) throw Object.assign(new Error("flush failed"), { code: "EIO" });
          await handle.sync();
        },
      };
    };
    try {
      await flushPayloadFile(path, host, opener);
      expect(flags).toEqual(host === "win32" ? ["r+"] : ["r", "r+"]);
      expect((await stat(path)).mode & 0o200).toBe(0);
      fail = true;
      await expect(flushPayloadFile(path, host, opener)).rejects.toThrow("flush failed");
      expect((await stat(path)).mode & 0o200).toBe(0);
      await expect(
        flushPayloadFile(path, host, async () => {
          throw Object.assign(new Error("open failed"), { code: "EIO" });
        }),
      ).rejects.toThrow("open failed");
      expect((await stat(path)).mode & 0o200).toBe(0);
    } finally {
      await chmod(path, 0o644);
    }
  },
);

test("installs without admin under a temporary home and reports each readiness transition", async () => {
  vi.stubEnv("HOME", home);
  const appData = join(home, "Library", "Application Support", "SPI Code");
  const installer = new ToolInstaller(appData, manifest(), platform);
  expect(await installer.readiness("gh")).toEqual({ state: "missing" });
  expect(await installer.binDir("gh")).toBeUndefined();
  const install = installer.install("gh");
  expect(await installer.readiness("gh")).toEqual({ state: "installing" });
  await expect(installer.install("gh")).rejects.toThrow("already running");
  await install;
  expect(await installer.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
  expect(await readFile(join((await installer.binDir("gh")) ?? "", binary))).toEqual(executable);
  const update = new ToolInstaller(appData, manifest("2.0.0"), platform);
  expect(await update.readiness("gh")).toEqual({ state: "needs-update", version: "1.0.0" });
  await update.install("gh");
  expect(await update.readiness("gh")).toEqual({ state: "ready", version: "2.0.0" });
  expect(await update.binDir("gh")).toBe(join(appData, "tools", "gh", "2.0.0", "bin"));
  expect(await readdir(appData)).toEqual(["tools"]);
});

test("a killed extract leaves the previous current intact, reports failed, and can retry", async () => {
  const appData = join(home, "app");
  await new ToolInstaller(appData, manifest(), platform).install("gh");
  let kill = true;
  const installer = new ToolInstaller(
    appData,
    manifest("2.0.0"),
    platform,
    async (path, binary, signal) => {
      if (kill) {
        await exec(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
      }
      return extractBinary(path, binary, signal);
    },
  );
  await expect(installer.install("gh")).rejects.toThrow();
  expect((await installer.readiness("gh")).state).toBe("failed");
  expect(await installer.binDir("gh")).toBe(join(appData, "tools", "gh", "1.0.0", "bin"));
  expect(await readdir(join(appData, "tools", "gh"))).toEqual(["1.0.0", "current"]);
  kill = false;
  await installer.install("gh");
  expect((await installer.readiness("gh")).state).toBe("ready");
});

test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "zip installs replace the Windows pointer file, not a privileged symlink",
  async () => {
    archive = Buffer.from(
      "UEsDBBQAAAAAAFEFZV3HXtWhEwAAABMAAAATAAAAZ2hfMS4wLjAvYmluL2doLmV4ZWZpeHR1cmUgZXhlY3V0YWJsZQpQSwECFAMUAAAAAABRBWVdx17VoRMAAAATAAAAEwAAAAAAAAAAAAAAgAEAAAAAZ2hfMS4wLjAvYmluL2doLmV4ZVBLBQYAAAAAAQABAEEAAABEAAAAAAA=",
      "base64",
    );
    url = url.replace("tar.gz", "zip");
    const appData = join(home, "AppData", "SPI Code");
    await new ToolInstaller(appData, manifest(), "win32-x64").install("gh");
    const installer = new ToolInstaller(appData, manifest("2.0.0"), "win32-x64");
    await installer.install("gh");
    expect(await readFile(join(appData, "tools", "gh", "current"), "utf8")).toBe("2.0.0");
    expect(await readFile(join((await installer.binDir("gh")) ?? "", "gh.exe"))).toEqual(
      executable,
    );
  },
);

test("aborted downloads and malformed archives cannot publish a version", async () => {
  const appData = join(home, "app");
  const installer = new ToolInstaller(appData, manifest(), platform);
  await expect(installer.install("gh", AbortSignal.abort())).rejects.toThrow();
  archive = Buffer.from("not an archive");
  await expect(new ToolInstaller(appData, manifest(), platform).install("gh")).rejects.toThrow();
  expect(await readdir(appData)).toEqual([]);
});

test("packaged manifest pins both Watch tools on both platforms and rejects unsafe pins", async () => {
  const pins = parseManifest(
    JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")),
  );
  expect(pins.map((pin) => pin.tool)).toEqual(["gh", "glab"]);
  expect((await (await createToolInstaller(home, platform)).readiness("glab")).state).toBe(
    "missing",
  );
  for (const pin of pins) expect(Object.keys(pin.platforms)).toEqual(["darwin-arm64", "win32-x64"]);
  const [pin] = parseManifest(manifest());
  expect(() => parseManifest({ tools: [{ ...pin, tool: "../gh" }] })).toThrow();
  expect(() => parseManifest({ tools: [{ ...pin, version: "../current" }] })).toThrow();
  expect(() => parseManifest({ tools: [pin, pin] })).toThrow();
  expect(() => new ToolInstaller(home, manifest(), "linux-x64")).toThrow("Unsupported");
});

test("a torn or foreign current pointer reads as missing instead of throwing", async () => {
  const appData = join(home, "torn");
  const installer = new ToolInstaller(appData, manifest(), "win32-x64");
  await mkdir(join(appData, "tools", "gh"), { recursive: true });
  for (const pointer of ["", "../../outside"]) {
    await writeFile(join(appData, "tools", "gh", "current"), pointer);
    expect(await installer.readiness("gh")).toEqual({ state: "missing" });
    expect(await installer.binDir("gh")).toBeUndefined();
  }
});

const tornShapes: Record<string, (root: string) => Promise<void>> = {
  "a regular file": (root) => writeFile(join(root, "current"), "1.0.0"),
  "a directory": async (root) => {
    await mkdir(join(root, "current", "bin"), { recursive: true });
  },
  "a dangling symlink": (root) => symlink("9.9.9", join(root, "current")),
  "a self-referencing symlink": (root) => symlink("current", join(root, "current")),
  "a symlink into a loop": async (root) => {
    await symlink("9.9.9", join(root, "9.9.9"));
    await symlink("9.9.9", join(root, "current"));
  },
};

test.skipIf(process.platform === "win32").each(
  (["darwin-arm64", "win32-x64"] as const).flatMap((target) =>
    Object.keys(tornShapes)
      .filter((shape) => target === "darwin-arm64" || shape !== "a regular file")
      .map((shape) => [target, shape] as const),
  ),
)("a %s current pointer that is %s reads as missing", async (target, shape) => {
  const appData = join(home, "torn-shape");
  const root = join(appData, "tools", "gh");
  await mkdir(root, { recursive: true });
  await tornShapes[shape]?.(root);
  const installer = new ToolInstaller(appData, manifest(), target);
  expect(await installer.binDir("gh")).toBeUndefined();
  expect(await installer.readiness("gh")).toEqual({ state: "missing" });
});

test.skipIf(process.platform === "win32").each(Object.keys(tornShapes))(
  "reinstalling repairs a current pointer that is %s",
  async (shape) => {
    const appData = join(home, "torn-repair");
    const root = join(appData, "tools", "gh");
    await mkdir(root, { recursive: true });
    await tornShapes[shape]?.(root);
    const installer = new ToolInstaller(appData, manifest(), platform);
    await installer.install("gh");
    expect(await installer.binDir("gh")).toBe(join(root, "1.0.0", "bin"));
    expect(await installer.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
  },
);

async function plantTornDirectory(name: string) {
  const appData = join(home, name);
  const root = join(appData, "tools", "gh");
  const current = join(root, "current");
  const outside = join(home, `${name}-outside`);
  await mkdir(join(current, "bin"), { recursive: true });
  await writeFile(join(current, "bin", "gh"), "torn");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "keep");
  return { root, current, outside, installer: new ToolInstaller(appData, manifest(), platform) };
}

async function quarantines(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith(".torn-current-"));
}

test.skipIf(process.platform === "win32").each(["current", "quarantine", "nested"])(
  "a torn directory swapped for an outside symlink at the %s never loses outside data",
  async (location) => {
    const { current, outside, installer } = await plantTornDirectory(`race-${location}`);
    let staged = "";
    let swapped = false;
    fsHooks.rename = (from, to) => {
      if (from === current && !staged) staged = to;
    };
    const swap = (path: string) => {
      const target =
        location === "current"
          ? current
          : staged && join(staged, location === "nested" ? "bin" : "");
      if (swapped || !target || path !== target) return;
      swapped = true;
      renameSync(path, join(home, `displaced-${location}`));
      symlinkSync(outside, path);
    };
    fsHooks.readdir = swap;
    fsHooks.readdirCallback = swap;
    await installer.install("gh").catch(() => undefined);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
    expect(await installer.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
  },
);

test.skipIf(process.platform === "win32")(
  "a collision at the quarantine destination keeps the pre-existing entry",
  async () => {
    const { current, installer } = await plantTornDirectory("collision");
    let collision = "";
    fsHooks.rename = (from, to) => {
      if (from !== current) return;
      collision = to;
      mkdirSync(to);
      writeFileSync(join(to, "sentinel"), "pre-existing");
    };
    await expect(installer.install("gh")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await readFile(join(collision, "sentinel"), "utf8")).toBe("pre-existing");
    expect(await readFile(join(current, "bin", "gh"), "utf8")).toBe("torn");
  },
);

test.skipIf(process.platform === "win32")(
  "a quarantined entry that became a symlink is unlinked without following it",
  async () => {
    const { root, current, outside, installer } = await plantTornDirectory("quarantine-link");
    let staged = "";
    fsHooks.rename = (from, to) => {
      if (from !== current) return;
      staged = to;
      renameSync(current, join(home, "displaced-link"));
      symlinkSync(outside, current);
    };
    await installer.install("gh");
    expect(staged).toContain(".torn-current-");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
    expect(await quarantines(root)).toEqual([]);
    expect(await installer.binDir("gh")).toBe(join(root, "1.0.0", "bin"));
  },
);

test.skipIf(process.platform === "win32")(
  "quarantined torn directories stay on disk and never affect version or later installs",
  async () => {
    const { root, current, installer } = await plantTornDirectory("leftover");
    await installer.install("gh");
    const [first, ...others] = await quarantines(root);
    expect(others).toEqual([]);
    const kept = join(root, String(first), "current", "bin", "gh");
    expect(await readFile(kept, "utf8")).toBe("torn");
    expect(await installer.binDir("gh")).toBe(join(root, "1.0.0", "bin"));
    const old = new Date(Date.now() - 72 * 60 * 60_000);
    await utimes(join(root, String(first)), old, old);
    await rm(current);
    await mkdir(join(current, "bin"), { recursive: true });
    await installer.install("gh");
    expect(await quarantines(root)).toHaveLength(2);
    expect(await readFile(kept, "utf8")).toBe("torn");
    const fresh = new ToolInstaller(join(home, "leftover"), manifest(), platform);
    expect(await fresh.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
    expect(await fresh.binDir("gh")).toBe(join(root, "1.0.0", "bin"));
  },
);

test("reinstalling over a damaged copy of the same version replaces it with the verified binary", async () => {
  const appData = join(home, "damaged");
  const installer = new ToolInstaller(appData, manifest(), platform);
  await installer.install("gh");
  const installed = join(appData, "tools", "gh", "1.0.0", "bin", binary);
  await writeFile(installed, "tampered");
  await installer.install("gh");
  expect(await readFile(installed)).toEqual(executable);
  expect(await installer.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
  await rm(installed);
  await installer.install("gh");
  expect(await readFile(installed)).toEqual(executable);
});

test("a repair that fails partway leaves current pointing at an intact version directory", async () => {
  const appData = join(home, "repair");
  const installer = new ToolInstaller(appData, manifest(), platform);
  await installer.install("gh");
  const version = join(appData, "tools", "gh", "1.0.0");
  const installed = join(version, "bin", binary);
  await writeFile(installed, "tampered");
  let renames = 0;
  fsHooks.rename = () => {
    // The first rename publishes the payload and meets the existing directory; fail the repair.
    if (++renames === 2) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
  };
  await expect(installer.install("gh")).rejects.toThrow("injected EIO");
  fsHooks.rename = undefined;
  expect((await stat(version)).isDirectory()).toBe(true);
  expect(await readFile(installed, "utf8")).toBe("tampered");
  expect(await readdir(join(version, "bin"))).toEqual([binary]);
  expect(await installer.binDir("gh")).toBe(join(version, "bin"));
  await installer.install("gh");
  expect(await readFile(installed)).toEqual(executable);
});

test("install reclaims only stale same-tool temporary entries and never follows their symlinks", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date((await stat(home)).mtimeMs));
  const appData = join(home, "stale");
  const installer = new ToolInstaller(appData, manifest(), platform);
  await installer.install("gh");
  const root = join(appData, "tools", "gh");
  const bin = join(root, "1.0.0", "bin");
  const stalePointer = join(root, ".current-abandoned");
  const stale = [
    join(appData, ".install-gh-Ab1234"),
    join(appData, ".install-Ab1234"),
    stalePointer,
    join(root, "2.0.0", "bin", ".repair-abandoned"),
  ];
  const kept = [
    join(appData, ".install-gh-Fresh1"),
    join(appData, ".install-glab-Ab1234"),
    join(appData, ".install-gh-other-Ab1234"),
    join(appData, ".install-Fresh1"),
    join(bin, ".repair-abandoned"),
    join(root, "0.9.0", "bin", ".repair-abandoned"),
    join(root, ".current-fresh"),
    join(bin, ".repair-fresh"),
    join(root, "1.0.0", "keep"),
    join(appData, "tools", "glab", ".current-abandoned"),
    join(appData, "tools", "glab", "1.0.0", "bin", ".repair-abandoned"),
  ];
  const old = new Date(Date.now() - 48 * 60 * 60_000);
  if (platform === "win32-x64") await utimes(join(root, "current"), old, old);
  else await lutimes(join(root, "current"), old, old);
  for (const path of [...stale, ...kept]) {
    await mkdir(join(path, ".."), { recursive: true });
    if (path.includes(".install-")) {
      await mkdir(path);
      await writeFile(join(path, "archive"), "partial download");
    } else await writeFile(path, "temporary");
    if (!path.includes("fresh") && !path.includes("Fresh1")) await utimes(path, old, old);
  }
  if (platform !== "win32-x64") {
    await rm(stalePointer);
    await symlink("1.0.0", stalePointer);
    await lutimes(stalePointer, old, old);
  }
  await new ToolInstaller(appData, manifest("2.0.0"), platform).install("gh");
  for (const path of stale) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  for (const path of kept) expect(await stat(path)).toBeDefined();
  expect(await installer.binDir("gh")).toBe(join(root, "2.0.0", "bin"));
  expect(await readFile(join(bin, binary))).toEqual(executable);
});

test("repair reclaim does not traverse unrelated installed version trees", async () => {
  const appData = join(home, "bounded-reclaim");
  const oldTree = join(appData, "tools", "gh", "0.9.0");
  await mkdir(join(oldTree, "deep", "portable-git"), { recursive: true });
  const visited: string[] = [];
  fsHooks.readdir = (path) => visited.push(path);
  await new ToolInstaller(appData, manifest(), platform).install("gh");
  expect(visited.filter((path) => path.startsWith(oldTree))).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "repair reclaim never follows a payload directory symlink",
  async () => {
    const appData = join(home, "symlink-reclaim");
    const foreign = join(home, "foreign");
    const version = join(appData, "tools", "gh", "1.0.0");
    await mkdir(foreign);
    await mkdir(version, { recursive: true });
    await symlink(foreign, join(version, "bin"));
    const repair = join(foreign, ".repair-abandoned");
    await writeFile(repair, "unrelated");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(repair, old, old);
    fsHooks.rename = () => {
      throw new Error("stop after reclaim");
    };
    await expect(new ToolInstaller(appData, manifest(), platform).install("gh")).rejects.toThrow(
      "stop after reclaim",
    );
    expect(await readFile(repair, "utf8")).toBe("unrelated");
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a stale entry that cannot be removed never blocks the install",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date((await stat(home)).mtimeMs));
    const appData = join(home, "locked");
    const installer = new ToolInstaller(appData, manifest(), platform);
    await installer.install("gh");
    const lockedBin = join(appData, "tools", "gh", "2.0.0", "bin");
    const locked = join(lockedBin, ".repair-abandoned");
    await mkdir(lockedBin, { recursive: true });
    await writeFile(join(lockedBin, binary), executable);
    await writeFile(locked, "temporary");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(locked, old, old);
    await chmod(lockedBin, 0o555);
    try {
      await new ToolInstaller(appData, manifest("2.0.0"), platform).install("gh");
      expect(await stat(locked)).toBeDefined();
      expect(await installer.binDir("gh")).toBe(join(appData, "tools", "gh", "2.0.0", "bin"));
    } finally {
      await chmod(lockedBin, 0o755);
    }
  },
);

test("another installer leaves a fresh in-progress same-tool staging directory alone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date((await stat(home)).mtimeMs));
  const appData = join(home, "concurrent");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const extracting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = new ToolInstaller(appData, manifest(), platform, async (path) => {
    entered();
    await gate;
    expect(await readFile(path)).toEqual(archive);
    return executable;
  });
  const install = first.install("gh");
  try {
    await extracting;
    await new ToolInstaller(appData, manifest(), platform).install("gh");
    expect((await readdir(appData)).some((name) => name.startsWith(".install-gh-"))).toBe(true);
  } finally {
    release();
    await install;
  }
  expect(await first.readiness("gh")).toEqual({ state: "ready", version: "1.0.0" });
});
