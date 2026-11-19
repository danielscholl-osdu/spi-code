# Thread view

- `apps/window/src/threads` draws data it is given: its props are the types in `types.ts`, and it imports no host client. The thread route and entry points wire it (spicode-xia.8).
- Highlighted rows in the composer's menus and the model picker sit on `--surface-raised`, never `--hover`: muted words on `--hover` fall under 4.5:1 in Warm dark, and the palette test gates every text role on `--surface-raised`.
- macOS resolves imports case-insensitively, so a `timeline.ts` beside `Timeline.tsx` shadows it under Vite. The pure row module is `rows.ts`.
- The list mounts at most `ROW_BUDGET` rows and follows the end while the reader is there; a work group's open state lives in the timeline, so a row scrolled out and back keeps it.

## Tool output redaction

- `@spi-code/threads` exports `journalOutputRedactor` for SQLite and `modelOutputRedactor` for everything the host returns to Copilot from a tool. With host-known secrets, call `createToolOutputRedactor(knownSecrets)` and pass its `journal` profile to `ThreadEngine`. Use its `model` profile for SDK hooks and SPI tools. Use `value` for structured output, `text` for text and `chunks` for one complete output delivered in pieces. The journal masks secret labels as well as recognized formats. The model profile covers GitHub and GitLab token prefixes, PEM private key blocks, and exact, case-sensitive host-known values. The remaining model rules for Azure connection strings, `sig=`, `AccountKey`, `SharedAccessKey`, Authorization headers, and kubeconfig fields, along with additional PEM cases, are tracked in `spicode-xia.26` under `spicode-xia`.
- The engine records the size of the redacted tool result JSON. Assistant text is journaled by complete line when safe. Streaming resumes when a held block ends. The engine flushes held text through the journal profile before recording a tool start or approval request and at turn end. The pending tail holds up to 16,384 UTF-16 code units between deltas. On overflow the engine writes a redaction marker and suppresses the continuation of the oversized line or block.
- Live macOS arm64 probe with Copilot SDK 1.0.26. Run `pnpm build` and `node scripts/probe-copilot-redaction.ts --use-existing-login` with a signed-in Copilot CLI. The script launches the host's bundled runtime over stdio and restricts the shell to its own fixture commands and workspace. Its report masks the fixture even when an event holds the original.

| Shell case | `tool.execution_complete` | Copilot reply |
| --- | --- | --- |
| `cat probe-fixture.txt` | Sandboxed, SDK success, exit 0. The success hook received the original fixture. Model-facing `result.content` held `probe-value=[redacted]` after `modifiedResult`. | `MARKER` |
| `cat probe-fixture.txt >&2; exit 7` | Sandboxed, SDK success, exit 7. The same hook redacted the stderr fixture before model-facing `result.content`. | `MARKER` |
| `bash` rejected an invalid `mode` carrying the fake fixture | SDK failure. The failure hook received the original fixture. The completion event omitted `result.content` and its error had no fixture. The SDK ignored the hook's attempted `modifiedResult`. | `ABSENT` |

Decision 6 on `spicode-xia.1` accepts the SDK boundary for sandboxed built-ins. The failure hook supports `additionalContext` and the model receives the failure as produced by the runtime. This probe observed a validation failure with the fixture only in the hook, so a model-facing failure with raw subprocess output remains unobserved. The engine redacts any failure contents passed to the SPI Code journal. The live SDK adapter wiring belongs to `spicode-xia.6`.
