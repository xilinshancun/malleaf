# Malleaf · 随形

**Software, shaped by you.**

[简体中文](README.zh-CN.md)

Malleaf is an open-source local agent app being built around a simple idea: describe how you want your software to work, and let an agent build your own version.

## Status

This repository is the initial source import. Malleaf's customization, version switching, and recovery workflow is under development; there is no Malleaf release yet. The imported application still carries upstream branding and update configuration.

## What we are building

- Customize the product through conversation: interface, backend, agent orchestration, and desktop behavior.
- Reuse installed Claude Code, Codex, and other supported agent harnesses.
- Build and test changes in an isolated local branch, try a personal version, and return to a working version when needed.
- Keep your customizations while adopting new Malleaf releases. Resolve product tradeoffs through plain-language choices.
- Share a customization or a complete version, and contribute useful changes back to the common product.

Source modification applies to Malleaf itself. Agent providers remain independent dependencies.

## Development

See [the product brief](docs/malleaf.md) and [development documentation](docs/development.md). Application identity, local state, and update feeds must be separated before distributing Malleaf builds. Existing upstream commands and downloads describe Paseo, not a released Malleaf product.

## Built on Paseo

Malleaf is an independent derivative of [Paseo](https://github.com/getpaseo/paseo), created by Mohamed Boudra and its contributors. We retain the original Git history, copyright notices, and [Apache-2.0 license](LICENSE). Third-party components retain their respective licenses.

The initial base is upstream commit [`de50243885ff47e0dc9c26233327fe066befa684`](https://github.com/getpaseo/paseo/commit/de50243885ff47e0dc9c26233327fe066befa684), verified as upstream `main` on October 28, 2026 (Asia/Shanghai). See the preserved [upstream README](README.paseo.md) and [upstream integration notes](UPSTREAM.md).

This README was adapted for Malleaf on October 28, 2026. Malleaf is independently maintained and is not an official Paseo distribution.
