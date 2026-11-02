#!/usr/bin/env node
/**
 * Mirror the monorepo package manifest into this release repo, keeping the
 * release repo's own `version`.
 *
 * The release version is owned HERE. The monorepo copy carries the workspace
 * version baked into the installed desktop build (`0.2.1-rc.3`), so a plain
 * copy silently rewrote the published version — the failure that left npm
 * `0.4.0` with no commit (and no tag) that ever carried that number.
 *
 * Every other field follows the monorepo. `devDependencies` ranges written
 * with the `workspace:` protocol do not survive publishing from this repo, so
 * they are normalized to concrete ranges; an unrecognized `workspace:` range
 * is a hard error rather than a manifest the registry later rejects.
 *
 * Usage: node sync-package-json.mjs <monorepo/package.json> <release/package.json>
 * Exit codes: 0 written, 1 usage/validation error, 2 unreadable input.
 *
 * @module scripts/sync-package-json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** `x.y.z` or `x.y.z-pre`. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** Concrete ranges this repo publishes; upstream declares them as `workspace:`. */
const DEV_RANGES = { '@deepseek-ai/cordis': '^4.0.5', vitest: '^4.1.11' }
/**
 * Manifest fields this repo owns. The monorepo copy is a workspace manifest and
 * carries none of them, so a plain mirror deletes them — `repository` is how the
 * npm package links back to the repo that the plugin list points at.
 */
const RELEASE_OWNED = ['repository', 'bugs', 'homepage']

const [monoArg, releaseArg] = process.argv.slice(2)
if (monoArg === undefined || releaseArg === undefined) {
  console.error('usage: node sync-package-json.mjs <monorepo/package.json> <release/package.json>')
  process.exit(1)
}
const monoPath = resolve(monoArg)
const releasePath = resolve(releaseArg)

/** @param {string} file @returns {Record<string, any>} */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    console.error(`sync-package-json: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

const mono = readManifest(monoPath)
if (typeof mono.name !== 'string' || mono.name === '') {
  console.error(`sync-package-json: ${monoPath} is not a package manifest`)
  process.exit(2)
}
const upstreamVersion = mono.version

// The release repo owns the version. A fresh repo (no manifest yet) seeds from
// upstream once; after that the value survives every mirror.
const release = readManifest(releasePath)
let version = upstreamVersion
let seeded = true
if (Object.keys(release).length > 0) {
  seeded = false
  if (typeof release.version !== 'string' || !SEMVER.test(release.version)) {
    console.error(`sync-package-json: ${releasePath} carries no usable version (${JSON.stringify(release.version)})`)
    process.exit(1)
  }
  version = release.version
}
if (typeof version !== 'string' || !SEMVER.test(version)) {
  console.error(`sync-package-json: upstream carries no usable version (${JSON.stringify(version)}) and the release repo has none`)
  process.exit(1)
}

mono.version = version
for (const field of RELEASE_OWNED) {
  if (release[field] !== undefined) mono[field] = release[field]
}
mono.devDependencies = { ...mono.devDependencies }
for (const [name, range] of Object.entries(DEV_RANGES)) {
  if (name in mono.devDependencies || name === '@deepseek-ai/cordis') mono.devDependencies[name] = range
}
const unpublishable = Object.entries(mono.devDependencies)
  .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
  .map(([name]) => name)
if (unpublishable.length > 0) {
  console.error(`sync-package-json: devDependencies still use the workspace: protocol: ${unpublishable.join(', ')}`)
  console.error('sync-package-json: add a concrete range to DEV_RANGES - the registry rejects workspace: ranges')
  process.exit(1)
}

writeFileSync(releasePath, `${JSON.stringify(mono, null, 2)}\n`)
console.log(seeded
  ? `sync-package-json: ${mono.name} ${version} (fresh release manifest, version seeded from upstream)`
  : `sync-package-json: ${mono.name} ${version} (version kept; upstream workspace version ${String(upstreamVersion)} ignored)`)
