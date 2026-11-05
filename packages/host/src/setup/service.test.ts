// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Message,
  PROTOCOL_VERSION,
  type SetupSigninProgress,
  type SetupState,
} from "@spi-code/contracts";
import {
  cacheSchema,
  createContext,
  type Exec,
  emptyCache,
  type Facts,
  Sweeper,
} from "@spi-code/core";
import { ToolInstaller } from "@spi-code/tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostExec } from "../exec/host-exec.js";
import { openRunStore } from "../store/store.js";
import { SweepService } from "../sweep/service.js";
import {
  GITLAB_AREAS_REASON,
  type SetupGit,
  SetupService,
  type SetupServiceOptions,
} from "./service.js";

const GH_FIXTURE = `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
mark="$here/../../signed-in"
case "$1 $2" in
  "auth status")
    if [ -f "$mark" ]; then
      printf 'github.com\\n  Logged in to github.com account fixture (keyring)\\n  - Active account: true\\n  - Token: gho_****\\n  - Token scopes: '"'"'repo'"'"', '"'"'workflow'"'"'\\n' >&2
      exit 0
    fi
    printf 'You are not logged into any GitHub hosts.\\n' >&2
    exit 1;;
  "auth login")
    printf '! First copy your one-time code: ABCD-1234\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2
    : > "$mark"
    exit 0;;
esac
echo "spi-fixture-gh $*"
`;
const GH_STATUS_OK =
  "github.com\n  Logged in to github.com account fixture (keyring)\n  - Active account: true\n  - Token: gho_****\n  - Token scopes: 'repo', 'workflow'\n";

