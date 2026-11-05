# Release notes parsing: spicode-t1k.3

Source: `keelson-rib-spi` at `59d6895`, `src/notes/file.ts:108`
and `test/releases.test.ts`.

`parseNotes(path, raw)` moves to core with no file I/O. The host supplies the
text or `undefined`. The existing `yaml` dependency replaces `JSON.parse` to
meet the bead's YAML acceptance; JSON documents remain supported. Syntax
errors say `not YAML` rather than `not JSON`; schema errors retain the first
issue's dotted path, and schema defaults and result states stay unchanged.

| Pinned case | Core coverage | Stays in the rib |
|---|---|---|
| missing, then created once and never overwritten | Missing text and valid JSON with the kept headline | Creation, reading and overwrite protection; the mixed case stays whole |
| a file that does not parse says where | Entire parsing assertion set: invalid status names `status`, malformed `{` is invalid; inputs supplied as text | File-write and read plumbing |

One parsing case moves; the missing/creation case remains counted in the rib,
with its parsing assertions also exercised in core. No rib test is deleted by
this bead. YAML parity, malformed YAML, nested schema errors and invalid root
documents add four new core cases, not baseline migration counts.

Other notes-file cases stay in the rib: status changes and approval validation;
agent draft parsing and prompting; draft writes, history and race protection;
external-file redraws and watching a folder created after startup. Document
models, collectors, inspector/board actions, PDF export and rib integration
are outside this bead. `readNotes`, `createNotes`, `writeDraft` and `watchNotes`
do not move.

The core dependency check additionally scans `notes.ts` for Node built-ins and
rejects planted `node:fs`, bare `fs` and `node:path` imports. Other core modules
retain their existing dependency policy.
