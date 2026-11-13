# @spi-code/core

SPI domain facts, models and briefing for plain Node, compiled as ESM with
TypeScript declarations.

## Vendoring version 0.1.2

Each vendored tarball must carry a version not used before; never replace the
contents of an already-vendored version.

When a consumer vendors version X, add X's SHA-256 to `pack-shas.json` and bump
this package to the next patch version.

From the repository root, run:

```sh
pnpm --filter @spi-code/core run pack
```

This builds core and runs `pnpm pack` on a temporary release staging directory.
The result is `packages/core/release/spi-code-core-0.1.2.tgz`; the script prints its
SHA-256. Vendor that tarball and pin it with a `file:` dependency in the consumer.
`node scripts/pack.mjs <release-directory>` from this package accepts an alternate
output directory.

Core and the window share contracts' `timeUnit` formatter, which binds each number
to its unit with U+00A0. The packer copies that compiled helper into
`dist/contracts/` and links core's imports to it. The release manifest omits the
workspace dependency rather than requiring an unpublished contracts version from
npm. Packing still fails if any other compiled JavaScript or declarations
reference contracts.
`yaml` and `zod` remain exact-version registry dependencies; an initial consumer
install needs registry access or a populated npm cache.

Only compiled code, declarations, this README and the MIT license ship. Tests,
fixtures and source maps are excluded. Use the `run pack` script above, not a
direct `pnpm pack` in the workspace: the latter retains the workspace dependency.

`test/pack.test.ts` installs the tarball into an empty temporary npm project with
its own cache, then imports `buildBriefing`. It runs with `scripts/check`. If the
npm registry cannot be reached, it reports a skip for the install proof after
checking the archive; run it again with registry access before release. It also fails
when the current version is recorded in `pack-shas.json` and packs to other bytes.
