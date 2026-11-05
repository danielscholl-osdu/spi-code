// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { ghAuthToken } from "../env/shell-environment.js";
import { buildAuthEnvironment, CopilotRuntime } from "./runtime.js";

async function files(directory: string, excluded?: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === excluded) continue;
    result.push(path);
    if (entry.isDirectory()) result.push(...(await files(path, excluded)));
  }
  return result.sort();
}

async function realHomeState() {
  return Promise.all(
    [
      "Library/Caches/copilot/copilot-user-cache.json",
      "Library/Application Support/Microsoft/DeveloperTools/deviceid",
    ].map(async (path) => {
      try {
        const info = await stat(join(homedir(), path));
        return { path, exists: true, size: info.size, mtimeMs: info.mtimeMs };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
        return { path, exists: false };
      }
    }),
  );
}

it("detects new empty directories outside app data", async () => {
  const root = await mkdtemp(join(tmpdir(), "spicode-isolation-listing-"));
  try {
    const appDataDir = join(root, "app-data");
    await mkdir(appDataDir);
    expect(await files(root, appDataDir)).toEqual([]);
    const empty = join(root, "empty");
    await mkdir(empty);
    await mkdir(join(appDataDir, "excluded"));
    expect(await files(root, appDataDir)).toEqual([empty]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.env.SPICODE_LIVE_COPILOT_ISOLATION !== "1")(
  "opens a real session and lists models without writing outside app data",
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "spicode-runtime-isolation-"));
    const appDataDir = join(root, "app-data");
    const home = join(root, "home");
    const capturedPath = process.env.PATH ?? "";
    let runtime: CopilotRuntime | undefined;
    try {
      const authEnv = buildAuthEnvironment({
        appDataDir,
        capturedPath,
      });
      let token: string;
      try {
        token = await ghAuthToken(authEnv);
      } catch {
        context.skip("Requires gh sign-in and a Copilot seat.");
        return;
      }
      await mkdir(appDataDir);
      await mkdir(home);
      const before = await files(root, appDataDir);
      const realHomeBefore = await realHomeState();
      runtime = new CopilotRuntime(
        {
          appDataDir,
          capturedPath,
          env: {
            ...authEnv,
            HOME: home,
            USERPROFILE: home,
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_STATE_HOME: join(home, ".state"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
            APPDATA: join(home, "AppData", "Roaming"),
            COPILOT_HOME: join(home, ".copilot"),
          },
        },
        async () => token,
      );
      const session = await runtime.createSession();
      let modelCount: number;
      try {
        modelCount = (await runtime.listModels()).models.length;
        expect(modelCount).toBeGreaterThan(0);
      } finally {
        await session.disconnect();
      }
      await runtime.stop();
      const after = await files(root, appDataDir);
      const realHomeAfter = await realHomeState();
      const listing = (paths: string[]) => paths.map((path) => relative(root, path));
      console.log(
        JSON.stringify({
          sessionOpened: true,
          modelCount,
          outsideAppDataBefore: listing(before),
          outsideAppDataAfter: listing(after),
          realHomeBefore,
          realHomeAfter,
          appDataFiles: listing(await files(appDataDir)),
        }),
      );
      expect(after).toEqual(before);
      expect(realHomeAfter).toEqual(realHomeBefore);
    } finally {
      try {
        await runtime?.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
