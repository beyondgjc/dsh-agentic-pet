#!/usr/bin/env node
/**
 * Cut a release: set the version, publish to npm, tag the commit that packed
 * the tarball.
 *
 * The version is owned by this repo (scripts/sync-package-json.mjs keeps it
 * across upstream mirrors), so this script is its only writer. A release is
 * one provable fact — npm `<version>` == tag `v<version>` == the commit the
 * tarball came from. Every precondition below exists to keep that true:
 *
 *   - the tree must be clean, so the tag points at content that was packed;
 *   - the version must not exist as a tag, and must exceed the current one;
 *   - the build artifacts must be present, with exactly one bundle chunk
 *     (tsdown runs with clean:false, so a stale `service-*.js` would ship).
 *
 * `package.json` is restored when the publish fails, so a half-finished run
 * never leaves the tree claiming a version that never shipped.
 *
 * Usage: node scripts/release.mjs <version> [--dry-run]
 *   --dry-run  pin the version, run `npm publish --dry-run`, then restore it
 *              (no publish, no commit, no tag)
 *
 * @module scripts/release
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
/** Explicit: the machine's .npmrc points at a mirror, and pnpm ignores npm_config_registry. */
const REGISTRY = 'https://registry.npmjs.org'
/** Artifacts a publishable tree must carry (mirrored by sync-from-monorepo.cmd). */
const REQUIRED_ARTIFACTS = [
  'lib/index.js',
  'lib/tools.js',
  'client/pet-settings.js',
  'carrier/lib/main.js',
  'carrier/dist-renderer/index.html',
]
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** @param {string} message - why the release cannot proceed. */
function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/** Quote one shell word; the scripts pass paths and commit subjects only. */
function quote(word) {
  if (word.includes('"')) fail(`cannot pass an argument containing a double quote: ${word}`)
  return /[\s&|<>^()]/.test(word) ? `"${word}"` : word
}

/** Run a command in the repo, straight to the console (npm's own prompts stay interactive). */
function run(command, args) {
  const result = spawnSync([command, ...args].map(quote).join(' '), { cwd: ROOT, shell: true, stdio: 'inherit' })
  if (result.error !== undefined) fail(`${command}: ${String(result.error.code ?? result.error.message)}`)
  return result.status ?? 1
}

/**
 * Run a command and read its output. The output lands in a temp file through
 * the shell rather than a pipe: the harness sandbox refuses piped child stdio.
 * @returns {{ status: number, output: string }}
 */
function capture(command, args) {
  const file = join(tmpdir(), `dsh-pet-release-${process.pid}-${Math.random().toString(36).slice(2)}.log`)
  const result = spawnSync(`${[command, ...args].map(quote).join(' ')} > "${file}" 2>&1`, { cwd: ROOT, shell: true, stdio: 'ignore' })
  const output = existsSync(file) ? readFileSync(file, 'utf8') : ''
  rmSync(file, { force: true })
  return { status: result.status ?? 1, output }
}

/** Order two versions; a prerelease sorts before the release it precedes. */
function compare(left, right) {
  const a = SEMVER.exec(left)
  const b = SEMVER.exec(right)
  if (a === null || b === null) fail(`not a version: ${a === null ? left : right}`)
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index])
    if (delta !== 0) return Math.sign(delta)
  }
  if (a[4] === undefined && b[4] === undefined) return 0
  if (a[4] === undefined) return 1
  if (b[4] === undefined) return -1
  return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const version = argv.find(argument => !argument.startsWith('--'))
if (version === undefined) fail('usage: node scripts/release.mjs <version> [--dry-run]')
if (!SEMVER.test(version)) fail(`"${version}" is not an x.y.z[-pre] version`)

const manifestPath = join(ROOT, 'package.json')
const manifestText = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)
if (typeof manifest.version !== 'string') fail('package.json carries no version')
if (compare(version, manifest.version) <= 0) {
  fail(`version ${version} must be greater than the current ${manifest.version}`)
}

const tree = capture('git', ['status', '--porcelain'])
if (tree.status !== 0) fail(`git status failed: ${tree.output.trim()}`)
if (tree.output.trim() !== '') {
  fail(`working tree is dirty - the tag would not match the packed content:\n${tree.output.trimEnd()}`)
}

const tag = capture('git', ['tag', '-l', `v${version}`])
if (tag.status !== 0) fail(`git tag failed: ${tag.output.trim()}`)
if (tag.output.trim() !== '') fail(`tag v${version} already exists`)

for (const relative of REQUIRED_ARTIFACTS) {
  if (!existsSync(join(ROOT, relative))) {
    fail(`missing release artifact ${relative} - build, then run scripts\\sync-from-monorepo.cmd`)
  }
}
const chunks = readdirSync(join(ROOT, 'lib')).filter(entry => /^service-.*\.js$/.test(entry))
if (chunks.length !== 1) {
  fail(`lib/ must carry exactly one bundle chunk, found ${String(chunks.length)} (${chunks.join(', ') || 'none'}) - tsdown clean:false leaves stale chunks behind; delete lib/*.js and rebuild`)
}

const prerelease = version.includes('-')
const publishArgs = ['publish', '--registry', REGISTRY]
if (prerelease) publishArgs.push('--tag', 'rc')
if (dryRun) publishArgs.push('--dry-run')

writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
console.log(`release: package.json version -> ${version}${prerelease ? ' (prerelease: publishes under --tag rc)' : ''}`)

const published = run('npm', publishArgs)
if (published !== 0) {
  writeFileSync(manifestPath, manifestText)
  fail(`npm publish exited ${String(published)}; package.json restored (nothing to tag)`)
}
if (dryRun) {
  writeFileSync(manifestPath, manifestText)
  console.log('release: dry run - nothing published, version restored, no commit, no tag')
  process.exit(0)
}

if (run('git', ['add', '--', 'package.json']) !== 0) fail(`git add failed; package.json is still at ${version} - commit it by hand`)
if (run('git', ['commit', '-m', `chore(release): ${version}`]) !== 0) fail(`git commit failed; package.json is still at ${version} - commit it by hand`)
if (run('git', ['tag', '-a', `v${version}`, '-m', `dsh-agentic-pet ${version}`]) !== 0) {
  fail(`published ${version} but git tag v${version} failed - tag it by hand before anything else`)
}
console.log(`release: published ${version}; tagged v${version}`)
console.log('release: push the record with `git push --follow-tags`')
