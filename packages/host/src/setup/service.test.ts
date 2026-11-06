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
let server: Server | undefined;
let origin: string;
let archive: Buffer;
const services: SetupService[] = [];

beforeEach(async () => {
  server = undefined;
  directory = mkdtempSync(join(tmpdir(), "spi-setup-"));
  appData = join(directory, "app");
  const fixture = join(directory, "fixture");
  mkdirSync(join(fixture, "bin"), { recursive: true });
  writeFileSync(join(fixture, "bin", "gh"), GH_FIXTURE);
  chmodSync(join(fixture, "bin", "gh"), 0o755);
  // Relative paths: GNU tar from Git for Windows reads "C:" in an archive path as a remote host.
  execFileSync("tar", ["-czf", "gh.tar.gz", "-C", "fixture", "bin/gh"], { cwd: directory });
  archive = readFileSync(join(directory, "gh.tar.gz"));
  const listening = createServer((request, response) => {
    if (request.url === "/gh.tar.gz") response.end(archive);
    else response.writeHead(404).end();
  });
  server = listening;
  listening.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listening.once("listening", resolve));
  origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  const listening = server;
  if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
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

function hostExec(tools: ToolInstaller, capturedPath = "/usr/bin:/bin"): HostExec {
  return new HostExec({
    appData,
    capturedPath,
    installer: tools,
    env: { HOME: directory, PATH: "/usr/bin:/bin" },
  });
}

/** An Exec that answers each call from `answer`, given the command and its arguments. */
function fakeExec(answer: (cmd: string, args: string[]) => string | undefined): Exec {
  return {
    runText: async (cmd, args) => {
      const data = answer(cmd, args);
      return data === undefined
        ? { ok: false, error: "absent", code: null }
        : { ok: true, data, exitCode: 0 };
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
}

const managedGh = {
  readiness: async (tool: string) =>
    tool === "gh" ? { state: "ready" as const, version: "2.74.0" } : { state: "missing" as const },
  install: async () => {},
};

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

      // Signed out outside the app: the next window connect re-reads gh and stops the sweep.
      rmSync(join(appData, "tools", "gh", "signed-in"));
      const stop = vi.spyOn(sweep as SweepService, "stop");
      const refresh = vi.spyOn(service, "refresh");
      const reloaded: Message[] = [];
      service.connect((message) => reloaded.push(message));
      expect(refresh).toHaveBeenCalledOnce();
      await refresh.mock.results[0]?.value;
      expect(stop).toHaveBeenCalledOnce();
      expect(reloaded.at(-1)).toMatchObject({
        type: "setup.state",
        payload: {
          watchReady: false,
          disabledReason: expect.stringContaining("gh is not signed in"),
        },
      });
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
    {
      requestId: "req-setup.signin",
      tool: "glab",
      state: "failed",
      reason: "Paste a GitLab token to sign in glab.",
    },
  ]);
});

