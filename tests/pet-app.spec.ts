/**
 * The pet-surface bundle: the patch list parses, and the `/pet` route serves
 * the renderer dist with browser authentication on the index entry.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { servePetStatic } from '../src/index.ts'

describe('dsh-pet-app bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string | string[] } }
    }
    // The patch manifest is an array: the main glue layer plus the pet preset
    // declaration (presets/pet.patch.yml), mirroring the web-app presets split.
    const patchList = manifest.dsh?.bundle?.patch
    const patches = typeof patchList === 'string' ? [patchList] : patchList
    expect(patches).toEqual(['./cordis.patch.yml', './presets/pet.patch.yml'])
    // entryListSchema is a js-yaml schema: load with it so `!!js` expressions
    // in the patch parse exactly the way the Loader parses them.
    const rows = patches!.flatMap(file =>
      (yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema: entryListSchema }) as unknown) as {
        insert?: { id?: string; name?: string }[]
      }[],
    ).flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['pet-surface', 'preset-pet'])
    expect(rows[0]).toMatchObject({ name: 'dsh-agentic-pet' })
    expect(rows[1]).toMatchObject({ name: '@deepseek-ai/dsh-agent-preset' })
  })
})

describe('servePetStatic', () => {
  function makeDist(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pet-app-'))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>dsh pet</title></head><body>pet</body></html>')
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets', 'main.js'), 'console.log(1)')
    return root
  }

  const dist = makeDist()
  const distIndex = join(dist, 'index.html')
  const admitted = (): Response | undefined => undefined

  it('serves the raw index behind authentication', async () => {
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/pet/'), dist, distIndex, admitted,
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    // Raw serving: no web boot injections may leak into the transparent page.
    expect(html).not.toContain('background-color')
    expect(html).toContain('dsh pet')
  })

  it('answers the bare /pet prefix with the index', async () => {
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/pet'), dist, distIndex, admitted,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('refuses the index when authentication refuses', async () => {
    const refusal = new Response('no', { status: 401 })
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/pet/'), dist, distIndex, () => refusal,
    )
    expect(response.status).toBe(401)
  })

  it('serves assets publicly with a weak ETag and answers 304', async () => {
    const url = 'http://127.0.0.1:3080/pet/assets/main.js'
    const first = await servePetStatic(new Request(url), dist, distIndex, admitted)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\//)
    const second = await servePetStatic(
      new Request(url, { headers: { 'if-none-match': etag! } }), dist, distIndex, admitted,
    )
    expect(second.status).toBe(304)
  })

  it('rejects traversal outside the dist root with 403', async () => {
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/pet/..%2F..%2Fsecret.txt'), dist, distIndex, admitted,
    )
    expect(response.status).toBe(403)
  })

  it('answers missing files with 404', async () => {
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/pet/assets/absent.js'), dist, distIndex, admitted,
    )
    expect(response.status).toBe(404)
  })

  it('treats a sibling-prefixed path as an ordinary miss', async () => {
    // The webserver never routes /petfoo to this resource (prefix matching is
    // p and p/<anything>); the slice logic alone would read dist/foo, which is
    // a 404 — never a traversal escape.
    const response = await servePetStatic(
      new Request('http://127.0.0.1:3080/petfoo'), dist, distIndex, admitted,
    )
    expect(response.status).toBe(404)
  })

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true })
  })
})