let directory: string;
let appData: string;
let server: Server;
let origin: string;
let archive: Buffer;
const services: SetupService[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "spi-setup-"));
  appData = join(directory, "app");
  const fixture = join(directory, "fixture");
  mkdirSync(join(fixture, "bin"), { recursive: true });
  writeFileSync(join(fixture, "bin", "gh"), GH_FIXTURE);
  chmodSync(join(fixture, "bin", "gh"), 0o755);
  execFileSync("tar", ["-czf", join(directory, "gh.tar.gz"), "-C", fixture, "bin/gh"]);
  archive = readFileSync(join(directory, "gh.tar.gz"));
  server = createServer((request, response) => {
    if (request.url === "/gh.tar.gz") response.end(archive);
    else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function installer(): ToolInstaller {
  const asset = (name: string, sha256: string) => ({
    "darwin-arm64": { url: `${origin}/${name}.tar.gz`, sha256 },
    "win32-x64": { url: `${origin}/${name}.tar.gz`, sha256 },
  });
  const sha = createHash("sha256").update(archive).digest("hex");
  return new ToolInstaller(
    appData,
    {
      tools: [
        { tool: "gh", version: "2.74.0", platforms: asset("gh", sha) },
        { tool: "glab", version: "1.74.0", platforms: asset("glab", "0".repeat(64)) },
      ],
    },
    "darwin-arm64",
  );
}

const git: SetupGit = {
  readiness: async () => ({ state: "ready", version: "2.45.0" }),
  install: async () => {},
};

function setup(overrides: Partial<SetupServiceOptions> & Pick<SetupServiceOptions, "exec">) {
  const sent: Message[] = [];
  const service = new SetupService({
    tools: async () => installer(),
    git: async () => git,
    probeSeat: async () => ({ kind: "seat-ok", models: ["auto"] }),
    createSweep: () => ({ start: async () => true, stop: async () => {} }),
    onError: (error) => {
      throw error;
    },
    ...overrides,
  });
  services.push(service);
  service.connect((message) => sent.push(message));
  const states = () =>
    sent.flatMap((message) => (message.type === "setup.state" ? [message.payload] : []));
  const progress = () =>
    sent.flatMap((message) => (message.type === "setup.signin.progress" ? [message.payload] : []));
  return { service, sent, states, progress };
}

function row(state: SetupState | undefined, tool: string) {
  return state?.tools.find((entry) => entry.tool === tool);
}

function request(
  type: "setup.install" | "setup.signin",
  payload: { tool: string; token?: string },
) {
  return {
    version: PROTOCOL_VERSION,
    id: `req-${type}`,
    kind: "request",
    type,
    payload,
  } as Message;
}

function hostExec(tools: ToolInstaller): HostExec {
  return new HostExec({
    appData,
    capturedPath: "/usr/bin:/bin",
    installer: tools,
    env: { HOME: directory, PATH: "/usr/bin:/bin" },
  });
}

it.skipIf(process.platform === "win32")(
  "installs gh from the pinned download and runs the managed binary through HostExec",
  async () => {
    const tools = installer();
    mkdirSync(join(appData, "tools", "gh"), { recursive: true });
    writeFileSync(join(appData, "tools", "gh", "signed-in"), "");
    const exec = hostExec(tools);
    const { service, states } = setup({ exec, tools: async () => tools });
    await service.refresh();
    expect(row(states().at(-1), "gh")).toMatchObject({ state: "missing", action: "install" });

    await service.routes["setup.install"]?.(request("setup.install", { tool: "gh" }), () => {});

    const gh = states().map((state) => row(state, "gh")?.state);
    expect(gh).toEqual(["missing", "installing", "ready"]);
    expect(row(states().at(-1), "gh")).toMatchObject({
      version: "2.74.0",
      scopes: ["repo", "workflow"],
    });
    const result = await exec.runText("gh", ["--version"]);
    expect(result).toMatchObject({ ok: true, data: "spi-fixture-gh --version\n" });
    expect(await tools.binDir("gh")).toBe(join(appData, "tools", "gh", "2.74.0", "bin"));

    await service.routes["setup.install"]?.(request("setup.install", { tool: "glab" }), () => {});
    expect(row(states().at(-1), "glab")).toMatchObject({
      state: "failed",
      action: "install",
      reason: expect.stringContaining("HTTP 404"),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "starts the SweepService once gh signs in with its scopes, and stops it when gh signs out",
  async () => {
    const tools = installer();
    await tools.install("gh");
    const exec = hostExec(tools);
    const path = join(directory, "store.sqlite");
    openRunStore(path).close();
    const db = new DatabaseSync(path);
    const starts: Promise<boolean>[] = [];
    const created = vi.fn();
    let sweep: SweepService | undefined;
    const { service, states, progress } = setup({
      exec,
      tools: async () => tools,
      createSweep: () => {
        created();
        const instance = new SweepService({
          db,
          fleet: "test",
          appData: directory,
          ctx: createContext({}),
          exec,
          factsSchema: z.custom<Facts>(),
          doctor: () => service.doctor(),
          onError: (error) => {
            throw error;
          },
          createSweeper: (options) =>
            new Sweeper({ ...options, areas: [], cacheSchema, emptyCache }),
        });
        sweep = instance;
        return {
          start: () => {
            const started = instance.start();
            starts.push(started);
            return started;
          },
          stop: () => instance.stop(),
        };
      },
    });
    try {
      await service.refresh();
      expect(row(states().at(-1), "gh")).toMatchObject({ state: "signed-out", action: "signin" });
      expect(states().at(-1)).toMatchObject({
        watchReady: false,
        disabledReason: expect.stringContaining("gh is not signed in"),
      });
      expect(created).not.toHaveBeenCalled();

      await service.routes["setup.signin"]?.(request("setup.signin", { tool: "gh" }), () => {});

      expect(progress().map(({ state }) => state)).toEqual([
        "starting",
        "device-code",
        "waiting",
        "completed",
      ]);
      expect(progress()[1]).toMatchObject({ deviceCode: "ABCD-1234" });
      expect(row(states().at(-1), "gh")).toMatchObject({
        state: "ready",
        scopes: ["repo", "workflow"],
      });
      expect(states().at(-1)).toMatchObject({ watchReady: true, disabledReason: null });
      expect(created).toHaveBeenCalledOnce();
      await expect(starts[0]).resolves.toBe(true);
      expect(sweep?.latest()).toBeDefined();

      await service.refresh();
      expect(created).toHaveBeenCalledOnce();

      rmSync(join(appData, "tools", "gh", "signed-in"));
      const stop = vi.spyOn(sweep as SweepService, "stop");
      await service.refresh();
      expect(states().at(-1)?.watchReady).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
      db.close();
    }
  },
);

it("reports the GitLab areas disabled while glab is missing, without blocking Watch", async () => {
  const exec: Exec = {
    runText: async (cmd) =>
      cmd === "gh"
        ? { ok: true, data: GH_STATUS_OK, exitCode: 0 }
        : { ok: false, error: "absent", code: null },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  const tools = {
    readiness: async (tool: string) =>
      tool === "gh"
        ? { state: "ready" as const, version: "2.74.0" }
        : { state: "missing" as const },
    install: async () => {},
  };
  const { service, states, progress } = setup({ exec, tools: async () => tools });
  await service.refresh();

  expect(row(states().at(-1), "glab")).toMatchObject({
    state: "missing",
    action: "install",
    reason: expect.stringContaining(GITLAB_AREAS_REASON),
  });
  expect(GITLAB_AREAS_REASON).toContain("upstream, radar");
  expect(states().at(-1)?.watchReady).toBe(true);
  expect(service.doctor()).toEqual({
    state: "partial",
    problems: [expect.stringContaining(GITLAB_AREAS_REASON)],
  });

  await service.routes["setup.signin"]?.(request("setup.signin", { tool: "glab" }), () => {});
  expect(progress()).toEqual<SetupSigninProgress[]>([
    { tool: "glab", state: "failed", reason: "Paste a GitLab token to sign in glab." },
  ]);
});

it("sends setup.state to each fresh connection", async () => {
  const exec: Exec = {
    runText: async () => ({ ok: true, data: GH_STATUS_OK, exitCode: 0 }),
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  const tools = {
    readiness: async () => ({ state: "missing" as const }),
    install: async () => {},
  };
  const { service, states } = setup({ exec, tools: async () => tools });
  await vi.waitFor(() => expect(states()).toHaveLength(1));
  expect(states()[0]).toMatchObject({ watchReady: false });

  const reloaded: Message[] = [];
  service.connect((message) => reloaded.push(message));
  expect(reloaded.map(({ type }) => type)).toEqual(["setup.state"]);
  expect(reloaded[0]?.payload).toEqual(states()[0]);
});