it("sends setup.state to each fresh connection", async () => {
  const exec = fakeExec((_cmd, args) => (args[0] === "--version" ? undefined : GH_STATUS_OK));
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

it.skipIf(process.platform === "win32")(
  "uses a signed-in gh from the login-shell PATH when no managed copy exists",
  async () => {
    const shell = join(directory, "shell", "bin");
    mkdirSync(shell, { recursive: true });
    writeFileSync(join(shell, "gh"), GH_FIXTURE);
    chmodSync(join(shell, "gh"), 0o755);
    writeFileSync(join(directory, "signed-in"), "");
    const tools = installer();
    const created = vi.fn();
    const { service, states } = setup({
      exec: hostExec(tools, `${shell}:/usr/bin:/bin`),
      tools: async () => tools,
      createSweep: () => {
        created();
        return { start: async () => true, stop: async () => {} };
      },
    });
    await service.refresh();

    expect(await tools.readiness("gh")).toEqual({ state: "missing" });
    expect(row(states().at(-1), "gh")).toMatchObject({
      state: "ready",
      action: null,
      scopes: ["repo", "workflow"],
      reason: "Using gh from the login-shell PATH.",
    });
    expect(states().at(-1)).toMatchObject({ watchReady: true, disabledReason: null });
    expect(created).toHaveBeenCalledOnce();
  },
);

it("re-reads on its interval, stops the sweep after an outside sign-out, and re-probes the seat on an account switch", async () => {
  let signedIn = true;
  let token = "gho_first";
  const exec = fakeExec((cmd, args) => {
    if (cmd === "gh" && args[1] === "status") return signedIn ? GH_STATUS_OK : undefined;
    if (cmd === "gh" && args[1] === "token") return signedIn ? token : undefined;
    return undefined;
  });
  const stop = vi.fn(async () => {});
  const probeSeat = vi.fn(async () => ({ kind: "seat-ok" as const, models: ["auto"] }));
  const { states } = setup({
    exec,
    tools: async () => managedGh,
    probeSeat,
    intervalMs: 20,
    createSweep: () => ({ start: async () => true, stop }),
  });
  await vi.waitFor(() => expect(states().at(-1)?.watchReady).toBe(true));
  expect(probeSeat).toHaveBeenCalledOnce();

  token = "gho_second";
  await vi.waitFor(() => expect(probeSeat).toHaveBeenCalledTimes(2));

  signedIn = false;
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(states().at(-1)).toMatchObject({ watchReady: false });
});

it("starts a sweep again at the next ready read after its start rejected", async () => {
  let signedIn = false;
  const errors: unknown[] = [];
  const start = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValueOnce(new Error("prune failed"))
    .mockResolvedValue(true);
  const createSweep = vi.fn(() => ({ start, stop: async () => {} }));
  const { service, states } = setup({
    exec: fakeExec((cmd) => (cmd === "gh" && signedIn ? GH_STATUS_OK : undefined)),
    tools: async () => managedGh,
    createSweep,
    onError: (error) => errors.push(error),
  });
  await vi.waitFor(() => expect(states()).toHaveLength(1));
  signedIn = true;
  await service.refresh();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(start).toHaveBeenCalledOnce();

  await service.refresh();
  expect(createSweep).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
  await service.refresh();
  expect(start).toHaveBeenCalledTimes(2);
});

it("runs one gh sign-in flow when copilot and gh ask together", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logins = vi.fn();
  const exec: Exec = {
    runText: async (cmd, args) => {
      if (cmd === "gh" && args[1] === "login") {
        logins();
        await held;
        return { ok: true, data: "", exitCode: 0 };
      }
      return { ok: false, error: "absent", code: null };
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  const { service } = setup({ exec, tools: async () => managedGh });
  const copilot = service.routes["setup.signin"]?.(
    request("setup.signin", { tool: "copilot" }),
    () => {},
  );
  const gh = service.routes["setup.signin"]?.(request("setup.signin", { tool: "gh" }), () => {});
  await gh;
  release();
  await copilot;
  expect(logins).toHaveBeenCalledOnce();
});

type Held = {
  cmd: string;
  args: string[];
  opts: Parameters<Exec["runText"]>[2];
  release: (data?: string) => void;
};

/** An Exec whose sign-in calls wait until the test releases them; other calls answer at once. */
function heldExec(answer: (cmd: string, args: string[]) => string | undefined = () => undefined) {
  const held: Held[] = [];
  const exec: Exec = {
    runText: async (cmd, args, opts) => {
      const signin =
        (cmd === "gh" && args[1] === "login") ||
        (cmd === "glab" && args[0] === "api" && !!opts?.env?.GITLAB_TOKEN) ||
        (cmd === "glab" && args[1] === "login");
      if (!signin) {
        const data = answer(cmd, args);
        return data === undefined
          ? { ok: false, error: "absent", code: null }
          : { ok: true, data, exitCode: 0 };
      }
      // Ignores the abort signal, the worst case: the old flow runs to its end.
      return new Promise((resolve) => {
        held.push({
          cmd,
          args,
          opts,
          release: (data) =>
            resolve(
              data === undefined
                ? { ok: false, error: "absent", code: null }
                : { ok: true, data, exitCode: 0 },
            ),
        });
      });
    },
    runJSON: async () => ({ ok: false, error: "unused", code: null }),
  };
  return { exec, held };
}

/** Releases every held call, including ones made later, until the flow settles. */
async function drain(flow: unknown, held: Held[], data?: string) {
  let done = false;
  void Promise.resolve(flow).then(() => {
    done = true;
  });
  await vi.waitFor(() => {
    for (const call of held) call.release(data);
    expect(done).toBe(true);
  });
}

function signinRequest(id: string, payload: { tool: string; token?: string }) {
  return { ...request("setup.signin", payload), id };
}

const DEVICE_OUTPUT =
  "! First copy your one-time code: WXYZ-9876\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
const PAT_SELF = JSON.stringify({ scopes: ["api"] });

function progressOf(messages: Message[]) {
  return messages.flatMap((message) =>
    message.type === "setup.signin.progress" ? [message.payload] : [],
  );
}

it("stamps every sign-in progress with the id of the request that started it", async () => {
  const { exec, held } = heldExec();
  const { service, progress } = setup({ exec, tools: async () => managedGh });
  const flow = service.routes["setup.signin"]?.(signinRequest("req-gh", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  held[0]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[0]?.release("");
  await flow;
  expect(progress()).toEqual([
    { requestId: "req-gh", tool: "gh", state: "starting" },
    {
      requestId: "req-gh",
      tool: "gh",
      state: "device-code",
      deviceCode: "WXYZ-9876",
      url: "https://github.com/login/device",
    },
    { requestId: "req-gh", tool: "gh", state: "waiting" },
    { requestId: "req-gh", tool: "gh", state: "completed" },
  ]);
});

it("retires an in-flight gh flow on reconnect: none of its progress reaches the new connection, and a new request starts fresh", async () => {
  const { exec, held } = heldExec();
  const { service, progress: before } = setup({ exec, tools: async () => managedGh });
  const old = service.routes["setup.signin"]?.(signinRequest("req-old", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));

  const after: Message[] = [];
  service.connect((message) => after.push(message));
  expect(held[0]?.opts?.signal?.aborted).toBe(true);

  const fresh = service.routes["setup.signin"]?.(
    signinRequest("req-new", { tool: "copilot" }),
    () => {},
  );
  await vi.waitFor(() => expect(held).toHaveLength(2));
  // The old flow's late device code, waiting and terminal arrive during the new pending request.
  held[0]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[0]?.release("");
  await old;
  expect(progressOf(after)).toEqual([{ requestId: "req-new", tool: "copilot", state: "starting" }]);

  held[1]?.opts?.onOutput?.("stderr", DEVICE_OUTPUT);
  held[1]?.release("");
  await fresh;
  expect(progressOf(after).map(({ requestId, state }) => `${requestId}:${state}`)).toEqual([
    "req-new:starting",
    "req-new:device-code",
    "req-new:waiting",
    "req-new:completed",
  ]);
  expect(before()).toEqual([{ requestId: "req-old", tool: "gh", state: "starting" }]);
});

it.each(["accepts", "rejects"] as const)(
  "retires an in-flight glab flow on reconnect so no terminal reaches the new connection when GitLab %s the token",
  async (end) => {
    const token = "glpat-OldFlow0123456789";
    const { exec, held } = heldExec((cmd, args) =>
      cmd === "glab" && args[0] === "api" ? PAT_SELF : undefined,
    );
    const { service, progress: before } = setup({ exec, tools: async () => managedGh });
    const old = service.routes["setup.signin"]?.(
      signinRequest("req-old", { tool: "glab", token }),
      () => {},
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(before().map(({ state }) => state)).toEqual(["starting", "waiting"]);

    const after: Message[] = [];
    service.connect((message) => after.push(message));
    held[0]?.release(end === "accepts" ? PAT_SELF : undefined);
    await drain(old, held, "");
    expect(progressOf(after)).toEqual([]);
    expect(before().map(({ state }) => state)).toEqual(["starting", "waiting"]);
  },
);

it("answers a second request for a running flow on the same connection instead of dropping it", async () => {
  const { exec, held } = heldExec();
  const { service, progress } = setup({ exec, tools: async () => managedGh });
  const first = service.routes["setup.signin"]?.(signinRequest("req-gh", { tool: "gh" }), () => {});
  await vi.waitFor(() => expect(held).toHaveLength(1));
  await service.routes["setup.signin"]?.(
    signinRequest("req-copilot", { tool: "copilot" }),
    () => {},
  );
  expect(progress()).toContainEqual({
    requestId: "req-copilot",
    tool: "copilot",
    state: "failed",
    reason: "A gh sign-in is already running.",
  });
  held[0]?.release("");
  await first;
  expect(held).toHaveLength(1);
});

it("keeps a planted glab token out of every message, on both connections, and every error", async () => {
  const token = "glpat-Planted0123456789abcdef";
  const errors: unknown[] = [];
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method),
  );
  const cases = [
    { probe: undefined, reconnect: false, last: "failed" },
    { probe: JSON.stringify({ scopes: ["read_user"] }), reconnect: false, last: "failed" },
    { probe: PAT_SELF, reconnect: false, last: "completed" },
    { probe: PAT_SELF, reconnect: true, last: "waiting" },
  ];
  for (const [index, { probe, reconnect, last }] of cases.entries()) {
    const { exec, held } = heldExec((cmd, args) =>
      cmd === "glab" && args[0] === "api" ? PAT_SELF : undefined,
    );
    const { service, sent, progress } = setup({
      exec,
      tools: async () => managedGh,
      onError: (error) => errors.push(error),
    });
    const later: Message[] = [];
    const flow = service.routes["setup.signin"]?.(
      signinRequest(`req-${index}`, { tool: "glab", token }),
      () => {},
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    if (reconnect) service.connect((message) => later.push(message));
    held[0]?.release(probe);
    await drain(flow, held, "");
    expect(progress().at(-1)?.state).toBe(last);
    const scanned = JSON.stringify([sent, later]);
    expect(scanned).not.toContain(token);
    expect(scanned).not.toContain("Planted");
  }
  expect(JSON.stringify(errors.map(String))).not.toContain(token);
  for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(token);
});
