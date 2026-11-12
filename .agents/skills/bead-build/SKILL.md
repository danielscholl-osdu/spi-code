---
name: bead-build
description: Build one spi-code bead from claim to a reviewed branch ready to land. Use when given a bead id to implement, when asked to "work", "build" or "take" a bead, or when picking up ready work in this repo.
---

# Build a bead

One bead, one worktree, one branch. You build it, someone from another provider reviews it, and `scripts/land` puts it on `main`.

## 1. Claim

Check before you claim. Stop if:

- the bead's epic (`bd show <id>` shows the parent) lacks the `breakdown:approved` label. A bead labelled `main-broken` is the exception: it has no epic and needs no approval.
- a bead labelled `main-broken` is open and this isn't it.

Pick a worker name once, your model plus four random hex characters (for example `sol-7f3a`), and pass it as `--actor` on every `bd` write. bd treats a repeat claim by the same actor as success, so two agents sharing a name could both claim one bead.

```bash
bd show <id>                      # read the description and acceptance
bd update <id> --claim --actor <worker>
bd update <id> --actor <worker> \
  --set-metadata build.provider=<anthropic|openai> \
  --set-metadata build.model=<model id>
```

Stop if the claim fails: someone else holds it.

## 2. Get a worktree

From the main checkout:

```bash
git worktree add .worktrees/<id> -b bead/<id> main
```

If your harness already gave you a worktree (T3 Code, a Keelson lease), it was cut from whatever its parent had checked out, under a name of the harness's choosing. Prepare it:

```bash
git status -sb                 # a clean worktree at a path made for this task, with no commits of its own:
git log --oneline main..HEAD   # prints nothing. If either is not so, the checkout is someone else's: stop.
git reset --hard main          # the local main ref is current; scripts/land moves it
git branch -m bead/<id>        # scripts/land finds the bead by this name
pnpm install --frozen-lockfile
pnpm build                     # packages import each other's built output
```

Never edit files in the main checkout.

## 3. Build

- Read the acceptance against the design or requirement it names before you write code. If they disagree, or a line can be read two ways, stop and ask the orchestrator; a ruling now costs minutes, and the same question found in review costs a round.
- Do what the acceptance criteria ask, and nothing more. Something else you notice becomes a new bead: `bd create "<title>" -t task --parent <epic> --deps discovered-from:<id>`.
- Write the test named in the acceptance first when you can.
- Follow `AGENTS.md` and `.agents/orchestration/rules.md`: the MIT header on new source files, no comments that narrate the change.
- What you learn that a later builder could not get from the code and tests goes in `docs/notes/<area>.md`, in a line or two. Never in `docs/sdlc.md`.
- Commit with `aipr` and the bead trailer:

  ```bash
  git commit -m "$(aipr commit -s)" --trailer "Bead: <id>"
  ```

- For work that runs long, keep the claim alive: `bd heartbeat <id> --actor <worker>`.

## 4. Check, push and show your evidence

```bash
scripts/check --quick
git push origin bead/<id>
```

`--quick` runs lint, typecheck, license headers and, once, the tests your diff reaches: the ones that import what you changed, every package that depends on a package you changed, and every package when a fixture changed. Don't hand off while it fails.

It takes from one minute for a window-only change to about six for a change in core, which most of the repository depends on. Give it a ten-minute timeout, or run it as a background command your harness lets you wait on. A bead written before 2026-11-11 may ask in its acceptance that `scripts/check` pass: CI's run on your pushed branch is that.

Don't run the full `scripts/check` on this machine: it runs every test twice, and several agents share the CPU. The push starts CI, which runs the full check and the packaged smoke on macOS and Windows. Run `pnpm package:mac` yourself only when your diff changes what the smoke looks at (`.agents/orchestration/rules.md` lists what).

Then write the evidence a reviewer will check, as a bead note:

```bash
bd note <id> "Built <sha> on main <sha>. CI run <run id>.
1. <acceptance line>: <test file:line>; fails when <the change you made to see it fail>.
2. ...
Not proven: <anything the acceptance asks that no test shows, and why>."
```

For each acceptance line, break the code the test guards, run that one test, see it fail, and restore the code (`git checkout -- <file>`; the shared stash is off limits). When the test lives in another package, rebuild the package you broke first (`pnpm --filter <package> build`), or the test runs the old build and passes; rebuild again after restoring. A line whose test you could not make fail is not done. Include the case the code cannot prove: when it cannot know an order, a read or a membership, it must report the quieter state, and a test must show that.

Two kinds of line have no failing test, and the note says so instead:

- a line the reviewer judges, such as a capture compared with the design: write "reviewer's: <what you looked at and saw>";
- a line only a command can show, such as a lint warning gone: write the command and its output.

Don't wait for CI before handing off; give the run id. The reviewer reads the run, and `scripts/land` waits for one.

## 5. Hand off

Stop here when an orchestrator dispatched you: reply with the worktree path, the branch, the head, the CI run id and the evidence note, and keep the claim. The orchestrator sends a reviewer from another provider.

When you work alone, follow `.agents/skills/bead-review/SKILL.md` to get that review yourself, fix the findings that hold up, push back on the ones that don't, and land with `.agents/skills/bead-land/SKILL.md` once the pass is recorded.

In a fix round you work in the bead's existing worktree, under your own `--actor` name; the claim stays with the bead. Change only what the findings name, take the nits that cost a line, and add to the evidence note a line per finding: the test, and that it fails without the fix.

If you stop early, leave a note saying where you got to (`bd note <id> "<state>"`) and keep the claim, so the next agent can pick it up.
