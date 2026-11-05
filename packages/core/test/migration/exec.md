# Exec boundary (spicode-t1k.2)

CO-05 / CO-03: core owns the `Exec` interface, matching Keelson's `RibExec`
options, result discriminant and methods. Optional `stdin` extends the options
for recorded input. No Keelson or Bun dependency is imported.

The result types and text/JSON interpretation are adapted from
Keelson `packages/shared/src/{rib,exec}.ts`. The recorder, replay and redactor
are new; no rib tests are removed or duplicated by this bead.

`RecordingExec(runner, write, env?)` takes a raw runner returning
`{stdout, stderr, exit, error?}` and an injected JSONL sink. The host implements
the runner and supplies its inherited environment for token-value redaction;
per-call environment values are included automatically. Core does no file or
process I/O. Sink failures reject the call. Runner exceptions become recorded
failed results. Calls execute concurrently, but writes retain invocation order.

Entries contain `{cmd, args, stdin, stdout, stderr, exit, ms}`, with optional
`error` for execution failures. Secrets are stripped before serialization,
including command/input fields. Live results remain unchanged. Replay returns
the sanitized recorded output, applies the caller's nonzero-exit policy and
parses JSON like the live path. `ReplayExec(jsonl, env?)` matches command,
arguments and stdin; callers supply the same token environment when replaying
calls with secret arguments. `assertExhausted()` detects leftover entries.

Tests: `src/exec/exec.test.ts` covers replay, mismatch/exhaustion, token patterns
in all streams and errors, option forwarding, concurrency, malformed logs and
sink failures. Existing dependency tests cover the new source files.
