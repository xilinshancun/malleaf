# Upstream provenance

Malleaf starts from [getpaseo/paseo](https://github.com/getpaseo/paseo), with its Git history intact.

- Initial commit: `de50243885ff47e0dc9c26233327fe066befa684`.
- Upstream package version: `0.14.0-beta.1`.
- Source branch: `main`, verified October 28, 2026 (Asia/Shanghai).
- License: Apache-2.0, with the original copyright and third-party notices preserved.

The `origin` remote points to `xilinshancun/malleaf`; `upstream` points to `getpaseo/paseo`.
Only the public upstream ancestry and Malleaf changes belong on Malleaf's main branch.

## Integrating changes

Bring upstream updates into a review branch, resolve conflicts, run the affected checks, and open a pull request against Malleaf main. Preserve the upstream merge ancestry when merging that pull request; squashing it discards the shared history needed for later integrations.

Personal versions track Malleaf releases. The product's customization workflow will handle their adaptation to later Malleaf versions separately from this maintainer workflow.

## Initial import checks

The imported upstream commit passed its quality, typecheck, application, server, desktop, and most browser CI jobs. Browser shard 8 reported 93 passed tests and an out-of-test `ENOTEMPTY` error while removing a worker's temporary directory. This is an unresolved upstream CI failure, not a fully green baseline. The upstream run is [40536405105](https://github.com/getpaseo/paseo/actions/runs/40536405105).

Inherited GitHub Actions are disabled during repository bootstrap. Release identities, package publication, app update feeds, data homes, and CI destinations must be reviewed before enabling distribution. Upstream release scripts are not Malleaf release instructions.
