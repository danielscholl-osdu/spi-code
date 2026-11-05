# SPI Code

A macOS and Windows desktop app for running the OSDU SPI program, with GitHub Copilot as its only agent. Nothing is built yet. The design lives in `design/`:

- `design/spi-code-product-brief.md`: what the product is and why
- `design/spi-code-prd.md`: requirements with IDs, milestones and checks; appendix C maps each capability to its source
- `design/spi-code-visual-design.html`: the window, palette and component kit

Where the original combined design (`design/spi-code-design.pdf`) disagrees with these, these win.

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
