---
description: "The dsh desktop pet: an agentic pet plugin that serves the pet renderer over the web composition, drives it from in-process dsh events, and answers approvals and questions from the desktop."
kind: "package-bundle"
---

# dsh-agentic-pet

English | [中文](README.zh.md)

## Summary

`dsh-agentic-pet` is a desktop-pet plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem: the pet lives on your desktop as a transparent always-on-top window, follows your agent sessions (idle / thinking / working / error), races the web GUI to answer approvals and user questions (first answer wins), collects a per-pet touch-affection ledger, and exposes expressive tools (`pet_say`, `pet_do`, `pet_digest`, `pet_interactions`, `pet_state`) so the model can speak and act through the pet. Multiple pet implementations can run side by side — a directory registry (`~/.dsh/pet-http.d/`) discovers every live pet and routes state, interactions, and ledgers per pet.

The pet itself is a dumb display with zero dsh knowledge. Everything that understands the runtime — event convergence, interaction waterfalls, multi-pet routing, the model tools — lives in the plugin's driver, and the pet only implements a small local HTTP control interface. Any pet implementation that speaks the same HTTP contract can be adopted without changing this plugin.

## What's in this repo

| Path | What it is |
|---|---|
| `src/` | The plugin (Cordis bundle): `/pet` route, event driver, registry, `PetService` seam, model tools, settings-page routes |
| `client/` | The desktop sidebar settings page (client half) |
| `carrier/` | The Electron carrier **build artifacts** shipped with the package (`lib/`, `dist-renderer/`) |
| `carrier-src/` | The carrier **sources** (mirrored from the dev upstream; media assets live in [dsh-pet-assets](https://github.com/beyondgjc/dsh-pet-assets)) |
| `vendor/typert-plugin/` | Vendored typert decorator plugin used by the packaging config |
| `tests/` | Vitest specs (pure-function coverage of the registry routing and the `/status` field-matrix normalization) |

## Install

From the DeepSeek Harness desktop app's plugin page, or:

```bash
dsh plugin --profile <name> add dsh-agentic-pet
```

The animation media ship as a separate package, `dsh-agentic-pet-assets`, and are pulled in automatically as a dependency.

## Development

The TypeScript build still runs inside the dsh monorepo workspace (the bundled `@deepseek-ai/dsh-*` deps are not published to npm). The flow:

1. In the monorepo: `pnpm run build` (plugin `lib/`) and `pnpm --filter @deepseek-ai/dsh-pet run build` (carrier `lib/` + `dist-renderer/`).
2. Here: `scripts\sync-from-monorepo.cmd` — mirrors sources and build outputs into this repo.
3. Commit here, then `npm publish` (assets package first; see [dsh-pet-assets/PUBLISH.md](../dsh-pet-assets/PUBLISH.md) for the release manual).

Tests: `npx vitest run tests/registry-service.spec.ts` runs self-contained (needs only `cordis` and `vitest`); the full suite including `tests/pet-app.spec.ts` runs in the monorepo workspace.

## Documentation

- Control-plane contract (the frozen consumer API every pet implementation speaks): see the multi-pet guide in the project documentation.
- Known limitations and design notes live in the repo wiki and the project's engineering docs.
