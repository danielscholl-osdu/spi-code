// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createToolInstaller, extractBinary, ToolInstaller } from "./installer.js";
import { parseManifest } from "./manifest.js";

const exec = promisify(execFile);
const executable = Buffer.from("fixture executable\n");
const platform = process.platform === "win32" ? "win32-x64" : "darwin-arm64";
const binary = platform === "win32-x64" ? "gh.exe" : "gh";
let home: string;
let archive: Buffer;
let url: string;
let server: Server;

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
  home = await mkdtemp(join(tmpdir(), "spi-tools-home-"));
  await mkdir(join(home, "fixture", "bin"), { recursive: true });
  await writeFile(join(home, "fixture", "bin", binary), executable);
  const path = join(home, "fixture.tar.gz");
  await exec("tar", ["-czf", path, "-C", join(home, "fixture"), `bin/${binary}`]);
  archive = await readFile(path);
  server = createServer((_request, response) => response.end(archive));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  url = `http://127.0.0.1:${address.port}/fixture.tar.gz`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
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
