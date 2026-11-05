// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  createWindowsGitInstaller,
  type GitPin,
  MacGitInstaller,
  type Runner,
  WindowsGitInstaller,
} from "./installer.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "spi-git-"));
  homes.push(home);
  const data = Buffer.from("fake SFX");
  const asset = async (name: string) => {
    const path = join(home, name);
    await writeFile(path, data);
    return {
      url: pathToFileURL(path).href,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  };
  const pin: GitPin = {
    version: "2.56.0-windows.4",
    portable: await asset("portable.7z.exe"),
    minimal: await asset("minimal.zip"),
  };
  const runner = vi.fn<Runner>(async (_cmd, args) => {
    const payload = args[0] === "-y" ? args[1]?.slice(2) : args[3];
    if (!payload) throw new Error("Missing extraction destination");
    await mkdir(join(payload, "cmd"), { recursive: true });
    await mkdir(join(payload, "mingw64", "bin"), { recursive: true });
    await writeFile(join(payload, "cmd", "git.exe"), "shim");
    await writeFile(join(payload, "mingw64", "bin", "runtime.dll"), "runtime");
    return { code: 0, stdout: "" };
  });
  return { home, pin, runner };
}

test("fake SFX gets exact switches; full runtime is published and damaged files are repaired", async () => {
  const { home, pin, runner } = await fixture();
  const app = join(home, "app");
  const installer = new WindowsGitInstaller(app, pin, runner);
  expect(await installer.readiness()).toEqual({ state: "missing" });
  const work = installer.install();
  expect(await installer.readiness()).toEqual({ state: "installing" });
  await expect(installer.install()).rejects.toThrow("already running");
  await work;
  expect(runner.mock.calls[0]?.[0]).toMatch(/archive\.exe$/);
  expect(runner.mock.calls[0]?.[1]).toEqual(["-y", expect.stringContaining("-o")]);
  const bin = await installer.binDir();
  if (!bin) throw new Error("Git was not published");
  expect(await readFile(join(bin, "git.exe"), "utf8")).toBe("shim");
  const dll = join(bin, "..", "mingw64", "bin", "runtime.dll");
  await writeFile(dll, "damaged");
  await installer.install();
  expect(await readFile(dll, "utf8")).toBe("runtime");
  expect(await readFile(join(app, "tools", "git", "current"), "utf8")).toBe(pin.version);
  expect(await readdir(app)).toEqual(["tools"]);
});

test("SFX failure falls back to MinGit; bad checksums never execute an archive", async () => {
  const { home, pin, runner } = await fixture();
  runner.mockResolvedValueOnce({ code: 1, stdout: "" });
  const installer = new WindowsGitInstaller(join(home, "app"), pin, runner);
  await installer.install();
  expect(runner.mock.calls[1]?.[1][0]).toBe("-xf");
  expect(await installer.readiness()).toEqual({ state: "ready", version: pin.version });
  runner.mockClear();
  pin.portable.sha256 = pin.minimal.sha256 = "0".repeat(64);
  const bad = new WindowsGitInstaller(join(home, "bad"), pin, runner);
  await expect(bad.install()).rejects.toThrow("PortableGit and MinGit");
  expect(runner).not.toHaveBeenCalled();
  expect((await bad.readiness()).state).toBe("failed");
  expect(await readdir(join(home, "bad"))).toEqual([]);
});

test("a failed or aborted update keeps the existing current", async () => {
  const { home, pin, runner } = await fixture();
  const installer = new WindowsGitInstaller(home, pin, runner);
  await installer.install();
  const update = new WindowsGitInstaller(home, { ...pin, version: "3.0.0" }, async () => {
    throw new Error("killed");
  });
  await expect(update.install()).rejects.toThrow();
  await expect(update.install(AbortSignal.abort())).rejects.toThrow();
  expect(await update.binDir()).toBe(await installer.binDir());
  expect(await readdir(join(home, "tools", "git"))).toEqual([pin.version, "current"]);
});

test("packaged Git pins parse without changing the existing single-binary manifest", async () => {
  const { home } = await fixture();
  expect(await (await createWindowsGitInstaller(home)).readiness()).toEqual({ state: "missing" });
});

test("macOS probes git, not an xcode-select path, and polls after the fake install prompt", async () => {
  let now = 0;
  let probes = 0;
  const runner = vi.fn<Runner>(async (cmd) => ({
    code: cmd === "xcode-select" || ++probes >= 4 ? 0 : 1,
    stdout: "git version 2.50.0",
  }));
  const installer = new MacGitInstaller(
    runner,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    3000,
  );
  expect(await installer.readiness()).toEqual({ state: "missing" });
  await installer.install();
  expect(runner.mock.calls[1]?.slice(0, 2)).toEqual(["xcode-select", ["--install"]]);
  expect(now).toBe(2000);
  expect((await installer.readiness()).state).toBe("ready");
});

test("macOS cancellation, prompt failure and bounded deadline surface failed states", async () => {
  let now = 0;
  const runner: Runner = async (cmd) => ({ code: cmd === "git" ? 1 : 0, stdout: "" });
  const installer = new MacGitInstaller(
    runner,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    1500,
  );
  await expect(installer.install()).rejects.toThrow("Timed out");
  expect(now).toBe(1500);
  expect((await installer.readiness()).state).toBe("failed");
  await expect(installer.install(AbortSignal.abort())).rejects.toThrow();
  await expect(
    new MacGitInstaller(async () => ({ code: 1, stdout: "" })).install(),
  ).rejects.toThrow("xcode-select --install exited 1");
});

test.skipIf(process.platform !== "win32")(
  "Windows executes a fake SFX process and publishes its runtime",
  async () => {
    const { home, pin } = await fixture();
    // A copied Node executable is the fake SFX; --require supplies its extraction script.
    const { execPath } = process;
    const bytes = await readFile(execPath);
    const path = join(home, "fake.7z.exe");
    await writeFile(path, bytes);
    const script = join(home, "extract.cjs");
    await writeFile(
      script,
      `const fs=require('node:fs');const p=require('node:path');
const out=process.argv.find(x=>x.startsWith('-o')).slice(2);
fs.mkdirSync(p.join(out,'cmd'),{recursive:true});fs.writeFileSync(p.join(out,'cmd','git.exe'),'fake');
process.exit(0);`,
    );
    const { run } = await import("./installer.js");
    const runner: Runner = async (cmd, args, signal) => {
      const { promisify } = await import("node:util");
      const { execFile } = await import("node:child_process");
      await promisify(execFile)(cmd, ["--require", script, "--", ...args], { signal });
      return { code: 0, stdout: "" };
    };
    pin.portable = {
      url: pathToFileURL(path).href,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const installer = new WindowsGitInstaller(join(home, "app"), pin, runner);
    await installer.install();
    expect((await installer.readiness()).state).toBe("ready");
    expect((await run(join(home, "missing.exe"), [])).code).toBe(127);
  },
);
