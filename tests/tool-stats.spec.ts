/**
 * 审计看板（2026-11-15）：bump 按天 × 按工具计数（幂等递增、非法 petId 拒写）、
 * readToolStats 两种口径（all 全体求和 / 30d 只算近 30 个本地日）、损坏文件折叠。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bumpToolStat, readToolStats } from '../src/tool-stats.ts'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-stats-'))
  dirs.push(dir)
  return dir
}

describe('bumpToolStat', () => {
  it('increments the day bucket per tool and records startedAt once', async () => {
    const home = await tempHome()
    await bumpToolStat(home, 'electron', 'pet_say')
    await bumpToolStat(home, 'electron', 'pet_say')
    await bumpToolStat(home, 'electron', 'pet_do')
    const summary = await readToolStats(home, 'electron', 'all')
    expect(summary.perTool['pet_say']).toBe(2)
    expect(summary.perTool['pet_do']).toBe(1)
    expect(summary.total).toBe(3)
    expect(summary.startedAt).not.toBeNull()
  })

  it('refuses invalid petIds instead of writing stray paths', async () => {
    const home = await tempHome()
    await bumpToolStat(home, '../escape', 'pet_say')
    await bumpToolStat(home, '', 'pet_say')
    const summary = await readToolStats(home, 'electron', 'all')
    expect(summary.total).toBe(0)
    expect(summary.startedAt).toBeNull()
  })

  it('keeps separate books per pet', async () => {
    const home = await tempHome()
    await bumpToolStat(home, 'electron', 'pet_say')
    await bumpToolStat(home, 'electron-2', 'pet_do')
    const a = await readToolStats(home, 'electron', 'all')
    const b = await readToolStats(home, 'electron-2', 'all')
    expect(a.perTool['pet_say']).toBe(1)
    expect(a.perTool['pet_do']).toBeUndefined()
    expect(b.perTool['pet_do']).toBe(1)
  })
})

describe('readToolStats ranges', () => {
  it('30d excludes days older than 30 local days, all includes everything', async () => {
    const home = await tempHome()
    // 直接造账：今天 + 40 天前
    const today = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    const old = new Date(Date.now() - 40 * 86_400_000)
    const oldKey = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
    await mkdir(join(home, 'whale598', 'electron'), { recursive: true })
    await writeFile(join(home, 'whale598', 'electron', 'pet-tool-stats.json'), JSON.stringify({
      startedAt: Date.now(),
      days: {
        [todayKey]: { pet_say: 3 },
        [oldKey]: { pet_say: 5, pet_do: 2 },
      },
    }), 'utf8')
    const all = await readToolStats(home, 'electron', 'all')
    expect(all.perTool['pet_say']).toBe(8)
    expect(all.perTool['pet_do']).toBe(2)
    expect(all.total).toBe(10)
    const d30 = await readToolStats(home, 'electron', '30d')
    expect(d30.perTool['pet_say']).toBe(3)
    expect(d30.perTool['pet_do']).toBeUndefined()
    expect(d30.total).toBe(3)
  })

  it('folds a broken stats file to empty instead of throwing', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598', 'electron'), { recursive: true })
    await writeFile(join(home, 'whale598', 'electron', 'pet-tool-stats.json'), '{not json', 'utf8')
    const summary = await readToolStats(home, 'electron', 'all')
    expect(summary.total).toBe(0)
    expect(summary.startedAt).toBeNull()
  })
})
