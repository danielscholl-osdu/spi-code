# SPI Code

A macOS and Windows desktop app for running the OSDU SPI program, with GitHub Copilot as its only agent. Nothing is built yet. The design lives in `design/`:

- `design/spi-code-product-brief.md`: what the product is and why
- `design/spi-code-prd.md`: requirements with IDs, milestones and checks; appendix C maps each capability to its source
- `design/spi-code-visual-design.html`: the window, palette and component kit

Where the original combined design (`design/spi-code-design.pdf`) disagrees with these, these win.

## How work moves

Work is tracked in beads (`bd`, prefix `spicode`), built in parallel worktrees, reviewed by a different provider, and landed by `scripts/land`. No GitHub issues or pull requests. `docs/sdlc.md` has the whole flow.

1. Work only on a claimed bead, in its own worktree, on branch `bead/<id>`. Never edit in the main checkout.
2. One bead, one author, one review, one landing. Anything outside the bead's acceptance becomes a new bead.
3. A different provider reviews what you wrote, and the pass is recorded on the bead.
4. Land only with `scripts/land <id>`. Never commit, merge or push to `main` by hand.
5. If a bead labelled `main-broken` is open, fixing it comes first.
6. Never close a bead without a landed commit or a stated reason.

| Skill | Use it to |
|---|---|
| `.agents/skills/epic-breakdown/SKILL.md` | Break a milestone epic into beads and dispatch the ready wave |
| `.agents/skills/bead-build/SKILL.md` | Claim and build one bead |
| `.agents/skills/bead-review/SKILL.md` | Review a bead from another provider and record the verdict |
| `.agents/skills/bead-land/SKILL.md` | Land a reviewed bead on `main` |
| `.agents/skills/stop-the-line/SKILL.md` | Fix a broken `main` |

`scripts/check` runs the checks every bead must pass. The beads database (`.beads/`) is git-ignored and local to this machine; every worktree finds it through git's common directory.

## License headers

SPI Code is MIT. Every source file starts with:

```ts
// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
```

- **New files:** use the header above.
- **Code extracted or ported from keelson-rib-spi or Keelson:** replace the Apache-2.0 header with the MIT header above. Daniel Scholl holds the copyright in both, so the code is relicensed as it moves. The source repositories stay Apache-2.0.
- **Files copied from T3 Code:** keep T3 Tools Inc.'s copyright and MIT permission notice as they are. Do not replace it.
- **Code ported from T3 Code:** put the Daniel Scholl line above T3 Tools Inc.'s copyright and MIT permission notice, and keep that notice. MIT requires it in substantial portions, even when the code is rewritten without Effect.
- **Bundled third-party packages:** list them in the packaged app's third-party notices file (PRD NF-08).

## Source repositories

Read-only references the PRD cites, at the commits in the brief's Built from table:

| Repository | Local path |
|---|---|
| keelson-rib-spi | `/Users/danielscholl/keelson/keelson-rib-spi` |
| Keelson | `/Users/danielscholl/keelson/keelson` |
| T3 Code | `/Users/danielscholl/source/github/t3code` |
